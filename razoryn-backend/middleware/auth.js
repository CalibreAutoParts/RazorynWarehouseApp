// middleware/auth.js — JWT-based auth for the warehouse app
const jwt = require('jsonwebtoken');
const { query } = require('../db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '12h';

function sign(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Reads token from Authorization header OR cookie
function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies && req.cookies.rzn_token) return req.cookies.rzn_token;
  return null;
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'auth_required' });
  try {
    const payload = jwt.verify(token, SECRET);
    const { rows } = await query(
      `SELECT id, email, name, role, permissions, active
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!rows[0] || !rows[0].active) return res.status(401).json({ error: 'user_inactive' });
    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
}

// Granular permission for warehouse role. Admins always pass.
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth_required' });
    if (req.user.role === 'admin') return next();
    const perms = req.user.permissions || {};
    if (perms[key]) return next();
    return res.status(403).json({ error: 'forbidden', missing: key });
  };
}

module.exports = { sign, requireAuth, requireAdmin, requirePermission };
