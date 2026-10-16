// AI Superfriends inbound-only handoff gateway.
// Required secrets: GATEWAY_HMAC_KEY, GITHUB_ISSUES_TOKEN
// Required KV namespace binding: HANDOFF_IDS
const AGENTS = new Set(["gemini","meta","grok","chatgpt"]);
const STATUSES = new Set(["proposed","in_progress","complete","blocked"]);
const enc = new TextEncoder();
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
function hex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");}
function safe(s,max){return typeof s==="string" && s.length>0 && s.length<=max;}
function escapeMd(s){return s.replace(/[\\`*_{}\[\]()#+.!|<>]/g,"\\$&");}
function hasSensitive(s){return /(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk_(?:live|test)_[a-zA-Z0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+)/i.test(s);}
async function verify(request,secret,body){
  const timestamp=request.headers.get("x-ai-timestamp");
  const signature=request.headers.get("x-ai-signature");
  if(!timestamp || !/^\d{10,13}$/.test(timestamp) || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))return false;
  const epoch=Number(timestamp.length===13?Number(timestamp)/1000:timestamp);
  if(Math.abs(Date.now()/1000-epoch)>300)return false;
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const expected=hex(await crypto.subtle.sign("HMAC",key,enc.encode(timestamp+"."+body)));
  // Compare signatures without an early exit.
  let mismatch=0;const received=signature.slice(7);
  for(let i=0;i<64;i++)mismatch|=expected.charCodeAt(i)^received.charCodeAt(i);
  return mismatch===0;
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==="/health" && request.method==="GET")return json({service:"ai-superfriends-gateway",status:"ready",mode:"inbound-only"});
  if(url.pathname!=="/v1/handoff")return json({error:"not_found"},404);
  if(request.method!=="POST")return json({error:"method_not_allowed"},405);
  if(!env.GATEWAY_HMAC_KEY || !env.GITHUB_ISSUES_TOKEN || !env.HANDOFF_IDS)return json({error:"not_configured"},503);
  const size=Number(request.headers.get("content-length")||0);
  if(size>12000)return json({error:"payload_too_large"},413);
  const body=await request.text();
  if(body.length>12000)return json({error:"payload_too_large"},413);
  if(!(await verify(request,env.GATEWAY_HMAC_KEY,body)))return json({error:"unauthorized"},401);
  let payload;try{payload=JSON.parse(body)}catch{return json({error:"invalid_json"},400)}
  if(!payload || typeof payload!=="object" || Array.isArray(payload))return json({error:"invalid_payload"},400);
  const {agent_role,task_id,status,summary,evidence,blockers,next_action,director_approval_required,created_at}=payload;
  if(!AGENTS.has(agent_role)||!STATUSES.has(status)||!safe(task_id,80)||! /^[a-zA-Z0-9_-]+$/.test(task_id)||!safe(summary,3500)||!Array.isArray(evidence)||evidence.length>8||!evidence.every(s=>safe(s,350))||!safe(blockers,1000)||!safe(next_action,1000)||typeof director_approval_required!=="boolean"||!safe(created_at,40)||!Number.isFinite(Date.parse(created_at))||Math.abs(Date.now()-Date.parse(created_at))>86400000)return json({error:"invalid_payload"},400);
  if([summary,blockers,next_action,...evidence].some(hasSensitive))return json({error:"sensitive_content_detected"},422);
  const id=agent_role+":"+task_id;
  // KV limits repeat submissions; simultaneous first requests can race. GitHub write remains scoped.
  if(await env.HANDOFF_IDS.get(id))return json({status:"duplicate",task_id},409);
  await env.HANDOFF_IDS.put(id,"pending",{expirationTtl:86400});
  const comment="## AI HANDOFF — "+escapeMd(agent_role.toUpperCase())+" / "+escapeMd(status)+"\\n\\n**Task:** "+escapeMd(task_id)+"\\n**Created:** "+escapeMd(created_at)+"\\n**Director approval required:** "+(director_approval_required?"YES":"NO")+"\\n\\n**Summary:** "+escapeMd(summary)+"\\n\\n**Evidence:**\\n"+(evidence.length?evidence.map(s=>"- "+escapeMd(s)).join("\\n"):"- None provided")+"\\n\\n**Blockers:** "+escapeMd(blockers)+"\\n\\n**Next action:** "+escapeMd(next_action)+"\\n\\n_Authenticated handoff; agent attribution is sender-asserted and claims require verification._";
  try{
   const response=await fetch("https://api.github.com/repos/contactdeleon/hospitality-ops-lab/issues/1/comments",{method:"POST",headers:{"authorization":"Bearer "+env.GITHUB_ISSUES_TOKEN,"accept":"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"ai-superfriends-gateway","content-type":"application/json"},body:JSON.stringify({body:comment})});
   if(!response.ok){await env.HANDOFF_IDS.delete(id);return json({error:"ledger_write_failed",status:response.status},502);}
   const result=await response.json();
   await env.HANDOFF_IDS.put(id,"posted",{expirationTtl:604800});
   return json({status:"accepted",task_id,ledger_url:result.html_url},201);
  }catch{await env.HANDOFF_IDS.delete(id);return json({error:"ledger_unavailable"},502)}
 }
}
};