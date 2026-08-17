// routes/usage.js — lightweight per-user app-usage tracking.
//
// The web app sends a throttled "ping" as staff move around (which page, and
// whether they're on the native handheld APP or a normal browser). We roll these
// up per user PER DAY (upsert) so there's no row explosion, giving admins a clear
// "who's using the app, how much, and on what device" view — complementing the
// audit log (which records specific actions, not presence).
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id   INTEGER NOT NULL,
      day       DATE NOT NULL,
      app_pings INTEGER NOT NULL DEFAULT 0,
      web_pings INTEGER NOT NULL DEFAULT 0,
      last_page TEXT,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day)
    )`);
  _ready = true;
}

// POST /api/usage/ping  { page, appShell }
// Cheap, any authenticated user. Client throttles to ~1/min so this is low-volume.
router.post('/ping', async (req, res) => {
  try {
    await ensureTable();
    const page = String(req.body?.page || '').slice(0, 40) || null;
    const app = req.body?.appShell ? 1 : 0;
    await query(
      `INSERT INTO usage_daily (user_id, day, app_pings, web_pings, last_page, last_seen)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, now())
       ON CONFLICT (user_id, day) DO UPDATE SET
         app_pings = usage_daily.app_pings + $2,
         web_pings = usage_daily.web_pings + $3,
         last_page = $4,
         last_seen = now()`,
      [req.user.id, app, app ? 0 : 1, page]
    );
    res.json({ ok: true });
  } catch (e) {
    // Never let usage tracking break the app.
    res.json({ ok: false });
  }
});

// GET /api/usage/summary?days=14 — per-user rollup (admin only).
router.get('/summary', requireAdmin, async (req, res) => {
  await ensureTable();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 14));
  const { rows } = await query(
    `SELECT u.id, u.name, u.role,
            COALESCE(SUM(d.app_pings),0)::int AS app_pings,
            COALESCE(SUM(d.web_pings),0)::int AS web_pings,
            COUNT(DISTINCT d.day)::int         AS active_days,
            MAX(d.last_seen)                   AS last_seen,
            (array_agg(d.last_page ORDER BY d.last_seen DESC))[1] AS last_page
       FROM usage_daily d JOIN users u ON u.id = d.user_id
      WHERE d.day > CURRENT_DATE - $1::int
      GROUP BY u.id, u.name, u.role
      ORDER BY MAX(d.last_seen) DESC NULLS LAST`,
    [days]
  );
  res.json({ days, users: rows });
});

module.exports = router;
