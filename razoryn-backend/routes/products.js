// routes/products.js — product catalogue + barcode lookup
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();

// All product routes require auth.
router.use(requireAuth);

// GET /api/products?search=&brand=&lowStock=1&page=1&pageSize=50
router.get('/', requirePermission('inventory'), async (req, res) => {
  const { search = '', brand = '', lowStock } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

  const where = ['active = true'];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    where.push(`(title ILIKE $${i} OR sku ILIKE $${i} OR part_number ILIKE $${i} OR barcode = $${params.length === i ? i : i})`);
  }
  if (brand) { params.push(brand); where.push(`brand = $${params.length}`); }
  if (lowStock === '1') where.push('qty_on_hand <= low_stock_threshold');

  const sql = `
    SELECT p.*, l.code AS location_code, l.name AS location_name
    FROM products p
    LEFT JOIN locations l ON l.id = p.location_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.title
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `;
  const { rows } = await query(sql, params);
  const count = await query(`SELECT COUNT(*)::int AS n FROM products WHERE ${where.join(' AND ')}`, params);
  res.json({ products: rows, total: count.rows[0].n, page, pageSize });
});

// GET /api/products/barcode/:code  — quick scan lookup
router.get('/barcode/:code', requirePermission('scan'), async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, l.code AS location_code, l.name AS location_name
     FROM products p
     LEFT JOIN locations l ON l.id = p.location_id
     WHERE p.barcode = $1 OR p.sku = $1
     LIMIT 1`,
    [req.params.code]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ product: rows[0] });
});

// GET /api/products/low-stock
router.get('/low-stock', requirePermission('inventory'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, sku, title, qty_on_hand, low_stock_threshold, brand, model
     FROM products
     WHERE active = true AND qty_on_hand <= low_stock_threshold
     ORDER BY qty_on_hand ASC, title`
  );
  res.json({ products: rows });
});

// GET /api/products/:id
router.get('/:id', requirePermission('inventory'), async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, l.code AS location_code, l.name AS location_name
     FROM products p LEFT JOIN locations l ON l.id = p.location_id
     WHERE p.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ product: rows[0] });
});

// POST /api/products  (admin only — direct create)
router.post('/', requireAdmin, async (req, res) => {
  const p = req.body || {};
  if (!p.sku || !p.title) return res.status(400).json({ error: 'sku_and_title_required' });
  try {
    const { rows } = await query(
      `INSERT INTO products (sku, title, brand, model, part_number, position, barcode,
                             qty_on_hand, low_stock_threshold, price_shopify, price_ebay,
                             cost_price, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [p.sku, p.title, p.brand || null, p.model || null, p.partNumber || null,
       p.position || null, p.barcode || null,
       p.qtyOnHand || 0, p.lowStockThreshold || 2,
       p.priceShopify || null, p.priceEbay || null, p.costPrice || null,
       p.locationId || null]
    );
    await audit(req, 'create_product', 'product', rows[0].id, { sku: p.sku });
    res.status(201).json({ product: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'sku_exists' });
    throw e;
  }
});

// PATCH /api/products/:id  — update fields (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['title', 'brand', 'model', 'part_number', 'position', 'barcode',
                   'low_stock_threshold', 'price_shopify', 'price_ebay', 'cost_price',
                   'location_id', 'active'];
  // Map camelCase -> snake_case
  const map = { partNumber: 'part_number', lowStockThreshold: 'low_stock_threshold',
                priceShopify: 'price_shopify', priceEbay: 'price_ebay',
                costPrice: 'cost_price', locationId: 'location_id' };
  const sets = [], params = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    const col = map[k] || k;
    if (allowed.includes(col)) {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_product', 'product', rows[0].id, req.body);
  res.json({ product: rows[0] });
});

// POST /api/products/:id/adjust-stock  { delta, reason, notes }
// Direct stock adjustment that records a movement.
router.post('/:id/adjust-stock', requirePermission('inventory'), async (req, res) => {
  const { delta, reason = 'manual', notes } = req.body || {};
  const d = parseInt(delta);
  if (!Number.isInteger(d) || d === 0) return res.status(400).json({ error: 'delta_required' });

  const result = await withTx(async (c) => {
    const cur = await c.query(
      `UPDATE products SET qty_on_hand = qty_on_hand + $1
       WHERE id = $2 RETURNING *`,
      [d, req.params.id]
    );
    if (!cur.rows[0]) return null;
    await c.query(
      `INSERT INTO stock_movements (product_id, delta, reason, notes, performed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, d, reason, notes || null, req.user.id]
    );
    return cur.rows[0];
  });
  if (!result) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'adjust_stock', 'product', result.id, { delta: d, reason });
  res.json({ product: result });
});

// DELETE /api/products/:id  — soft delete by default (admin).
// Pass ?hard=true&shopify=true to also delete from Shopify.
router.delete('/:id', requireAdmin, async (req, res) => {
  const hard = req.query.hard === 'true';
  const removeFromShopify = req.query.shopify === 'true';
  const { rows: productRows } = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ error: 'not_found' });

  // Optionally delete from Shopify first
  if (removeFromShopify && product.shopify_product_id) {
    try {
      const shopify = require('../services/shopify');
      if (shopify.isConfigured()) {
        const axios = require('axios');
        // Use direct API call rather than adding a method just for this
        await axios.delete(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION || '2025-01'}/products/${product.shopify_product_id}.json`,
          { headers: { 'X-Shopify-Access-Token': await shopify.getAccessToken() } }
        );
      }
    } catch (e) {
      console.warn('[products] shopify delete failed:', e.message);
      // Continue with local delete even if Shopify fails
    }
  }

  if (hard) {
    await query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
  } else {
    await query(`UPDATE products SET active = false WHERE id = $1`, [req.params.id]);
  }
  await audit(req, hard ? 'hard_delete_product' : 'delete_product', 'product', req.params.id, { removeFromShopify });
  res.json({ ok: true });
});

module.exports = router;
