// lib/push-queue.js — the paper trail + retry queue for LIVE listing changes.
//
// 1. listing_changes — every change pushed to a listing (price, title, SKU,
//    specifics, photos, category, part number…) is logged with before → after,
//    who/what pushed it (source) and whether eBay accepted it. This is the
//    per-item breakdown the Push Queue page shows.
// 2. pending_pushes — eBay REFUSES revisions while a listing has an open
//    best offer (sent or received) and on some transient errors. Those pushes
//    land here instead of vanishing: the payload is kept (merged per item as
//    more changes stack up) and a 12-hour background retry keeps trying until
//    eBay accepts. The Push Queue page lists what's stuck and why.
const { query } = require('../db');

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS listing_changes (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER,
      ebay_item_id TEXT,
      store_code   TEXT,
      source       TEXT,
      field        TEXT NOT NULL,
      before       JSONB,
      after        JSONB,
      ok           BOOLEAN NOT NULL DEFAULT true,
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS listing_changes_item_idx ON listing_changes (ebay_item_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS listing_changes_product_idx ON listing_changes (product_id, created_at DESC)`);
    await query(`CREATE TABLE IF NOT EXISTS pending_pushes (
      id              SERIAL PRIMARY KEY,
      product_id      INTEGER,
      ebay_item_id    TEXT NOT NULL,
      store_code      TEXT,
      payload         JSONB NOT NULL,
      reason          TEXT,
      source          TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      last_error      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS pending_pushes_item_uq ON pending_pushes (ebay_item_id) WHERE status = 'pending'`);
    _ready = true;
  } catch (e) { console.warn('[push-queue] migration:', e.message); }
}

// Errors worth retrying later — an open best offer / bids block revisions
// entirely, and transient eBay hiccups clear on their own. Anything else
// (invalid value, listing ended…) is permanent and NOT queued.
const RETRYABLE = /offer|bid|auction|try again|temporar|timeout|timed out|internal error|busy|unavailable|cannot be (accessed|revised|changed) right now|exceeded.*rate/i;
function isRetryable(message) { return RETRYABLE.test(String(message || '')); }

async function logChange({ productId, ebayItemId, storeCode, source, field, before, after, ok = true, error = null }) {
  await ensureTables();
  try {
    await query(
      `INSERT INTO listing_changes (product_id, ebay_item_id, store_code, source, field, before, after, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
      [productId || null, ebayItemId ? String(ebayItemId) : null, storeCode || null, source || null, field,
       before !== undefined ? JSON.stringify(before) : null, after !== undefined ? JSON.stringify(after) : null,
       ok, error ? String(error).slice(0, 500) : null]);
  } catch (e) { console.warn('[push-queue] logChange:', e.message); }
}

// Queue (or merge into) the pending push for an item. Later payloads override
// earlier fields — if a price change queued and then a title change queues,
// the one retry carries both.
async function queuePush({ productId, ebayItemId, storeCode, payload, reason, source }) {
  await ensureTables();
  try {
    const existing = await query(`SELECT id, payload FROM pending_pushes WHERE ebay_item_id = $1 AND status = 'pending' LIMIT 1`, [String(ebayItemId)]);
    if (existing.rows[0]) {
      const merged = { ...(existing.rows[0].payload || {}), ...payload };
      await query(`UPDATE pending_pushes SET payload = $2::jsonb, reason = COALESCE($3, reason), source = COALESCE($4, source), updated_at = now() WHERE id = $1`,
        [existing.rows[0].id, JSON.stringify(merged), reason || null, source || null]);
      return existing.rows[0].id;
    }
    const r = await query(
      `INSERT INTO pending_pushes (product_id, ebay_item_id, store_code, payload, reason, source)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
      [productId || null, String(ebayItemId), storeCode || null, JSON.stringify(payload || {}), reason || null, source || null]);
    return r.rows[0].id;
  } catch (e) { console.warn('[push-queue] queuePush:', e.message); return null; }
}

// The one revise entry point that (a) logs the change with before → after,
// (b) queues retryable failures instead of losing them. Returns
// { ok } | { ok:false, queued:true, error } — it only THROWS on permanent
// failures, so callers can show "queued for retry" instead of a hard error.
// meta: { productId, source, changes: [{field, before, after}] }
async function revisePush(itemId, opts, storeArg, meta = {}) {
  const ebay = require('../services/ebay');
  const changes = Array.isArray(meta.changes) && meta.changes.length
    ? meta.changes
    : [{ field: Object.keys(opts).filter(k => opts[k] !== undefined && k !== 'call').join('+') || 'listing', before: undefined, after: undefined }];
  const storeCode = typeof storeArg === 'string' ? storeArg : (storeArg && storeArg.code) || null;
  try {
    const r = await ebay.reviseItem(itemId, opts, storeArg);
    for (const c of changes) {
      await logChange({ productId: meta.productId, ebayItemId: itemId, storeCode, source: meta.source, field: c.field, before: c.before, after: c.after, ok: true });
    }
    return { ok: true, warnings: r.warnings };
  } catch (e) {
    const retry = isRetryable(e.message);
    for (const c of changes) {
      await logChange({ productId: meta.productId, ebayItemId: itemId, storeCode, source: meta.source, field: c.field, before: c.before, after: c.after, ok: false, error: e.message + (retry ? ' — queued for retry' : '') });
    }
    if (retry) {
      await queuePush({ productId: meta.productId, ebayItemId: itemId, storeCode, payload: opts, reason: e.message, source: meta.source });
      return { ok: false, queued: true, error: e.message };
    }
    throw e;
  }
}

const MAX_ATTEMPTS = 30;   // ~2 weeks at 12h — offers rarely sit open longer

// Retry every pending push (the 12-hour cron + the Retry-now button).
async function retryPending({ onlyId } = {}) {
  await ensureTables();
  const ebay = require('../services/ebay');
  const params = [];
  let where = `status = 'pending'`;
  if (onlyId) { params.push(onlyId); where += ` AND id = $${params.length}`; }
  const { rows } = await query(`SELECT * FROM pending_pushes WHERE ${where} ORDER BY created_at`, params);
  const out = { tried: rows.length, ok: 0, stillBlocked: 0, gaveUp: 0, failed: 0 };
  for (const row of rows) {
    try {
      const r = await ebay.reviseItem(row.ebay_item_id, row.payload || {}, row.store_code);
      await query(`UPDATE pending_pushes SET status = 'done', attempts = attempts + 1, last_attempt_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
      await logChange({ productId: row.product_id, ebayItemId: row.ebay_item_id, storeCode: row.store_code, source: 'retry', field: Object.keys(row.payload || {}).filter(k => k !== 'call').join('+') || 'listing', after: row.payload, ok: true });
      out.ok++;
      void r;
    } catch (e) {
      const retry = isRetryable(e.message);
      const attempts = (row.attempts || 0) + 1;
      const giveUp = !retry || attempts >= MAX_ATTEMPTS;
      await query(`UPDATE pending_pushes SET status = $2, attempts = $3, last_attempt_at = now(), last_error = $4, updated_at = now() WHERE id = $1`,
        [row.id, giveUp ? 'given_up' : 'pending', attempts, String(e.message).slice(0, 500)]);
      if (giveUp) { out.gaveUp++; await logChange({ productId: row.product_id, ebayItemId: row.ebay_item_id, storeCode: row.store_code, source: 'retry', field: 'listing', ok: false, error: 'gave up after ' + attempts + ' attempts: ' + e.message }); }
      else if (retry) out.stillBlocked++;
      else out.failed++;
    }
    await new Promise(r2 => setTimeout(r2, 400));
  }
  return out;
}

module.exports = { ensureTables, logChange, queuePush, revisePush, retryPending, isRetryable };
