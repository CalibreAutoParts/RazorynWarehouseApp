// routes/devices.js — native app device registry.
//
// The Android app registers itself on launch (device id/model/app version, and —
// once Firebase is set up — its FCM push token). This gives admins a list of the
// handheld devices, who's signed in on each, their app version and last-seen time,
// and is the source of push targets. Works even before Firebase is configured
// (the push token is just null until then).
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  await query(`CREATE TABLE IF NOT EXISTS app_devices (
    device_id   TEXT PRIMARY KEY,
    user_id     INTEGER,
    platform    TEXT,
    model       TEXT,
    app_version TEXT,
    push_token  TEXT,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ready = true;
}

// POST /api/devices/register
//   { deviceId, model, platform, appVersion, pushToken? }
// Upsert keyed by deviceId so re-launches update the same row (who's logged in,
// last seen, latest push token).
router.post('/register', async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    if (!b.deviceId) return res.status(400).json({ error: 'deviceId_required' });
    await query(
      `INSERT INTO app_devices (device_id, user_id, platform, model, app_version, push_token, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (device_id) DO UPDATE SET
         user_id     = EXCLUDED.user_id,
         platform    = EXCLUDED.platform,
         model       = EXCLUDED.model,
         app_version = EXCLUDED.app_version,
         push_token  = COALESCE(EXCLUDED.push_token, app_devices.push_token),
         last_seen   = now()`,
      [String(b.deviceId).slice(0, 200), req.user.id,
       (b.platform || 'android').slice(0, 20),
       (b.model || '').slice(0, 120) || null,
       (b.appVersion || '').slice(0, 40) || null,
       b.pushToken ? String(b.pushToken).slice(0, 500) : null]
    );
    res.json({ ok: true, pushConfigured: require('../services/fcm').isConfigured() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/devices — admin list of registered devices.
router.get('/', requireAdmin, async (req, res) => {
  await ensureTable();
  const { rows } = await query(
    `SELECT d.device_id, d.platform, d.model, d.app_version,
            (d.push_token IS NOT NULL) AS push_enabled,
            d.last_seen, u.name AS user_name
       FROM app_devices d LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.last_seen DESC`
  );
  res.json({ devices: rows, pushConfigured: require('../services/fcm').isConfigured() });
});

module.exports = router;
