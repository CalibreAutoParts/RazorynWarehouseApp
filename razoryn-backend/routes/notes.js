// routes/notes.js — Notes & follow-ups (phone team / admin)
// Each note is owned by the user who created it. Standard staff see their own notes;
// admins see everyone's. Notes older than 31 days are filtered out of GET responses
// (effectively "auto-archived") and can be optionally deleted by a cron job.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/notes
// Query params:
//   ?scope=mine   — only the current user's notes (default for non-admins)
//   ?scope=all    — every user's notes (admin only)
//   ?status=open|done|all (default: all)
router.get('/', async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  // Default scope: admins see "all", non-admins see "mine"
  const scopeReq = (req.query.scope || (isAdmin ? 'all' : 'mine')).toLowerCase();
  const scope = (scopeReq === 'all' && isAdmin) ? 'all' : 'mine';
  const status = (req.query.status || 'all').toLowerCase();

  const where = [`n.created_at > now() - INTERVAL '31 days'`];
  const params = [];
  if (scope === 'mine') {
    params.push(req.user.id);
    where.push(`n.user_id = $${params.length}`);
  }
  if (status === 'open') where.push(`n.done_at IS NULL`);
  else if (status === 'done') where.push(`n.done_at IS NOT NULL`);

  const { rows } = await query(`
    SELECT n.*, u.name AS author_name, u.email AS author_email
    FROM staff_notes n
    LEFT JOIN users u ON u.id = n.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN n.done_at IS NULL THEN 0 ELSE 1 END,
      n.follow_up_date NULLS LAST,
      n.created_at DESC
  `, params);
  res.json({ notes: rows, scope, isAdmin });
});

// POST /api/notes
// Body: { body, customerName?, customerPhone?, customerEmail?, followUpDate?, category? }
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.body || !String(b.body).trim()) return res.status(400).json({ error: 'body_required' });

  const { rows } = await query(
    `INSERT INTO staff_notes (user_id, body, customer_name, customer_phone, customer_email,
                              follow_up_date, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id, String(b.body).trim(),
     b.customerName || null, b.customerPhone || null, b.customerEmail || null,
     b.followUpDate || null, b.category || null]
  );
  await audit(req, 'create_note', 'note', rows[0].id, null);
  res.json({ note: rows[0] });
});

// PATCH /api/notes/:id
// Toggle done, edit body, update customer fields. Owner or admin only.
router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  // Verify ownership
  const existing = await query(`SELECT user_id FROM staff_notes WHERE id = $1`, [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not_yours' });
  }

  const fields = {
    body: b.body,
    customer_name: b.customerName,
    customer_phone: b.customerPhone,
    customer_email: b.customerEmail,
    follow_up_date: b.followUpDate,
    category: b.category,
  };
  const sets = [], params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    params.push(v === '' ? null : v);
    sets.push(`${k} = $${params.length}`);
  }
  // Handle done toggle separately
  if (b.done === true) sets.push(`done_at = now()`);
  if (b.done === false) sets.push(`done_at = NULL`);
  if (!sets.length) return res.status(400).json({ error: 'no_updates' });
  params.push(req.params.id);

  const { rows } = await query(
    `UPDATE staff_notes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  await audit(req, 'update_note', 'note', req.params.id, b);
  res.json({ note: rows[0] });
});

// DELETE /api/notes/:id — owner or admin
router.delete('/:id', async (req, res) => {
  const existing = await query(`SELECT user_id FROM staff_notes WHERE id = $1`, [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not_yours' });
  }
  await query(`DELETE FROM staff_notes WHERE id = $1`, [req.params.id]);
  await audit(req, 'delete_note', 'note', req.params.id, null);
  res.json({ ok: true });
});

// POST /api/notes/cleanup-old (admin) — explicit cleanup endpoint; cron usually handles it
router.post('/cleanup-old', requireAdmin, async (req, res) => {
  const r = await query(`DELETE FROM staff_notes WHERE created_at < now() - INTERVAL '31 days' RETURNING id`);
  res.json({ deleted: r.rowCount });
});

module.exports = router;
