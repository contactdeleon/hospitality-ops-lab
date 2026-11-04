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
  // A checkout session's line items must be retrieved server-side and verified against TOOLKIT_PRICE_ID.
  // Do not return a download or acknowledge fulfillment until durable, idempotent entitlement
  // storage and private signed-file delivery are implemented.
  return res.status(503).json({ error: 'Fulfillment pending configuration', expected_price: TOOLKIT_PRICE_ID });
}
