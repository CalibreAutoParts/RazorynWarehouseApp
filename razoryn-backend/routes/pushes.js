// routes/pushes.js — the eBay Push Queue page's API: what's stuck behind an
// open offer (with the queued payload), retry-now, discard, and the per-item
// change history (before → after breakdown of everything pushed).
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const pushQueue = require('../lib/push-queue');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/pushes/pending — stuck + recently-resolved pushes, product titles joined.
router.get('/pending', async (req, res) => {
  await pushQueue.ensureTables();
  const { rows } = await query(`
    SELECT pp.*, p.title AS product_title, p.sku AS product_sku
      FROM pending_pushes pp
      LEFT JOIN products p ON p.id = pp.product_id
     WHERE pp.status = 'pending'
        OR (pp.status IN ('done','given_up') AND pp.updated_at > now() - interval '7 days')
     ORDER BY (pp.status = 'pending') DESC, pp.updated_at DESC
     LIMIT 300`);
  res.json({ pushes: rows });
});

// POST /api/pushes/retry { id? } — retry one (or every) pending push now.
router.post('/retry', async (req, res) => {
  try {
    const r = await pushQueue.retryPending({ onlyId: req.body?.id ? parseInt(req.body.id) : undefined });
    await audit(req, 'push_retry', null, null, r);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: 'retry_failed', message: e.message }); }
});

// DELETE /api/pushes/:id — discard a queued push (the change is dropped).
router.delete('/:id', async (req, res) => {
  await pushQueue.ensureTables();
  const r = await query(`UPDATE pending_pushes SET status = 'discarded', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_resolved' });
  await audit(req, 'push_discard', 'pending_push', req.params.id);
  res.json({ ok: true });
});

// GET /api/pushes/changes?q=&productId=&itemId=&limit= — the change log.
// q matches the product title / SKU / item id, so "view the breakdown per
// item" is a search away.
router.get('/changes', async (req, res) => {
  await pushQueue.ensureTables();
  const params = [];
  const where = [];
  if (req.query.productId) { params.push(parseInt(req.query.productId)); where.push(`lc.product_id = $${params.length}`); }
  if (req.query.itemId) { params.push(String(req.query.itemId)); where.push(`lc.ebay_item_id = $${params.length}`); }
  if (req.query.q) {
    params.push('%' + req.query.q + '%');
    where.push(`(p.title ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR lc.ebay_item_id ILIKE $${params.length})`);
  }
  const limit = Math.min(500, parseInt(req.query.limit) || 150);
  const { rows } = await query(`
    SELECT lc.*, p.title AS product_title, p.sku AS product_sku
      FROM listing_changes lc
      LEFT JOIN products p ON p.id = lc.product_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY lc.created_at DESC
     LIMIT ${limit}`, params);
  res.json({ changes: rows });
});

module.exports = router;
