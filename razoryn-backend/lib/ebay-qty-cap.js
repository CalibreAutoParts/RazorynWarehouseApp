// lib/ebay-qty-cap.js — per-eBay-account "show at most N" quantity cap.
//
// New / limited eBay accounts have monthly selling limits (e.g. 25 items and
// £523 a month). Listing the full warehouse stock burns that allowance on a few
// products. With a cap set, every quantity sent to that account (new listings,
// stock pushes, edits, cross-listing) is clamped to min(warehouse stock, cap),
// so the allowance stretches across as many different products as possible.
//
// The warehouse quantity itself is NEVER changed by the cap — it stays the real
// count. After a sale the normal stock push tops the listing back up to the cap
// while warehouse stock remains.
//
// Stored in app_settings.data.ebayQtyCaps = { <storeCode>: <int ≥ 1> }.

const { query } = require('../db');

let _cache = null, _cacheAt = 0;
const TTL_MS = 60 * 1000;

async function getCaps() {
  if (_cache && Date.now() - _cacheAt < TTL_MS) return _cache;
  try {
    const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
    const raw = (rows[0]?.data && rows[0].data.ebayQtyCaps) || {};
    const out = {};
    for (const [code, v] of Object.entries(raw)) {
      const n = parseInt(v);
      if (Number.isFinite(n) && n >= 1) out[code] = n;
    }
    _cache = out;
  } catch (_) { _cache = _cache || {}; }
  _cacheAt = Date.now();
  return _cache;
}

async function capFor(storeCode) {
  if (!storeCode) return null;
  return (await getCaps())[storeCode] || null;
}

// qty → the quantity eBay should show on this store.
async function applyCap(qty, storeCode) {
  const q = Math.max(0, parseInt(qty) || 0);
  const cap = await capFor(storeCode);
  return cap ? Math.min(q, cap) : q;
}

// caps: { storeCode: int | null } — null / 0 / '' removes the cap.
async function saveCaps(caps = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.ebayQtyCaps || {}) };
  for (const [code, v] of Object.entries(caps)) {
    const n = parseInt(v);
    if (Number.isFinite(n) && n >= 1) next[code] = Math.min(n, 9999);
    else delete next[code];
  }
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, ebayQtyCaps: next })]);
  _cache = null;
  return getCaps();
}

module.exports = { getCaps, capFor, applyCap, saveCaps };
