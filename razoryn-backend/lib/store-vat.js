// lib/store-vat.js — per-eBay-shop VAT switch.
//
// A shop can be run by a different, non-VAT-registered business (e.g. a sole
// trader account replacing a Ltd account). For such a shop, from its "since"
// date onwards:
//   • imported orders carry no VAT (sales.vat = 0),
//   • new eBay listings are created without VATDetails,
//   • invoices drop the VAT lines, VAT number and company-reg wording, and show
//     the shop's own trading name when one is set.
// Orders before the since date keep the treatment they had, so switching a shop
// over doesn't rewrite history.
//
// Stored in app_settings.data.storeVat = { <storeCode>: { vatOff, since, tradingName } }.

const { query } = require('../db');

let _cache = null, _cacheAt = 0;

function isoDay(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function getAll() {
  if (_cache && Date.now() - _cacheAt < 60 * 1000) return _cache;
  try {
    const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
    _cache = (rows[0]?.data && rows[0].data.storeVat) || {};
  } catch (_) { _cache = _cache || {}; }
  _cacheAt = Date.now();
  return _cache;
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
  if (!(await saleVatOff(sale))) return company;
  const c = (await getAll())[storeForChannel(sale.channel)] || {};
  return {
    ...company,
    vat_registered: false,
    vat_number: null,
    company_reg_no: null,
    company_name: c.tradingName || company.company_name,
  };
}

// patch: { storeCode: { vatOff, since, tradingName } }
async function save(patch = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...(cur.storeVat || {}) };
  for (const [code, v] of Object.entries(patch)) {
    if (!v || !v.vatOff) { delete next[code]; continue; }
    next[code] = {
      vatOff: true,
      since: isoDay(v.since) || isoDay(new Date()),
      tradingName: String(v.tradingName || '').trim().slice(0, 120) || null,
    };
  }
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, storeVat: next })]);
  _cache = null;
  return getAll();
}

module.exports = { getAll, vatOffFor, storeForChannel, saleVatOff, companyForSale, save };
