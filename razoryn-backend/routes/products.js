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
  // Cap raised to 1000 (from 200) so the frontend can load the entire catalogue
  // in one request — inventory/stock-check/location search all filter the
  // in-memory product list client-side, so every product must be loaded or it's
  // invisible to search. With ~540 products one request covers everything; the
  // frontend also paginates as a safety net for catalogues beyond 1000.
  const pageSize = Math.min(1000, Math.max(1, parseInt(req.query.pageSize) || 50));

  const where = ['active = true'];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    // All four columns use ILIKE for consistent partial matching. The barcode
    // clause previously used exact `= $i` against a wildcard-wrapped param, so
    // it never matched anything — now it's ILIKE like the others.
    where.push(`(title ILIKE $${i} OR sku ILIKE $${i} OR part_number ILIKE $${i} OR barcode ILIKE $${i})`);
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

// GET /api/products/diagnose/:sku — trace a SKU across products + mirror_links
// to explain WHY it might show in Listing Mirror but not in inventory search.
// MUST be defined before GET /:id, otherwise "diagnose" is captured as an :id.
router.get('/diagnose/:sku', requireAdmin, async (req, res) => {
  const sku = (req.params.sku || '').trim();
  const out = { sku, findings: [] };

  const exact = await query(
    `SELECT id, sku, title, active, shopify_product_id, barcode, part_number, location_id, qty_on_hand
     FROM products WHERE sku = $1`, [sku]);
  out.exactProductMatch = exact.rows;

  const fuzzy = await query(
    `SELECT id, sku, title, active, qty_on_hand,
            ('[' || sku || ']') AS sku_with_brackets, length(sku) AS sku_len
     FROM products WHERE TRIM(LOWER(sku)) = TRIM(LOWER($1))`, [sku]);
  out.fuzzyProductMatch = fuzzy.rows;

  const ilike = await query(
    `SELECT id, sku, title, active FROM products WHERE sku ILIKE $1 LIMIT 10`, [`%${sku}%`]);
  out.ilikeMatch = ilike.rows;

  const ml = await query(
    `SELECT ebay_item_id, shopify_product_id, store_code, last_synced_sku, last_synced_title
     FROM mirror_links WHERE last_synced_sku = $1 OR last_synced_sku ILIKE $2`, [sku, `%${sku}%`]);
  out.mirrorLinkMatch = ml.rows;

  out.mirrorLinkProductCheck = [];
  for (const link of ml.rows) {
    const prodForLink = await query(
      `SELECT id, sku, title, active FROM products WHERE shopify_product_id = $1::text`,
      [link.shopify_product_id]);
    out.mirrorLinkProductCheck.push({
      ebay_item_id: link.ebay_item_id,
      shopify_product_id: link.shopify_product_id,
      matchingProducts: prodForLink.rows,
      productExists: prodForLink.rows.length > 0,
    });
  }

  if (out.exactProductMatch.length > 0) {
    const p = out.exactProductMatch[0];
    if (!p.active) {
      out.diagnosis = `Product EXISTS (id ${p.id}) but active = ${p.active}. Inventory search filters active=true, so it's hidden. Fix: reactivate.`;
      out.fixAvailable = 'reactivate';
      out.fixProductId = p.id;
    } else {
      out.diagnosis = `Product EXISTS (id ${p.id}) and is active — it should appear in search. If not, the search term may have hidden whitespace; compare sku_len in fuzzyProductMatch.`;
    }
  } else if (out.fuzzyProductMatch.length > 0) {
    out.diagnosis = `No EXACT sku match, but a whitespace/case variant exists. Stored SKU differs from "${sku}". See fuzzyProductMatch for the real value + its length.`;
    out.fixAvailable = 'normalize_sku';
    out.fixProductId = out.fuzzyProductMatch[0].id;
  } else if (out.mirrorLinkMatch.length > 0) {
    const anyProduct = out.mirrorLinkProductCheck.some(c => c.productExists);
    if (!anyProduct) {
      out.diagnosis = `This SKU exists ONLY in mirror_links (eBay↔Shopify link) with NO matching product row. That's why Listing Mirror shows it but inventory search can't find it. The Shopify product was never imported into the warehouse, OR the shopify_product_id didn't match on import. Fix: run Import Shopify products (Settings), or clean the orphan link.`;
      out.fixAvailable = 'reimport_or_orphan';
      out.orphanShopifyIds = out.mirrorLinkProductCheck.map(c => c.shopify_product_id);
    } else {
      out.diagnosis = `mirror_links has this SKU AND a product exists for its shopify_product_id — but the product's OWN sku differs from the eBay last_synced_sku. Search for the product's real SKU (see mirrorLinkProductCheck.matchingProducts), not "${sku}".`;
    }
  } else {
    out.diagnosis = `"${sku}" not found anywhere — not in products, not in mirror_links. Check exact spelling.`;
  }

  res.json(out);
});

// POST /api/products/:id/reactivate — flip active back to true
router.post('/:id/reactivate', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `UPDATE products SET active = true WHERE id = $1 RETURNING id, sku, title, active`,
    [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'reactivate_product', 'product', rows[0].id, {});
  res.json({ ok: true, product: rows[0] });
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

// POST /api/products/bulk-delete — delete multiple products at once.
// Body: { ids: [..], hard: true|false, shopify: true|false }
router.post('/bulk-delete', requireAdmin, async (req, res) => {
  const ids = (req.body.ids || []).map(String);
  const hard = !!req.body.hard;
  const removeFromShopify = !!req.body.shopify;
  if (!ids.length) return res.status(400).json({ error: 'no_ids' });

  const results = { deleted: 0, shopifyDeleted: 0, errors: [] };

  // Pre-fetch products so we have their Shopify IDs even if we hard-delete the rows
  const { rows: products } = await query(
    `SELECT id, shopify_product_id, sku FROM products WHERE id = ANY($1)`, [ids]
  );

  if (removeFromShopify) {
    const shopify = require('../services/shopify');
    if (shopify.isConfigured()) {
      const axios = require('axios');
      const token = await shopify.getAccessToken();
      for (const p of products) {
        if (!p.shopify_product_id) continue;
        try {
          await axios.delete(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION || '2025-01'}/products/${p.shopify_product_id}.json`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          results.shopifyDeleted++;
        } catch (e) {
          results.errors.push({ id: p.id, sku: p.sku, error: e.message });
        }
      }
    }
  }

  // Delete from DB
  if (hard) {
    const r = await query(`DELETE FROM products WHERE id = ANY($1)`, [ids]);
    results.deleted = r.rowCount || 0;
  } else {
    const r = await query(`UPDATE products SET active = false WHERE id = ANY($1)`, [ids]);
    results.deleted = r.rowCount || 0;
  }

  await audit(req, hard ? 'bulk_hard_delete_product' : 'bulk_delete_product', 'product', null, results);
  res.json({ ok: true, ...results });
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
