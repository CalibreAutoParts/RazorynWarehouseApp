// routes/timeclock.js — staff clock in/out + work-hours tracking.
//
// Any signed-in member can clock in/out (works with no admin present). Each
// clock-in opens a session; clock-out closes it. Staff see their own hours; admins
// get a team report for pay. Hours are computed from the timestamps, never stored.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS time_clock (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      clock_in   TIMESTAMPTZ NOT NULL DEFAULT now(),
      clock_out  TIMESTAMPTZ,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS time_clock_user_idx ON time_clock (user_id, clock_in DESC)`);
    // At most one OPEN session per user.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS time_clock_open_uq ON time_clock (user_id) WHERE clock_out IS NULL`);
    _ready = true;
  } catch (e) { console.warn('[timeclock] migration:', e.message); }
}
ensureTable();

const mins = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));

// GET /api/timeclock/status — the caller's current open session (or null).
router.get('/status', async (req, res) => {
  await ensureTable();
  const r = await query(`SELECT * FROM time_clock WHERE user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`, [req.user.id]);
  const open = r.rows[0] || null;
  res.json({ clockedIn: !!open, session: open, sinceMinutes: open ? mins(open.clock_in, new Date()) : 0 });
});

// POST /api/timeclock/clock-in — open a session (idempotent: returns the open one).
router.post('/clock-in', async (req, res) => {
  await ensureTable();
  const existing = await query(`SELECT * FROM time_clock WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`, [req.user.id]);
  if (existing.rows[0]) return res.json({ ok: true, alreadyIn: true, session: existing.rows[0] });
  const r = await query(`INSERT INTO time_clock (user_id) VALUES ($1) RETURNING *`, [req.user.id]);
  await audit(req, 'clock_in', 'user', req.user.id, {});
  res.status(201).json({ ok: true, session: r.rows[0] });
});

// POST /api/timeclock/clock-out { note? } — close the caller's open session.
router.post('/clock-out', async (req, res) => {
  await ensureTable();
  const r = await query(
    `UPDATE time_clock SET clock_out = now(), note = COALESCE($2, note)
       WHERE user_id = $1 AND clock_out IS NULL RETURNING *`,
    [req.user.id, (req.body?.note || '').trim() || null]);
  if (!r.rows[0]) return res.status(409).json({ error: 'not_clocked_in' });
  const s = r.rows[0];
  await audit(req, 'clock_out', 'user', req.user.id, { minutes: mins(s.clock_in, s.clock_out) });
  res.json({ ok: true, session: s, minutes: mins(s.clock_in, s.clock_out) });
});

// GET /api/timeclock/me?from=&to= — the caller's sessions + total in a window
// (defaults to the last 14 days).
router.get('/me', async (req, res) => {
  await ensureTable();
  const from = req.query.from || new Date(Date.now() - 14 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();
  const { rows } = await query(
    `SELECT * FROM time_clock WHERE user_id = $1 AND clock_in >= $2 AND clock_in <= $3 ORDER BY clock_in DESC`,
    [req.user.id, from, to]);
  const sessions = rows.map(s => ({ ...s, minutes: s.clock_out ? mins(s.clock_in, s.clock_out) : mins(s.clock_in, new Date()), open: !s.clock_out }));
  const totalMinutes = sessions.reduce((a, s) => a + s.minutes, 0);
  res.json({ from, to, sessions, totalMinutes });
});

// GET /api/timeclock/report?from=&to=&userId= — admin team hours (for pay).
router.get('/report', requireAdmin, async (req, res) => {
  await ensureTable();
  const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();
  const params = [from, to];
  let userClause = '';
  if (req.query.userId) { params.push(req.query.userId); userClause = `AND tc.user_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT tc.*, u.name AS user_name FROM time_clock tc JOIN users u ON u.id = tc.user_id
      WHERE tc.clock_in >= $1 AND tc.clock_in <= $2 ${userClause}
      ORDER BY u.name, tc.clock_in DESC`, params);
  // Group per user with totals.
  const byUser = {};
  for (const s of rows) {
    const m = s.clock_out ? mins(s.clock_in, s.clock_out) : mins(s.clock_in, new Date());
    const u = byUser[s.user_id] || (byUser[s.user_id] = { userId: s.user_id, name: s.user_name, totalMinutes: 0, sessions: [] });
    u.totalMinutes += m;
    u.sessions.push({ id: s.id, clockIn: s.clock_in, clockOut: s.clock_out, minutes: m, open: !s.clock_out, note: s.note });
  }
  res.json({ from, to, staff: Object.values(byUser).sort((a, b) => b.totalMinutes - a.totalMinutes) });
});

// PATCH /api/timeclock/:id — admin correction of a session's times (typos / forgot
// to clock out). Body: { clockIn?, clockOut? }.
router.patch('/:id', requireAdmin, async (req, res) => {
  await ensureTable();
  const sets = [], params = [];
  if (req.body?.clockIn) { params.push(req.body.clockIn); sets.push(`clock_in = $${params.length}`); }
  if (req.body?.clockOut !== undefined) { params.push(req.body.clockOut || null); sets.push(`clock_out = $${params.length}`); }
  if (req.body?.note !== undefined) { params.push(req.body.note || null); sets.push(`note = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  params.push(req.params.id);
  const r = await query(`UPDATE time_clock SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'timeclock_edit', 'time_clock', req.params.id, {});
  res.json({ ok: true, session: r.rows[0] });
});

module.exports = router;
