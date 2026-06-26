// lib/fx.js — foreign-exchange rates for costing (e.g. RMB/CNY → GBP).
//
// Costs are entered in the supplier's currency and converted to GBP at the
// PURCHASE date. Rates come from the free, no-key frankfurter.app API (historical
// by date), are cached in the fx_rates table, and degrade gracefully so a save
// flow NEVER breaks because the API is down: manual override → DB cache → API →
// most-recent cached → throw (caller asks for a manual rate).
const axios = require('axios');
const { query } = require('../db');

let _ready = false;
async function ensureFxTable() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS fx_rates (
      base       TEXT NOT NULL,
      quote      TEXT NOT NULL,
      rate_date  DATE NOT NULL,
      rate       NUMERIC(14,8) NOT NULL,
      source     TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (base, quote, rate_date)
    )`);
    _ready = true;
  } catch (e) { console.warn('[fx] table migration warning:', e.message); }
}
ensureFxTable();

// Process-lifetime memo to avoid hammering the API within a request burst.
const _memo = new Map();

function isoDate(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return new Date().toISOString().slice(0, 10); }
}

async function upsert(base, quote, date, rate, source) {
  try {
    await query(
      `INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (base, quote, rate_date)
       DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
      [base, quote, date, rate, source]);
  } catch (e) { /* cache write is best-effort */ }
}

async function fetchFromApi(base, quote, date) {
  // frankfurter returns the nearest prior business day; we store under the
  // REQUESTED date so later lookups hit cache.
  try {
    const r = await axios.get(`https://api.frankfurter.app/${date}`, { params: { from: base, to: quote }, timeout: 8000 });
    const rate = r.data?.rates?.[quote];
    if (rate) return { rate: Number(rate), source: 'frankfurter' };
  } catch (e) { /* try fallback */ }
  try {
    const r = await axios.get(`https://api.exchangerate.host/${date}`, { params: { base, symbols: quote }, timeout: 8000 });
    const rate = r.data?.rates?.[quote];
    if (rate) return { rate: Number(rate), source: 'exchangerate.host' };
  } catch (e) { /* fall through */ }
  return null;
}

// getRate(from, to, date, { override }) → number (rate so that to = from * rate).
// Throws Error('fx_unavailable') only when nothing — override, cache, API or any
// prior cached rate — can supply a number.
async function getRate(from, to, date, { override } = {}) {
  await ensureFxTable();
  const base = String(from || '').toUpperCase();
  const quote = String(to || 'GBP').toUpperCase();
  const d = isoDate(date);
  if (base === quote) return 1;

  // 1) Manual override wins and is remembered.
  const ovr = parseFloat(override);
  if (!Number.isNaN(ovr) && ovr > 0) { await upsert(base, quote, d, ovr, 'manual'); return ovr; }

  const memoKey = `${base}:${quote}:${d}`;
  if (_memo.has(memoKey)) return _memo.get(memoKey);

  // 2) Exact cached rate for that date.
  try {
    const c = await query(`SELECT rate FROM fx_rates WHERE base=$1 AND quote=$2 AND rate_date=$3`, [base, quote, d]);
    if (c.rows[0]) { const r = Number(c.rows[0].rate); _memo.set(memoKey, r); return r; }
  } catch (_) {}

  // 3) Live API.
  const api = await fetchFromApi(base, quote, d);
  if (api) { await upsert(base, quote, d, api.rate, api.source); _memo.set(memoKey, api.rate); return api.rate; }

  // 4) Most-recent cached rate for the pair (any date).
  try {
    const last = await query(`SELECT rate FROM fx_rates WHERE base=$1 AND quote=$2 ORDER BY rate_date DESC LIMIT 1`, [base, quote]);
    if (last.rows[0]) return Number(last.rows[0].rate);
  } catch (_) {}

  const err = new Error('fx_unavailable');
  err.code = 'fx_unavailable';
  throw err;
}

// convert(amount, from, to, date, opts) → { gbp, rate, source }.
async function convert(amount, from, to, date, opts = {}) {
  const rate = await getRate(from, to, date, opts);
  const a = parseFloat(amount) || 0;
  return { gbp: +(a * rate).toFixed(4), rate, source: opts.override ? 'manual' : 'auto' };
}

module.exports = { getRate, convert, ensureFxTable };
