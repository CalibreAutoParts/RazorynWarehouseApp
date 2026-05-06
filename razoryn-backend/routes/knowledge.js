// routes/knowledge.js — feature 11: knowledge base for contacts/logins
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// Helper — does the current user see sensitive entries?
function canSeeSensitive(user) {
  if (user.role === 'admin') return true;
  return !!(user.permissions && user.permissions.kbSensitive);
}

// GET /api/kb?category=
router.get('/', requirePermission('kb'), async (req, res) => {
  const { category } = req.query;
  const where = ['1=1'], params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (!canSeeSensitive(req.user)) where.push(`sensitive = false`);
  const { rows } = await query(
    `SELECT id, title, category, body, sensitive, created_at, updated_at
     FROM kb_entries
     WHERE ${where.join(' AND ')}
     ORDER BY category NULLS LAST, title`,
    params
  );
  res.json({ entries: rows });
});

// POST /api/kb (admin)
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title_required' });
  const { rows } = await query(
    `INSERT INTO kb_entries (title, category, body, sensitive, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.title, b.category || null, b.body || null, !!b.sensitive, req.user.id]
  );
  await audit(req, 'create_kb', 'kb', rows[0].id);
  res.status(201).json({ entry: rows[0] });
});

// PATCH /api/kb/:id (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  for (const [k, v] of Object.entries({
    title: b.title, category: b.category, body: b.body, sensitive: b.sensitive,
  })) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE kb_entries SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_kb', 'kb', rows[0].id);
  res.json({ entry: rows[0] });
});

// DELETE /api/kb/:id (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(`DELETE FROM kb_entries WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'delete_kb', 'kb', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
