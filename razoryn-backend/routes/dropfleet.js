// routes/dropfleet.js — configure the DropFleet integration and push orders
// into DropFleet's Integrated Orders ingest endpoint.
//
// The API key is a secret: it's stored in app_settings.dropfleet_api_key and is
// NEVER returned to the browser (the config endpoint reports only whether a key
// is set + its last 4 chars). See services/dropfleet.js for the mapping/push.

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const df = require('../services/dropfleet');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────
// INBOUND webhook (must be BEFORE requireAuth — DropFleet is not a logged-in
// user). DropFleet calls this once it books an order and has a tracking number;
// we save it, mark the order dispatched, and push the tracking to the source
// channel (eBay CompleteSale / Shopify fulfilment) so the buyer is notified.
//
// Auth: DropFleet must send header  X-Integration-Key: <the same key you gave
// DropFleet>  (or set DROPFLEET_WEBHOOK_SECRET and have DropFleet send that).
// Body: { external_id: "WH-<saleId>", tracking_number, carrier?, tracking_url? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/tracking', async (req, res) => {
  try {
    const cfg = await df.getConfig();
    const expected = (process.env.DROPFLEET_WEBHOOK_SECRET || cfg.apiKey || '').trim();
    const provided = String(req.get('X-Integration-Key') || req.body?.key || '').trim();
    if (!expected || !provided || provided !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const b = req.body || {};
    const extId = String(b.external_id || b.externalId || '').trim();
    const tracking = String(b.tracking_number || b.trackingNumber || '').trim();
    const carrier = String(b.carrier || 'Dropfleet').trim() || 'Dropfleet';
    // Optional lifecycle status from DropFleet: 'delivered' (their driver handed
    // it over) or 'collected'. Without one, this is the original "booked, here's
    // the tracking number" event.
    const evStatus = String(b.status || b.event || '').trim().toLowerCase();
    const isDelivered = ['delivered', 'collected', 'completed_delivery'].includes(evStatus);
    if (!extId || (!tracking && !isDelivered)) return res.status(400).json({ error: 'external_id_and_tracking_required' });
    // We key DropFleet orders as WH-<saleId>.
    const m = extId.match(/(?:^|[^0-9])(\d+)\s*$/);
    const saleId = m ? parseInt(m[1]) : NaN;
    if (!Number.isFinite(saleId)) return res.status(400).json({ error: 'bad_external_id', message: `Expected "WH-<id>", got "${extId}"` });

    const dispatch = require('./dispatch');
    if (typeof dispatch.ensureDispatchColumns === 'function') await dispatch.ensureDispatchColumns();

    const sel = await query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    const sale = sel.rows[0];
    if (!sale) return res.status(404).json({ error: 'sale_not_found', saleId });

    // Idempotent: same tracking + already dispatched (and not a new delivered event) → no-op.
    if (!isDelivered && (sale.tracking_number || '').trim() === tracking && sale.dispatched_at) {
      return res.json({ ok: true, saleId, alreadyRecorded: true });
    }

    const when = b.delivered_at ? new Date(b.delivered_at) : new Date();
    const updated = await query(`
      UPDATE sales SET
        tracking_number = COALESCE(NULLIF($1,''), tracking_number),
        carrier = COALESCE(NULLIF($2,''), carrier),
        dispatched_at = COALESCE(dispatched_at, now()),
        status = CASE WHEN status = 'paid' THEN 'dispatched' ELSE status END,
        delivered_at = CASE WHEN $4 THEN COALESCE(delivered_at, $5::timestamptz) ELSE delivered_at END,
        shipping_status = CASE WHEN $4 THEN 'delivered' ELSE shipping_status END,
        channel_push_state = CASE WHEN channel ~ '^(shopify|ebay_)' AND channel_push_state IS DISTINCT FROM 'ok' THEN 'pending' ELSE channel_push_state END,
        channel_push_error = CASE WHEN channel ~ '^(shopify|ebay_)' AND channel_push_state IS DISTINCT FROM 'ok' THEN NULL ELSE channel_push_error END
      WHERE id = $3 RETURNING *`, [tracking, carrier, saleId, isDelivered, when]);
    const s = updated.rows[0];

    // Push the tracking/fulfilment to the source marketplace (best-effort,
    // async) — for a delivered event this also covers orders whose shipped
    // push never happened, so eBay/Shopify get the fulfilment either way.
    if ((s.channel || '').match(/^(shopify|ebay_)/) && s.channel_push_state === 'pending' && s.tracking_number
        && typeof dispatch.pushDispatchToChannel === 'function') {
      setImmediate(() => dispatch.pushDispatchToChannel(s).catch(e => console.warn('[dropfleet.webhook] channel push failed:', e.message)));
    }
    res.json({ ok: true, saleId, event: isDelivered ? 'delivered' : 'tracking', tracking: s.tracking_number, carrier: s.carrier, channel: s.channel, deliveredAt: isDelivered ? s.delivered_at : undefined });
  } catch (e) {
    console.error('[dropfleet.webhook]', e.message);
    res.status(500).json({ error: 'webhook_failed', message: e.message });
  }
});

router.use(requireAuth);

function publicConfig(c) {
  return {
    configured: !!c.apiKey,
    keyLast4: c.apiKey ? c.apiKey.slice(-4) : '',
    enabled: c.enabled,
    autoPush: c.autoPush,
    defaultCarrier: c.defaultCarrier,
    defaultService: c.defaultService,
  };
}

// GET /api/dropfleet/config — never returns the raw key.
router.get('/config', requireAdmin, async (req, res) => {
  try {
    res.json(publicConfig(await df.getConfig()));
  } catch (e) {
    res.status(500).json({ error: 'load_failed', message: e.message });
  }
});

// PUT /api/dropfleet/config { apiKey?, enabled?, autoPush?, defaultCarrier?, defaultService? }
router.put('/config', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['apiKey', 'enabled', 'autoPush', 'defaultCarrier', 'defaultService']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    const c = await df.saveConfig(patch);
    // Never log the key itself.
    await audit(req, 'update_dropfleet_config', null, null, { configured: !!c.apiKey, enabled: c.enabled, autoPush: c.autoPush });
    res.json({ ok: true, ...publicConfig(c) });
  } catch (e) {
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

// POST /api/dropfleet/test — validate the stored key (creates nothing).
router.post('/test', requireAdmin, async (req, res) => {
  try {
    res.json(await df.testConnection());
  } catch (e) {
    res.status(500).json({ ok: false, error: 'test_failed', message: e.message });
  }
});

// POST /api/dropfleet/push { saleIds:[…] } or { saleId }
router.post('/push', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.saleIds) ? b.saleIds : (b.saleId ? [b.saleId] : []);
    const r = await df.pushSaleIds(ids);
    if (r.ok) await audit(req, 'dropfleet_push', 'sale', null, { attempted: r.attempted, ingested: r.ingested, skipped: (r.skipped || []).length });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'push_failed', message: e.message });
  }
});

// GET /api/dropfleet/pending-breakdown?manualOnly=&days= — diagnostic: what the
// bulk sync WOULD push, bucketed by channel/carrier so over-sends are visible.
router.get('/pending-breakdown', requireAdmin, async (req, res) => {
  try {
    const manualOnly = req.query.manualOnly === '1' || req.query.manualOnly === 'true';
    const days = req.query.days;
    res.json(await df.pendingBreakdown({ manualOnly, days }));
  } catch (e) {
    res.status(500).json({ error: 'breakdown_failed', message: e.message });
  }
});

// GET /api/dropfleet/pending?manualOnly= — how many unshipped orders a bulk sync
// would push (for the confirm dialog).
router.get('/pending', requireAdmin, async (req, res) => {
  try {
    const manualOnly = req.query.manualOnly === '1' || req.query.manualOnly === 'true';
    const days = req.query.days;
    res.json({ count: await df.countUnshipped({ manualOnly, days }) });
  } catch (e) {
    res.status(500).json({ error: 'count_failed', message: e.message });
  }
});

// POST /api/dropfleet/sync-unshipped { manualOnly?, days? } — backfill the
// unshipped delivery backlog into DropFleet (batched, de-duped, retried).
router.post('/sync-unshipped', requireAdmin, async (req, res) => {
  try {
    const manualOnly = !!(req.body && req.body.manualOnly);
    const days = req.body && req.body.days;
    // An admin pressing "Sync now" is an explicit action — allow it even if the
    // auto toggle is off, so they can push on demand without enabling auto-push.
    const r = await df.pushUnshipped({ manualOnly, days, allowDisabled: true });
    if (r.ok) await audit(req, 'dropfleet_sync_unshipped', null, null, { total: r.total, attempted: r.attempted, ingested: r.ingested, days });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'sync_failed', message: e.message });
  }
});

module.exports = router;
