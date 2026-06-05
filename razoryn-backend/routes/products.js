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
    // Phase 3A: 1 item photo + 2 location photos, plus which one is the thumbnail.
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_photo_data_url TEXT`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS location_photo_data_url_2 TEXT`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS primary_photo TEXT`);
    // updated_at lets the frontend cache-bust photo URLs (?v=updated_at) when an
    // image changes — without it, edited photos could serve stale from cache.
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`);
    _prodLocMigrated = true;
  } catch (e) { console.warn('[products] location-columns migration warning:', e.message); }
}
ensureProductLocationColumns();

// Decode a base64 data URL stored in the DB and stream it as a cached binary
// image, so list payloads don't have to inline megabytes of base64.
function sendPhoto(res, dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.send(Buffer.from(m[2], 'base64'));
}

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
  // Don't ship base64 photos in the list — they ballooned the payload (every
  // product carried full data URLs). Replace with booleans; the frontend
  // lazy-loads each image from its photo endpoint.
  for (const r of rows) {
    r.has_item_photo = !!r.item_photo_data_url;
    r.has_location_photo = !!r.location_photo_data_url;
    r.has_location_photo_2 = !!r.location_photo_data_url_2;
    delete r.item_photo_data_url;
    delete r.location_photo_data_url;
    delete r.location_photo_data_url_2;
  }
  res.json({ products: rows, total: count.rows[0].n, page, pageSize });
});

// Per-product photo endpoints — stream the stored base64 as cached binary
// instead of inlining it. `private` cache because they're behind auth (must not
// be stored by shared proxies); callers cache-bust with ?v=<updated_at>.
// 404 when the slot is empty.
router.get('/:id/item-photo', requirePermission('locations'), async (req, res) => {
  const { rows } = await query('SELECT item_photo_data_url FROM products WHERE id = $1', [req.params.id]);
  return sendPhoto(res, rows[0] && rows[0].item_photo_data_url);
});
router.get('/:id/location-photo', requirePermission('locations'), async (req, res) => {
  const { rows } = await query('SELECT location_photo_data_url FROM products WHERE id = $1', [req.params.id]);
  return sendPhoto(res, rows[0] && rows[0].location_photo_data_url);
});
router.get('/:id/location-photo-2', requirePermission('locations'), async (req, res) => {
  const { rows } = await query('SELECT location_photo_data_url_2 FROM products WHERE id = $1', [req.params.id]);
  return sendPhoto(res, rows[0] && rows[0].location_photo_data_url_2);
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

// GET /api/products/shopify-collections — all Shopify custom collections (for
// the picker). Declared BEFORE /:id so the literal path isn't caught by :id.
router.get('/shopify-collections', requireAdmin, async (req, res) => {
  try { res.json({ collections: await require('../services/shopify').getCustomCollections() }); }
  catch (e) { res.status(502).json({ error: 'shopify_error', message: e.message }); }
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
                   'location_id', 'active', 'location_note', 'location_photo_data_url',
                   'item_photo_data_url', 'location_photo_data_url_2', 'primary_photo'];
  // Map camelCase -> snake_case
  const map = { partNumber: 'part_number', lowStockThreshold: 'low_stock_threshold',
                priceShopify: 'price_shopify', priceEbay: 'price_ebay',
                costPrice: 'cost_price', locationId: 'location_id',
                locationNote: 'location_note', locationPhotoDataUrl: 'location_photo_data_url',
                itemPhotoDataUrl: 'item_photo_data_url',
                locationPhotoDataUrl2: 'location_photo_data_url_2',
                primaryPhoto: 'primary_photo' };
  const sets = [], params = [];
  // Always ensure the per-product location/photo columns (incl. updated_at)
  // exist before we touch them — cheap (cached after first run).
  await ensureProductLocationColumns();
  // Guard: photo data URLs must be a reasonable size. The data URL is base64,
  // so ~33% larger than the raw image — 7 MB string ≈ 5 MB image. The frontend
  // auto-downscales to ~400 KB, so this cap is just a safety net.
  for (const f of ['itemPhotoDataUrl', 'locationPhotoDataUrl', 'locationPhotoDataUrl2']) {
    if (typeof req.body?.[f] === 'string' && req.body[f].length > 7_000_000) {
      return res.status(413).json({ error: 'photo_too_large', message: 'Photo is too large — please use an image under 5 MB.' });
    }
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
  // Bump updated_at so the frontend's ?v= cache-buster sees changed photos.
  const { rows } = await query(
    `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  // Audit without the huge base64 blobs
  const auditBody = { ...req.body };
  for (const f of ['itemPhotoDataUrl', 'locationPhotoDataUrl', 'locationPhotoDataUrl2']) {
    if (auditBody[f]) auditBody[f] = '[photo]';
  }
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

// ---------- Shopify collections (shop categories) + live stock ----------
const _shopify = () => require('../services/shopify');

// GET /api/products/:id/shopify-stock — live Shopify available qty (Match button).
router.get('/:id/shopify-stock', requireAdmin, async (req, res) => {
  const pr = await query('SELECT shopify_inventory_id, qty_on_hand FROM products WHERE id = $1', [req.params.id]);
  if (!pr.rows[0]) return res.status(404).json({ error: 'not_found' });
  const invId = pr.rows[0].shopify_inventory_id;
  if (!invId) return res.json({ stock: null, warehouse: pr.rows[0].qty_on_hand, notLinked: true });
  try { res.json({ stock: await _shopify().getInventoryLevel(invId), warehouse: pr.rows[0].qty_on_hand }); }
  catch (e) { res.status(502).json({ error: 'shopify_error', message: e.message }); }
});

// GET /api/products/:id/shopify-price — live Shopify variant price. Used by the
// eBay listing form's "From Shopify +%" button when the cached price is absent.
// Falls back to the stored price_shopify column if the live fetch isn't possible.
router.get('/:id/shopify-price', requireAdmin, async (req, res) => {
  const pr = await query('SELECT shopify_product_id, price_shopify FROM products WHERE id = $1', [req.params.id]);
  const row = pr.rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!row.shopify_product_id) {
    return res.json({ price: row.price_shopify != null ? parseFloat(row.price_shopify) : null, source: 'warehouse', notLinked: true });
  }
  try {
    const full = await _shopify().getShopifyProductFull(row.shopify_product_id);
    const price = full.price != null ? full.price : (row.price_shopify != null ? parseFloat(row.price_shopify) : null);
    res.json({ price, source: full.price != null ? 'shopify' : 'warehouse' });
  } catch (e) {
    // Live fetch failed — fall back to the stored price rather than erroring.
    res.json({ price: row.price_shopify != null ? parseFloat(row.price_shopify) : null, source: 'warehouse', error: e.message });
  }
});

// GET /api/products/:id/collections — which collections this product is in.
router.get('/:id/collections', requireAdmin, async (req, res) => {
  const pr = await query('SELECT shopify_product_id FROM products WHERE id = $1', [req.params.id]);
  const spid = pr.rows[0] && pr.rows[0].shopify_product_id;
  if (!spid) return res.json({ collects: [], notLinked: true });
  try { res.json({ collects: await _shopify().getProductCollects(spid) }); }
  catch (e) { res.status(502).json({ error: 'shopify_error', message: e.message }); }
});

// POST /api/products/:id/collections { collectionId } — add to a collection.
router.post('/:id/collections', requireAdmin, async (req, res) => {
  const pr = await query('SELECT shopify_product_id FROM products WHERE id = $1', [req.params.id]);
  const spid = pr.rows[0] && pr.rows[0].shopify_product_id;
  if (!spid) return res.status(400).json({ error: 'not_linked_to_shopify' });
  if (!(req.body && req.body.collectionId)) return res.status(400).json({ error: 'collectionId required' });
  try {
    const r = await _shopify().addProductToCollection(spid, req.body.collectionId);
    await audit(req, 'add_to_collection', 'product', req.params.id, { collectionId: req.body.collectionId });
    res.json(r);
  } catch (e) { res.status(502).json({ error: 'shopify_error', message: (e.response && e.response.data && e.response.data.errors) || e.message }); }
});

// DELETE /api/products/:id/collections/:collectId — remove from a collection.
router.delete('/:id/collections/:collectId', requireAdmin, async (req, res) => {
  try {
    await _shopify().removeCollect(req.params.collectId);
    await audit(req, 'remove_from_collection', 'product', req.params.id, { collectId: req.params.collectId });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'shopify_error', message: e.message }); }
});

// ---------- SEO optimiser (search-engine listing) ----------
const _brand = () => require('../lib/brand');
const _seo = () => require('../lib/seo');

// POST /api/products/seo/preview  { ids?: [productId,...] }
// Generates proposed SEO (title/meta/handle/category) for the given products
// (or all Shopify-linked active products if ids omitted) and pairs it with each
// product's CURRENT Shopify values, so the UI can show a before/after table.
// Read-only — writes nothing.
router.post('/seo/preview', requireAdmin, async (req, res) => {
  const brandCfg = _brand();
  const seo = _seo();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const params = [];
  let where = 'active = true AND shopify_product_id IS NOT NULL';
  if (ids && ids.length) { params.push(ids); where += ` AND id = ANY($1)`; }
  const { rows } = await query(
    `SELECT id, sku, title, brand, model, part_number, shopify_product_id
       FROM products WHERE ${where} ORDER BY title LIMIT 500`, params);

  const shopify = require('../services/shopify');
  const out = [];
  for (const p of rows) {
    const proposed = seo.buildSeo(p, brandCfg);
    let current = null, category = null;
    try { current = await shopify.getProductSeo(p.shopify_product_id); } catch (e) { /* surfaced as null */ }
    if (proposed.categoryQuery) {
      try { category = await shopify.findTaxonomyCategory(proposed.categoryQuery); } catch (e) {}
    }
    out.push({
      id: p.id, sku: p.sku, title: p.title, shopifyProductId: p.shopify_product_id,
      proposed: {
        pageTitle: proposed.pageTitle,
        metaDescription: proposed.metaDescription,
        handle: proposed.handle,
        partType: proposed.partType,
        categoryId: category?.id || null,
        categoryName: category?.fullName || null,
        categoryQuery: proposed.categoryQuery,
      },
      current: current ? {
        handle: current.handle,
        pageTitle: current.seoTitle,
        metaDescription: current.seoDescription,
        categoryName: current.categoryName,
      } : null,
      unrecognisedPartType: !proposed.partType,
    });
  }
  res.json({ items: out, count: out.length });
});

// POST /api/products/seo/apply  { items: [{ shopifyProductId, pageTitle, metaDescription, handle, categoryId }] }
// Writes the (user-reviewed) SEO fields to Shopify. Each item is applied
// independently so one failure doesn't abort the batch.
router.post('/seo/apply', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const shopify = require('../services/shopify');
  const results = [];
  for (const it of items) {
    if (!it.shopifyProductId) { results.push({ id: it.id, ok: false, error: 'missing shopifyProductId' }); continue; }
    try {
      const r = await shopify.applyProductSeo(it.shopifyProductId, {
        seoTitle: it.pageTitle,
        seoDescription: it.metaDescription,
        handle: it.handle || undefined,
        categoryId: it.categoryId || undefined,
      });
      results.push({ id: it.id, ok: r.ok, userErrors: r.userErrors, newHandle: r.product?.handle });
    } catch (e) {
      results.push({ id: it.id, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  await audit(req, 'seo_bulk_apply', 'product', null, { applied: okCount, total: items.length });
  res.json({ applied: okCount, total: items.length, results });
});

module.exports = router;
// Reusable by other routers (e.g. Listing Mirror set-stock) so a quantity edit
// propagates to Shopify + every linked eBay store consistently.
module.exports.pushProductStockToChannels = pushProductStockToChannels;
