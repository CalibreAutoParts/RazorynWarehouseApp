// routes/notifications.js — feature 8: low-stock notifications etc.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications?unread=1
router.get('/', async (req, res) => {
  const { unread } = req.query;
  const where = ['(target_user_id IS NULL OR target_user_id = $1)'];
  const params = [req.user.id];
  if (unread === '1') where.push('read_at IS NULL');
  const { rows } = await query(
    `SELECT * FROM notifications WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT 100`, params
  );
  const unreadCount = await query(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE (target_user_id IS NULL OR target_user_id = $1) AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ notifications: rows, unreadCount: unreadCount.rows[0].n });
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  await query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND (target_user_id IS NULL OR target_user_id = $2)`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  await query(
    `UPDATE notifications SET read_at = now()
     WHERE read_at IS NULL AND (target_user_id IS NULL OR target_user_id = $1)`,
    [req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
