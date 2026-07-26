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

const INGEST_URL = 'https://www.dropfleet.co.uk/api/integrations/ingest';

let _migrated = false;
async function ensureConfigColumn() {
  if (_migrated) return;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS dropfleet_api_key TEXT`);
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
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

// Map one sale (+ its items) to a DropFleet order object.
function mapSaleToOrder(sale, items = [], cfg = {}) {
  const { recipient, streetLines, postcode } = parseAddress(sale);
  const description = (items || [])
    .map(i => (Number(i.qty) > 1 ? `${i.qty}× ` : '') + (i.title || i.sku || 'item'))
    .join(', ').slice(0, 500);
  const paymentMethod = sale.payment_method
    || (sale.channel === 'direct_cash' ? 'cash' : sale.channel === 'direct_bank' ? 'bank' : undefined);
  const order = {
    // Stable, globally-unique key so re-pushing updates rather than duplicates.
    external_id: 'WH-' + sale.id,
    customer_name: recipient || undefined,
    address: streetLines[0] || undefined,
    address_line2: streetLines[1] || undefined,
    address_line3: streetLines[2] || undefined,
    postcode: postcode || undefined,
    customer_phone: sale.customer_phone || undefined,
    customer_email: sale.customer_email || undefined,
    description: description || undefined,
    order_ref: sale.invoice_number || sale.payment_reference || sale.external_order_id || undefined,
    payment_method: paymentMethod,
    carrier: sale.carrier || cfg.defaultCarrier || undefined,
    service: cfg.defaultService || undefined,
  };
  // Drop undefined keys so the payload stays clean.
  Object.keys(order).forEach(k => order[k] === undefined && delete order[k]);
  return order;
}

// POST a batch of already-mapped orders. Never throws — returns a result object.
async function pushOrders(orders, cfg) {
  cfg = cfg || await getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'not_configured' };
  try {
    const r = await axios.post(INGEST_URL, { orders }, {
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': cfg.apiKey },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (r.status === 401) return { ok: false, error: 'invalid_key', status: 401 };
    if (r.status >= 500)  return { ok: false, error: 'server_error', status: r.status };
    if (r.status !== 200) return { ok: false, error: 'http_' + r.status, status: r.status };
    return { ok: true, ingested: Number(r.data?.ingested) || 0, status: 200 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

  const orders = [], skipped = [];
  for (const s of sales) {
    const o = mapSaleToOrder(s, byId.get(s.id) || [], cfg);
    if (!o.customer_name || !o.address || !o.postcode) {
      skipped.push({ id: s.id, ref: s.invoice_number || s.payment_reference || ('#' + s.id), reason: 'missing name, address or postcode' });
      continue;
    }
    orders.push(o);
  }
  if (!orders.length) return { ok: false, error: 'nothing_pushable', skipped };
  const res = await pushOrders(orders, cfg);
  return { ...res, attempted: orders.length, skipped };
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

module.exports = {
  INGEST_URL, getConfig, saveConfig, mapSaleToOrder, parseAddress,
  pushOrders, pushSaleIds, testConnection, autoPushSale,
};
