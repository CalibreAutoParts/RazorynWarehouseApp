// services/dropfleet.js — push warehouse orders into DropFleet's "Integrated
// Orders" ingest endpoint.
//
// DropFleet is a URL-tracked courier we use (numbers start "DFDX"). Their API
// accepts "potential orders" (address + name + postcode); the pushed order lands
// in their admin Integrated Orders tab where a human reviews it and either books
// it into DropFleet (one click, which generates the real tracking number and
// booking email) or dismisses it. So we send an order once it's ready to be
// considered for DropFleet delivery — re-sending the same external_id updates the
// pending order instead of duplicating it.
//
// Spec: POST https://www.dropfleet.co.uk/api/integrations/ingest
//   Headers: Content-Type: application/json, X-Integration-Key: dfk_…
//   Body:    { "orders": [ {…}, {…} ] }
//   200 → { ok:true, ingested:N };  401 → bad/disabled key;  500 → retry.

const axios = require('axios');
const { query } = require('../db');
const { isGspExport } = require('../lib/uk-vat');

const INGEST_URL = 'https://www.dropfleet.co.uk/api/integrations/ingest';
const WITHDRAW_URL = 'https://www.dropfleet.co.uk/api/integrations/withdraw';
const GSP_HUB_POSTCODE = 'WS13 8UR';

let _migrated = false;
async function ensureConfigColumn() {
  if (_migrated) return;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS dropfleet_api_key TEXT`);
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    // Stamp set when an order has been accepted by DropFleet, so staff can see
    // what's already gone over and we can badge it in the Dispatch worklist.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS dropfleet_pushed_at TIMESTAMPTZ`);
    _migrated = true;
  } catch (e) {
    console.warn('[dropfleet] migration warning:', e.message);
  }
}

// Read stored config. The secret key lives in its own column; the non-secret
// toggles live in app_settings.data.dropfleet (JSONB) so we don't add a column
// per option.
async function getConfig() {
  await ensureConfigColumn();
  const { rows } = await query(`SELECT dropfleet_api_key, data FROM app_settings WHERE id = 1`);
  const row = rows[0] || {};
  const opts = (row.data && row.data.dropfleet) || {};
  return {
    apiKey: row.dropfleet_api_key || '',
    enabled: !!opts.enabled,
    autoPush: !!opts.autoPush,
    defaultCarrier: opts.defaultCarrier || '',
    defaultService: opts.defaultService || '',
  };
}

// Persist a partial config update. The API key is only touched when `apiKey` is
// supplied (a non-empty value sets it; an explicit empty string clears it) so
// saving the toggles never wipes the stored key.
async function saveConfig(patch = {}) {
  await ensureConfigColumn();
  const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
  const data = rows[0]?.data || {};
  const next = { ...(data.dropfleet || {}) };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.autoPush !== undefined) next.autoPush = !!patch.autoPush;
  if (patch.defaultCarrier !== undefined) next.defaultCarrier = String(patch.defaultCarrier || '').trim();
  if (patch.defaultService !== undefined) next.defaultService = String(patch.defaultService || '').trim();
  data.dropfleet = next;
  if (patch.apiKey !== undefined) {
    const key = String(patch.apiKey || '').trim();
    await query(`UPDATE app_settings SET dropfleet_api_key = $1, data = $2::jsonb, updated_at = now() WHERE id = 1`,
      [key || null, JSON.stringify(data)]);
  } else {
    await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
      [JSON.stringify(data)]);
  }
  return getConfig();
}

// UK postcode matcher — case-insensitive, tolerant of a missing space.
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const _codeKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// Pull recipient name, street lines and postcode out of the stored multi-line
// shipping_address. Mirrors the invoice logic: the first cleaned line is the
// recipient's real name (eBay/Shopify put the name on line 1), the rest is the
// address, and the postcode is detected anywhere in the block.
function parseAddress(sale) {
  const raw = (sale.shipping_address || '').trim();
  const lines = raw.split('\n').map(l => l.trim())
    .filter(l => l && !/^ebay[a-z0-9]{4,}$/i.test(l) && !/^(GB|UK|GBR|United Kingdom)$/i.test(l));
  let postcode = '';
  const m = raw.match(UK_POSTCODE_RE);
  if (m) postcode = (m[1] + ' ' + m[2]).toUpperCase();

  // Recipient name. When a real customer_name is on the sale (manual/Shopify),
  // use it — the address block is then pure street lines. When customer_name is
  // an eBay username (or missing), the real name is the first address line, so
  // take that as the recipient and start the street on the next line.
  const nameIsReal = sale.customer_name && !/^ebay[a-z0-9]{4,}$/i.test(sale.customer_name);
  let recipient, streetSource;
  if (nameIsReal) {
    recipient = sale.customer_name;
    // Skip a leading address line that just repeats the name.
    streetSource = (lines[0] && _codeKey(lines[0]) === _codeKey(recipient)) ? lines.slice(1) : lines;
  } else {
    recipient = lines[0] || sale.customer_name || '';
    streetSource = lines.slice(1);
  }
  // Drop any line that is only the postcode.
  const streetLines = streetSource.filter(l => !(postcode && _codeKey(l) === _codeKey(postcode)));
  return { recipient, streetLines, postcode };
}

// Normalise the internal sales.channel (shopify | ebay_em | ebay_cl |
// direct_cash | direct_bank) to the clean channel tag DropFleet expects.
function channelTag(sale) {
  const c = String(sale.channel || '').toLowerCase();
  if (c.startsWith('ebay')) return 'ebay';
  if (c === 'shopify') return 'shopify';
  if (c === 'direct_cash' || c === 'direct_bank') return 'direct';
  return c || undefined;
}

// Pull the eBay Global Shipping REFERENCE number out of a GSP address block.
// The hub sorts by this number (NOT the seller's order id). eBay embeds it in
// the hub address, either labelled ("Reference: 1234567890") or as a bare long
// numeric token. We deliberately avoid the eBay order id, which is hyphenated
// (e.g. 12-34567-89012). Returns the reference string, or '' if none is found —
// in which case the caller leaves order_ref empty and sends the full address so
// DropFleet can salvage the reference itself.
function extractGspReference(shippingAddress) {
  const raw = String(shippingAddress || '');
  const labelled = raw.match(/\b(?:ref(?:erence)?|gsp)\s*(?:no\.?|number|#|:)?\s*([A-Z0-9]{6,})\b/i);
  if (labelled) return labelled[1].toUpperCase();
  // A bare contiguous 9–16 digit token (no hyphens ⇒ not the eBay order id),
  // that isn't the postcode.
  for (const tok of raw.split(/[\s,]+/)) {
    if (/^\d{9,16}$/.test(tok)) return tok;
  }
  return '';
}

// Map one sale (+ its items) to a DropFleet order object. GSP (eBay Global
// Shipping) exports are special-cased per the DropFleet GSP spec: the physical
// destination is always the hub (WS13 8UR), the reference — NOT the eBay order
// id — is what the hub sorts by, and a street address is optional.
function mapSaleToOrder(sale, items = [], cfg = {}) {
  const { recipient, streetLines, postcode } = parseAddress(sale);
  const gsp = isGspExport(sale.shipping_address);
  const description = (items || [])
    .map(i => (Number(i.qty) > 1 ? `${i.qty}× ` : '') + (i.title || i.sku || 'item'))
    .join(', ').slice(0, 500);
  const paymentMethod = sale.payment_method
    || (sale.channel === 'direct_cash' ? 'cash' : sale.channel === 'direct_bank' ? 'bank' : undefined);

  // Reference: for GSP, the GSP reference (or empty → DropFleet salvages from the
  // address); NEVER the eBay order id. For everything else, our invoice/order ref.
  const gspRef = gsp ? extractGspReference(sale.shipping_address) : '';
  const orderRef = gsp
    ? (gspRef || undefined)
    : (sale.invoice_number || sale.payment_reference || sale.external_order_id || undefined);

  const order = {
    // Stable, globally-unique key so re-pushing updates rather than duplicates.
    external_id: 'WH-' + sale.id,
    customer_name: recipient || undefined,
    // For GSP send every non-postcode address line (the reference may sit on any
    // of them, and DropFleet ignores the address for delivery but salvages the
    // reference from it). For normal orders send the first three street lines.
    address: streetLines[0] || undefined,
    address_line2: streetLines[1] || undefined,
    address_line3: gsp ? (streetLines.slice(2).join(', ') || undefined) : (streetLines[2] || undefined),
    // The hub postcode is the trigger — force it for GSP so a bad parse can't
    // send the buyer's international postcode instead.
    postcode: gsp ? GSP_HUB_POSTCODE : (postcode || undefined),
    customer_phone: sale.customer_phone || undefined,
    customer_email: sale.customer_email || undefined,
    description: description || undefined,
    order_ref: orderRef,
    channel: gsp ? 'ebay' : channelTag(sale),
    payment_method: paymentMethod,
    carrier: sale.carrier || cfg.defaultCarrier || undefined,
    service: cfg.defaultService || undefined,
  };
  // Drop undefined keys so the payload stays clean.
  Object.keys(order).forEach(k => order[k] === undefined && delete order[k]);
  return order;
}

// POST a batch of already-mapped orders. Never throws — returns a result object.
// Retries network errors and 5xx with exponential backoff (up to 3 attempts).
// Retries are safe: DropFleet de-dupes on external_id, so a retry can't create a
// duplicate. A 401 (bad/disabled key) or other 4xx is returned immediately.
async function pushOrders(orders, cfg) {
  cfg = cfg || await getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
  let lastErr = 'failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s
    try {
      const r = await axios.post(INGEST_URL, { orders }, {
        headers: { 'Content-Type': 'application/json', 'X-Integration-Key': cfg.apiKey },
        timeout: 20000,
        validateStatus: () => true,
      });
      if (r.status === 401) return { ok: false, error: 'invalid_key', status: 401 };
      if (r.status === 429 || r.status >= 500) { lastErr = 'server_error_' + r.status; continue; } // rate-limit / server — retry
      if (r.status !== 200) return { ok: false, error: 'http_' + r.status, status: r.status };
      return { ok: true, ingested: Number(r.data?.ingested) || 0, status: 200 };
    } catch (e) {
      lastErr = e.message; // network error — retry
    }
  }
  return { ok: false, error: lastErr };
}

// Load the given sale IDs, map them, and push. Orders missing the required
// name/address/postcode are skipped (reported, not errored).
async function pushSaleIds(saleIds) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
  const ids = [...new Set((saleIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'no_sales' };
  const { rows: sales } = await query(`SELECT * FROM sales WHERE id = ANY($1::int[])`, [ids]);
  const { rows: items } = await query(`SELECT * FROM sale_items WHERE sale_id = ANY($1::int[])`, [ids]);
  const byId = new Map();
  for (const it of items) { if (!byId.has(it.sale_id)) byId.set(it.sale_id, []); byId.get(it.sale_id).push(it); }

  const orders = [], pushedIds = [], skipped = [];
  for (const s of sales) {
    const o = mapSaleToOrder(s, byId.get(s.id) || [], cfg);
    // GSP hub parcels only need the trigger postcode (WS13 8UR) — a buyer
    // street address is optional (DropFleet uses the hub label). Everything else
    // needs a name + street + postcode to be deliverable.
    const gsp = isGspExport(s.shipping_address);
    const pushable = gsp ? !!o.postcode : (o.customer_name && o.address && o.postcode);
    if (!pushable) {
      skipped.push({ id: s.id, ref: s.invoice_number || s.payment_reference || ('#' + s.id), reason: gsp ? 'GSP order missing hub postcode' : 'missing name, address or postcode' });
      continue;
    }
    orders.push(o);
    pushedIds.push(s.id);
  }
  if (!orders.length) return { ok: false, error: 'nothing_pushable', skipped };
  const res = await pushOrders(orders, cfg);
  // Stamp only when DropFleet accepted the WHOLE batch — a partial ingest
  // (ingested < attempted) means some orders didn't land, so we must NOT mark
  // them all as pushed (they'd never be retried).
  const fullyIngested = res.ok && (res.ingested == null || res.ingested >= orders.length);
  if (fullyIngested && pushedIds.length) {
    try { await query(`UPDATE sales SET dropfleet_pushed_at = now() WHERE id = ANY($1::int[])`, [pushedIds]); } catch (_) {}
  }
  return { ...res, attempted: orders.length, partial: res.ok && !fullyIngested, skipped };
}

// WHERE clause for the bulk sync — mirrors the Dispatch "to ship" worklist so
// the sync only sends what's genuinely awaiting dispatch:
//   • not an estimate, fulfilment = ship (not cash-on-collection)
//   • NOT already handled: no dispatched_at, no collected_at, and no tracking
//     number (a tracking number means it already shipped — often on the source
//     channel — so it must NOT be pushed to DropFleet again)
//   • status excludes refunded/cancelled/dispatched/preorder
//   • within the recency window (older orders are assumed already shipped on
//     eBay/Shopify before this app's dispatch tracking existed) — this is what
//     the Dispatch page bounds by, so the counts line up
// `$1` is the day window; manualOnly is a static channel clause (no param).
function unshippedWhere(manualOnly) {
  const channelClause = manualOnly ? `AND channel IN ('direct_cash','direct_bank')` : '';
  return `
    WHERE is_estimate = false
      AND dispatched_at IS NULL
      AND collected_at IS NULL
      AND (tracking_number IS NULL OR tracking_number = '')
      AND COALESCE(fulfillment_method, CASE WHEN payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'ship'
      AND status NOT IN ('refunded','cancelled','dispatched','preorder')
      AND NOT (COALESCE(refunded_amount, 0) > 0 AND COALESCE(refunded_amount, 0) >= total - 0.005)
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.sale_id = sales.id)
      AND occurred_at >= now() - ($1 || ' days')::interval
      ${channelClause}`;
}
const _clampDays = (d) => Math.max(1, Math.min(3650, parseInt(d, 10) || 10));

// Bulk-sync the current unshipped delivery backlog into DropFleet, in batches of
// 50. Safe to re-run — the external_id de-dupe means re-sends update the pending
// order, never duplicate.
//   manualOnly: restrict to direct cash/bank sales (exclude eBay/Shopify).
//   days:       recency window (default 10, matching the Dispatch worklist).
const SYNC_HARD_CAP = 5000;   // safety bound; well above any real backlog
async function pushUnshipped({ manualOnly = false, days = 10, allowDisabled = false } = {}) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
  // Respect the integration toggle for the bulk/auto path (a disabled integration
  // must not keep pushing). Explicit callers can override with allowDisabled.
  if (!cfg.enabled && !allowDisabled) return { ok: false, error: 'disabled' };
  const d = _clampDays(days);
  const { rows } = await query(
    `SELECT id FROM sales ${unshippedWhere(manualOnly)} ORDER BY occurred_at ASC LIMIT ${SYNC_HARD_CAP}`,
    [String(d)]
  );
  const ids = rows.map(r => r.id);
  const truncated = ids.length >= SYNC_HARD_CAP;
  if (!ids.length) return { ok: true, ingested: 0, attempted: 0, total: 0, batches: 0, failedBatches: 0, skipped: [], truncated };
  let ingested = 0, attempted = 0, failedBatches = 0;
  const skipped = [];
  let batches = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await pushSaleIds(batch);
    batches++;
    // A key problem aborts the whole run — surface it rather than looping.
    if (r.error === 'not_configured' || r.error === 'invalid_key' || r.error === 'disabled') {
      return { ok: false, error: r.error, ingested, attempted, total: ids.length, batches, failedBatches, skipped };
    }
    if (r.ok) { ingested += r.ingested || 0; attempted += r.attempted || 0; }
    // A transient/server failure (network, 5xx, 429 after retries) dropped this
    // whole batch — count it so the caller never sees a false "all good".
    else if (r.error !== 'nothing_pushable') failedBatches++;
    if (Array.isArray(r.skipped)) skipped.push(...r.skipped);
  }
  // Not "ok" if any batch was lost — the run was incomplete and should be re-run.
  return { ok: failedBatches === 0, error: failedBatches ? 'partial_failure' : undefined, ingested, attempted, total: ids.length, batches, failedBatches, skipped, truncated };
}

// Count how many orders the bulk sync would push (for the confirm dialog).
async function countUnshipped({ manualOnly = false, days = 10 } = {}) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM sales ${unshippedWhere(manualOnly)}`,
    [String(_clampDays(days))]
  );
  return rows[0]?.n || 0;
}

// Validate the stored key without creating anything: an empty batch returns
// 200 {ingested:0} for a valid key, 401 for an invalid/disabled one.
async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
  return pushOrders([], cfg);
}

// Fire-and-forget hook for newly-created MANUAL sales. Only pushes when the
// integration is enabled AND auto-push is on, the sale isn't an estimate, and
// it's going out for delivery (not cash-on-collection). Deliberately NOT wired
// into the eBay/Shopify import firehose — those have their own couriers.
async function autoPushSale(saleId) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.autoPush || !cfg.apiKey) return { ok: false, error: 'auto_off' };
    const { rows } = await query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    const s = rows[0];
    if (!s || s.is_estimate) return { ok: false, error: 'not_eligible' };
    const fm = s.fulfillment_method || (s.payment_method === 'cash' ? 'collect' : 'ship');
    if (fm !== 'ship') return { ok: false, error: 'not_ship' };
    return await pushSaleIds([saleId]);
  } catch (e) {
    console.warn('[dropfleet] autoPushSale failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Diagnostic: what WOULD the bulk sync push, and why. Returns the eligible
// orders bucketed so staff can see (and spot) anything that shouldn't be going to
// DropFleet — e.g. Shopify orders already shipped on-channel, or items with a
// non-DropFleet trackable carrier. Read-only; never sends anything.
async function pendingBreakdown({ manualOnly = false, days = 10 } = {}) {
  const d = _clampDays(days);
  const { rows } = await query(
    `SELECT id, channel, status, occurred_at, payment_method, fulfillment_method,
            carrier, tracking_number, shipping_address, customer_name, total
     FROM sales ${unshippedWhere(manualOnly)} ORDER BY occurred_at ASC LIMIT ${SYNC_HARD_CAP}`,
    [String(d)]
  );
  const byChannel = {}, byCarrier = {};
  let gspCount = 0, withCarrierNoTracking = 0, collectish = 0;
  const samples = [];
  for (const s of rows) {
    const ch = channelTag(s) || 'unknown';
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    const car = (s.carrier || '(none)').trim() || '(none)';
    byCarrier[car] = (byCarrier[car] || 0) + 1;
    if (isGspExport(s.shipping_address)) gspCount++;
    // A carrier is set (staff picked a courier) but no tracking captured yet —
    // often means it went via that trackable courier, not DropFleet.
    if (s.carrier && !s.tracking_number) withCarrierNoTracking++;
    const fm = s.fulfillment_method || (s.payment_method === 'cash' ? 'collect' : 'ship');
    if (fm === 'collect') collectish++;
    if (samples.length < 60) samples.push({
      id: s.id, channel: ch, status: s.status, carrier: s.carrier || null,
      tracking: s.tracking_number || null, fulfillment: fm,
      gsp: isGspExport(s.shipping_address),
      ageDays: Math.floor((Date.now() - new Date(s.occurred_at).getTime()) / 86400000),
      customer: s.customer_name || null,
    });
  }
  return {
    total: rows.length,
    byChannel, byCarrier,
    gspCount, withCarrierNoTracking, collectish,
    samples,
    note: 'These would be pushed by the bulk sync. Shopify rows here that were already fulfilled on Shopify, or rows with a non-DropFleet carrier, are likely over-sends.',
  };
}

// Withdraw-on-tracking: once an order has a real tracking number (it shipped —
// via DropFleet, Proovia, or any trackable courier), re-send it so DropFleet
// marks it shipped and drops it from its pending Integrated Orders list. Safe to
// call repeatedly (external_id de-dupe). No-op if unconfigured.
async function notifyShipped(saleId) {
  try {
    const cfg = await getConfig();
    if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
    const { rows } = await query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    const s = rows[0];
    if (!s) return { ok: false, error: 'not_found' };
    if (!s.tracking_number) return { ok: false, error: 'no_tracking' };
    // Only meaningful for orders we actually sent to DropFleet.
    if (!s.dropfleet_pushed_at) return { ok: false, error: 'not_pushed' };
    const { rows: items } = await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [saleId]);
    const order = mapSaleToOrder(s, items, cfg);
    order.tracking_number = s.tracking_number;
    order.carrier = s.carrier || order.carrier;
    order.status = 'shipped';   // hint for DropFleet to withdraw from pending
    return await pushOrders([order], cfg);
  } catch (e) {
    console.warn('[dropfleet] notifyShipped failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Withdraw orders from DropFleet's Integrated Orders review queue the moment
// they're fulfilled on OUR side — delivered, collected, cancelled, or shipped
// by another courier — so they stop sitting there looking like they still need
// a DropFleet run. Per their spec: POST /api/integrations/withdraw with
// { external_ids: ["WH-<id>", …] }; idempotent, repeats are harmless. Only
// fires for orders we actually pushed (dropfleet_pushed_at set). Best-effort —
// never throws, never blocks the fulfilment that triggered it.
async function withdrawSales(saleIds) {
  try {
    const ids = (Array.isArray(saleIds) ? saleIds : [saleIds]).map(n => parseInt(n)).filter(Number.isFinite);
    if (!ids.length) return { ok: false, error: 'no_ids' };
    const cfg = await getConfig();
    if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
    const { rows } = await query(
      `SELECT id FROM sales WHERE id = ANY($1::int[]) AND dropfleet_pushed_at IS NOT NULL`, [ids]);
    if (!rows.length) return { ok: true, withdrawn: 0, skipped: 'none_pushed' };
    const external_ids = rows.map(r => 'WH-' + r.id);
    const r = await axios.post(WITHDRAW_URL, { external_ids },
      { headers: { 'Content-Type': 'application/json', 'X-Integration-Key': cfg.apiKey }, timeout: 15000 });
    return { ok: true, withdrawn: r.data?.withdrawn ?? external_ids.length };
  } catch (e) {
    console.warn('[dropfleet] withdraw failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  INGEST_URL, getConfig, saveConfig, mapSaleToOrder, parseAddress,
  channelTag, extractGspReference,
  pushOrders, pushSaleIds, testConnection, autoPushSale,
  pushUnshipped, countUnshipped, pendingBreakdown, notifyShipped, withdrawSales,
};
