// routes/settings.js — global app settings + manual sync trigger
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const sync = require('../services/sync');

const router = express.Router();
router.use(requireAuth);

// GET /api/settings
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM app_settings WHERE id = 1');
  res.json({ settings: rows[0] || {} });
});

// PATCH /api/settings (admin)
router.patch('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  for (const [k, v] of Object.entries({
    cash_discount_pct: b.cashDiscountPct,
    vat_rate: b.vatRate,
    free_delivery_threshold: b.freeDeliveryThreshold,
    same_day_cutoff_hour: b.sameDayCutoffHour,
  })) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (b.data) { params.push(JSON.stringify(b.data)); sets.push(`data = $${params.length}::jsonb`); }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  sets.push('updated_at = now()');
  const { rows } = await query(
    `UPDATE app_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    params
  );
  await audit(req, 'update_settings');
  res.json({ settings: rows[0] });
});

// POST /api/settings/sync-now (admin) — manual sync trigger
router.post('/sync-now', requireAdmin, async (req, res) => {
  try {
    const result = await sync.runFullSync();
    await audit(req, 'manual_sync', null, null, result);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// GET /api/settings/sync-state
router.get('/sync-state', async (req, res) => {
  const { rows } = await query('SELECT * FROM sync_state ORDER BY channel');
  res.json({ state: rows });
});

module.exports = router;
