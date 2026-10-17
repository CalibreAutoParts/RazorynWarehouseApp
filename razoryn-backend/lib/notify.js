// lib/notify.js — one place every alert goes through: the in-app
// notification row AND the OS push (web push, Android FCM, and the Windows
// desktop app's notification feed all read from the same row).
//
// audience: null = everyone · 'admin' = admins only (anything with money in
// it — sale totals, competitor prices, AI pricing) · 'staff' = non-admins
// (e.g. a "new order to pack" variant without the £).
const { query } = require('../db');

let _ready = false;
async function ensureCols() {
  if (_ready) return;
  try {
    await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience TEXT`);
    // "Handled" is separate from "read": reading the bell menu must not hide
    // competitor alerts, but acting on one (repricing, dismissing) closes it.
    await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
    await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolution TEXT`);
    _ready = true;
  } catch (e) { console.warn('[notify] migration:', e.message); }
}

async function notifyEvent({ type, title, body = '', severity = 'info', relatedType = null, relatedId = null,
  audience = null, url = '/', tag = null, push = true, force = false }) {
  await ensureCols();
  try {
    await query(
      `INSERT INTO notifications (type, title, body, severity, related_type, related_id, audience)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [type, title, body, severity, relatedType, relatedId, audience]);
  } catch (e) { console.warn('[notify] insert failed:', e.message); }
  if (push) {
    try {
      await require('../services/push').sendToAll({ title, body, url, tag: tag || `${type}-${relatedId || Date.now()}`, category: type, audience, force });
    } catch (_) {}
  }
}

// ── New-order alerts, batched ─────────────────────────────────────────────
// A sync pulling six orders sends ONE push ("6 new orders — £412"), not six.
// Admins get the £ version; warehouse staff get a "to pack" version with no
// money in it (the app hides £ from staff).
const CHANNEL_NAME = { ebay_em: 'eBay', ebay_cl: 'eBay', shopify: 'Shopify', direct_cash: 'Cash', direct_bank: 'Bank transfer', direct_card: 'Card' };
const _pendingSales = [];
let _salesTimer = null;
function saleSold({ saleId, channel, ref, customer, total, items = [], occurredAt }) {
  // Re-pulls / backfills of old orders stay silent.
  if (occurredAt && Date.now() - new Date(occurredAt).getTime() > 48 * 3600 * 1000) return;
  _pendingSales.push({ saleId, channel, ref, customer, total: parseFloat(total) || 0, items, occurredAt });
  if (!_salesTimer) _salesTimer = setTimeout(() => { flushSales().catch(e => console.warn('[notify] sales flush:', e.message)); }, 5000);
}
async function flushSales() {
  _salesTimer = null;
  const batch = _pendingSales.splice(0);
  if (!batch.length) return;
  const gbp = (n) => '£' + (+n || 0).toFixed(2);
  const itemLine = (s) => {
    const first = s.items[0];
    if (!first) return 'order ' + (s.ref || '#' + s.saleId);
    const more = s.items.length > 1 ? ` +${s.items.length - 1} more` : '';
    return `${first.title || first.sku}${first.qty > 1 ? ' ×' + first.qty : ''}${more}`;
  };
  // In-app rows: one per order (admin £ version + staff pack version).
  for (const s of batch) {
    const ch = CHANNEL_NAME[s.channel] || s.channel;
    await notifyEvent({ type: 'sale', title: `💷 Sold on ${ch} — ${gbp(s.total)}`, body: `${itemLine(s)}${s.customer ? ' · ' + s.customer : ''}`,
      relatedType: 'sale', relatedId: s.saleId, audience: 'admin', push: false });
    await notifyEvent({ type: 'sale', title: `📦 New ${ch} order to pack`, body: itemLine(s),
      relatedType: 'sale', relatedId: s.saleId, audience: 'staff', push: false });
  }
  const push = require('../services/push');
  if (batch.length === 1) {
    const s = batch[0], ch = CHANNEL_NAME[s.channel] || s.channel;
    await push.sendToAll({ title: `💷 Sold on ${ch} — ${gbp(s.total)}`, body: `${itemLine(s)}${s.customer ? ' · ' + s.customer : ''}`, url: '/#sales', tag: 'sale-' + s.saleId, category: 'sale', audience: 'admin', force: true });
    await push.sendToAll({ title: `📦 New ${ch} order to pack`, body: itemLine(s), url: '/#dispatch', tag: 'sale-' + s.saleId, category: 'sale', audience: 'staff', force: true });
  } else {
    const sum = batch.reduce((a, s) => a + s.total, 0);
    const byCh = {};
    for (const s of batch) { const ch = CHANNEL_NAME[s.channel] || s.channel; byCh[ch] = (byCh[ch] || 0) + 1; }
    const chText = Object.entries(byCh).map(([k, v]) => `${v} ${k}`).join(' · ');
    const list = batch.slice(0, 3).map(itemLine).join(', ') + (batch.length > 3 ? '…' : '');
    await push.sendToAll({ title: `💷 ${batch.length} new orders — ${gbp(sum)}`, body: `${chText} — ${list}`, url: '/#sales', tag: 'sales-batch', category: 'sale', audience: 'admin', force: true });
    await push.sendToAll({ title: `📦 ${batch.length} new orders to pack`, body: `${chText} — ${list}`, url: '/#dispatch', tag: 'sales-batch', category: 'sale', audience: 'staff', force: true });
  }
}

module.exports = { notifyEvent, saleSold, ensureCols };
