// services/dispatch-messages.js — "your order is on its way" eBay message.
//
// eBay shows the buyer the tracking number we upload, but for couriers it doesn't
// know (Proovia, DropFleet) it can't link to the tracking page — so after we mark
// such an order dispatched, the buyer gets one message with the courier's name,
// the tracking number and the tracking link.
//
// Same guards as the fitment messages (an account was restricted in Oct 2026
// after automated messages): OFF by default, only the eBay accounts ticked, only
// the couriers ticked, at most once per order, only about that order, and the
// text is checked by lib/ebay-message-guard (a courier tracking link is allowed
// because the buyer has an order; nothing else off-eBay).
const { query } = require('../db');
const guard = require('../lib/ebay-message-guard');

const DEFAULT_SUBJECT = 'Your order is on its way';
const DEFAULT_BODY =
`Hi {name},

Good news — your order has been dispatched with {carrier}.
Tracking number: {tracking}
Track it here: {link}

Thanks for shopping with {shop}!`;
const DEFAULT_CARRIERS = ['Proovia', 'Dropfleet'];

let _cols = false;
async function ensureColumns() {
  if (_cols) return;
  for (const c of ['dispatch_msg_sent_at TIMESTAMPTZ', 'dispatch_msg_status TEXT', 'dispatch_msg_error TEXT']) {
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ${c}`);
  }
  _cols = true;
}

async function getConfig() {
  await ensureColumns();
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const c = d.dispatchMsg || {};
  return {
    enabled: !!c.enabled,
    channels: Array.isArray(c.channels) ? c.channels.map(String) : [],
    carriers: Array.isArray(c.carriers) && c.carriers.length ? c.carriers.map(String) : DEFAULT_CARRIERS,
    subject: c.subject || DEFAULT_SUBJECT,
    body: c.body || DEFAULT_BODY,
    DEFAULT_SUBJECT, DEFAULT_BODY,
  };
}

async function saveConfig(patch = {}) {
  await ensureColumns();
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.dispatchMsg || {}) };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.channels !== undefined) next.channels = (Array.isArray(patch.channels) ? patch.channels : []).map(String).filter(c => /^ebay_/.test(c));
  if (patch.carriers !== undefined) next.carriers = (Array.isArray(patch.carriers) ? patch.carriers : []).map(String).slice(0, 20);
  if (patch.subject !== undefined) next.subject = String(patch.subject || '').slice(0, 200);
  if (patch.body !== undefined) next.body = String(patch.body || '').slice(0, 2000);
  // Check the wording with sample values before it's ever stored.
  const sample = fill(next.body || DEFAULT_BODY, { name: 'Sam', carrier: 'Proovia', tracking: 'PR123456789', link: 'https://track.proovia.delivery/order/PR123456789', shop: 'Our shop', ref: '12-34567-89012' });
  guard.assertClean(next.subject || DEFAULT_SUBJECT, sample, { allowTracking: true });
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify({ ...cur, dispatchMsg: next })]);
  return getConfig();
}

// {name} {carrier} {tracking} {link} {shop} {ref}; a line whose placeholder is
// empty (no link for this courier, no tracking) is left out.
function fill(tpl, v) {
  return String(tpl).split('\n').filter(line => {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    return keys.every(k => v[k] != null && String(v[k]).trim() !== '');
  }).map(line => line.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''))).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Send (or skip) for ONE dispatched sale. At most once: the sale is stamped
// whatever happens (a second message is worse than a missing one).
async function sendForSale(saleId) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const sale = (await query(`SELECT * FROM sales WHERE id = $1`, [saleId])).rows[0];
    if (!sale) return { skipped: 'not_found' };
    if (!/^ebay_/.test(sale.channel || '') || !cfg.channels.includes(sale.channel)) return { skipped: 'channel_not_ticked' };
    if (!sale.dispatched_at || sale.dispatch_msg_sent_at) return { skipped: 'not_dispatched_or_sent' };
    if (!cfg.carriers.some(c => norm(c) === norm(sale.carrier))) return { skipped: 'carrier_not_ticked' };
    if (!sale.tracking_number && !sale.tracking_url) return { skipped: 'no_tracking' };
    // Claim it first, so two triggers can never both send.
    const claim = await query(`UPDATE sales SET dispatch_msg_sent_at = now(), dispatch_msg_status = 'sending' WHERE id = $1 AND dispatch_msg_sent_at IS NULL RETURNING id`, [sale.id]);
    if (!claim.rows.length) return { skipped: 'already_sent' };
    const done = (status, err) => query(`UPDATE sales SET dispatch_msg_status = $2, dispatch_msg_error = $3 WHERE id = $1`, [sale.id, status, err ? String(err).slice(0, 500) : null]);
    const t = await require('./fitment-messages').resolveSendTargets(sale);
    if (t.skip) { await done('skipped', t.skip); return { skipped: t.skip }; }
    const brand = require('../lib/brand');
    const body = fill(cfg.body, {
      name: String(sale.customer_name || '').trim().split(/\s+/)[0] || 'there',
      carrier: sale.carrier, tracking: sale.tracking_number, link: sale.tracking_url,
      shop: t.store?.name || brand.name || 'us', ref: sale.external_order_id || sale.invoice_number,
    });
    try {
      await require('./ebay').sendMemberMessage(t.store.code, { itemId: t.itemId, recipientId: t.buyerUserId, subject: cfg.subject, body, questionType: 'Shipping', allowTracking: true });
      await done('sent', null);
      return { ok: true };
    } catch (e) { await done('error', e.message); return { error: e.message }; }
  } catch (e) { console.warn('[dispatch-msg]', e.message); return { error: e.message }; }
}

module.exports = { ensureColumns, getConfig, saveConfig, sendForSale, fill, DEFAULT_SUBJECT, DEFAULT_BODY };
