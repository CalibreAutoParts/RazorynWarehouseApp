// routes/ebayhub.js — the eBay page: overview per account, buyer messages
// (read + reply) and offers to watchers. Messages: staff with Dispatch
// permission; offers (prices) and money: admins only.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const hub = require('../lib/ebay-hub');

const router = express.Router();
router.use(requireAuth);
const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e.code === 'ebay_message_policy') return res.status(422).json({ error: e.code, message: e.message });
  res.status(e.status || 500).json({ error: 'ebay_hub_error', message: e.message });
});

router.get('/overview', requirePermission('dispatch'), aw(async (req, res) => res.json(await hub.overview())));

// GET /messages?store=&filter=all|unread|answer&q=&limit=
router.get('/messages', requirePermission('dispatch'), aw(async (req, res) => {
  await hub.ensureSchema();
  const where = [], params = [];
  if (req.query.store) { params.push(req.query.store); where.push(`m.store_code = $${params.length}`); }
  if (req.query.filter === 'unread') where.push('NOT m.is_read');
  if (req.query.filter === 'answer') where.push('m.response_enabled AND NOT m.replied');
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); where.push(`(m.sender ILIKE $${params.length} OR m.subject ILIKE $${params.length} OR m.item_title ILIKE $${params.length} OR m.item_id ILIKE $${params.length} OR m.body ILIKE $${params.length})`); }
  const lim = Math.min(300, Math.max(1, parseInt(req.query.limit) || 100));
  const rows = (await query(`SELECT m.id, m.store_code, m.sender, m.subject, m.item_id, m.item_title, m.message_type, m.received_at,
      m.is_read, m.replied, m.response_enabled, m.high_priority, LEFT(COALESCE(m.body, ''), 160) AS preview
    FROM ebay_messages m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.received_at DESC NULLS LAST LIMIT ${lim}`, params)).rows;
  res.json({ messages: rows });
}));

router.post('/messages/sync', requirePermission('dispatch'), aw(async (req, res) => {
  res.json({ results: await hub.syncAll({ days: Math.min(30, Math.max(1, parseInt(req.body?.days) || 5)) }) });
}));

// One message in full (marks it read here and on eBay), with our replies and
// the buyer's other messages about the same item.
router.get('/messages/:id', requirePermission('dispatch'), aw(async (req, res) => {
  await hub.ensureSchema();
  const m = (await query(`SELECT * FROM ebay_messages WHERE id = $1`, [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  await hub.markRead(m);
  const replies = (await query(`SELECT r.body, r.sent_at, r.ok, r.error, u.name AS sent_by FROM ebay_message_replies r LEFT JOIN users u ON u.id = r.sent_by
    WHERE r.message_row_id = $1 ORDER BY r.sent_at`, [m.id])).rows;
  const thread = (await query(`SELECT id, subject, LEFT(COALESCE(body,''), 400) AS body, received_at, replied FROM ebay_messages
    WHERE store_code = $1 AND sender = $2 AND id <> $3 AND (item_id = $4 OR $4 IS NULL) ORDER BY received_at DESC LIMIT 10`,
    [m.store_code, m.sender, m.id, m.item_id])).rows;
  res.json({ message: { ...m, is_read: true }, replies, thread });
}));

router.post('/messages/:id/reply', requirePermission('dispatch'), aw(async (req, res) => {
  const r = await hub.reply(parseInt(req.params.id), req.body?.body, req.user.id);
  await audit(req, 'ebay_message_reply', 'ebay_message', req.params.id, {});
  res.json(r);
}));

// Offers — admin only (prices).
router.get('/offers/eligible', requireAdmin, aw(async (req, res) => {
  await hub.ensureSchema();
  const items = await hub.eligibleItems();
  const recent = (await query(`SELECT listing_id, MAX(sent_at) AS last FROM ebay_offers_sent WHERE ok GROUP BY listing_id`)).rows;
  const last = new Map(recent.map(r => [r.listing_id, r.last]));
  res.json({ items: items.map(i => ({ ...i, lastOfferAt: last.get(i.listingId) || null })) });
}));
router.post('/offers/send', requireAdmin, aw(async (req, res) => {
  const b = req.body || {};
  const results = await hub.sendOffers({ items: Array.isArray(b.items) ? b.items : [], message: b.message, allowCounterOffer: !!b.allowCounterOffer }, req.user.id);
  await audit(req, 'ebay_offers_send', null, null, { count: results.length, ok: results.filter(r => r.ok).length });
  res.json({ results });
}));
router.get('/offers/sent', requireAdmin, aw(async (req, res) => {
  await hub.ensureSchema();
  const rows = (await query(`SELECT o.*, p.sku, p.title, u.name AS sent_by_name FROM ebay_offers_sent o
    LEFT JOIN products p ON p.id = o.product_id LEFT JOIN users u ON u.id = o.sent_by ORDER BY o.sent_at DESC LIMIT 200`)).rows;
  res.json({ offers: rows });
}));

module.exports = router;
