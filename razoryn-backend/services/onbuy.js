// services/onbuy.js — OnBuy (OnCommerce) Seller API v2 client.
//
// Credentials live in Railway env vars (like the eBay tokens):
//   ONBUY_CONSUMER_KEY, ONBUY_SECRET_KEY   — from Seller Control Panel →
//     Inventory → Integrations → OnBuy API (Test keys while integrating,
//     Live keys to go live — the same URL serves both).
//   ONBUY_SITE_ID                         — default 2000 (OnBuy UK).
//
// Auth: POST /v2/auth/request-token (form: secret_key, consumer_key) returns an
// access_token valid for 15 minutes, tied to the calling IP. It is sent as the
// raw `Authorization` header on every other call.
// Reference: https://docs.api.onbuy.com/ (OnCommerce API v2).

const axios = require('axios');

const BASE = 'https://api.onbuy.com/v2';
const SITE_ID = parseInt(process.env.ONBUY_SITE_ID || '2000', 10) || 2000;

function isConfigured() {
  return !!(process.env.ONBUY_CONSUMER_KEY && process.env.ONBUY_SECRET_KEY);
}

let _token = null, _tokenExp = 0;
async function token(force = false) {
  if (!isConfigured()) { const e = new Error('onbuy_not_configured'); e.code = 'onbuy_not_configured'; throw e; }
  if (!force && _token && Date.now() < _tokenExp) return _token;
  const r = await axios.post(`${BASE}/auth/request-token`,
    new URLSearchParams({ secret_key: process.env.ONBUY_SECRET_KEY, consumer_key: process.env.ONBUY_CONSUMER_KEY }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
  _token = r.data?.access_token;
  if (!_token) throw new Error('OnBuy returned no access token');
  // Refresh a couple of minutes early (tokens last 15 min).
  const exp = r.data?.expires_at ? Number(r.data.expires_at) * 1000 : Date.now() + 15 * 60 * 1000;
  _tokenExp = Math.min(exp, Date.now() + 15 * 60 * 1000) - 2 * 60 * 1000;
  return _token;
}

function errMessage(e) {
  const d = e.response?.data;
  const m = d?.error?.message || d?.message || (Array.isArray(d?.errors) ? d.errors.map(x => x.message || x).join('; ') : null)
    || (typeof d === 'string' ? d.slice(0, 300) : null);
  return m ? `OnBuy ${e.response?.status || ''}: ${m}` : e.message;
}

// params → OnBuy's bracket query style (filter[status]=…).
function qs(params = {}) {
  const sp = new URLSearchParams();
  const add = (k, v) => {
    if (v == null || v === '') return;
    if (typeof v === 'object' && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v)) add(`${k}[${k2}]`, v2); }
    else if (Array.isArray(v)) v.forEach(x => sp.append(k, x));
    else sp.append(k, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return sp.toString();
}

async function call(method, path, { params, body } = {}, retry = true) {
  const t = await token();
  const url = `${BASE}${path}${params ? '?' + qs({ site_id: SITE_ID, ...params }) : ''}`;
  try {
    const r = await axios({ method, url, data: body, timeout: 45000,
      headers: { Authorization: t, 'Content-Type': 'application/json' } });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401 && retry) { await token(true); return call(method, path, { params, body }, false); }
    const err = new Error(errMessage(e));
    err.status = e.response?.status; err.data = e.response?.data;
    throw err;
  }
}

// ── Catalogue + listings ───────────────────────────────────────────────────
// field: 'product_code' (EAN/GTIN) | 'mpn' | 'name' | 'opc'
async function searchProducts(field, value, { limit = 10 } = {}) {
  const d = await call('get', '/products', { params: { filter: { query: value, field }, limit } });
  return Array.isArray(d?.results) ? d.results : [];
}

// Add our listing to an existing catalogue product (OPC).
async function createListing(opc, listing, condition = 'new') {
  return call('post', `/products/${encodeURIComponent(opc)}/listings`, {
    body: { site_id: SITE_ID, listings: { [condition]: listing } } });
}

// Create a new catalogue product (needs an EAN-13 in product_codes); returns a
// queue id — poll queue() for the result / OPC.
async function createProduct(payload) {
  return call('post', '/products', { body: { site_id: SITE_ID, ...payload } });
}
async function queue(queueId) {
  const d = await call('get', `/queues/${encodeURIComponent(queueId)}`, { params: {} });
  return d?.results || d;
}

// Stock + price by SKU, up to 1000 per call (OnBuy's recommendation).
async function updateBySku(listings) {
  const out = [];
  for (let i = 0; i < listings.length; i += 1000) {
    out.push(await call('put', '/listings/by-sku', { body: { site_id: SITE_ID, listings: listings.slice(i, i + 1000) } }));
  }
  return out;
}
async function deleteBySku(skus) {
  return call('delete', '/listings/by-sku', { body: { site_id: SITE_ID, skus } });
}
async function listingsBySku(skus) {
  const d = await call('get', '/listings', { params: { filter: { sku: skus } } });
  return Array.isArray(d?.results) ? d.results : [];
}

// ── Orders ─────────────────────────────────────────────────────────────────
async function getOrders({ status = 'awaiting_dispatch', modifiedSince = null, limit = 50, offset = 0 } = {}) {
  const filter = { status };
  if (modifiedSince) filter.modified_since = modifiedSince;
  const d = await call('get', '/orders', { params: { filter, sort: { modified: 'asc' }, limit, offset } });
  return Array.isArray(d?.results) ? d.results : [];
}
async function dispatchOrder(orderId, { trackingNumber = null, carrier = null, url = null } = {}) {
  const order = { order_id: orderId };
  if (trackingNumber) order.tracking = { supplier_name: carrier || 'Courier', number: trackingNumber, ...(url ? { url } : {}) };
  const d = await call('put', '/orders/dispatch', { body: { site_id: SITE_ID, orders: [order] } });
  const res = d?.results?.[orderId];
  if (res && res.success === false) throw new Error(res.message || 'OnBuy refused the dispatch');
  return d;
}

// ── Account setup lookups ──────────────────────────────────────────────────
async function deliveryTemplates() {
  const d = await call('get', '/sellers/deliveries', { params: { limit: 1000 } });
  const seen = new Map();
  for (const r of d?.results || []) {
    const id = r.seller_delivery_template_id;
    if (id != null && !seen.has(id)) seen.set(id, { id: String(id), name: r.template_name || `Template ${id}`, isDefault: !!r.is_default_template, time: r.delivery_time });
  }
  return [...seen.values()];
}
async function categories(name = '') {
  const d = await call('get', '/categories', { params: { filter: name ? { name } : undefined, limit: 100 } });
  return (d?.results || []).map(c => ({ id: String(c.category_id || c.id), name: c.name, path: c.category_tree || c.tree || null, canList: c.can_list_in }));
}

async function testConnection() {
  await token(true);
  const templates = await deliveryTemplates().catch(e => { throw e; });
  return { ok: true, siteId: SITE_ID, deliveryTemplates: templates.length };
}

module.exports = {
  isConfigured, SITE_ID, call, searchProducts, createListing, createProduct, queue, updateBySku, deleteBySku,
  listingsBySku, getOrders, dispatchOrder, deliveryTemplates, categories, testConnection,
};
