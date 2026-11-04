// lib/store-vat.js — per-eBay-shop business setup.
//
// Each eBay account can be run by a different business: a VAT-registered
// limited company, or a sole trader who isn't VAT registered. A shop's profile
// says what that means everywhere:
//   • VAT — not registered (from the "since" date): imported orders carry no
//     VAT, new listings are created without VATDetails, invoices drop the VAT
//     lines / VAT number / company-reg wording. Earlier orders keep their VAT.
//   • Invoices — the shop's own trading name instead of the company name.
//   • Listing branding — the eBay description shows the company logo + name,
//     or the shop's own name with no company logo.
//   • Photos — the branded listing photos, or clean (unbranded) photos where
//     we have them (Trade → Settings → Clean photos).
//   • Display name — what the shop is called across the app.
//
// Stored in app_settings.data:
//   storeVat     = { <code>: { vatOff, since, tradingName } }      (VAT, unchanged shape)
//   shopProfiles = { <code>: { displayName, businessType, listingBranding, photos } }

const { query } = require('../db');

let _cache = null, _cacheAt = 0;

function isoDay(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function _load() {
  if (_cache && Date.now() - _cacheAt < 60 * 1000) return _cache;
  try {
    const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
    const d = rows[0]?.data || {};
    _cache = { vat: d.storeVat || {}, profiles: d.shopProfiles || {} };
  } catch (_) { _cache = _cache || { vat: {}, profiles: {} }; }
  _cacheAt = Date.now();
  return _cache;
}
async function getAll() { return (await _load()).vat; }

// Full profile for one shop, with sensible defaults by business type.
async function getProfile(storeCode) {
  const { vat, profiles } = await _load();
  const v = vat[storeCode] || {};
  const p = profiles[storeCode] || {};
  const businessType = p.businessType || (v.vatOff ? 'sole_trader' : 'company');
  return {
    code: storeCode,
    displayName: p.displayName || null,
    businessType,
    vatOff: !!v.vatOff,
    since: v.since || null,
    tradingName: v.tradingName || null,
    listingBranding: p.listingBranding || (businessType === 'sole_trader' ? 'shop' : 'company'),
    photos: p.photos || 'branded',
  };
}

// Is VAT switched off for this shop on this date? (no date → today)
async function vatOffFor(storeCode, when) {
  if (!storeCode) return false;
  const c = (await getAll())[storeCode];
  if (!c || !c.vatOff) return false;
  const day = isoDay(when) || isoDay(new Date());
  return !c.since || day >= c.since;
}

function storeForChannel(channel) {
  const brand = require('./brand');
  const s = (brand.stores || []).find(x => x.channelCode === channel);
  return s ? s.code : null;
}

async function saleVatOff(sale) {
  if (!sale || !String(sale.channel || '').startsWith('ebay')) return false;
  return vatOffFor(storeForChannel(sale.channel), sale.occurred_at);
}

// Company block to print on this sale's invoice.
async function companyForSale(sale, company) {
  if (!sale || !String(sale.channel || '').startsWith('ebay')) return company;
  const code = storeForChannel(sale.channel);
  const prof = await getProfile(code);
  const off = await saleVatOff(sale);
  if (!off && !(prof.businessType === 'sole_trader' && prof.tradingName)) return company;
  return {
    ...company,
    ...(off ? { vat_registered: false, vat_number: null } : {}),
    // A sole trader isn't the limited company — never print its reg number.
    ...(off || prof.businessType === 'sole_trader' ? { company_reg_no: null } : {}),
    company_name: prof.tradingName || company.company_name,
  };
}

// VAT patch: { storeCode: { vatOff, since, tradingName } }
async function save(patch = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.storeVat || {}) };
  for (const [code, v] of Object.entries(patch)) {
    const tradingName = String((v && v.tradingName) || '').trim().slice(0, 120) || null;
    if (!v || !v.vatOff) {
      // VAT on — keep only an invoice name if one was given.
      if (tradingName) next[code] = { vatOff: false, since: null, tradingName }; else delete next[code];
      continue;
    }
    next[code] = { vatOff: true, since: isoDay(v.since) || isoDay(new Date()), tradingName };
  }
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, storeVat: next })]);
  _cache = null;
  return getAll();
}

// Profile patch for one shop (everything except VAT, which goes through save()).
async function saveProfile(storeCode, patch = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const all = { ...(cur.shopProfiles || {}) };
  const p = { ...(all[storeCode] || {}) };
  if (patch.displayName !== undefined) p.displayName = String(patch.displayName || '').trim().slice(0, 60) || null;
  if (['company', 'sole_trader'].includes(patch.businessType)) p.businessType = patch.businessType;
  if (['company', 'shop'].includes(patch.listingBranding)) p.listingBranding = patch.listingBranding;
  if (['branded', 'clean'].includes(patch.photos)) p.photos = patch.photos;
  all[storeCode] = p;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, shopProfiles: all })]);
  _cache = null;
  await applyNames();
  return getProfile(storeCode);
}

// Shop names set in the app override the code / env defaults (brand.stores is
// the live object every module reads).
const _defaultNames = {};
async function applyNames() {
  const brand = require('./brand');
  const { profiles } = await _load();
  for (const s of brand.stores || []) {
    if (!(s.code in _defaultNames)) _defaultNames[s.code] = s.name;
    s.name = (profiles[s.code] && profiles[s.code].displayName) || _defaultNames[s.code];
  }
}

// Shop on/off + main shop (app_settings.data.ebayShops = { disabled: [codes], main: code }).
async function getShopState() {
  const { query } = require('../db');
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const st = d.ebayShops || {};
  return { disabled: Array.isArray(st.disabled) ? st.disabled : [], main: st.main || null };
}
async function saveShopState(patch = {}) {
  const { query } = require('../db');
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const st = { ...(await getShopState()) };
  if (Array.isArray(patch.disabled)) st.disabled = [...new Set(patch.disabled.map(String))];
  if ('main' in patch) st.main = patch.main ? String(patch.main) : null;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify({ ...cur, ebayShops: st })]);
  require('./brand').applyShopState(st);
  return st;
}
async function applyShopState() { require('./brand').applyShopState(await getShopState()); }

module.exports = { getAll, getProfile, vatOffFor, storeForChannel, saleVatOff, companyForSale, save, saveProfile, applyNames, getShopState, saveShopState, applyShopState };
