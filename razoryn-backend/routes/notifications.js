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

// ── Web Push (#2) — let devices subscribe to OS notifications ────────────────
const push = require('../services/push');

// The VAPID public key the browser needs to subscribe.
router.get('/vapid-public-key', async (req, res) => {
  const key = await push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'push_unavailable' });
  res.json({ key });
});

// Save this device's push subscription.
router.post('/subscribe', async (req, res) => {
  try {
    await push.saveSubscription(req.user.id, req.body?.subscription, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'subscribe_failed', message: e.message });
  }
});

// Remove a subscription (device opted out).
router.post('/unsubscribe', async (req, res) => {
  await push.removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

// Send a test push to all subscribed devices (so the user can confirm it works).
router.post('/test-push', async (req, res) => {
  const r = await push.sendToAll({ title: 'Warehouse Hub', body: 'Push notifications are working on this device ✅', url: '/' });
  res.json({ ok: true, ...r });
});

module.exports = router;
