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
    // Unpaid break minutes per session (entered at clock-out, admin-editable)
    // + an hourly pay rate per staff member so the admin report can show pay.
    await query(`ALTER TABLE time_clock ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(8,2)`);
    _ready = true;
  } catch (e) { console.warn('[timeclock] migration:', e.message); }
}
ensureTable();

const mins = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));

// GET /api/timeclock/status — the caller's current open session (or null).
// ── Clock-in QR gate ────────────────────────────────────────────────────────
// A QR poster on the warehouse wall carries a secret token; clocking in/out
// requires scanning it (proves you're physically here, not on the sofa).
// Configured in Settings: admin generates the token + prints the poster and
// flips "required" on. Until then, clocking works without it (no lock-out).
async function clockQrConfig() {
  try {
    const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
    return d.clockQr || {};
  } catch (_) { return {}; }
}
function qrOk(cfg, provided) {
  if (!cfg.required || !cfg.token) return true;
  return String(provided || '').trim().toUpperCase() === String(cfg.token).trim().toUpperCase();
}
// GET (admin) current config; POST (admin) { required?, regenerate? }
router.get('/qr-config', requireAdmin, async (req, res) => {
  const cfg = await clockQrConfig();
  res.json({ token: cfg.token || null, required: !!cfg.required });
});
router.post('/qr-config', requireAdmin, async (req, res) => {
  try {
    const cur = await clockQrConfig();
    const next = { ...cur };
    if (req.body?.regenerate || !next.token) {
      next.token = 'CLOCK-' + Math.random().toString(36).slice(2, 8).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
    }
    if (req.body?.required !== undefined) next.required = !!req.body.required;
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
    await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
      [JSON.stringify({ ...d, clockQr: next })]);
    await audit(req, 'clock_qr_config', null, null, { required: next.required, regenerated: !!req.body?.regenerate });
    res.json({ token: next.token, required: !!next.required });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

router.get('/status', async (req, res) => {
  await ensureTable();
  const r = await query(`SELECT * FROM time_clock WHERE user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`, [req.user.id]);
  const open = r.rows[0] || null;
  // Today's total (UK day): every session that STARTED today, closed sessions
  // at their real length, the open one live up to now.
  const today = await query(
    `SELECT clock_in, clock_out FROM time_clock
      WHERE user_id = $1
        AND clock_in >= (date_trunc('day', (now() AT TIME ZONE 'Europe/London')) AT TIME ZONE 'Europe/London')`,
    [req.user.id]);
  const todayMinutes = today.rows.reduce((a, s) => a + mins(s.clock_in, s.clock_out || new Date()), 0);
  const cfg = await clockQrConfig();
  res.json({
    clockedIn: !!open, session: open, sinceMinutes: open ? mins(open.clock_in, new Date()) : 0,
    todayMinutes, qrRequired: !!(cfg.required && cfg.token),
  });
});

// POST /api/timeclock/clock-in — open a session (idempotent: returns the open one).
router.post('/clock-in', async (req, res) => {
  await ensureTable();
  const cfg = await clockQrConfig();
  if (!qrOk(cfg, req.body?.qrToken)) {
    return res.status(403).json({ error: 'qr_required', message: 'Scan the clock-in QR poster to clock in.' });
  }
  const existing = await query(`SELECT * FROM time_clock WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`, [req.user.id]);
  if (existing.rows[0]) return res.json({ ok: true, alreadyIn: true, session: existing.rows[0] });
  const r = await query(`INSERT INTO time_clock (user_id) VALUES ($1) RETURNING *`, [req.user.id]);
  await audit(req, 'clock_in', 'user', req.user.id, {});
  res.status(201).json({ ok: true, session: r.rows[0] });
});

// POST /api/timeclock/clock-out { note? } — close the caller's open session.
router.post('/clock-out', async (req, res) => {
  await ensureTable();
  const cfg = await clockQrConfig();
  if (!qrOk(cfg, req.body?.qrToken)) {
    return res.status(403).json({ error: 'qr_required', message: 'Scan the clock-in QR poster to clock out.' });
  }
  const breakMins = Math.max(0, Math.min(480, parseInt(req.body?.breakMinutes) || 0));
  const r = await query(
    `UPDATE time_clock SET clock_out = now(), note = COALESCE($2, note), break_minutes = $3
       WHERE user_id = $1 AND clock_out IS NULL RETURNING *`,
    [req.user.id, (req.body?.note || '').trim() || null, breakMins]);
  if (!r.rows[0]) return res.status(409).json({ error: 'not_clocked_in' });
  const s = r.rows[0];
  await audit(req, 'clock_out', 'user', req.user.id, { minutes: mins(s.clock_in, s.clock_out), breakMins });
  res.json({ ok: true, session: s, minutes: mins(s.clock_in, s.clock_out), breakMinutes: breakMins });
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
    `SELECT tc.*, u.name AS user_name, u.hourly_rate FROM time_clock tc JOIN users u ON u.id = tc.user_id
      WHERE tc.clock_in >= $1 AND tc.clock_in <= $2 ${userClause}
      ORDER BY u.name, tc.clock_in DESC`, params);
  // Group per user with totals: worked, unpaid breaks, PAYABLE (worked −
  // breaks), and pay when an hourly rate is set on the staff record.
  const byUser = {};
  for (const s of rows) {
    const m = s.clock_out ? mins(s.clock_in, s.clock_out) : mins(s.clock_in, new Date());
    const br = parseInt(s.break_minutes) || 0;
    const u = byUser[s.user_id] || (byUser[s.user_id] = {
      userId: s.user_id, name: s.user_name,
      hourlyRate: s.hourly_rate != null ? parseFloat(s.hourly_rate) : null,
      totalMinutes: 0, breakMinutes: 0, sessions: [],
    });
    u.totalMinutes += m;
    u.breakMinutes += br;
    u.sessions.push({ id: s.id, clockIn: s.clock_in, clockOut: s.clock_out, minutes: m, breakMinutes: br, open: !s.clock_out, note: s.note });
  }
  const staff = Object.values(byUser).map(u => {
    const payable = Math.max(0, u.totalMinutes - u.breakMinutes);
    return { ...u, payableMinutes: payable, pay: u.hourlyRate != null ? +((payable / 60) * u.hourlyRate).toFixed(2) : null };
  }).sort((a, b) => b.totalMinutes - a.totalMinutes);
  res.json({ from, to, staff });
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
