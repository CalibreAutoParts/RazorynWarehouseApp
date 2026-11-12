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

// ── Top-up level + money kept free (per account) ──────────────────────────
// refillAt:  a listing's quantity is only RAISED again once it has sold down
//            to this many (e.g. cap 15, refill at 3 → shows 15, sells down to
//            3, then goes back up to 15). Lowering always happens straight away.
// reserveGbp: on accounts with monthly selling limits, raising quantities never
//            uses the last £X of the allowance — kept free for new / incoming
//            stock. Stored in app_settings.data.ebayQtyRules = { code: {...} }.
let _rules = null, _rulesAt = 0;
async function getRules() {
  if (_rules && Date.now() - _rulesAt < TTL_MS) return _rules;
  try {
    const raw = ((await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {}).ebayQtyRules || {};
    const out = {};
    for (const [code, r] of Object.entries(raw)) {
      const refillAt = parseInt(r?.refillAt), reserveGbp = parseFloat(r?.reserveGbp);
      out[code] = { refillAt: Number.isFinite(refillAt) && refillAt >= 0 ? refillAt : null, reserveGbp: Number.isFinite(reserveGbp) && reserveGbp > 0 ? reserveGbp : null, tiers: cleanTiers(r?.tiers) };
    }
    _rules = out;
  } catch (_) { _rules = _rules || {}; }
  _rulesAt = Date.now();
  return _rules;
}
// Price bands: dearer parts use more of the monthly £ allowance per unit, so
// "over £X → show at most Y, top up at Z". Highest matching band wins.
function cleanTiers(t) {
  return (Array.isArray(t) ? t : []).map(x => ({
    over: parseFloat(x?.over), max: parseInt(x?.max), refillAt: x?.refillAt === '' || x?.refillAt == null ? null : parseInt(x.refillAt),
  })).filter(x => Number.isFinite(x.over) && x.over >= 0 && Number.isFinite(x.max) && x.max >= 1)
    .map(x => ({ ...x, refillAt: Number.isFinite(x.refillAt) && x.refillAt >= 0 && x.refillAt < x.max ? x.refillAt : null }))
    .sort((a, b) => a.over - b.over).slice(0, 5);
}
function tierFor(rules, price) {
  const p = parseFloat(price);
  if (!rules || !Array.isArray(rules.tiers) || !Number.isFinite(p)) return null;
  return [...rules.tiers].reverse().find(t => p > t.over) || null;
}
async function rulesFor(storeCode) { return (storeCode && (await getRules())[storeCode]) || { refillAt: null, reserveGbp: null, tiers: [] }; }
async function saveRules(rules = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.ebayQtyRules || {}) };
  for (const [code, r] of Object.entries(rules)) {
    if (!r) { delete next[code]; continue; }
    const refillAt = r.refillAt === '' || r.refillAt == null ? null : parseInt(r.refillAt);
    const reserveGbp = r.reserveGbp === '' || r.reserveGbp == null ? null : parseFloat(r.reserveGbp);
    next[code] = { refillAt: Number.isFinite(refillAt) && refillAt >= 0 ? refillAt : null, reserveGbp: Number.isFinite(reserveGbp) && reserveGbp > 0 ? reserveGbp : null,
      tiers: r.tiers !== undefined ? cleanTiers(r.tiers) : ((cur.ebayQtyRules || {})[code]?.tiers || []) };
  }
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify({ ...cur, ebayQtyRules: next })]);
  _rules = null;
  return getRules();
}

module.exports = { getCaps, capFor, applyCap, saveCaps, getRules, rulesFor, saveRules, tierFor };
