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

// GET /messages?store=&filter=answer|unread|buyers|ebay|all&q=&limit=
// One entry per conversation (account + buyer + item), newest first.
router.get('/messages', requirePermission('dispatch'), aw(async (req, res) => {
  await hub.ensureSchema();
  const where = [], params = [];
  if (req.query.store) { params.push(req.query.store); where.push(`m.store_code = $${params.length}`); }
  const f = String(req.query.filter || 'answer');
  if (f === 'answer') where.push(hub.NEEDS_REPLY_SQL);
  else if (f === 'unread') where.push(`NOT m.is_read AND NOT ${hub.EBAY_SQL}`);
  else if (f === 'buyers') where.push(`NOT ${hub.EBAY_SQL}`);
  else if (f === 'ebay') where.push(hub.EBAY_SQL);
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); where.push(`(m.sender ILIKE $${params.length} OR m.subject ILIKE $${params.length} OR m.item_title ILIKE $${params.length} OR m.item_id ILIKE $${params.length} OR m.body ILIKE $${params.length})`); }
  const lim = Math.min(300, Math.max(1, parseInt(req.query.limit) || 150));
  const rows = (await query(`SELECT m.id, m.store_code, m.sender, m.subject, m.item_id, m.item_title, m.message_type, m.received_at,
      m.is_read, m.replied, m.done, m.response_enabled, ${hub.NEEDS_REPLY_SQL} AS needs_reply, ${hub.EBAY_SQL} AS is_ebay,
      LEFT(BTRIM(split_part(COALESCE(m.body, ''), E'\nNew message from', 1)), 160) AS preview
    FROM (${hub.LATEST_SQL}) m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.received_at DESC NULLS LAST LIMIT ${lim}`, params)).rows;
  res.json({ messages: rows });
}));

// POST /messages/:id/order-check — the order's shipping status live on eBay,
// synced into the warehouse (dispatched / tracking).
router.post('/messages/:id/order-check', requirePermission('dispatch'), aw(async (req, res) => {
  const m = (await query(`SELECT * FROM ebay_messages WHERE id = $1`, [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  const order = await hub.orderForMessage(m);
  if (!order) return res.json({ order: null });
  const r = await hub.checkOrderOnEbay(m.store_code, order.number);
  res.json({ order: await hub.orderForMessage(m), ...r });
}));

// POST /messages/:id/mark { as: 'done' | 'reply' | 'unread' | 'read' }
router.post('/messages/:id/mark', requirePermission('dispatch'), aw(async (req, res) => {
  res.json(await hub.mark(parseInt(req.params.id), String(req.body?.as || '')));
}));

// POST /messages/poll — called every 30 s by every open app. The server checks
// eBay at most once per 30 s (shared by everyone) and answers with what's new.
let _pollAt = 0;
router.post('/messages/poll', requirePermission('dispatch'), aw(async (req, res) => {
  await hub.ensureSchema();
  let added = 0;
  if (Date.now() - _pollAt > 28000) {
    _pollAt = Date.now();
    const r = await hub.syncAll({ days: 2 });
    if (Array.isArray(r)) added = r.reduce((a, x) => a + (x.added || 0), 0);
  }
  const toAnswer = (await query(`SELECT COUNT(*)::int AS n FROM (${hub.LATEST_SQL}) m WHERE ${hub.NEEDS_REPLY_SQL}`)).rows[0].n;
  res.json({ added, toAnswer, lastCheck: new Date(_pollAt).toISOString() });
}));
router.put('/schedule', requireAdmin, aw(async (req, res) => res.json(await hub.saveScheduleSettings(req.body || {}))));
router.post('/messages/sync', requirePermission('dispatch'), aw(async (req, res) => {
  const r = await hub.syncAll({ days: Math.min(30, Math.max(1, parseInt(req.body?.days) || 5)) });
  res.json({ results: Array.isArray(r) ? r : [] , running: !Array.isArray(r) });
}));

// One message in full (marks it read here and on eBay), with our replies and
// the buyer's other messages about the same item.
router.get('/messages/:id', requirePermission('dispatch'), aw(async (req, res) => {
  await hub.ensureSchema();
  const m = (await query(`SELECT * FROM ebay_messages WHERE id = $1`, [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  const convRows = await hub.conversationRows(m);
  for (const r of convRows) if (!r.is_read) await hub.markRead(r);
  const replies = (await query(`SELECT r.body, r.sent_at, r.ok, r.error, r.media, u.name AS sent_by FROM ebay_message_replies r LEFT JOIN users u ON u.id = r.sent_by
    WHERE r.message_row_id = ANY($1) ORDER BY r.sent_at`, [(await hub.conversationRows(m)).map(r => r.id)])).rows;
  const thread = (await query(`SELECT id, subject, LEFT(COALESCE(body,''), 400) AS body, received_at, replied FROM ebay_messages
    WHERE store_code = $1 AND sender = $2 AND id <> $3 AND item_id IS DISTINCT FROM $4 ORDER BY received_at DESC LIMIT 10`,
    [m.store_code, m.sender, m.id, m.item_id])).rows;
  // One conversation, oldest first: what eBay's email carries + replies sent
  // from here since (until eBay's next email includes them).
  // Open the conversation from its newest email (it carries the history).
  const latest = convRows[convRows.length - 1] || m;
  // Merge every email in the conversation (each carries some history; the
  // newest may only hold the last message), oldest first, no repeats. A
  // buyer email that's only a photo becomes its own photo bubble.
  const nrm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const conv = [];
  const hasMedia = url => conv.some(c => (c.media || []).some(x => x.url === url));
  for (const r of convRows.length ? convRows : [m]) {
    const parts = hub.parseConversation(r.body, m.sender);
    const own = String(r.body || '').split(/\nNew message from/i)[0].trim();
    parts.forEach((x, i) => {
      if (!x.text || conv.some(c => c.text && nrm(c.text) === nrm(x.text))) return;
      if (i === parts.length - 1 && x.from === 'buyer' && !x.at) x.at = r.received_at;
      conv.push({ ...x });
    });
    const media = (Array.isArray(r.media) ? r.media : []).filter(x => !hasMedia(x.url));
    if (!media.length) continue;
    const target = own ? conv.find(c => c.from === 'buyer' && nrm(c.text) === nrm(own)) : null;
    if (target) target.media = [...(target.media || []), ...media];
    else conv.push({ from: 'buyer', text: '', media, at: r.received_at });
  }
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const known = new Set(conv.map(x => norm(x.text)));
  for (const rp of replies) if (!known.has(norm(rp.body))) conv.push({ from: 'us', text: rp.body, at: rp.sent_at, by: rp.sent_by, ok: rp.ok, error: rp.error, media: rp.media || [] });

  const order = await hub.orderForMessage(m);
  const needs = (await query(`SELECT ${hub.NEEDS_REPLY_SQL} AS n, ${hub.EBAY_SQL} AS e FROM ebay_messages WHERE id = $1`, [latest.id])).rows[0] || {};
  res.json({ message: { ...m, id: latest.id, is_read: true, needs_reply: !!needs.n, is_ebay: !!needs.e, done: latest.done }, conversation: conv, replies, thread, order });
}));

// Photos for a reply → eBay Picture Services; returns their eBay URLs.
router.post('/messages/:id/photos', requirePermission('dispatch'), express.json({ limit: '40mb' }), aw(async (req, res) => {
  res.json({ photos: await hub.uploadPhotos(parseInt(req.params.id), Array.isArray(req.body?.files) ? req.body.files : []) });
}));
router.post('/messages/:id/reply', requirePermission('dispatch'), aw(async (req, res) => {
  const media = (Array.isArray(req.body?.media) ? req.body.media : []).filter(x => x && /^https:\/\/i\.ebayimg\.com\//.test(String(x.url || '')));
  const r = await hub.reply(parseInt(req.params.id), req.body?.body, req.user.id, media);
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
