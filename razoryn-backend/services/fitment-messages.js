// services/fitment-messages.js — automated eBay "confirm fitment" messages.
//
// Sends a friendly message to eBay buyers shortly after purchase asking them to
// confirm their vehicle registration / VIN (and ideally a photo) so we can check
// the part fits before dispatch — cutting wrong-fit returns. Fully automatic on a
// cron, at-most-once per order, with skip rules so we never pester a buyer we've
// already handled.
//
// LIMITATION: eBay's API here (AddMemberMessageAAQToPartner) sends but we do NOT
// read the buyer's replies, so "skip if we already discussed fitment" is
// approximated by: send once per order, only while it's still PAID + undispatched
// (before we ship), never on refunded/cancelled/returned/dispatched orders.

const { query } = require('../db');

const DEFAULT_SUBJECT = 'Quick check so your part fits first time';
const DEFAULT_BODY =
`Hi, thanks for your order with us!

To make sure this part fits your exact vehicle first time — and save us both the hassle of a return — could you reply with your vehicle REGISTRATION or VIN, and ideally a quick photo of the part you're replacing?

We'll confirm the fit and get it dispatched straight away. Thanks so much!`;

let _migrated = false;
async function ensureColumns() {
  if (_migrated) return;
  try {
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS fitment_msg_sent_at TIMESTAMPTZ`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS fitment_msg_status TEXT`);   // 'sent' | 'error' | 'skipped'
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS fitment_msg_error TEXT`);
    _migrated = true;
  } catch (e) { console.warn('[fitment-msg] migration warning:', e.message); }
}

async function getConfig() {
  await ensureColumns();
  const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
  const c = (rows[0]?.data && rows[0].data.fitmentMsg) || {};
  return {
    enabled: !!c.enabled,
    subject: c.subject || DEFAULT_SUBJECT,
    body: c.body || DEFAULT_BODY,
    windowDays: Number.isFinite(+c.windowDays) ? Math.min(90, Math.max(1, +c.windowDays)) : 14,
    delayHours: Number.isFinite(+c.delayHours) ? Math.min(240, Math.max(0, +c.delayHours)) : 0,
    maxPerRun: Number.isFinite(+c.maxPerRun) ? Math.min(200, Math.max(1, +c.maxPerRun)) : 40,
    DEFAULT_SUBJECT, DEFAULT_BODY,
  };
}

async function saveConfig(patch = {}) {
  await ensureColumns();
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.fitmentMsg || {}) };
  if (patch.enabled !== undefined)    next.enabled = !!patch.enabled;
  if (patch.subject !== undefined)    next.subject = String(patch.subject || '').slice(0, 200);
  if (patch.body !== undefined)       next.body = String(patch.body || '').slice(0, 2000);
  if (patch.windowDays !== undefined) next.windowDays = Math.min(90, Math.max(1, parseInt(patch.windowDays) || 14));
  if (patch.delayHours !== undefined) next.delayHours = Math.min(240, Math.max(0, parseInt(patch.delayHours) || 0));
  if (patch.maxPerRun !== undefined)  next.maxPerRun = Math.min(200, Math.max(1, parseInt(patch.maxPerRun) || 40));
  const data = { ...cur, fitmentMsg: next };
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify(data)]);
  return getConfig();
}

// The eligibility clause — orders that should get a fitment message:
//   • an eBay order, paid, not an estimate
//   • NOT yet dispatched/collected (we ask BEFORE shipping)
//   • not refunded/cancelled and with no return
//   • not already messaged (at-most-once)
//   • old enough to have settled (delayHours) but within the recency window
function eligibleWhere() {
  return `
    WHERE channel LIKE 'ebay_%'
      AND is_estimate = false
      AND status = 'paid'
      AND dispatched_at IS NULL
      AND collected_at IS NULL
      AND fitment_msg_sent_at IS NULL
      AND external_order_id IS NOT NULL
      AND occurred_at >= now() - ($1 || ' days')::interval
      AND occurred_at <= now() - ($2 || ' hours')::interval
      AND NOT (COALESCE(refunded_amount,0) > 0)
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.sale_id = sales.id)`;
}

async function countEligible() {
  const cfg = await getConfig();
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM sales ${eligibleWhere()}`,
    [String(cfg.windowDays), String(cfg.delayHours)]
  );
  return rows[0]?.n || 0;
}

// Resolve the eBay buyer username + a linked ItemID for a sale (needed by the
// member-message API). Returns { store, buyerUserId, itemId } or a reason it
// can't be sent.
async function resolveSendTargets(sale) {
  const ebay = require('./ebay');
  const brand = require('../lib/brand');
  const store = brand.stores.find(s => s.channelCode === sale.channel);
  if (!store || !store.token) return { skip: 'store_unavailable' };

  // Pull the order from eBay — one call gives BOTH the buyer's username AND the
  // exact ItemID(s) the buyer actually purchased. Using the order's own ItemID
  // (not a lookup) means the message threads under the SAME item conversation the
  // buyer bought on — the correct listing, on the correct account.
  let od;
  try { od = await ebay.getOrderDetail(sale.external_order_id, store.code); }
  catch (e) { return { skip: 'order_lookup_failed', error: e.message }; }
  const buyerUserId = od?.buyer?.username || null;
  if (!buyerUserId) return { skip: 'no_buyer_userid' };   // anonymised (order >~30 days old)

  let itemId = (od.lineItems || []).map(li => li.itemId).find(Boolean) || null;
  // Fallback only if the order didn't carry an ItemID: our mirror_links for this store.
  if (!itemId) {
    const fi = (await query(
      `SELECT p.shopify_product_id FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = $1 AND p.shopify_product_id IS NOT NULL ORDER BY si.id LIMIT 1`, [sale.id])).rows[0];
    if (fi?.shopify_product_id) {
      const nullClause = store.primary ? 'OR store_code IS NULL' : '';
      const link = await query(
        `SELECT ebay_item_id FROM mirror_links
          WHERE shopify_product_id::text = $1 AND ebay_item_id IS NOT NULL AND (store_code = $2 ${nullClause})
          ORDER BY (store_code = $2) DESC NULLS LAST LIMIT 1`,
        [String(fi.shopify_product_id), store.code]);
      itemId = link.rows[0]?.ebay_item_id || null;
    }
  }
  if (!itemId) return { skip: 'no_item_link' };
  return { store, buyerUserId, itemId };
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Send (or skip) the fitment message for ONE sale. Stamps fitment_msg_sent_at so
// it's at-most-once. Returns { sent | skipped | error }.
async function sendOneSale(sale, cfg) {
  const ebay = require('./ebay');
  const t = await resolveSendTargets(sale);
  if (t.skip) {
    // Only truly-unsendable orders are stamped permanently: an anonymised buyer
    // (eBay hides the username ~30 days after the order) can never be messaged.
    // FIXABLE reasons (no linked ItemID yet, the store's token missing/disabled,
    // a transient order lookup) are NOT stamped, so they retry once the link is
    // created / the account is enabled, instead of being silently skipped forever.
    if (t.skip === 'no_buyer_userid') {
      await query(`UPDATE sales SET fitment_msg_sent_at = now(), fitment_msg_status = 'skipped', fitment_msg_error = $2 WHERE id = $1`, [sale.id, t.skip]);
    }
    return { saleId: sale.id, skipped: t.skip };
  }
  try {
    await ebay.sendMemberMessage(t.store.code, {
      itemId: t.itemId, recipientId: t.buyerUserId, subject: cfg.subject, body: cfg.body,
    });
    await query(`UPDATE sales SET fitment_msg_sent_at = now(), fitment_msg_status = 'sent', fitment_msg_error = NULL WHERE id = $1`, [sale.id]);
    return { saleId: sale.id, ok: true };
  } catch (e) {
    // Stamp even on failure — messaging a buyer twice is worse than missing one,
    // and most failures here are permanent (bad itemId/recipient).
    await query(`UPDATE sales SET fitment_msg_sent_at = now(), fitment_msg_status = 'error', fitment_msg_error = $2 WHERE id = $1`, [sale.id, String(e.message).slice(0, 500)]);
    return { saleId: sale.id, error: e.message };
  }
}

// Fire-and-forget: send the fitment message for a single freshly-imported order,
// straight away. Called from the eBay order sync so buyers are asked to confirm
// fitment within minutes of ordering (not on a slow sweep). Guards: enabled, the
// order is a still-open eBay sale, not already messaged, no return/refund. Ignores
// the delay/window (those only bound the catch-up cron).
async function sendForSale(saleId) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
    const ebay = require('./ebay');
    if (!ebay.isConfigured()) return { ok: false, skipped: 'ebay_not_configured' };
    const { rows } = await query(
      `SELECT id, external_order_id, channel FROM sales
        WHERE id = $1 AND channel LIKE 'ebay_%' AND is_estimate = false AND status = 'paid'
          AND dispatched_at IS NULL AND collected_at IS NULL
          AND fitment_msg_sent_at IS NULL AND external_order_id IS NOT NULL
          AND NOT (COALESCE(refunded_amount,0) > 0)
          AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.sale_id = sales.id)`, [saleId]);
    if (!rows[0]) return { ok: false, skipped: 'not_eligible' };
    return await sendOneSale(rows[0], cfg);
  } catch (e) {
    console.warn('[fitment-msg] sendForSale failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Catch-up sweep — messages any eligible order the per-order hook missed (e.g.
// the integration was toggled on after some orders came in, or a send failed
// transiently). Automatic (short cron) when enabled; `allowDisabled` lets an
// admin trigger a run on demand.
async function sendFitmentMessagesCore({ allowDisabled = false } = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled && !allowDisabled) return { ok: true, skipped: 'disabled', sent: 0 };
  const ebay = require('./ebay');
  if (!ebay.isConfigured()) return { ok: false, error: 'ebay_not_configured', sent: 0 };

  const { rows } = await query(
    `SELECT id, external_order_id, channel FROM sales ${eligibleWhere()} ORDER BY occurred_at ASC LIMIT $3`,
    [String(cfg.windowDays), String(cfg.delayHours), cfg.maxPerRun]
  );
  let sent = 0, skipped = 0, failed = 0;
  const results = [];
  for (const sale of rows) {
    const r = await sendOneSale(sale, cfg);
    if (r.ok) sent++; else if (r.error) failed++; else skipped++;
    results.push(r);
    await _sleep(1200);   // gentle throttle — eBay member-message rate limits
  }
  return { ok: true, sent, skipped, failed, considered: rows.length, results };
}

// Clear the at-most-once stamp on orders that were skipped/errored but NEVER
// actually sent, so they become eligible again (e.g. after fixing the ItemID
// lookup or linking listings). Never touches rows that were genuinely 'sent'.
async function resetUnsent() {
  await ensureColumns();
  const r = await query(
    `UPDATE sales SET fitment_msg_sent_at = NULL, fitment_msg_status = NULL, fitment_msg_error = NULL
      WHERE channel LIKE 'ebay_%' AND fitment_msg_sent_at IS NOT NULL
        AND fitment_msg_status IS DISTINCT FROM 'sent'`);
  return r.rowCount || 0;
}

module.exports = {
  ensureColumns, getConfig, saveConfig, countEligible,
  sendFitmentMessagesCore, sendForSale, resetUnsent,
  DEFAULT_SUBJECT, DEFAULT_BODY,
};
