// routes/dropfleet.js — configure the DropFleet integration and push orders
// into DropFleet's Integrated Orders ingest endpoint.
//
// The API key is a secret: it's stored in app_settings.dropfleet_api_key and is
// NEVER returned to the browser (the config endpoint reports only whether a key
// is set + its last 4 chars). See services/dropfleet.js for the mapping/push.

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const df = require('../services/dropfleet');

const router = express.Router();
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
  const r = await df.testConnection();
  res.json(r);
});

// POST /api/dropfleet/push { saleIds:[…] } or { saleId }
router.post('/push', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.saleIds) ? b.saleIds : (b.saleId ? [b.saleId] : []);
  const r = await df.pushSaleIds(ids);
  if (r.ok) await audit(req, 'dropfleet_push', 'sale', null, { attempted: r.attempted, ingested: r.ingested, skipped: (r.skipped || []).length });
  res.json(r);
});

// GET /api/dropfleet/pending?manualOnly= — how many unshipped orders a bulk sync
// would push (for the confirm dialog).
router.get('/pending', requireAdmin, async (req, res) => {
  try {
    const manualOnly = req.query.manualOnly === '1' || req.query.manualOnly === 'true';
    res.json({ count: await df.countUnshipped({ manualOnly }) });
  } catch (e) {
    res.status(500).json({ error: 'count_failed', message: e.message });
  }
});

// POST /api/dropfleet/sync-unshipped { manualOnly? } — backfill the whole
// unshipped delivery backlog into DropFleet (batched, de-duped, retried).
router.post('/sync-unshipped', requireAdmin, async (req, res) => {
  const manualOnly = !!(req.body && req.body.manualOnly);
  const r = await df.pushUnshipped({ manualOnly });
  if (r.ok) await audit(req, 'dropfleet_sync_unshipped', null, null, { total: r.total, attempted: r.attempted, ingested: r.ingested });
  res.json(r);
});

module.exports = router;
