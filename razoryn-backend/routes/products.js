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
    // Large-panel flag: marks bulky parts (bumpers, bonnets, doors) that need the
    // dedicated courier. Orders containing one are flagged for routing at ingest.
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS large_panel BOOLEAN NOT NULL DEFAULT false`);
    // Price lock: when true, automated price derivation (eBay→Shopify link, bulk
    // price tools) won't overwrite this product's prices — staff keep it manual.
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_locked BOOLEAN NOT NULL DEFAULT false`);
    // Pre-listing / pre-order: a product created BEFORE its stock arrives. It is
    // listed (Shopify as a pre-order, eBay scheduled to go live) and can be
    // quoted/pre-ordered, but is excluded from the stock-take quantity count.
    //   is_prelisted        — true while awaiting incoming stock
    //   preorder_eta        — expected availability date (drives the notice)
    //   ebay_scheduled_at   — warehouse-held eBay go-live time (we publish it)
    //   ebay_prelist_payload— captured AddItem opts so the cron can publish later
    //   ebay_prelist_status — 'scheduled' | 'live' | 'failed' (NULL = n/a)
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_prelisted BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS preorder_eta DATE`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_scheduled_at TIMESTAMPTZ`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_prelist_payload JSONB`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_prelist_status TEXT`);
    await query(`CREATE INDEX IF NOT EXISTS products_prelisted_idx ON products (is_prelisted) WHERE is_prelisted = true`);
    await query(`CREATE INDEX IF NOT EXISTS products_ebay_sched_idx ON products (ebay_scheduled_at) WHERE ebay_prelist_status = 'scheduled'`);
    _prodLocMigrated = true;
  } catch (e) { console.warn('[products] location-columns migration warning:', e.message); }
}
ensureProductLocationColumns();

// Self-healing migration for the sub part-numbers table (alternate factory codes
// that all resolve to one master SKU). Idempotent; safe on every cold boot.
let _ppnMigrated = false;
async function ensurePartNumbersTable() {
  if (_ppnMigrated) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS product_part_numbers (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS ppn_product_idx ON product_part_numbers (product_id)`);
    await query(`CREATE INDEX IF NOT EXISTS ppn_code_idx ON product_part_numbers (upper(code))`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ppn_product_code_uq ON product_part_numbers (product_id, upper(code))`);
    _ppnMigrated = true;
  } catch (e) { console.warn('[products] part-numbers migration warning:', e.message); }
}
ensurePartNumbersTable();

// Self-healing migration for shared stock pools (one part number shared across
// multiple model listings). Idempotent; safe on every cold boot.
let _sgMigrated = false;
async function ensureStockGroupsSchema() {
  if (_sgMigrated) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS stock_groups (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      note TEXT,
      qty_on_hand INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_group_id INTEGER REFERENCES stock_groups(id) ON DELETE SET NULL`);
    await query(`CREATE INDEX IF NOT EXISTS products_stock_group_idx ON products (stock_group_id) WHERE stock_group_id IS NOT NULL`);
    _sgMigrated = true;
  } catch (e) { console.warn('[products] stock-groups migration warning:', e.message); }
}
ensureStockGroupsSchema();

// Normalise a part number for matching (ignore spaces, dashes, case).
const sgNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

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

  await ensurePartNumbersTable();
  await ensureStockGroupsSchema();
  const where = ['active = true'];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    // All columns use ILIKE for consistent partial matching. Also match any of
    // the product's sub part-numbers so searching an alternate factory/country
    // code surfaces the master SKU.
    where.push(`(title ILIKE $${i} OR sku ILIKE $${i} OR part_number ILIKE $${i} OR barcode ILIKE $${i}
      OR EXISTS (SELECT 1 FROM product_part_numbers ppn WHERE ppn.product_id = p.id AND ppn.code ILIKE $${i}))`);
  }
  if (brand) { params.push(brand); where.push(`brand = $${params.length}`); }
  if (lowStock === '1') where.push('qty_on_hand <= low_stock_threshold');

  const sql = `
    SELECT p.*, l.code AS location_code, l.name AS location_name,
           sg.code AS stock_group_code, sg.note AS stock_group_note
    FROM products p
    LEFT JOIN locations l ON l.id = p.location_id
    LEFT JOIN stock_groups sg ON sg.id = p.stock_group_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.title
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `;
  const { rows } = await query(sql, params);
  const count = await query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where.join(' AND ')}`, params);
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
    // The captured eBay AddItem payload is only needed server-side (cron/publish);
    // don't ship it in the catalogue list.
    delete r.ebay_prelist_payload;
  }
  // Attach incoming/pre-order info per product (units on the way + earliest ETA).
  // Lets the inventory list flag items as pre-order with an arrival date. Done
  // as a separate, guarded query so a cold-boot before the incoming table exists
  // never breaks the products list.
  try {
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const inc = await query(`
        SELECT product_id,
               COALESCE(SUM(GREATEST(qty_ordered - qty_received, 0)), 0)::int AS incoming_qty,
               MIN(expected_date) AS incoming_eta
        FROM incoming_stock
        WHERE product_id = ANY($1) AND status NOT IN ('received','cancelled')
        GROUP BY product_id`, [ids]);
      const map = new Map(inc.rows.map(x => [x.product_id, x]));
      for (const r of rows) {
        const x = map.get(r.id);
        r.incoming_qty = x ? x.incoming_qty : 0;
        r.incoming_eta = x ? x.incoming_eta : null;
      }
    }
  } catch (e) { /* incoming table not ready yet — non-critical */ }
  // Attach sub part-numbers so the client-side search can match them and the UI
  // can show them. Done as one batched query, guarded.
  try {
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const pn = await query(`SELECT id, product_id, code, note FROM product_part_numbers WHERE product_id = ANY($1) ORDER BY id`, [ids]);
      const byProd = new Map();
      for (const x of pn.rows) { if (!byProd.has(x.product_id)) byProd.set(x.product_id, []); byProd.get(x.product_id).push(x); }
      for (const r of rows) r.part_numbers = byProd.get(r.id) || [];
    }
  } catch (e) { for (const r of rows) r.part_numbers = r.part_numbers || []; }
  res.json({ products: rows, total: count.rows[0].n, page, pageSize });
});

// ── Sub part-numbers (alternate factory/country codes) for a product ─────────
router.get('/:id/part-numbers', requirePermission('inventory'), async (req, res) => {
  await ensurePartNumbersTable();
  const { rows } = await query(`SELECT id, code, note, created_at FROM product_part_numbers WHERE product_id = $1 ORDER BY id`, [req.params.id]);
  res.json({ partNumbers: rows });
});
router.post('/:id/part-numbers', requirePermission('inventory'), async (req, res) => {
  await ensurePartNumbersTable();
  const code = String(req.body?.code || '').trim();
  const note = req.body?.note != null ? String(req.body.note).trim() || null : null;
  if (!code) return res.status(400).json({ error: 'code_required' });
  const p = await query(`SELECT id FROM products WHERE id = $1`, [req.params.id]);
  if (!p.rows[0]) return res.status(404).json({ error: 'product_not_found' });
  try {
    const { rows } = await query(
      `INSERT INTO product_part_numbers (product_id, code, note) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, upper(code)) DO UPDATE SET note = EXCLUDED.note
       RETURNING id, code, note, created_at`,
      [req.params.id, code, note]
    );
    await audit(req, 'add_part_number', 'product', Number(req.params.id), { code, note });
    res.json({ ok: true, partNumber: rows[0] });
  } catch (e) { res.status(500).json({ error: 'insert_failed', message: e.message }); }
});
router.delete('/:id/part-numbers/:pnId', requirePermission('inventory'), async (req, res) => {
  await ensurePartNumbersTable();
  await query(`DELETE FROM product_part_numbers WHERE id = $1 AND product_id = $2`, [req.params.pnId, req.params.id]);
  await audit(req, 'remove_part_number', 'product', Number(req.params.id), { pnId: req.params.pnId });
  res.json({ ok: true });
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

// ─────────────── Shared stock pools (one part number, many model listings) ───────────────
// NOTE: every literal route here MUST be defined before GET /:id, otherwise
// "stock-groups" is captured as an :id.

// Set a group's shared qty and mirror it to every member, pushing each to its
// channels. Used by create + PATCH. Returns the ids that were pushed.
async function setStockGroupQty(groupId, qty) {
  await query(`UPDATE stock_groups SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, groupId]);
  const members = await query(`SELECT id FROM products WHERE stock_group_id = $1`, [groupId]);
  const pushed = [];
  for (const m of members.rows) {
    await query(`UPDATE products SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, m.id]);
    try { await pushProductStockToChannels(m.id, { skipGroup: true }); pushed.push(m.id); } catch (_) {}
  }
  return pushed;
}

// GET /api/products/stock-groups — every pool with its member listings.
router.get('/stock-groups', requirePermission('inventory'), async (req, res) => {
  await ensureStockGroupsSchema();
  const groups = await query(`SELECT id, code, note, qty_on_hand, created_at, updated_at FROM stock_groups ORDER BY code`);
  const members = await query(
    `SELECT p.id, p.sku, p.title, p.brand, p.model, p.part_number, p.qty_on_hand, p.image_url, p.stock_group_id
     FROM products p WHERE p.stock_group_id IS NOT NULL AND p.active = true
     ORDER BY p.brand NULLS LAST, p.model NULLS LAST, p.title`);
  const byGroup = new Map();
  for (const m of members.rows) { if (!byGroup.has(m.stock_group_id)) byGroup.set(m.stock_group_id, []); byGroup.get(m.stock_group_id).push(m); }
  res.json({ groups: groups.rows.map(g => ({ ...g, members: byGroup.get(g.id) || [] })) });
});

// GET /api/products/stock-groups/suggestions — ungrouped products that already
// share a part number across DIFFERENT make/model listings (the "needs fixing"
// cases the user described). One-click to turn each set into a shared pool.
router.get('/stock-groups/suggestions', requirePermission('inventory'), async (req, res) => {
  await ensureStockGroupsSchema();
  const { rows } = await query(
    `SELECT id, sku, title, brand, model, part_number, qty_on_hand
     FROM products
     WHERE active = true AND stock_group_id IS NULL AND part_number IS NOT NULL AND part_number <> ''`);
  const byCode = new Map();
  for (const p of rows) {
    const k = sgNorm(p.part_number);
    if (!k) continue;
    if (!byCode.has(k)) byCode.set(k, { code: p.part_number, products: [] });
    byCode.get(k).products.push(p);
  }
  // Only surface part numbers that actually span more than one listing.
  const suggestions = [...byCode.values()].filter(g => g.products.length > 1)
    .sort((a, b) => b.products.length - a.products.length);
  res.json({ suggestions });
});

// POST /api/products/stock-groups — create a pool from a code + 2+ products.
router.post('/stock-groups', requireAdmin, async (req, res) => {
  await ensureStockGroupsSchema();
  const code = String(req.body?.code || '').trim();
  const note = req.body?.note ? String(req.body.note).trim() : null;
  const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds.map(Number).filter(Boolean) : [];
  if (!code) return res.status(400).json({ error: 'code_required' });
  if (productIds.length < 2) return res.status(400).json({ error: 'need_two_products' });
  const out = await withTx(async (c) => {
    const g = await c.query(`INSERT INTO stock_groups (code, note) VALUES ($1, $2) RETURNING id`, [code, note]);
    const gid = g.rows[0].id;
    await c.query(`UPDATE products SET stock_group_id = $1 WHERE id = ANY($2)`, [gid, productIds]);
    // Seed the pool from the highest current member qty (safest assumption), unless
    // an explicit starting qty was supplied.
    const mx = await c.query(`SELECT COALESCE(MAX(qty_on_hand), 0)::int AS q FROM products WHERE id = ANY($1)`, [productIds]);
    const qty = req.body?.qty != null ? Math.max(0, parseInt(req.body.qty) || 0) : mx.rows[0].q;
    await c.query(`UPDATE stock_groups SET qty_on_hand = $1 WHERE id = $2`, [qty, gid]);
    await c.query(`UPDATE products SET qty_on_hand = $1 WHERE stock_group_id = $2`, [qty, gid]);
    return { gid, qty };
  });
  // Push the now-synced qty to each member's channels (outside the tx).
  const members = await query(`SELECT id FROM products WHERE stock_group_id = $1`, [out.gid]);
  for (const m of members.rows) { try { await pushProductStockToChannels(m.id, { skipGroup: true }); } catch (_) {} }
  await audit(req, 'create_stock_group', 'stock_group', out.gid, { code, productIds, qty: out.qty });
  res.json({ ok: true, groupId: out.gid, qty: out.qty });
});

// PATCH /api/products/stock-groups/:gid — update the shared qty and/or note.
router.patch('/stock-groups/:gid', requireAdmin, async (req, res) => {
  await ensureStockGroupsSchema();
  const gid = Number(req.params.gid);
  const g = await query(`SELECT id FROM stock_groups WHERE id = $1`, [gid]);
  if (!g.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (req.body?.note !== undefined) {
    await query(`UPDATE stock_groups SET note = $1, updated_at = now() WHERE id = $2`, [req.body.note ? String(req.body.note).trim() : null, gid]);
  }
  let pushed = [];
  if (req.body?.qty !== undefined) pushed = await setStockGroupQty(gid, Math.max(0, parseInt(req.body.qty) || 0));
  await audit(req, 'update_stock_group', 'stock_group', gid, { qty: req.body?.qty, note: req.body?.note });
  res.json({ ok: true, pushed });
});

// POST /api/products/stock-groups/:gid/members — add products to a pool.
router.post('/stock-groups/:gid/members', requireAdmin, async (req, res) => {
  await ensureStockGroupsSchema();
  const gid = Number(req.params.gid);
  const g = await query(`SELECT id, qty_on_hand FROM stock_groups WHERE id = $1`, [gid]);
  if (!g.rows[0]) return res.status(404).json({ error: 'not_found' });
  const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds.map(Number).filter(Boolean) : [];
  if (!productIds.length) return res.status(400).json({ error: 'no_products' });
  await query(`UPDATE products SET stock_group_id = $1, qty_on_hand = $2 WHERE id = ANY($3)`, [gid, g.rows[0].qty_on_hand, productIds]);
  for (const id of productIds) { try { await pushProductStockToChannels(id, { skipGroup: true }); } catch (_) {} }
  await audit(req, 'add_stock_group_members', 'stock_group', gid, { productIds });
  res.json({ ok: true });
});

// DELETE /api/products/stock-groups/:gid/members/:pid — remove one listing from
// the pool. If fewer than 2 members remain, the pool is dissolved automatically.
router.delete('/stock-groups/:gid/members/:pid', requireAdmin, async (req, res) => {
  await ensureStockGroupsSchema();
  const gid = Number(req.params.gid);
  await query(`UPDATE products SET stock_group_id = NULL WHERE id = $1 AND stock_group_id = $2`, [Number(req.params.pid), gid]);
  const cnt = await query(`SELECT COUNT(*)::int AS n FROM products WHERE stock_group_id = $1`, [gid]);
  const dissolved = cnt.rows[0].n < 2;
  if (dissolved) {
    await query(`UPDATE products SET stock_group_id = NULL WHERE stock_group_id = $1`, [gid]);
    await query(`DELETE FROM stock_groups WHERE id = $1`, [gid]);
  }
  await audit(req, 'remove_stock_group_member', 'stock_group', gid, { pid: req.params.pid, dissolved });
  res.json({ ok: true, dissolved });
});

// DELETE /api/products/stock-groups/:gid — dissolve the pool entirely.
router.delete('/stock-groups/:gid', requireAdmin, async (req, res) => {
  await ensureStockGroupsSchema();
  const gid = Number(req.params.gid);
  await query(`UPDATE products SET stock_group_id = NULL WHERE stock_group_id = $1`, [gid]);
  await query(`DELETE FROM stock_groups WHERE id = $1`, [gid]);
  await audit(req, 'delete_stock_group', 'stock_group', gid, {});
  res.json({ ok: true });
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
                   'item_photo_data_url', 'location_photo_data_url_2', 'primary_photo', 'large_panel', 'price_locked'];
  // Map camelCase -> snake_case
  const map = { partNumber: 'part_number', lowStockThreshold: 'low_stock_threshold',
                priceShopify: 'price_shopify', priceEbay: 'price_ebay',
                costPrice: 'cost_price', locationId: 'location_id',
                locationNote: 'location_note', locationPhotoDataUrl: 'location_photo_data_url',
                itemPhotoDataUrl: 'item_photo_data_url',
                locationPhotoDataUrl2: 'location_photo_data_url_2',
                primaryPhoto: 'primary_photo', largePanel: 'large_panel', priceLocked: 'price_locked' };
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

// PATCH /api/products/:id/location — warehouse-staff-safe subset of the product
// PATCH. Lets anyone with the 'locations' permission set a product's storage
// area, note and photos (the full PATCH above is admin-only because it can also
// change prices/title/etc). This is what the Locations page actually saves, so
// warehouse staff can now add location photos without being an admin.
router.patch('/:id/location', requirePermission('locations'), async (req, res) => {
  await ensureProductLocationColumns();
  const allowed = ['location_id', 'location_note', 'location_photo_data_url',
                   'item_photo_data_url', 'location_photo_data_url_2', 'primary_photo'];
  const map = { locationId: 'location_id', locationNote: 'location_note',
                locationPhotoDataUrl: 'location_photo_data_url',
                itemPhotoDataUrl: 'item_photo_data_url',
                locationPhotoDataUrl2: 'location_photo_data_url_2',
                primaryPhoto: 'primary_photo' };
  for (const f of ['itemPhotoDataUrl', 'locationPhotoDataUrl', 'locationPhotoDataUrl2']) {
    if (typeof req.body?.[f] === 'string' && req.body[f].length > 7_000_000) {
      return res.status(413).json({ error: 'photo_too_large', message: 'Photo is too large — please use an image under 5 MB.' });
    }
  }
  const sets = [], params = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    const col = map[k] || k;
    if (allowed.includes(col)) { params.push(v); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const auditBody = { ...req.body };
  for (const f of ['itemPhotoDataUrl', 'locationPhotoDataUrl', 'locationPhotoDataUrl2']) {
    if (auditBody[f]) auditBody[f] = '[photo]';
  }
  await audit(req, 'update_product_location', 'product', rows[0].id, auditBody);
  res.json({ product: rows[0] });
});

// Shared helper: push a product's current qty_on_hand to Shopify AND every
// eBay store it's linked to (via mirror_links). Used by adjust-stock + the
// product PATCH so manual quantity edits actually propagate to the channels.
//
// Returns { shopify, ebay: [...] } describing what happened, with errors
// captured per-channel so one failure doesn't block the others.
async function pushProductStockToChannels(productId, _opts = {}) {
  const result = { shopify: null, ebay: [] };
  // Load the product + its eBay links
  const pr = await query(
    `SELECT id, sku, qty_on_hand, shopify_inventory_id, shopify_product_id, stock_group_id FROM products WHERE id = $1`,
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

  // This product's stock just changed — refresh any bundle that uses it as a
  // component so the bundle's eBay quantity tracks the scarcest part.
  try {
    const res = await require('../services/bundles').recomputeBundlesForProduct(productId);
    if (res && res.length) result.bundles = res;
  } catch (e) { /* best-effort — never fail the stock push over a bundle */ }

  // Shared stock pool: this product belongs to a pool keyed by a common part
  // number, so mirror its new qty to every sibling listing and push each one.
  // skipGroup stops the sibling pushes from recursing back into the group.
  if (!_opts.skipGroup && product.stock_group_id) {
    try {
      const qty = product.qty_on_hand;
      await query(`UPDATE stock_groups SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, product.stock_group_id]);
      const sibs = await query(`SELECT id FROM products WHERE stock_group_id = $1 AND id <> $2`, [product.stock_group_id, productId]);
      const siblings = [];
      for (const s of sibs.rows) {
        await query(`UPDATE products SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, s.id]);
        try { await pushProductStockToChannels(s.id, { skipGroup: true }); siblings.push({ id: s.id, ok: true }); }
        catch (e) { siblings.push({ id: s.id, error: e.message }); }
      }
      result.group = { groupId: product.stock_group_id, qty, siblings };
    } catch (e) { /* best-effort — never fail a stock push over pool mirroring */ }
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

  // Stock arrived → flip any pre-listing/pre-orders for this product (best-effort).
  if (d > 0 && result.qty_on_hand > 0) {
    setImmediate(() => require('../services/sync').handlePreorderStockArrival(result.id).catch(() => {}));
  }

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

  // Stock arrived → flip any pre-listing/pre-orders for this product (best-effort).
  if (result.qty_on_hand > 0) {
    setImmediate(() => require('../services/sync').handlePreorderStockArrival(result.id).catch(() => {}));
  }

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

// Auto-link a product into a shared stock pool with any OTHER active products
// that carry the same part number (normalised). Creates the pool if none of the
// matches are pooled yet, then syncs every member's qty to the pool and pushes.
// Returns pool info (or null when nothing else shares the part number) so callers
// can tell the user their new listing was linked. Used by create-listing so
// "make a second listing with the same part number" just works.
async function autoPoolByPartNumber(productId, partNumber) {
  await ensureStockGroupsSchema();
  const code = sgNorm(partNumber);
  if (!code) return null;
  const others = await query(
    `SELECT id, stock_group_id, qty_on_hand FROM products
     WHERE active = true AND id <> $1
       AND REGEXP_REPLACE(UPPER(COALESCE(part_number,'')), '[^A-Z0-9]', '', 'g') = $2`,
    [productId, code]);
  if (!others.rows.length) return null;
  // Reuse an existing pool among the matches if there is one; otherwise create.
  let gid = others.rows.find(o => o.stock_group_id)?.stock_group_id || null;
  if (!gid) {
    const g = await query(`INSERT INTO stock_groups (code) VALUES ($1) RETURNING id`, [partNumber]);
    gid = g.rows[0].id;
    const ungrouped = others.rows.filter(o => !o.stock_group_id).map(o => o.id);
    if (ungrouped.length) await query(`UPDATE products SET stock_group_id = $1 WHERE id = ANY($2)`, [gid, ungrouped]);
  }
  await query(`UPDATE products SET stock_group_id = $1 WHERE id = $2`, [gid, productId]);
  // Pool qty = the highest current member qty (safest — never undercounts).
  const mx = await query(`SELECT COALESCE(MAX(qty_on_hand), 0)::int AS q FROM products WHERE stock_group_id = $1`, [gid]);
  const qty = mx.rows[0].q;
  await query(`UPDATE stock_groups SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, gid]);
  await query(`UPDATE products SET qty_on_hand = $1 WHERE stock_group_id = $2`, [qty, gid]);
  const members = await query(`SELECT id FROM products WHERE stock_group_id = $1`, [gid]);
  for (const m of members.rows) { try { await pushProductStockToChannels(m.id, { skipGroup: true }); } catch (_) {} }
  return { groupId: gid, qty, memberCount: members.rows.length };
}
module.exports.autoPoolByPartNumber = autoPoolByPartNumber;
