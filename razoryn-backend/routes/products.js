// routes/products.js — product catalogue + barcode lookup
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();

// All product routes require auth.
router.use(requireAuth);

// Self-healing migration: per-product location detail columns.
//   location_note            — free text, e.g. "3rd shelf, behind the door"
//   location_photo_data_url  — base64 photo of exactly where THIS item sits
// Stored as base64 in the DB (not on disk) so they survive Railway redeploys,
// matching how location-area photos are stored. Idempotent.
let _prodLocMigrated = false;
async function ensureProductLocationColumns() {
  if (_prodLocMigrated) return;
  try {
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS location_note TEXT`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS location_photo_data_url TEXT`);
    _prodLocMigrated = true;
  } catch (e) { console.warn('[products] location-columns migration warning:', e.message); }
}
ensureProductLocationColumns();

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
                   'location_id', 'active', 'location_note', 'location_photo_data_url'];
  // Map camelCase -> snake_case
  const map = { partNumber: 'part_number', lowStockThreshold: 'low_stock_threshold',
                priceShopify: 'price_shopify', priceEbay: 'price_ebay',
                costPrice: 'cost_price', locationId: 'location_id',
                locationNote: 'location_note', locationPhotoDataUrl: 'location_photo_data_url' };
  const sets = [], params = [];
  // Make sure the per-product location columns exist before we try to set them
  if (req.body && (req.body.locationNote !== undefined || req.body.locationPhotoDataUrl !== undefined)) {
    await ensureProductLocationColumns();
  }
  // Guard: location photo data URL must be a reasonable size. The data URL is
  // base64-encoded, so it's ~33% larger than the raw image — 7 MB string ≈ 5 MB
  // image. The frontend auto-downscales to ~400 KB, so this cap is a safety net.
  if (typeof req.body?.locationPhotoDataUrl === 'string' && req.body.locationPhotoDataUrl.length > 7_000_000) {
    return res.status(413).json({ error: 'photo_too_large', message: 'Location photo is too large — please use an image under 5 MB.' });
  }
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
  // Audit without the huge base64 blob
  const auditBody = { ...req.body };
  if (auditBody.locationPhotoDataUrl) auditBody.locationPhotoDataUrl = '[photo]';
  await audit(req, 'update_product', 'product', rows[0].id, auditBody);
  res.json({ product: rows[0] });
});

// Shared helper: push a product's current qty_on_hand to Shopify AND every
// eBay store it's linked to (via mirror_links). Used by adjust-stock + the
// product PATCH so manual quantity edits actually propagate to the channels.
//
// Returns { shopify, ebay: [...] } describing what happened, with errors
// captured per-channel so one failure doesn't block the others.
async function pushProductStockToChannels(productId) {
  const result = { shopify: null, ebay: [] };
  // Load the product + its eBay links
  const pr = await query(
    `SELECT id, sku, qty_on_hand, shopify_inventory_id, shopify_product_id FROM products WHERE id = $1`,
    [productId]
  );
  const product = pr.rows[0];
  if (!product) return result;

  // --- Shopify push ---
  try {
    const shopify = require('../services/shopify');
    if (shopify.isConfigured() && product.shopify_inventory_id) {
      await shopify.pushStockForProduct(product);
      result.shopify = { ok: true, qty: product.qty_on_hand };
    } else {
      result.shopify = { skipped: product.shopify_inventory_id ? 'shopify_not_configured' : 'no_inventory_id' };
    }
  } catch (e) {
    result.shopify = { error: e.message };
  }

  // --- eBay push (per linked store) ---
  // Find every eBay listing linked to this product via mirror_links. Each row
  // carries the ItemID + which store it belongs to. We use ReviseInventoryStatus
  // (Trading API) which works for Calibre's legacy listings.
  try {
    const ebay = require('../services/ebay');
    const links = await query(
      `SELECT ebay_item_id, store_code FROM mirror_links
       WHERE shopify_product_id::text = $1`,
      [product.shopify_product_id]
    );
    for (const link of links.rows) {
      // Skip stores with no token / disabled
      const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
      const store = stores.find(s => s.code === link.store_code)
        || (link.store_code ? null : stores.find(s => s.primary) || stores[0]);
      if (!store) {
        result.ebay.push({ itemId: link.ebay_item_id, store: link.store_code, skipped: 'store_unavailable' });
        continue;
      }
      try {
        await ebay.setQuantityTradingAPI(link.ebay_item_id, product.qty_on_hand, store.code);
        result.ebay.push({ itemId: link.ebay_item_id, store: store.code, ok: true, qty: product.qty_on_hand });
      } catch (e) {
        result.ebay.push({ itemId: link.ebay_item_id, store: store.code, error: e.message });
      }
    }
    if (links.rows.length === 0) result.ebay.push({ skipped: 'no_ebay_links' });
  } catch (e) {
    result.ebay.push({ error: e.message });
  }

  return result;
}

// POST /api/products/:id/adjust-stock  { delta, reason, notes, push }
// Direct stock adjustment that records a movement. When push !== false, the
// new quantity is propagated to Shopify + all linked eBay stores.
router.post('/:id/adjust-stock', requirePermission('inventory'), async (req, res) => {
  const { delta, reason = 'manual', notes, push = true } = req.body || {};
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

  // Propagate the new quantity to channels (unless explicitly disabled)
  let channelPush = null;
  if (push !== false) {
    try { channelPush = await pushProductStockToChannels(result.id); }
    catch (e) { channelPush = { error: e.message }; }
  }

  res.json({ product: result, channelPush });
});

// POST /api/products/:id/set-quantity  { quantity, push }
// Set an ABSOLUTE quantity (not a delta). Records the implied movement and
// pushes to channels. Cleaner for the UI than computing a delta client-side.
router.post('/:id/set-quantity', requirePermission('inventory'), async (req, res) => {
  const { quantity, push = true, notes } = req.body || {};
  const q = parseInt(quantity);
  if (!Number.isInteger(q) || q < 0) return res.status(400).json({ error: 'invalid_quantity' });

  const result = await withTx(async (c) => {
    const before = await c.query(`SELECT qty_on_hand FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows[0]) return null;
    const delta = q - before.rows[0].qty_on_hand;
    const cur = await c.query(`UPDATE products SET qty_on_hand = $1 WHERE id = $2 RETURNING *`, [q, req.params.id]);
    if (delta !== 0) {
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, notes, performed_by)
         VALUES ($1,$2,'manual',$3,$4)`,
        [req.params.id, delta, notes || 'Set absolute quantity', req.user.id]
      );
    }
    return cur.rows[0];
  });
  if (!result) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'set_quantity', 'product', result.id, { quantity: q });

  let channelPush = null;
  if (push !== false) {
    try { channelPush = await pushProductStockToChannels(result.id); }
    catch (e) { channelPush = { error: e.message }; }
  }
  res.json({ product: result, channelPush });
});

// POST /api/products/pull-ebay-stock — for every product with eBay links,
// read the live quantity from eBay and update qty_on_hand to match. Use this
// to fix products showing 0 in the app when eBay actually has stock (the
// import only reads Shopify levels). Admin-only; uses GetItem per linked item.
router.post('/pull-ebay-stock', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
  if (stores.length === 0) return res.json({ ok: true, updated: 0, message: 'No active eBay stores.' });

  // Get all linked products (those with a mirror_links row)
  const links = await query(`
    SELECT ml.ebay_item_id, ml.store_code, p.id AS product_id, p.sku, p.qty_on_hand
    FROM mirror_links ml
    JOIN products p ON p.shopify_product_id = ml.shopify_product_id::text
    WHERE p.active = true
    LIMIT 2000
  `);

  let updated = 0, checked = 0, unchanged = 0;
  const errors = [];
  for (const link of links.rows) {
    const store = stores.find(s => s.code === link.store_code) || (link.store_code ? null : stores[0]);
    if (!store) continue;
    checked++;
    try {
      const ebayQty = await ebay.getQuantityTradingAPI(link.ebay_item_id, store.code);
      if (ebayQty !== link.qty_on_hand) {
        await query(`UPDATE products SET qty_on_hand = $1 WHERE id = $2`, [ebayQty, link.product_id]);
        updated++;
      } else {
        unchanged++;
      }
    } catch (e) {
      errors.push({ itemId: link.ebay_item_id, sku: link.sku, error: e.message });
      // Bail early if we hit the rate limit — no point hammering
      if (/usage limit|exceeded|21917/i.test(e.message)) {
        errors.push({ fatal: 'eBay API quota exceeded — stopping. Try again after the daily reset.' });
        break;
      }
    }
  }
  await audit(req, 'pull_ebay_stock', null, null, { checked, updated });
  res.json({ ok: true, checked, updated, unchanged, errors: errors.slice(0, 20) });
});
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
