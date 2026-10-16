# AI Superfriends Gateway (inbound only)

Cloudflare Worker that accepts authenticated structured handoffs from explicitly configured clients and posts them **only** to `contactdeleon/hospitality-ops-lab#1`. It does not connect to or read Gemini, Meta AI, or Grok conversations. Each agent requires a separate authorized sender integration.

## Setup (not yet deployed)
1. Create a separate Cloudflare Worker named `ai-superfriends-gateway` (do not modify the PSPS Stripe/Seam booking Worker).
2. Bind a Cloudflare KV namespace as `HANDOFF_IDS`. KV-based duplicate suppression is best-effort under concurrency; for strict exactly-once semantics use Durable Objects or a transaction-backed store.
3. Add **Worker secrets** `GATEWAY_HMAC_KEY` (strong random shared key) and `GITHUB_ISSUES_TOKEN` (fine-grained token limited to Issues write on `contactdeleon/hospitality-ops-lab`). Do not put secrets in code, GitHub issues, or AI chat.
4. Deploy from `ai-gateway/`. Test `GET /health`, unauthenticated `POST /v1/handoff` (must be 401), malformed payload (400), replay timestamp (401), successful signed handoff (201), and duplicate task ID (409). Do not turn on external senders until tests pass.
5. Configure provider-side senders individually. Never expose the signing secret in a public browser, shared Gemini/Grok/Meta prompt, or public client-side JavaScript.

## Request contract
`POST /v1/handoff` with `content-type: application/json`, `x-ai-timestamp: <unix seconds>`, and `x-ai-signature: sha256=<lowercase hex HMAC SHA-256>`. Sign UTF-8 bytes of `timestamp + "." + raw JSON request body`. Timestamp tolerance is five minutes.

```json
{"agent_role":"gemini","task_id":"research-20261016-001","status":"in_progress","summary":"Evidence-backed findings with uncertainty noted.","evidence":["https://example.com/source"],"blockers":"None","next_action":"Submit verification results to Director","director_approval_required":false,"created_at":"2026-10-16T22:00:00Z"}
```

Agent roles: `gemini`, `meta`, `grok`, `chatgpt`. Statuses: `proposed`, `in_progress`, `complete`, `blocked`. Evidence is a list of short strings; blockers and next_action are required strings; director_approval_required is boolean. The shared key authenticates the sender integration, **not** the claimed agent identity; use per-agent credentials and policy before trusting attribution.

## Security limits
Fixed repository and issue; no arbitrary URL forwarding; payload and source limits; markdown escaping; basic secret-pattern rejection; no tokens in logs. No publishing, emails, payments, or production website modifications. KV idempotency is best-effort. The GitHub token must be rotated if leaked.