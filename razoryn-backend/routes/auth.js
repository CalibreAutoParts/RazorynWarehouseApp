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

// POST /api/auth/login  { email, password }
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

  const { rows } = await query(
    `SELECT id, email, name, role, permissions, password_hash, active
     FROM users WHERE email = $1`,
    [email]
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

  await audit({ user: u, ip: req.ip }, 'login_email');

  res.json({
    token,
    user: {
      id: u.id, email: u.email, name: u.name, role: u.role,
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
