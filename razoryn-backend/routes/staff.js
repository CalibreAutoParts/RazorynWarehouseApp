// routes/staff.js — feature 4: staff & access management (admin)
const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const DEFAULT_PERMS = {
  inventory: true, scan: true, locations: true, returns: true,
  sales: false, pricing: false, kb: true, kbSensitive: false,
  schedule: true, videos: true,
};

// GET /api/staff
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT id, email, name, role, permissions, active, last_login_at, created_at
    FROM users ORDER BY active DESC, name
  `);
  res.json({ users: rows });
});

// POST /api/staff  { name, email?, password?, pin?, role, permissions }
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.role) return res.status(400).json({ error: 'name_and_role_required' });
  if (!['admin', 'warehouse'].includes(b.role)) return res.status(400).json({ error: 'invalid_role' });
  if (b.role === 'admin' && (!b.email || !b.password)) {
    return res.status(400).json({ error: 'admin_needs_email_and_password' });
  }
  if (b.role === 'warehouse' && !b.pin) {
    return res.status(400).json({ error: 'warehouse_needs_pin' });
  }

  const passwordHash = b.password ? await bcrypt.hash(b.password, 10) : null;
  const pinHash = b.pin ? await bcrypt.hash(b.pin, 10) : null;
  const perms = b.role === 'warehouse' ? { ...DEFAULT_PERMS, ...(b.permissions || {}) } : {};

  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, pin_hash, role, permissions)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id, name, email, role, permissions, active`,
      [b.name, b.email || null, passwordHash, pinHash, b.role, JSON.stringify(perms)]
    );
    await audit(req, 'create_user', 'user', rows[0].id, { role: b.role });
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_exists' });
    throw e;
  }
});

// PATCH /api/staff/:id  — update name, permissions, role, active, password, pin
router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  if (b.name)         { params.push(b.name); sets.push(`name = $${params.length}`); }
  if (b.email)        { params.push(b.email); sets.push(`email = $${params.length}`); }
  if (b.role)         { params.push(b.role); sets.push(`role = $${params.length}`); }
  if (b.active !== undefined) { params.push(b.active); sets.push(`active = $${params.length}`); }
  if (b.permissions)  { params.push(JSON.stringify(b.permissions)); sets.push(`permissions = $${params.length}::jsonb`); }
  if (b.password)     {
    const h = await bcrypt.hash(b.password, 10);
    params.push(h); sets.push(`password_hash = $${params.length}`);
  }
  if (b.pin) {
    const h = await bcrypt.hash(b.pin, 10);
    params.push(h); sets.push(`pin_hash = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, email, role, permissions, active`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_user', 'user', rows[0].id);
  res.json({ user: rows[0] });
});

// DELETE /api/staff/:id (soft delete via active=false; we never hard-delete to preserve audit FKs)
router.delete('/:id', async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  await query(`UPDATE users SET active = false WHERE id = $1`, [req.params.id]);
  await audit(req, 'deactivate_user', 'user', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
