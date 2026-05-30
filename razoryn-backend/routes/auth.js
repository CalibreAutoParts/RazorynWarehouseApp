// routes/auth.js — login (PIN + email/password), logout, /me
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { sign, requireAuth } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();

// Rate-limit auth endpoints to slow brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Ensure the username column exists (case-insensitive unique). Users now log in
// with a username (or email) + password; the PIN keypad has been retired.
let _userAuthMigrated = false;
async function ensureUserAuthColumns() {
  if (_userAuthMigrated) return;
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq ON users (LOWER(username)) WHERE username IS NOT NULL`);
    _userAuthMigrated = true;
  } catch (e) { console.warn('[auth] username migration warning:', e.message); }
}
ensureUserAuthColumns();

// POST /api/auth/login-pin  { pin }
// PIN-only login for warehouse staff. We have to compare against every active
// user's pin_hash because PINs aren't unique IDs. With ~10 staff this is fine.
router.post('/login-pin', authLimiter, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'invalid_pin_format' });
  }

  const { rows } = await query(
    `SELECT id, name, role, permissions, pin_hash
     FROM users WHERE active = true AND pin_hash IS NOT NULL`
  );

  let matched = null;
  for (const u of rows) {
    if (await bcrypt.compare(pin, u.pin_hash)) { matched = u; break; }
  }
  if (!matched) return res.status(401).json({ error: 'invalid_credentials' });

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [matched.id]);

  const token = sign(matched);
  res.cookie('rzn_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  });

  await audit({ user: matched, ip: req.ip }, 'login_pin');

  res.json({
    token,
    user: {
      id: matched.id, name: matched.name, role: matched.role,
      permissions: matched.permissions,
    },
  });
});

// POST /api/auth/login  { username, password }  (username may also be an email)
router.post('/login', authLimiter, async (req, res) => {
  const body = req.body || {};
  // Accept `username` (preferred) or legacy `email`; either may match the
  // username OR email column, case-insensitively.
  const identifier = (body.username || body.email || '').trim();
  const password = body.password;
  if (!identifier || !password) return res.status(400).json({ error: 'username_and_password_required' });

  await ensureUserAuthColumns();
  const { rows } = await query(
    `SELECT id, email, username, name, role, permissions, password_hash, active
       FROM users
      WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
      LIMIT 1`,
    [identifier]
  );
  const u = rows[0];
  if (!u || !u.active || !u.password_hash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);

  const token = sign(u);
  res.cookie('rzn_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  });

  await audit({ user: u, ip: req.ip }, 'login_password');

  res.json({
    token,
    user: {
      id: u.id, email: u.email, username: u.username, name: u.name, role: u.role,
      permissions: u.permissions,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('rzn_token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const { id, email, name, role, permissions } = req.user;
  res.json({ user: { id, email, name, role, permissions } });
});

module.exports = router;
