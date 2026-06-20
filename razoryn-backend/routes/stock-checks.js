// routes/stock-checks.js — feature 2: employee stock-check workflow
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// POST /api/stock-checks  { productId, actualQty, reason, notes, photoPath }
// Records a stock check. If actualQty != expected, applies the variance and
// logs a stock movement so the audit trail stays complete.
router.post('/', requirePermission('scan'), async (req, res) => {
  const { productId, actualQty, reason, notes, photoPath, forcePush } = req.body || {};
  if (!productId || actualQty == null) {
    return res.status(400).json({ error: 'productId_and_actualQty_required' });
  }

  const result = await withTx(async (c) => {
    const p = await c.query(
      `SELECT id, qty_on_hand FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );
    if (!p.rows[0]) return { error: 'product_not_found' };
    const expected = p.rows[0].qty_on_hand;
    const variance = actualQty - expected;

    const sc = await c.query(
      `INSERT INTO stock_checks (product_id, expected_qty, actual_qty, reason, notes, photo_path, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId, expected, actualQty, reason || null, notes || null, photoPath || null, req.user.id]
    );

    if (variance !== 0) {
      await c.query(
        `UPDATE products SET qty_on_hand = $1 WHERE id = $2`,
        [actualQty, productId]
      );
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, notes, performed_by)
         VALUES ($1,$2,'stock_check',$3,$4,$5)`,
        [productId, variance, sc.rows[0].id, reason || null, req.user.id]
      );
    }
    return { check: sc.rows[0], variance };
  });

  if (result.error) return res.status(404).json({ error: result.error });
  await audit(req, 'stock_check', 'product', productId, { variance: result.variance });

  // Push the counted quantity to Shopify + every linked eBay store immediately.
  // We push whenever the count CHANGED the system qty, and also when the caller
  // asks (forcePush) — the latter reconciles the channels even when the system
  // already matched, catching channel drift so a sold-out item can't be oversold
  // during a stock-take. Best-effort — never fail the stock check.
  let channelPush = null;
  if (result.variance !== 0 || forcePush) {
    try {
      const { pushProductStockToChannels } = require('./products');
      channelPush = await pushProductStockToChannels(productId);
    } catch (e) { channelPush = { error: e.message }; }
  }
  res.status(201).json({ ...result, channelPush });
});

// GET /api/stock-checks?productId=&days=30
router.get('/', requirePermission('inventory'), async (req, res) => {
  const { productId, days = 30 } = req.query;
  const where = ['sc.created_at > now() - $1::interval'];
  const params = [`${parseInt(days)} days`];
  if (productId) { params.push(productId); where.push(`sc.product_id = $${params.length}`); }
  const { rows } = await query(`
    SELECT sc.*, p.sku, p.title, u.name AS performed_by_name
    FROM stock_checks sc
    JOIN products p ON p.id = sc.product_id
    LEFT JOIN users u ON u.id = sc.performed_by
    WHERE ${where.join(' AND ')}
    ORDER BY sc.created_at DESC
    LIMIT 200
  `, params);
  res.json({ checks: rows });
});

// GET /api/stock-checks/this-month — product IDs counted in the current calendar
// month, for the monthly stock-take checklist (progress + resume across devices).
router.get('/this-month', requirePermission('scan'), async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT product_id FROM stock_checks
     WHERE created_at >= date_trunc('month', now())`
  );
  res.json({ productIds: rows.map(r => r.product_id) });
});

module.exports = router;
