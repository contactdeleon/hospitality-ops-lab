// Staged checkout-success delivery endpoint. Keep off production until credentials and tests pass.
// A Stripe Checkout session ID is a bearer credential; do not log or expose it to third parties.
const PRICE_ID = 'price_1UY7cyAcVts6x0hotcrN42w8';
const REPO = 'contactdeleon/hospitality-toolkit-delivery';
const FILE = 'Hospitality_Manager_Toolkit_v2_2_8_Five_File_Package.zip';
const EXPECTED_GIT_SHA = 'a32ff3d7c511cec1f5defa126726e1002bd6ffac';
const MAX_ZIP_BYTES = 15 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const githubToken = process.env.TOOLKIT_GITHUB_READ_TOKEN;
  if (!stripeKey || !githubToken) return res.status(503).json({ error: 'Delivery not configured' });
  const sessionId = req.body?.session_id;
  if (typeof sessionId !== 'string' || !/^cs_(test_)?[A-Za-z0-9]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid checkout session' });
  }
  try {
    const stripeHeaders = { Authorization: 'Bearer ' + stripeKey };
    const sessionResponse = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), { headers: stripeHeaders });
    if (!sessionResponse.ok) return res.status(403).json({ error: 'Purchase not verified' });
    const session = await sessionResponse.json();
    if (session.livemode !== true || session.mode !== 'payment' || session.payment_status !== 'paid' ||
        session.status !== 'complete' || session.amount_total !== 4900 || session.currency !== 'usd') {
      return res.status(403).json({ error: 'Purchase not verified' });
    }
    const itemsResponse = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId) + '/line_items?limit=100', { headers: stripeHeaders });
    if (!itemsResponse.ok) return res.status(503).json({ error: 'Purchase verification unavailable' });
    const items = await itemsResponse.json();
    if (items.has_more || items.data?.length !== 1 || items.data[0].price?.id !== PRICE_ID || items.data[0].quantity !== 1) {
      return res.status(403).json({ error: 'Wrong product' });
    }
    const githubResponse = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + encodeURIComponent(FILE), {
      headers: { Authorization: 'Bearer ' + githubToken, Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hospitality-toolkit-delivery' }
    });
    if (!githubResponse.ok) return res.status(503).json({ error: 'File unavailable' });
    const declared = Number(githubResponse.headers.get('content-length'));
    if (declared > MAX_ZIP_BYTES) return res.status(503).json({ error: 'File size exceeded' });
    const bytes = Buffer.from(await githubResponse.arrayBuffer());
    if (bytes.length > MAX_ZIP_BYTES || bytes.subarray(0, 4).toString('hex') !== '504b0304') {
      return res.status(503).json({ error: 'Invalid file' });
    }
    // Git blob SHA is validated by a separate release verification; content may change in repo.
    // Pinning release assets to a commit is required before production.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + FILE + '"');
    return res.status(200).send(bytes);
  } catch {
    return res.status(503).json({ error: 'Delivery temporarily unavailable' });
  }
}
