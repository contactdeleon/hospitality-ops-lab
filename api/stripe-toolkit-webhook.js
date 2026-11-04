// Staged only: do not deploy until STRIPE_WEBHOOK_SECRET and durable fulfillment are configured.
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 300;
const TOOLKIT_PRICE_ID = 'price_1UY7cyAcVts6x0hotcrN42w8';

function verifyStripeSignature(raw, header, secret) {
  const parts = Object.fromEntries((header || '').split(',').map(x => x.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');
  const signatures = (header || '').split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  return signatures.some(sig => /^[a-f0-9]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Fulfillment not configured' });
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) return res.status(400).json({ error: 'Invalid signature' });
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true });
  const session = event.data?.object;
  if (session?.mode !== 'payment' || session?.payment_status !== 'paid' || session?.amount_total !== 4900 || session?.currency !== 'usd') {
    return res.status(200).json({ received: true, fulfilled: false });
  }
  // Verify the actual purchased line items, not customer-controlled metadata.
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey || !session?.id || !/^cs_(test_)?[A-Za-z0-9]+$/.test(session.id)) {
    return res.status(503).json({ error: 'Fulfillment not configured' });
  }
  let lines;
  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions/' +
      encodeURIComponent(session.id) + '/line_items?limit=100', {
      headers: { Authorization: 'Bearer ' + apiKey }
    });
    if (!response.ok) return res.status(503).json({ error: 'Payment verification unavailable' });
    lines = await response.json();
  } catch {
    return res.status(503).json({ error: 'Payment verification unavailable' });
  }
  if (lines?.has_more || lines?.data?.length !== 1 ||
      lines.data[0]?.price?.id !== TOOLKIT_PRICE_ID ||
      lines.data[0]?.quantity !== 1) {
    return res.status(200).json({ received: true, fulfilled: false });
  }
  // Deliberately fail closed until idempotent entitlements, private storage and
  // customer delivery are configured and tested. Stripe retries non-2xx events.
  return res.status(503).json({ error: 'Fulfillment pending configuration' });
}
