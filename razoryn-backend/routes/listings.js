// routes/listings.js — eBay → Shopify listing mirror
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { query } = require('../db');
const ebay = require('../services/ebay');
const shopify = require('../services/shopify');

const router = express.Router();

router.use(requireAuth);

// Vehicle Make/Model/Year parsing now lives in lib/vehicle.js so the
// competitor-monitor matcher reuses the exact same logic. Behaviour here is
// unchanged — it's the same function, just imported.
const { VEHICLE_MAKES, parseVehicleFromTitle } = require('../lib/vehicle');
const preorder = require('../lib/preorder');

// GET /api/listings/category-specifics?categoryId=&storeCode=
// eBay's recommended/required item specifics for a category, so the UI can show
// which fields are required before creating a listing.
router.get('/category-specifics', requireAdmin, async (req, res) => {
  const brand = require('../lib/brand');
  const categoryId = req.query.categoryId;
  if (!categoryId) return res.status(400).json({ error: 'categoryId required' });
  const primary = brand.getPrimaryStore();
  const storeCode = req.query.storeCode || (primary && primary.code);
  try {
    res.json(await ebay.getCategorySpecifics(storeCode, categoryId));
  } catch (e) {
    res.status(502).json({ error: 'ebay_error', message: e.message });
  }
});

// GET /api/listings/store-categories?storeCode=
// The seller's custom shop/store categories, for the listing-time dropdown.
router.get('/store-categories', requireAdmin, async (req, res) => {
  const brand = require('../lib/brand');
  const primary = brand.getPrimaryStore();
  const storeCode = req.query.storeCode || (primary && primary.code);
  try {
    res.json({ categories: await ebay.getStoreCategories(storeCode) });
  } catch (e) {
    res.status(502).json({ error: 'ebay_error', message: e.message });
  }
});

// GET /api/listings/shopify-categories?q= — search Shopify's product taxonomy
// for the Mirror-to-Shopify category picker (#1).
router.get('/shopify-categories', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.json({ categories: [] });
  try {
    const cats = await shopify.searchTaxonomyCategories(req.query.q || '');
    res.json({ categories: cats.map(c => ({ id: c.id, name: c.fullName })) });
  } catch (e) {
    res.status(502).json({ error: 'shopify_error', message: e.message });
  }
});

// GET /api/listings/category-search?q=grille&carPartsOnly=1
// Search eBay categories by NAME and (optionally) keep only vehicle-parts ones.
router.get('/category-search', requireAdmin, async (req, res) => {
  const brand = require('../lib/brand');
  const q = req.query.q || '';
  if (!q || q.trim().length < 2) return res.json({ categories: [] });
  const primary = brand.getPrimaryStore();
  const storeCode = req.query.storeCode || (primary && primary.code);
  try {
    let cats = await ebay.getSuggestedCategories(q, storeCode);
    if (req.query.carPartsOnly === '1') {
      const auto = cats.filter(c => c.automotive);
      if (auto.length) cats = auto;  // only narrow if we actually have automotive hits
    }
    res.json({ categories: cats.slice(0, 12) });
  } catch (e) {
    res.status(502).json({ error: 'ebay_error', message: e.message });
  }
});

// GET /api/listings/business-policies?marketplaceId=EBAY_GB
// The seller's payment / shipping / return policies, for listing-time dropdowns.
router.get('/business-policies', requireAdmin, async (req, res) => {
  const brand = require('../lib/brand');
  const primary = brand.getPrimaryStore();
  const storeCode = req.query.storeCode || (primary && primary.code);
  try {
    res.json(await ebay.getBusinessPolicies(req.query.marketplaceId || 'EBAY_GB', storeCode));
  } catch (e) {
    res.status(502).json({ error: 'ebay_error', message: e.message });
  }
});

// Diagnostic: returns the raw GetUserPreferences response + parsed result so we
// can see WHY policy dropdowns are empty (account not opted in vs auth error vs
// parse miss). Admin-only. ?storeCode=… selects the eBay account.
router.get('/business-policies-debug', requireAdmin, async (req, res) => {
  const brand = require('../lib/brand');
  const storeCode = req.query.storeCode || (brand.getPrimaryStore() && brand.getPrimaryStore().code);
  try {
    res.json(await ebay.debugBusinessPolicies(storeCode));
  } catch (e) {
    res.status(502).json({ error: 'ebay_error', message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration: adds the store_code column to mirror_links if it
// doesn't already exist. Lets us track which eBay account each link belongs
// to (e.g. EVBODYPARTS vs Evanta) without requiring a separate migration
// step. Runs on every cold boot — ALTER TABLE IF NOT EXISTS is idempotent.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureMirrorLinksColumns() {
  if (_migrationDone) return;
  try {
    await query(`ALTER TABLE mirror_links ADD COLUMN IF NOT EXISTS store_code TEXT`);
    _migrationDone = true;
  } catch (e) {
    console.warn('[listings.js] mirror_links migration warning:', e.message);
  }
}
ensureMirrorLinksColumns();

// Persist the full eBay listing config ON THE PRODUCT so (a) editing a listing
// never wipes item specifics that the edit form didn't resend — we rebuild the
// complete set from here — and (b) draft listings can store everything and be
// reopened without data loss. ebay_item_specifics holds the last full
// [{name,value|values}] set; draft_payload holds a whole unpublished listing.
let _listingColsDone = false;
async function ensureListingColumns() {
  if (_listingColsDone) return;
  try {
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_category_id TEXT`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_condition_id INTEGER`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_item_specifics JSONB`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_description TEXT`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS draft_payload JSONB`);
    _listingColsDone = true;
  } catch (e) {
    console.warn('[listings.js] listing-columns migration warning:', e.message);
  }
}
ensureListingColumns();

// Pulls active listings from every configured eBay store, including ones
// flagged as `standalone`. Used for diagnostics, manual link enrichment,
// and store-code detection on legacy mirror_links rows.
// Returns a flat array of listing objects, each tagged with `storeCode`.
async function getAllListingsAcrossStores() {
  const stores = ebay.listStores().filter(s => s.hasToken);
  let all = [];
  for (const s of stores) {
    try {
      const part = await ebay.getActiveListings(s.code);
      all = all.concat(part);
    } catch (e) {
      console.warn(`[listings.js] store=${s.code} fetch failed: ${e.message}`);
    }
  }
  return all;
}

// Build a fast itemId → listing lookup map from a listing array.
function indexByItemId(listings) {
  const map = new Map();
  for (const l of listings) map.set(String(l.itemId), l);
  return map;
}

// GET /api/listings/debug-ebay-returns
// Hits the Post-Order Returns API and dumps whatever eBay returns.
// Useful to verify the AuthToken has access to the returns endpoint.
router.get('/debug-ebay-returns', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  try {
    const data = await ebay.getAllRecentReturns(parseInt(req.query.days || 90));
    res.json({ ok: true, ...data, count: (data.members || data.returns || []).length });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'failed', status: e.status, message: e.message, detail: e.detail });
  }
});

// GET /api/listings/debug-ebay-order?orderId=...
// Dumps the raw Trading-API GetOrders XML for one order so we can see WHICH fields are
// actually present (vs. what our extractor is finding). Strips eBay seller token from output.
router.get('/debug-ebay-order', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  try {
    const xml = await ebay.dumpOrderXml(req.query.orderId, req.query.days || 7);
    res.set('Content-Type', 'application/xml').send(xml);
  } catch (e) {
    res.status(500).json({ error: 'failed', message: e.message });
  }
});

// GET /api/listings/link-status
// Returns a unified view of every warehouse product and its links:
//   - shopify_product_id (from products table, set by Shopify sync)
//   - mirror_links row (ebay_item_id → shopify_product_id)
// Each row has flags: linkedToShopify, linkedToEbay, plus the live SKU.
// Used by the "Link Status" tab to show what's linked vs. orphan products and
// listings, and to manually create or break a mirror link.
router.get('/link-status', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const { rows: products } = await query(`
    SELECT p.id, p.sku, p.title, p.barcode, p.part_number, p.qty_on_hand,
           p.shopify_product_id, p.shopify_inventory_id,
           ml.ebay_item_id, ml.store_code, ml.last_synced_sku, ml.last_synced_title, ml.last_mirrored_at
    FROM products p
    LEFT JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id
    WHERE p.active = true
    ORDER BY p.id DESC
    LIMIT 1000
  `);
  const { rows: orphanMirrors } = await query(`
    SELECT ml.ebay_item_id, ml.shopify_product_id, ml.store_code, ml.last_synced_sku, ml.last_synced_title, ml.last_mirrored_at
    FROM mirror_links ml
    LEFT JOIN products p ON p.shopify_product_id = ml.shopify_product_id::text
    WHERE p.id IS NULL
    ORDER BY ml.last_mirrored_at DESC NULLS LAST
    LIMIT 500
  `);
  const summary = {
    total: products.length,
    linkedShopify: products.filter(p => p.shopify_product_id).length,
    linkedEbay: products.filter(p => p.ebay_item_id).length,
    linkedBoth: products.filter(p => p.shopify_product_id && p.ebay_item_id).length,
    linkedNoStoreCode: products.filter(p => p.ebay_item_id && !p.store_code).length,
    orphan: products.filter(p => !p.shopify_product_id && !p.ebay_item_id).length,
    orphanMirrors: orphanMirrors.length,
  };
  res.json({ summary, products, orphanMirrors });
});

// Normalise a part number / code for comparison: uppercase, alphanumerics only,
// so "92202-G5000", "92202 G5000" and "92202g5000" all compare equal.
function normCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function pushTo(map, key, val) { if (!map.has(key)) map.set(key, []); map.get(key).push(val); }

// ──────────────────────────────────────────────────────────────────────────
// GET /api/listings/integrity — read-only data-integrity report (instant).
// Surfaces:
//   1. mirror_links where one Shopify product is linked to >1 eBay item
//   2. mirror_links where one eBay item is linked to >1 Shopify product
//      (the PK should prevent this, but legacy DBs are checked defensively)
//   3. multiple warehouse product rows pointing at the SAME Shopify product
//   4. the same eBay listing id appearing on multiple warehouse products
//   5. duplicate listings sharing the same part number (normalised)
//   6. a product's part number appearing in ANOTHER product's title
// Descriptions aren't stored locally, so part-numbers-in-descriptions is a
// separate, opt-in scan (POST /integrity/scan-descriptions).
// ──────────────────────────────────────────────────────────────────────────
router.get('/integrity', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const { rows: products } = await query(`
    SELECT id, sku, title, part_number, shopify_product_id,
           ebay_listing_id_em, ebay_listing_id_cl
    FROM products WHERE active = true`);
  const { rows: links } = await query(`
    SELECT ebay_item_id, shopify_product_id::text AS shopify_product_id,
           store_code, last_synced_sku, last_synced_title
    FROM mirror_links`);

  // 1. one Shopify product → many eBay items (in mirror_links)
  const byShopify = new Map();
  for (const l of links) if (l.shopify_product_id) pushTo(byShopify, l.shopify_product_id, l);
  const shopifyLinkedToManyEbay = [...byShopify.entries()]
    .filter(([, ls]) => new Set(ls.map(x => x.ebay_item_id)).size > 1)
    .map(([spid, ls]) => ({
      shopifyProductId: spid,
      ebayItems: ls.map(x => ({ ebayItemId: x.ebay_item_id, storeCode: x.store_code, sku: x.last_synced_sku, title: x.last_synced_title })),
    }));

  // 2. one eBay item → many Shopify products (shouldn't happen; defensive)
  const byEbay = new Map();
  for (const l of links) if (l.ebay_item_id) pushTo(byEbay, l.ebay_item_id, l);
  const ebayLinkedToManyShopify = [...byEbay.entries()]
    .filter(([, ls]) => new Set(ls.map(x => x.shopify_product_id)).size > 1)
    .map(([eid, ls]) => ({ ebayItemId: eid, shopifyProductIds: [...new Set(ls.map(x => x.shopify_product_id))] }));

  // 3. multiple warehouse rows → same Shopify product
  const prodByShopify = new Map();
  for (const p of products) if (p.shopify_product_id) pushTo(prodByShopify, String(p.shopify_product_id), p);
  const productsSharingShopifyId = [...prodByShopify.entries()]
    .filter(([, ps]) => ps.length > 1)
    .map(([spid, ps]) => ({ shopifyProductId: spid, products: ps.map(x => ({ id: x.id, sku: x.sku, title: x.title })) }));

  // 4. same eBay listing id on multiple warehouse products
  const prodByEbay = new Map();
  for (const p of products) for (const id of [p.ebay_listing_id_em, p.ebay_listing_id_cl]) if (id) pushTo(prodByEbay, String(id), p);
  const productsSharingEbayId = [...prodByEbay.entries()]
    .filter(([, ps]) => new Set(ps.map(x => x.id)).size > 1)
    .map(([eid, ps]) => ({ ebayListingId: eid, products: ps.map(x => ({ id: x.id, sku: x.sku, title: x.title })) }));

  // 5. duplicate part numbers (normalised; ignore very short / empty codes)
  const byPN = new Map();
  for (const p of products) {
    const pn = normCode(p.part_number);
    if (pn.length >= 4) pushTo(byPN, pn, p);
  }
  const duplicatePartNumbers = [...byPN.entries()]
    .filter(([, ps]) => ps.length > 1)
    .map(([pn, ps]) => ({ partNumber: ps[0].part_number, normalised: pn, count: ps.length, products: ps.map(x => ({ id: x.id, sku: x.sku, title: x.title })) }))
    .sort((a, b) => b.count - a.count);

  // 6. a product's part number found inside another product's title
  const needles = products
    .map(p => ({ p, pn: normCode(p.part_number) }))
    .filter(x => x.pn.length >= 5);
  const titleNorms = products.map(p => ({ p, t: normCode(p.title) }));
  const partNumberInOtherTitle = [];
  for (const { p, pn } of needles) {
    for (const { p: other, t } of titleNorms) {
      if (other.id === p.id) continue;
      if (normCode(other.part_number) === pn) continue; // already caught as a PN dupe
      if (t.includes(pn)) {
        partNumberInOtherTitle.push({
          partNumber: p.part_number,
          ofProduct: { id: p.id, sku: p.sku, title: p.title },
          foundInProduct: { id: other.id, sku: other.sku, title: other.title },
        });
      }
    }
  }

  res.json({
    counts: {
      shopifyLinkedToManyEbay: shopifyLinkedToManyEbay.length,
      ebayLinkedToManyShopify: ebayLinkedToManyShopify.length,
      productsSharingShopifyId: productsSharingShopifyId.length,
      productsSharingEbayId: productsSharingEbayId.length,
      duplicatePartNumbers: duplicatePartNumbers.length,
      partNumberInOtherTitle: partNumberInOtherTitle.length,
    },
    shopifyLinkedToManyEbay,
    ebayLinkedToManyShopify,
    productsSharingShopifyId,
    productsSharingEbayId,
    duplicatePartNumbers: duplicatePartNumbers.slice(0, 300),
    partNumberInOtherTitle: partNumberInOtherTitle.slice(0, 300),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/integrity/scan-descriptions { offset, batchSize, includeEbay }
// Opt-in, paginated scan for part numbers embedded in Shopify (and optionally
// eBay) listing DESCRIPTIONS — which aren't stored locally, so each page is
// fetched live. The frontend loops, advancing `offset`, so no single request is
// long-running or risks the eBay GetItem quota in one shot.
//
// For each product in the page we fetch its description and check whether ANY
// OTHER active product's part number appears in it — a strong duplicate signal
// when the part number isn't in that product's own part_number field.
// ──────────────────────────────────────────────────────────────────────────
router.post('/integrity/scan-descriptions', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const offset = Math.max(0, parseInt(req.body?.offset) || 0);
  const batchSize = Math.min(40, Math.max(5, parseInt(req.body?.batchSize) || 20));
  const includeEbay = !!req.body?.includeEbay;
  const shopify = require('../services/shopify');

  // Needles: every meaningful part number across the catalogue.
  const { rows: all } = await query(`
    SELECT id, sku, title, part_number FROM products
    WHERE active = true AND part_number IS NOT NULL AND part_number <> ''`);
  const needles = all.map(p => ({ id: p.id, sku: p.sku, title: p.title, pn: p.part_number, n: normCode(p.part_number) }))
    .filter(x => x.n.length >= 5);

  // The page of products whose descriptions we fetch this call. Scan eBay-linked
  // products when includeEbay, else Shopify-linked products.
  const pageSql = includeEbay
    ? `SELECT p.id, p.sku, p.title, ml.ebay_item_id, ml.store_code
         FROM products p JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id
        WHERE p.active = true ORDER BY p.id LIMIT $1 OFFSET $2`
    : `SELECT id, sku, title, shopify_product_id
         FROM products WHERE active = true AND shopify_product_id IS NOT NULL
        ORDER BY id LIMIT $1 OFFSET $2`;
  const { rows: page } = await query(pageSql, [batchSize, offset]);
  const countSql = includeEbay
    ? `SELECT COUNT(*)::int AS n FROM products p JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id WHERE p.active = true`
    : `SELECT COUNT(*)::int AS n FROM products WHERE active = true AND shopify_product_id IS NOT NULL`;
  const total = (await query(countSql)).rows[0].n;

  const matches = [];
  for (const prod of page) {
    let desc = '';
    try {
      desc = includeEbay
        ? await ebay.getItemDescription(prod.ebay_item_id, prod.store_code)
        : (await shopify.getShopifyProductFull(prod.shopify_product_id)).description;
    } catch (e) { continue; }
    const dn = normCode(desc);
    if (!dn) continue;
    for (const ndl of needles) {
      if (ndl.id === prod.id) continue;             // a product's own PN in its own desc is normal
      if (dn.includes(ndl.n)) {
        matches.push({
          source: includeEbay ? 'ebay' : 'shopify',
          foundInProduct: { id: prod.id, sku: prod.sku, title: prod.title },
          partNumber: ndl.pn,
          ofProduct: { id: ndl.id, sku: ndl.sku, title: ndl.title },
        });
      }
    }
  }

  res.json({ matches, scanned: page.length, offset, nextOffset: offset + page.length, total, done: offset + page.length >= total });
});

// POST /api/listings/link-status/link
// Creates a mirror_links row. When possible we ALSO fetch the live eBay
// listing to populate the store_code AND immediately update the warehouse
// product's price_ebay — so linking is a one-stop operation, not a "link
// now, hydrate later" two-step. Caller may pass storeCode if they already
// know it (Listing Mirror page does); otherwise we detect by scanning all
// stores' active listings.
router.post('/link-status/link', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const { productId, ebayItemId, shopifyProductId, storeCode: storeCodeHint } = req.body || {};
  if (!ebayItemId) return res.status(400).json({ error: 'ebay_item_id_required' });
  // productId is optional: the All-listings reconcile view links an eBay item
  // straight to a Shopify product (no warehouse row needed). When given, we use
  // the product's shopify_product_id as a fallback and bump its price_ebay.
  let prod = null;
  if (productId) {
    const p = await query(`SELECT id, shopify_product_id, sku, title FROM products WHERE id = $1`, [productId]);
    if (!p.rows[0]) return res.status(404).json({ error: 'product_not_found' });
    prod = p.rows[0];
  }
  const spId = shopifyProductId || prod?.shopify_product_id;
  if (!spId) return res.status(400).json({ error: 'no_shopify_product_id', message: 'No Shopify product id supplied or found. Sync from Shopify first.' });

  // Try to look up the live listing — gives us store_code and live price.
  // Fail open if eBay isn't configured or the item isn't found; the link still
  // gets saved, just without enrichment.
  let listing = null;
  let detectedStoreCode = storeCodeHint || null;
  if (ebay.isConfigured()) {
    try {
      const all = await getAllListingsAcrossStores();
      const map = indexByItemId(all);
      listing = map.get(String(ebayItemId)) || null;
      if (listing && !detectedStoreCode) detectedStoreCode = listing.storeCode;
    } catch (e) {
      console.warn('[link] enrichment fetch failed:', e.message);
    }
  }

  await query(
    `INSERT INTO mirror_links (ebay_item_id, shopify_product_id, store_code, last_mirrored_at, last_synced_sku, last_synced_title)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (ebay_item_id) DO UPDATE
       SET shopify_product_id = EXCLUDED.shopify_product_id,
           store_code = COALESCE(EXCLUDED.store_code, mirror_links.store_code),
           last_mirrored_at = now()`,
    [String(ebayItemId), spId, detectedStoreCode || null, prod?.sku || (listing?.sku || null), prod?.title || (listing?.title || null)]
  );

  // If we have the live listing AND a warehouse product, also bump price_ebay on
  // it so the quote builder + invoices reflect reality immediately.
  let priceUpdated = false;
  if (prod && listing && listing.priceEbay > 0) {
    await query(
      `UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`,
      [listing.priceEbay, prod.id]
    );
    priceUpdated = true;
  }

  await audit(req, 'create_mirror_link', 'product', productId || null, { ebayItemId, shopifyProductId: spId, storeCode: detectedStoreCode, priceUpdated });
  res.json({ ok: true, storeCode: detectedStoreCode, priceUpdated, livePrice: listing?.priceEbay || null });
});

router.post('/link-status/unlink', requireAdmin, async (req, res) => {
  const { ebayItemId } = req.body || {};
  if (!ebayItemId) return res.status(400).json({ error: 'ebay_item_id_required' });
  await query(`DELETE FROM mirror_links WHERE ebay_item_id = $1`, [String(ebayItemId)]);
  await audit(req, 'delete_mirror_link', 'mirror_link', null, { ebayItemId });
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/listings/reconcile — the unified, three-way "all listings" view.
//
// Pulls EVERY eBay listing, EVERY Shopify product/variant and EVERY warehouse
// product, then groups them so each row shows what exists where and whether it
// is linked. Grouping joins on (a) explicit links — mirror_links (eBay↔Shopify)
// and products.shopify_product_id (warehouse↔Shopify) — and (b) a normalised SKU
// shared across platforms. This surfaces broken links and, crucially, duplicates
// (two eBay listings or two Shopify products that resolve to the same item).
//
// Heavy (full Shopify + eBay pulls); intended to be triggered on demand.
// ──────────────────────────────────────────────────────────────────────────
router.get('/reconcile', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();

  // Skip Shopify's synthetic placeholder SKUs (SHOPIFY-<variantId>) — they are
  // not real, shared identifiers and would wrongly never match.
  const skuKey = (s) => {
    const n = normCode(s);
    if (!n) return null;
    if (/^SHOPIFY\d+$/.test(n)) return null;
    return n;
  };

  // 1. Warehouse products
  const { rows: products } = await query(`
    SELECT id, sku, title, part_number, qty_on_hand, shopify_product_id, price_ebay, price_shopify
    FROM products WHERE active = true LIMIT 5000
  `);

  // 2. Explicit eBay↔Shopify links
  const { rows: links } = await query(`SELECT ebay_item_id, shopify_product_id, store_code FROM mirror_links`);

  // 3. Shopify products (fail open if not configured)
  let shopifyVariants = [];
  if (shopify.isConfigured()) {
    try {
      for await (const v of shopify.iterateAllProductsAndVariants()) shopifyVariants.push(v);
    } catch (e) { console.warn('[reconcile] shopify pull failed:', e.message); }
  }

  // 4. eBay listings (fail open if not configured)
  let ebayListings = [];
  if (ebay.isConfigured()) {
    try { ebayListings = await getAllListingsAcrossStores(); }
    catch (e) { console.warn('[reconcile] ebay pull failed:', e.message); }
  }

  // ── Union-Find over nodes: e:<itemId>, s:<productId>, w:<productId> ──
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Register every node first
  for (const l of ebayListings) add('e:' + l.itemId);
  for (const s of shopifyVariants) add('s:' + s.shopify_product_id);
  for (const p of products) add('w:' + p.id);

  // Join by explicit links
  for (const ml of links) {
    if (ml.ebay_item_id && ml.shopify_product_id) union('e:' + ml.ebay_item_id, 's:' + ml.shopify_product_id);
  }
  for (const p of products) {
    if (p.shopify_product_id) union('w:' + p.id, 's:' + String(p.shopify_product_id));
  }

  // Join by shared normalised SKU
  const bySku = new Map(); // skuKey -> [node,...]
  const pushSku = (sku, node) => { const k = skuKey(sku); if (!k) return; if (!bySku.has(k)) bySku.set(k, []); bySku.get(k).push(node); };
  for (const l of ebayListings) pushSku(l.sku, 'e:' + l.itemId);
  for (const s of shopifyVariants) pushSku(s.sku, 's:' + s.shopify_product_id);
  for (const p of products) pushSku(p.sku, 'w:' + p.id);
  for (const nodes of bySku.values()) { for (let i = 1; i < nodes.length; i++) union(nodes[0], nodes[i]); }

  // Index entities by node for assembly
  const linkByEbay = new Map(links.map(l => [String(l.ebay_item_id), l]));
  const groups = new Map(); // root -> { ebay:[], shopify:[], warehouse:[] }
  const grp = (node) => { const r = find(node); if (!groups.has(r)) groups.set(r, { ebay: [], shopify: [], warehouse: [] }); return groups.get(r); };

  for (const l of ebayListings) {
    grp('e:' + l.itemId).ebay.push({
      itemId: String(l.itemId), sku: l.sku || null, title: l.title || '',
      price: l.priceEbay ?? null, storeCode: l.storeCode || null, storeName: l.storeName || null,
      url: l.viewItemURL || `https://www.ebay.co.uk/itm/${l.itemId}`,
      linkedShopifyId: linkByEbay.get(String(l.itemId))?.shopify_product_id || null,
    });
  }
  for (const s of shopifyVariants) {
    grp('s:' + s.shopify_product_id).shopify.push({
      productId: String(s.shopify_product_id), sku: /^SHOPIFY-/.test(s.sku) ? null : s.sku,
      title: s.title || '', price: s.price_shopify ?? null, handle: s.shopify_handle || null,
    });
  }
  for (const p of products) {
    grp('w:' + p.id).warehouse.push({
      id: p.id, sku: p.sku || null, title: p.title || '', qty: p.qty_on_hand ?? null,
      shopifyProductId: p.shopify_product_id ? String(p.shopify_product_id) : null,
    });
  }

  // Assemble + classify
  const linkedShopifyIds = new Set(links.map(l => String(l.shopify_product_id)));
  const out = [];
  for (const [root, g] of groups) {
    // A multi-variant Shopify product yields one entry per variant; collapse to
    // distinct productIds so extra variants don't read as "duplicate products".
    const seenSp = new Set();
    g.shopify = g.shopify.filter(x => (seenSp.has(x.productId) ? false : seenSp.add(x.productId)));
    const onEbay = g.ebay.length > 0, onShopify = g.shopify.length > 0, onWarehouse = g.warehouse.length > 0;
    const platforms = (onEbay ? 1 : 0) + (onShopify ? 1 : 0) + (onWarehouse ? 1 : 0);
    // Real links present within the group?
    const ebayShopifyLinked = g.ebay.some(e => e.linkedShopifyId && g.shopify.some(s => s.productId === e.linkedShopifyId));
    const whShopifyLinked = g.warehouse.some(w => w.shopifyProductId && g.shopify.some(s => s.productId === w.shopifyProductId));
    // SKUs across the group (for display + duplicate hints)
    const skus = [...new Set([...g.ebay, ...g.shopify, ...g.warehouse].map(x => x.sku).filter(Boolean))];

    // Why did these nodes land in one group? Surface the bridging signals so a
    // wrong link or a mis-keyed SKU that dragged two unrelated items together is
    // visible (and fixable). A bridge is "suspect" when it connects entries whose
    // titles differ — i.e. it's holding two different parts under one identifier.
    const tSig = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const allEntries = [
      ...g.ebay.map(e => ({ kind: 'ebay', id: e.itemId, title: e.title, sku: e.sku, storeCode: e.storeCode })),
      ...g.shopify.map(x => ({ kind: 'shopify', id: x.productId, title: x.title, sku: x.sku })),
      ...g.warehouse.map(w => ({ kind: 'warehouse', id: String(w.id), title: w.title, sku: w.sku })),
    ];
    const skuMap = new Map();
    for (const en of allEntries) {
      const k = skuKey(en.sku); if (!k) continue;
      if (!skuMap.has(k)) skuMap.set(k, { sku: en.sku, entries: [] });
      skuMap.get(k).entries.push(en);
    }
    const sharedSkus = [...skuMap.values()].filter(s => s.entries.length > 1).map(s => ({
      sku: s.sku, entries: s.entries,
      suspect: new Set(s.entries.map(e => tSig(e.title)).filter(Boolean)).size > 1,
    }));
    const linkEdges = g.ebay
      .filter(e => e.linkedShopifyId && g.shopify.some(s => s.productId === e.linkedShopifyId))
      .map(e => {
        const sp = g.shopify.find(s => s.productId === e.linkedShopifyId) || {};
        return { ebayItemId: e.itemId, ebayTitle: e.title, ebayStoreCode: e.storeCode || null, shopifyProductId: e.linkedShopifyId, shopifyTitle: sp.title || '', suspect: !!(e.title && sp.title && tSig(e.title) !== tSig(sp.title)) };
      });
    const whEdges = g.warehouse
      .filter(w => w.shopifyProductId && g.shopify.some(s => s.productId === w.shopifyProductId))
      .map(w => {
        const sp = g.shopify.find(s => s.productId === w.shopifyProductId) || {};
        return { warehouseId: w.id, warehouseTitle: w.title, shopifyProductId: w.shopifyProductId, shopifyTitle: sp.title || '', suspect: !!(w.title && sp.title && tSig(w.title) !== tSig(sp.title)) };
      });
    const whyGrouped = { sharedSkus, linkEdges, whEdges, suspect: sharedSkus.some(s => s.suspect) || linkEdges.some(e => e.suspect) || whEdges.some(e => e.suspect) };

    out.push({
      key: root,
      ebay: g.ebay, shopify: g.shopify, warehouse: g.warehouse,
      onEbay, onShopify, onWarehouse, platforms, skus, whyGrouped,
      ebayShopifyLinked, whShopifyLinked,
      dupEbay: g.ebay.length > 1, dupShopify: g.shopify.length > 1, dupWarehouse: g.warehouse.length > 1,
      // "needsLink": exists on >1 platform but the cross-platform link is missing
      needsEbayShopifyLink: onEbay && onShopify && !ebayShopifyLinked,
    });
  }

  // Stable, useful ordering: problems first (duplicates, then needs-link), then the rest.
  const score = (r) => (r.dupEbay || r.dupShopify ? 0 : r.needsEbayShopifyLink ? 1 : 2);
  out.sort((a, b) => score(a) - score(b) || (b.platforms - a.platforms));

  const summary = {
    groups: out.length,
    ebayListings: ebayListings.length,
    shopifyVariants: shopifyVariants.length,
    warehouseProducts: products.length,
    fullyLinked: out.filter(r => r.onEbay && r.onShopify && r.ebayShopifyLinked).length,
    needsLink: out.filter(r => r.needsEbayShopifyLink).length,
    duplicates: out.filter(r => r.dupEbay || r.dupShopify).length,
    ebayOnly: out.filter(r => r.onEbay && !r.onShopify && !r.onWarehouse).length,
    shopifyOnly: out.filter(r => r.onShopify && !r.onEbay && !r.onWarehouse).length,
    shopifyConfigured: shopify.isConfigured(),
    ebayConfigured: ebay.isConfigured(),
  };
  res.json({ summary, groups: out });
});

// POST /api/listings/link-status/force-match
// Auto-link by SKU + part-number + title-token fuzzy matching. Pulls listings from
// every eBay store the brand has configured and aggregates the results. Each
// successful match ALSO stores the source store_code in mirror_links and
// bumps the warehouse product's price_ebay so no separate hydrate is needed.
router.post('/link-status/force-match', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  const sync = require('../services/sync');
  const stores = ebay.listStores().filter(s => s.hasToken);

  let allListings = [];
  const storeErrors = [];
  for (const s of stores) {
    try {
      const part = await ebay.getActiveListings(s.code);
      allListings = allListings.concat(part);
    } catch (e) {
      console.warn(`[force-match] store=${s.code} fetch failed: ${e.message}`);
      storeErrors.push({ store: s.code, error: e.message });
    }
  }

  let matched = 0, alreadyLinked = 0, noMatch = 0, pricesUpdated = 0, storeCodesBackfilled = 0;
  const matches = [];
  for (const l of allListings) {
    // If link already exists, take this opportunity to backfill store_code
    // and price on legacy rows that pre-date the per-store tracking.
    const existing = await query(`SELECT store_code FROM mirror_links WHERE ebay_item_id = $1`, [String(l.itemId)]);
    if (existing.rows[0]) {
      alreadyLinked++;
      if (!existing.rows[0].store_code && l.storeCode) {
        await query(`UPDATE mirror_links SET store_code = $1 WHERE ebay_item_id = $2`, [l.storeCode, String(l.itemId)]);
        storeCodesBackfilled++;
      }
      // Also backfill price_ebay via mirror_links → product join, if missing
      if (l.priceEbay > 0) {
        const upd = await query(
          `UPDATE products p SET price_ebay = $1, updated_at = now()
           FROM mirror_links ml
           WHERE ml.ebay_item_id = $2 AND ml.shopify_product_id::text = p.shopify_product_id
             AND (p.price_ebay IS NULL OR p.price_ebay <= 0)
           RETURNING p.id`,
          [l.priceEbay, String(l.itemId)]
        );
        if (upd.rows.length) pricesUpdated += upd.rows.length;
      }
      continue;
    }

    let product = null;
    if (l.sku) {
      try { product = await sync.resolveProductBySku(null, l.sku); } catch (e) {}
    }
    if (!product && l.title) {
      const tokens = String(l.title).match(/\b[A-Z0-9]{5,}(?:[-\/][A-Z0-9]{2,})*\b/gi) || [];
      // Require BOTH letters AND digits — eliminates false matches on car-model names
      const partNumberTokens = tokens.filter(t => /[A-Z]/i.test(t) && /[0-9]/.test(t));
      partNumberTokens.sort((a, b) => b.length - a.length);
      for (const tok of partNumberTokens.slice(0, 5)) {
        const norm = tok.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (norm.length < 5) continue;
        const r = await query(
          `SELECT id, sku, shopify_product_id FROM products
           WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(part_number,'')), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(barcode,'')), '[^A-Z0-9]', '', 'g') = $1
           LIMIT 1`, [norm]
        );
        if (r.rows[0]) { product = r.rows[0]; break; }
      }
    }
    if (!product || !product.shopify_product_id) { noMatch++; continue; }

    await query(
      `INSERT INTO mirror_links (ebay_item_id, shopify_product_id, store_code, last_mirrored_at, last_synced_sku, last_synced_title)
       VALUES ($1, $2, $3, now(), $4, $5)
       ON CONFLICT (ebay_item_id) DO NOTHING`,
      [String(l.itemId), product.shopify_product_id, l.storeCode || null, l.sku || product.sku, l.title]
    );
    // Update product price_ebay if we have a positive eBay price
    if (l.priceEbay > 0) {
      await query(
        `UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`,
        [l.priceEbay, product.id]
      );
      pricesUpdated++;
    }
    matched++;
    if (matches.length < 20) matches.push({ ebayItemId: l.itemId, productId: product.id, sku: product.sku, title: l.title, store: l.storeCode });
  }
  await audit(req, 'force_match_links', null, null, { matched, alreadyLinked, noMatch, pricesUpdated, storeCodesBackfilled, stores: stores.map(s => s.code) });
  res.json({ scanned: allListings.length, matched, alreadyLinked, noMatch, pricesUpdated, storeCodesBackfilled, sample: matches, stores: stores.map(s => s.code), storeErrors });
});

// POST /api/listings/hydrate-ebay-prices
// Pull live eBay listings, then update products.price_ebay using three
// matching strategies, in order of reliability:
//   1. mirror_links — explicit linking (ebay_item_id ↔ shopify_product_id)
//      A linked product is the most reliable signal; we trust this even if
//      the SKUs disagree (e.g. SKU drift between Shopify + eBay).
//   2. Exact SKU — products.sku === listing.sku
//   3. Normalised SKU — uppercased, alphanumeric-only
// We also opportunistically backfill mirror_links.store_code for legacy
// entries that don't have one yet, using the listing's storeCode.
router.post('/hydrate-ebay-prices', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  try {
    const stores = ebay.listStores().filter(s => s.hasToken);
    let allListings = [];
    // Per-store errors — surfaced in the response so the user can see exactly
    // which store's token / scope is broken. Without this they just see "0 from
    // 0 listings" and assume nothing is wrong with the auth.
    const storeErrors = [];
    for (const s of stores) {
      try {
        const part = await ebay.getActiveListings(s.code);
        allListings = allListings.concat(part);
      } catch (e) {
        console.warn(`[hydrate-ebay-prices] store=${s.code} failed: ${e.message}`);
        storeErrors.push({ store: s.code, error: e.message });
      }
    }

    // Pre-load mirror_links — used for strategy 1.
    const linksRes = await query(`SELECT ebay_item_id, shopify_product_id, store_code FROM mirror_links`);
    const linkByItemId = new Map();
    for (const r of linksRes.rows) linkByItemId.set(String(r.ebay_item_id), r);

    let matchedViaLink = 0, matchedViaSku = 0, matchedViaNormalizedSku = 0;
    let storeCodesBackfilled = 0;
    let zeroPrice = 0, unmatched = 0;
    const unmatchedSample = [];

    // Helper: update product.price_ebay for a given product id (by p.id)
    async function bumpPriceById(productId, ebayPrice) {
      const r = await query(
        `UPDATE products SET price_ebay = $1, updated_at = now()
         WHERE id = $2 AND $1::numeric > 0
         RETURNING id`,
        [ebayPrice, productId]
      );
      return r.rows.length;
    }

    for (const l of allListings) {
      const ebayPrice = l.priceEbay || 0;
      if (ebayPrice <= 0) { zeroPrice++; continue; }

      // Backfill store_code on any matching mirror_link that's missing one
      const link = linkByItemId.get(String(l.itemId));
      if (link && !link.store_code && l.storeCode) {
        await query(
          `UPDATE mirror_links SET store_code = $1 WHERE ebay_item_id = $2`,
          [l.storeCode, String(l.itemId)]
        );
        storeCodesBackfilled++;
        link.store_code = l.storeCode;
      }

      // Strategy 1: mirror_links → join to products via shopify_product_id
      if (link) {
        const r = await query(
          `UPDATE products SET price_ebay = $1, updated_at = now()
           WHERE shopify_product_id::text = $2 AND $1::numeric > 0
           RETURNING id`,
          [ebayPrice, String(link.shopify_product_id)]
        );
        if (r.rows.length) { matchedViaLink += r.rows.length; continue; }
      }

      // Strategy 2: exact SKU match
      if (l.sku) {
        const r = await query(
          `UPDATE products SET price_ebay = $1, updated_at = now() WHERE sku = $2 AND $1::numeric > 0 RETURNING id`,
          [ebayPrice, l.sku]
        );
        if (r.rows.length) { matchedViaSku += r.rows.length; continue; }

        // Strategy 3: normalised SKU (uppercase alphanumeric only)
        const norm = String(l.sku).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (norm.length >= 4) {
          const r2 = await query(
            `UPDATE products SET price_ebay = $1, updated_at = now()
             WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $2 AND $1::numeric > 0
             RETURNING id`,
            [ebayPrice, norm]
          );
          if (r2.rows.length) { matchedViaNormalizedSku += r2.rows.length; continue; }
        }
      }

      unmatched++;
      if (unmatchedSample.length < 20) unmatchedSample.push({ itemId: l.itemId, sku: l.sku, title: (l.title || '').slice(0, 80), price: ebayPrice, store: l.storeCode });
    }

    const totalUpdated = matchedViaLink + matchedViaSku + matchedViaNormalizedSku;
    res.json({
      ok: true,
      listingsFound: allListings.length,
      updated: totalUpdated,
      productsUpdated: totalUpdated, // legacy alias kept for old frontends
      matchedViaLink, matchedViaSku, matchedViaNormalizedSku,
      storeCodesBackfilled,
      zeroPrice,
      unmatched,
      unmatchedSample,
      stores: stores.map(s => s.code),
      storeErrors,  // populated only when one or more stores failed to fetch
    });
  } catch (e) {
    console.error('[hydrate-ebay-prices]', e);
    res.status(500).json({ error: 'hydrate_failed', message: e.message });
  }
});

// GET /api/listings/ebay-price-coverage — diagnostic. Counts how many products
// have price_ebay set, and lists the linked-but-missing ones so staff can see
// at a glance what's left to fix.
router.get('/ebay-price-coverage', requireAdmin, async (req, res) => {
  try {
    const totals = await query(`
      SELECT
        COUNT(*) FILTER (WHERE active) AS total,
        COUNT(*) FILTER (WHERE active AND price_ebay IS NOT NULL AND price_ebay > 0) AS with_ebay_price,
        COUNT(*) FILTER (WHERE active AND price_shopify IS NOT NULL AND price_shopify > 0) AS with_shopify_price,
        COUNT(*) FILTER (WHERE active AND shopify_product_id IS NOT NULL) AS linked_to_shopify
      FROM products
    `);
    const missing = await query(`
      SELECT p.id, p.sku, p.title, p.price_shopify, ml.ebay_item_id, ml.store_code
      FROM products p
      LEFT JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id
      WHERE p.active = true AND (p.price_ebay IS NULL OR p.price_ebay <= 0)
      ORDER BY ml.ebay_item_id NULLS LAST, p.id DESC
      LIMIT 50
    `);
    res.json({
      totals: {
        ...totals.rows[0],
        linked_no_ebay_price: missing.rows.filter(r => r.ebay_item_id).length,
      },
      missingSample: missing.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'coverage_failed', message: e.message });
  }
});

// GET /api/listings/debug-product?sku=... — pinpoints why a specific product
// isn't getting an eBay price. Returns the product, its mirror_link (if any),
// and whether any active eBay listing matches by SKU or item_id.
router.get('/debug-product', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const { sku, productId } = req.query;
  if (!sku && !productId) return res.status(400).json({ error: 'sku_or_productId_required' });
  try {
    const where = productId ? `id = $1` : `LOWER(sku) = LOWER($1)`;
    const param = productId || sku;
    const pRes = await query(
      `SELECT id, sku, title, price_shopify, price_ebay, shopify_product_id, active
       FROM products WHERE ${where} LIMIT 1`, [param]
    );
    const product = pRes.rows[0];
    if (!product) return res.json({ found: false });

    const linkRes = await query(
      `SELECT ebay_item_id, store_code, last_mirrored_at, last_synced_sku
       FROM mirror_links WHERE shopify_product_id::text = $1`,
      [String(product.shopify_product_id)]
    );
    const mirrorLink = linkRes.rows[0] || null;

    // If eBay is configured, also check live listings for matches
    let ebayMatches = { byItemId: null, bySku: null };
    if (ebay.isConfigured()) {
      const all = await getAllListingsAcrossStores();
      if (mirrorLink) {
        ebayMatches.byItemId = all.find(l => String(l.itemId) === String(mirrorLink.ebay_item_id))
          ? { found: true, store: all.find(l => String(l.itemId) === String(mirrorLink.ebay_item_id)).storeCode,
              price: all.find(l => String(l.itemId) === String(mirrorLink.ebay_item_id)).priceEbay }
          : { found: false };
      }
      const skuHit = all.find(l => l.sku === product.sku);
      if (skuHit) ebayMatches.bySku = { found: true, itemId: skuHit.itemId, store: skuHit.storeCode, price: skuHit.priceEbay };
      else ebayMatches.bySku = { found: false };
    }

    res.json({ found: true, product, mirrorLink, ebayMatches });
  } catch (e) {
    res.status(500).json({ error: 'debug_failed', message: e.message });
  }
});

// Diagnostic
router.get('/debug-shopify', requireAdmin, async (req, res) => {
  try {
    const out = await shopify.debugShopifyAccess();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'debug_failed', message: e.message });
  }
});

// GET /api/listings/sku-mismatches — compare eBay listing SKUs against Shopify SKUs
// via mirror_links. Returns any rows where eBay and Shopify disagree on SKU.
router.get('/sku-mismatches', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured() || !shopify.isConfigured()) {
    return res.status(400).json({ error: 'not_configured' });
  }
  try {
    const links = await query(
      `SELECT ebay_item_id, shopify_product_id, last_synced_sku FROM mirror_links`
    );
    if (!links.rows.length) return res.json({ checked: 0, mismatches: [] });

    // 1) Pull live eBay SKUs across all stores (only for our mirrored items)
    const stores = ebay.listStores().filter(s => s.hasToken);
    let ebayListings = [];
    for (const s of stores) {
      try {
        const part = await ebay.getActiveListings(s.code);
        ebayListings = ebayListings.concat(part);
      } catch (e) { console.warn(`[sku-mismatches] store=${s.code} failed: ${e.message}`); }
    }
    const ebaySkuByItemId = {};
    for (const l of ebayListings) ebaySkuByItemId[l.itemId] = l.sku || '';

    // 2) Pull Shopify products by ID
    const productIds = links.rows.map(r => String(r.shopify_product_id));
    const shopifySkuByProductId = {};
    // Fetch in batches via REST
    const axios = require('axios');
    const token = await shopify.getAccessToken();
    const VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
    for (const pid of productIds) {
      try {
        const r = await axios.get(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${VERSION}/products/${pid}.json`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const variant = r.data.product?.variants?.[0];
        shopifySkuByProductId[pid] = variant?.sku || '';
      } catch (e) {
        shopifySkuByProductId[pid] = null; // 404 / deleted
      }
    }

    // 3) Compare
    const mismatches = [];
    for (const link of links.rows) {
      const ebaySku = ebaySkuByItemId[link.ebay_item_id];
      const shopifySku = shopifySkuByProductId[String(link.shopify_product_id)];
      const onEbay = ebaySku !== undefined;
      const onShopify = shopifySku !== null;
      if (!onEbay || !onShopify || ebaySku !== shopifySku) {
        mismatches.push({
          ebayItemId: link.ebay_item_id,
          shopifyProductId: link.shopify_product_id,
          ebaySku: onEbay ? ebaySku : null,
          shopifySku,
          lastSyncedSku: link.last_synced_sku,
          status: !onEbay ? 'ebay_listing_missing'
                : !onShopify ? 'shopify_product_missing'
                : 'sku_mismatch',
        });
      }
    }

    res.json({
      checked: links.rows.length,
      mismatches,
      mismatchCount: mismatches.length,
    });
  } catch (e) {
    console.error('[listings/sku-mismatches]', e);
    res.status(500).json({ error: 'check_failed', message: e.message });
  }
});

// Metafield definitions
router.get('/metafield-definitions', requireAdmin, async (req, res) => {
  try {
    const defs = await shopify.getMetafieldDefinitions();
    res.json({ definitions: defs });
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// Delivery (shipping) profiles
router.get('/delivery-profiles', requireAdmin, async (req, res) => {
  try {
    const profiles = await shopify.getDeliveryProfiles();
    // When empty it's almost always the Shopify custom app missing the shipping
    // scopes — surface an actionable hint so the UI can explain the empty list.
    const hint = profiles.length ? null
      : 'No Shopify delivery profiles returned. Your Shopify custom app token likely needs the read_shipping scope (and write_shipping to assign products). In Shopify admin → Apps → your custom app → Configuration → Admin API access scopes, enable read_shipping + write_shipping, Save, then reinstall the app.';
    res.json({ profiles, hint });
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// GET /api/listings/ebay-active — pulls all active eBay listings, enriches with photos,
// merges in any persisted overrides, and uses mirror_links table to detect already-mirrored items.
router.get('/ebay-active', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) {
    return res.status(400).json({
      error: 'ebay_not_configured',
      message: 'Set EBAY_AUTH_TOKEN + EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (or OAuth refresh token) in Railway.',
    });
  }
  try {
    // Only stores with a live token are pulled — a store whose token was removed
    // (e.g. Evanta) is skipped automatically. We report which stores were pulled
    // and tag each listing with its store so duplicates can be spotted/filtered.
    const stores = ebay.listStores().filter(s => s.hasToken);
    let listings = [];
    const storesPulled = [];
    for (const s of stores) {
      try {
        const part = await ebay.getActiveListings(s.code, { enrichPhotos: true });
        part.forEach(l => { l.storeCode = s.code; l.storeName = s.name; });
        listings = listings.concat(part);
        storesPulled.push({ code: s.code, name: s.name, count: part.length });
      } catch (e) {
        console.warn(`[mirror.pull] store=${s.code} failed: ${e.message}`);
        storesPulled.push({ code: s.code, name: s.name, count: 0, error: e.message });
      }
    }

    const itemIds = listings.map(l => l.itemId);

    // Merge overrides
    const overridesRows = await query(
      `SELECT * FROM ebay_listing_overrides WHERE ebay_item_id = ANY($1)`, [itemIds]
    );
    const overridesMap = {};
    for (const row of overridesRows.rows) overridesMap[row.ebay_item_id] = row;

    // Mirror-link map (stable, survives SKU/title changes)
    const linkRows = await query(
      `SELECT * FROM mirror_links WHERE ebay_item_id = ANY($1)`, [itemIds]
    );
    const linkMap = {};
    for (const row of linkRows.rows) linkMap[row.ebay_item_id] = row;

    for (const l of listings) {
      const o = overridesMap[l.itemId];
      if (o) {
        l.overrideSku = o.override_sku;
        l.overrideTitle = o.override_title;
        l.customPrice = o.custom_price != null ? parseFloat(o.custom_price) : null;
        // Restore the saved per-listing settings + metafields so the user's work
        // reappears on re-pull.
        try { l.overrideMetafields = o.metafields ? (typeof o.metafields === 'string' ? JSON.parse(o.metafields) : o.metafields) : null; } catch (_) { l.overrideMetafields = null; }
        l.overrideTags = o.tags != null ? o.tags : null;
        l.overrideTemplateSuffix = o.template_suffix != null ? o.template_suffix : null;
        l.overrideShippingProfileId = o.shipping_profile_id != null ? o.shipping_profile_id : null;
        l.overrideCategoryId = o.category_id != null ? o.category_id : null;
        try { l.overrideSelectedImages = o.selected_images ? (typeof o.selected_images === 'string' ? JSON.parse(o.selected_images) : o.selected_images) : null; } catch (_) { l.overrideSelectedImages = null; }
      }
      const link = linkMap[l.itemId];
      if (link) {
        l.existsOnShopify = true;
        l.shopifyProductId = String(link.shopify_product_id);
        l.lastMirroredAt = link.last_mirrored_at;
      }
    }

    // For listings with no link, look them up on Shopify by SKU. eBay custom
    // labels are frequently EB-<itemid> while the Shopify product is keyed on the
    // PART NUMBER (e.g. "… RH - 10788797"), so the eBay SKU alone misses and the
    // listing looks un-mirrored — pushing it would then CREATE A DUPLICATE. We
    // therefore check two candidate codes per listing against Shopify: the eBay
    // SKU, and the part-number code at the end of the title.
    if (shopify.isConfigured()) {
      const unlinked = listings.filter(l => !l.existsOnShopify);
      const candFor = new Map(); // itemId -> [rawCode,...]
      const allCodes = new Set();
      for (const l of unlinked) {
        const cands = [];
        const sku = l.overrideSku || l.sku;
        if (sku) cands.push(String(sku));
        const title = l.overrideTitle || l.title || '';
        // Trailing " - CODE" (spaces around the dash, so a year range like
        // "2022-2025" is NOT captured). CODE may itself contain hyphens.
        const tail = title.match(/\s[-–]\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/);
        if (tail) cands.push(tail[1]);
        candFor.set(l.itemId, cands);
        for (const c of cands) allCodes.add(c);
      }
      if (allCodes.size) {
        const found = await shopify.findProductsBySkus([...allCodes]);
        for (const l of unlinked) {
          if (l.existsOnShopify) continue;
          const ebaySku = l.overrideSku || l.sku;
          const hit = (candFor.get(l.itemId) || []).find(c => found[c]);
          if (hit) {
            l.existsOnShopify = true;
            l.shopifyProductId = String(found[hit].product_id);
            l.shopifyTitle = found[hit].title;
            l.matchedBy = (hit === String(ebaySku)) ? 'sku' : 'part_number';
            // Backfill the mirror_links table so future pulls don't need to search.
            try {
              await query(`
                INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_synced_sku, last_synced_title)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (ebay_item_id) DO NOTHING
              `, [l.itemId, found[hit].product_id, ebaySku || hit, found[hit].title]);
            } catch (e) { /* ignore — non-critical */ }
          }
        }
      }
    }

    // Final fallback: match still-unmatched listings to a Shopify-linked
    // warehouse product by the CODE in the title. Many eBay listings have NO SKU
    // (or a SKU that differs from Shopify), so SKU-only matching leaves them
    // looking un-mirrored even though the product IS on Shopify. Calibre titles
    // end with "- <code>" (e.g. "… Diffuser Trim - 11192455"). That code is the
    // product's SKU on some products and the part_number on others (the
    // part_number column is often empty), so we index BOTH. Local products only;
    // high-precision candidates only.
    const stillUnmatched = listings.filter(l => !l.existsOnShopify);
    if (stillUnmatched.length) {
      const { rows: prodRows } = await query(
        `SELECT sku, part_number, shopify_product_id, title FROM products
          WHERE active = true AND shopify_product_id IS NOT NULL`);
      const pnMap = new Map();
      for (const p of prodRows) {
        for (const code of [p.part_number, p.sku]) {
          const n = normCode(code);
          if (n.length >= 5 && !pnMap.has(n)) pnMap.set(n, p);
        }
      }
      for (const l of stillUnmatched) {
        const sku = l.overrideSku || l.sku;
        const title = l.overrideTitle || l.title || '';
        const cands = [];
        if (sku) cands.push(normCode(sku));
        // Trailing " - CODE" (spaces around the dash, so a year range like
        // "2022-2025" is NOT matched). CODE may itself contain hyphens.
        const tail = title.match(/\s[-–]\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/);
        if (tail) cands.push(normCode(tail[1]));
        const match = cands.map(c => (c.length >= 5 ? pnMap.get(c) : null)).find(Boolean);
        if (match) {
          l.existsOnShopify = true;
          l.shopifyProductId = String(match.shopify_product_id);
          l.matchedBy = 'part_number';
          try {
            await query(`
              INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_synced_sku, last_synced_title)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (ebay_item_id) DO NOTHING
            `, [l.itemId, match.shopify_product_id, sku || null, title]);
          } catch (e) { /* ignore — non-critical */ }
        }
      }
    }

    res.json({ listings, count: listings.length, storesPulled });
  } catch (e) {
    console.error('[listings/ebay-active]', e.message);
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// POST /api/listings/set-stock { shopifyProductId, qty }
// Set the warehouse stock for the product behind a mirror listing and push the
// new quantity to Shopify + every linked eBay store. Used by the Listing Mirror
// "Update stock" control so an edited quantity becomes the single source of
// truth across channels.
router.post('/set-stock', requireAdmin, async (req, res) => {
  const { shopifyProductId } = req.body || {};
  const qty = parseInt(req.body?.qty);
  if (!shopifyProductId) return res.status(400).json({ error: 'shopifyProductId required' });
  if (!Number.isInteger(qty) || qty < 0) return res.status(400).json({ error: 'invalid_qty' });

  const pr = await query(`SELECT id, qty_on_hand FROM products WHERE shopify_product_id = $1 AND active = true LIMIT 1`, [String(shopifyProductId)]);
  const product = pr.rows[0];
  if (!product) return res.status(404).json({ error: 'product_not_found', message: 'No warehouse product is linked to this Shopify product.' });

  const delta = qty - product.qty_on_hand;
  await query(`UPDATE products SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [qty, product.id]);
  if (delta !== 0) {
    await query(`INSERT INTO stock_movements (product_id, delta, reason, notes, performed_by) VALUES ($1,$2,'manual',$3,$4)`,
      [product.id, delta, 'Set from Listing Mirror', req.user.id]).catch(() => {});
  }
  await audit(req, 'set_quantity', 'product', product.id, { quantity: qty, source: 'listing_mirror' });

  let channelPush = null;
  try {
    const { pushProductStockToChannels } = require('./products');
    channelPush = await pushProductStockToChannels(product.id);
  } catch (e) { channelPush = { error: e.message }; }
  res.json({ ok: true, productId: product.id, qty, channelPush });
});

// Persist override — SKU/title/price PLUS the per-listing settings + metafields
// (tags, product template, shipping profile, Shopify category) so a user's work
// in "Per-listing settings & metafields" survives a refresh / re-pull.
let _ovrColsReady = false;
async function ensureOverrideColumns() {
  if (_ovrColsReady) return;
  try {
    await query(`ALTER TABLE ebay_listing_overrides ADD COLUMN IF NOT EXISTS tags TEXT`);
    await query(`ALTER TABLE ebay_listing_overrides ADD COLUMN IF NOT EXISTS template_suffix TEXT`);
    await query(`ALTER TABLE ebay_listing_overrides ADD COLUMN IF NOT EXISTS category_id TEXT`);
    await query(`ALTER TABLE ebay_listing_overrides ADD COLUMN IF NOT EXISTS shipping_profile_id TEXT`);
    await query(`ALTER TABLE ebay_listing_overrides ADD COLUMN IF NOT EXISTS selected_images TEXT`);
    _ovrColsReady = true;
  } catch (e) { console.warn('[listings] ensureOverrideColumns:', e.message); }
}
router.post('/save-override', requireAdmin, async (req, res) => {
  const { itemId, overrideSku, overrideTitle, customPrice, metafields, shippingProfileId, tags, templateSuffix, categoryId, selectedImages } = req.body;
  if (!itemId) return res.status(400).json({ error: 'missing_item_id' });
  try {
    await ensureOverrideColumns();
    await query(`
      INSERT INTO ebay_listing_overrides (ebay_item_id, override_sku, override_title, custom_price, metafields, shipping_profile_id, tags, template_suffix, category_id, selected_images, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (ebay_item_id) DO UPDATE SET
        override_sku = EXCLUDED.override_sku,
        override_title = EXCLUDED.override_title,
        custom_price = EXCLUDED.custom_price,
        metafields = EXCLUDED.metafields,
        shipping_profile_id = EXCLUDED.shipping_profile_id,
        tags = EXCLUDED.tags,
        template_suffix = EXCLUDED.template_suffix,
        category_id = EXCLUDED.category_id,
        selected_images = EXCLUDED.selected_images,
        updated_at = now()
    `, [
      itemId,
      overrideSku || null,
      overrideTitle || null,
      customPrice != null ? customPrice : null,
      metafields ? JSON.stringify(metafields) : null,
      shippingProfileId || null,
      tags != null ? tags : null,
      templateSuffix != null ? templateSuffix : null,
      categoryId || null,
      (selectedImages && Array.isArray(selectedImages)) ? JSON.stringify(selectedImages) : null,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[listings/save-override]', e);
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

// Common (bulk) metafields applied to every mirrored listing — persisted globally
// so the set of Position/Finish/Part Number/etc. fields survives a refresh and is
// shared across the team, rather than living only in one browser tab.
let _mfDefaultsReady = false;
async function ensureMirrorDefaults() {
  if (_mfDefaultsReady) return;
  await query(`CREATE TABLE IF NOT EXISTS mirror_defaults (
    id INT PRIMARY KEY DEFAULT 1,
    common_metafields JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _mfDefaultsReady = true;
}
router.get('/common-metafields', requireAdmin, async (req, res) => {
  try {
    await ensureMirrorDefaults();
    const { rows } = await query(`SELECT common_metafields FROM mirror_defaults WHERE id = 1`);
    const mf = rows[0]?.common_metafields;
    res.json({ metafields: Array.isArray(mf) ? mf : (mf ? (typeof mf === 'string' ? JSON.parse(mf) : mf) : []) });
  } catch (e) {
    console.error('[listings/common-metafields GET]', e.message);
    res.json({ metafields: [] });
  }
});
router.post('/common-metafields', requireAdmin, async (req, res) => {
  try {
    await ensureMirrorDefaults();
    const metafields = Array.isArray(req.body?.metafields) ? req.body.metafields : [];
    await query(`
      INSERT INTO mirror_defaults (id, common_metafields, updated_at) VALUES (1, $1, now())
      ON CONFLICT (id) DO UPDATE SET common_metafields = EXCLUDED.common_metafields, updated_at = now()
    `, [JSON.stringify(metafields)]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[listings/common-metafields POST]', e.message);
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

// Check existing Shopify products by SKU
router.post('/check-conflicts', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });

  // Items mode: match each listing to an existing Shopify product by its SKU OR
  // the part-number code in its title, returning the productId so the caller can
  // offer to LINK instead of creating a duplicate.
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (items) {
    const codes = new Set();
    const perItem = items.map(it => {
      const cands = [];
      if (it.sku) cands.push(String(it.sku));
      const tail = String(it.title || '').match(/\s[-–]\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/);
      if (tail) cands.push(tail[1]);
      cands.forEach(c => codes.add(c));
      return { itemId: String(it.itemId), cands };
    });
    const found = codes.size ? await shopify.findProductsBySkus([...codes]) : {};
    const conflicts = [];
    for (const pi of perItem) {
      const hit = pi.cands.find(c => found[c]);
      if (hit) conflicts.push({ itemId: pi.itemId, matchedCode: hit, productId: found[hit].product_id, title: found[hit].title });
    }
    return res.json({ conflicts, mode: 'items' });
  }

  // Legacy SKU-only mode.
  const skus = (req.body.skus || []).filter(Boolean);
  const found = await shopify.findProductsBySkus(skus);
  const conflicts = Object.entries(found).map(([sku, info]) => ({ sku, ...info }));
  res.json({ conflicts });
});

// MIRROR — items: [{itemId, sku, title, price, imageUrls, status, metafields, qty, tags, templateSuffix, shippingProfileId}]
router.post('/mirror', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const items = req.body.items || [];
  const overwrite = !!req.body.overwriteConflicts;
  const results = { created: 0, updated: 0, skipped: 0, errors: [], metafieldIssues: [] };

  // Build lookup of existing products. Use mirror_links first (stable), then SKU as fallback.
  const itemIds = items.map(i => i.itemId).filter(Boolean);
  const linkRows = await query(`SELECT * FROM mirror_links WHERE ebay_item_id = ANY($1)`, [itemIds]);
  const linkByItemId = {};
  for (const r of linkRows.rows) linkByItemId[r.ebay_item_id] = r;

  // Group profile assignments to batch them at the end
  const profileAssignments = {}; // profileId -> [productIds]

  for (const item of items) {
    if (!item.sku) {
      results.errors.push({ title: item.title, error: 'missing SKU' });
      continue;
    }
    try {
      // Determine if this is an update (has stable link or matching SKU)
      let existingProductId = linkByItemId[item.itemId]?.shopify_product_id;
      if (!existingProductId) {
        const found = await shopify.findProductsBySkus([item.sku]);
        if (found[item.sku]) existingProductId = found[item.sku].product_id;
      }

      if (existingProductId && !overwrite) {
        results.skipped++;
        continue;
      }

      const args = {
        title: item.title,
        sku: item.sku,
        price: item.price,
        imageUrls: item.imageUrls || [],
        // Do NOT force a status. New products default to 'draft' inside
        // createProduct; updates must PRESERVE the live Shopify status unless the
        // user explicitly picked one — otherwise re-pushing an Active listing
        // would silently flip it to Draft.
        status: item.status || undefined,
        metafields: item.metafields || [],
        qty: item.qty != null ? item.qty : null,
        tags: item.tags || null,
        templateSuffix: item.templateSuffix || null,
      };

      let product;
      if (existingProductId && overwrite) {
        product = await shopify.updateProduct(existingProductId, args);
        results.updated++;
      } else {
        product = await shopify.createProduct(args);
        results.created++;
      }

      // Surface any metafields Shopify rejected so they're not silently dropped.
      for (const mf of (product?.__metafieldResults || [])) {
        if (!mf.ok) results.metafieldIssues.push({ sku: item.sku, key: `${mf.namespace}.${mf.key}`, error: mf.error });
      }

      // Assign the Shopify product category (standard taxonomy) when one was
      // chosen for this listing. Best-effort — a category failure must not abort
      // the mirror. categoryId is a taxonomy GID from the category picker.
      if (item.categoryId && product?.id) {
        try { await shopify.applyProductSeo(product.id, { categoryId: item.categoryId }); }
        catch (e) { console.warn('[mirror] category assign failed:', e.message); }
      }

      // Record/refresh the mirror link
      try {
        await query(`
          INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_mirrored_at, last_synced_sku, last_synced_title)
          VALUES ($1, $2, now(), $3, $4)
          ON CONFLICT (ebay_item_id) DO UPDATE SET
            shopify_product_id = EXCLUDED.shopify_product_id,
            last_mirrored_at = now(),
            last_synced_sku = EXCLUDED.last_synced_sku,
            last_synced_title = EXCLUDED.last_synced_title
        `, [item.itemId, product.id, item.sku, item.title]);
      } catch (e) {
        console.warn('[listings/mirror] failed to record link:', e.message);
      }

      // Mirror a warehouse product row so newly-created items immediately show in
      // Inventory + the stock-take. On conflict (SKU already exists) we only
      // refresh the Shopify link ids + reactivate — we do NOT overwrite the
      // warehouse title or stock qty, which the warehouse owns.
      try {
        const v = product?.variants?.[0];
        await query(`
          INSERT INTO products (sku, title, barcode, qty_on_hand, price_shopify,
                                shopify_product_id, shopify_variant_id, shopify_inventory_id, active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          ON CONFLICT (sku) DO UPDATE SET
            shopify_product_id   = EXCLUDED.shopify_product_id,
            shopify_variant_id   = EXCLUDED.shopify_variant_id,
            shopify_inventory_id = COALESCE(EXCLUDED.shopify_inventory_id, products.shopify_inventory_id),
            active = true,
            updated_at = now()
        `, [
          item.sku, item.title || item.sku, item.sku,
          item.qty != null ? item.qty : 0,
          item.price != null ? item.price : null,
          String(product.id),
          v?.id ? String(v.id) : null,
          v?.inventory_item_id ? String(v.inventory_item_id) : null,
        ]);
      } catch (e) {
        console.warn('[listings/mirror] failed to upsert warehouse product:', e.message);
      }

      // Group shipping profile assignment for batch (only non-default)
      if (item.shippingProfileId) {
        if (!profileAssignments[item.shippingProfileId]) profileAssignments[item.shippingProfileId] = [];
        profileAssignments[item.shippingProfileId].push(product.id);
      }
    } catch (e) {
      console.error('[listings/mirror] failed for', item.sku, e.message);
      results.errors.push({ sku: item.sku, title: item.title, error: e.message });
    }
  }

  // Apply shipping profile assignments per profile (one mutation per profile, batched variants)
  for (const [profileId, productIds] of Object.entries(profileAssignments)) {
    for (const pid of productIds) {
      try { await shopify.assignProductToDeliveryProfile(pid, profileId); }
      catch (e) { console.warn('[listings/mirror] profile assign failed:', e.message); }
    }
  }

  await audit(req, 'mirror_listings', null, null, results);
  res.json({ ok: true, ...results });
});

// Reusable warehouse-import worker (called by the manual button AND the cron).
// Repair/backfill so Shopify products show fully in the warehouse:
//   • create a `products` row for any Shopify product missing one,
//   • ENRICH rows already imported but lacking a photo or Shopify ids,
//   • adopt a real Shopify SKU where the warehouse still has a SHOPIFY- placeholder,
//   • re-establish the eBay link (mirror_links, matched by SKU) + eBay price.
// Idempotent: safe to run repeatedly; never clobbers warehouse-owned title/stock.
async function runShopifyWarehouseImport() {
  await ensureMirrorLinksColumns();
  if (!shopify.isConfigured()) return { error: 'shopify_not_configured' };

  let variants = [];
  for await (const v of shopify.iterateAllProductsAndVariants()) variants.push(v);

  const { rows: existing } = await query(`SELECT id, sku, shopify_product_id, image_url, price_ebay FROM products`);
  const prodBySpid = new Map();
  const prodBySku = new Map();
  for (const r of existing) {
    if (r.shopify_product_id) prodBySpid.set(String(r.shopify_product_id), r);
    if (r.sku) prodBySku.set(String(r.sku).trim().toUpperCase(), r);
  }

  const { rows: mlRows } = await query(`SELECT ebay_item_id, shopify_product_id FROM mirror_links`);
  const linkedSpid = new Set();
  const itemIdBySpid = new Map();
  for (const r of mlRows) {
    const spid = String(r.shopify_product_id || '');
    if (spid) { linkedSpid.add(spid); if (!itemIdBySpid.has(spid)) itemIdBySpid.set(spid, String(r.ebay_item_id)); }
  }

  // Decide whether the eBay pull is worth it BEFORE doing it — pulling every
  // store's active listings is the most quota-expensive step, and on the steady
  // 6-hourly cron there's usually nothing left to link or price. We only need
  // eBay data if some product is new, unlinked, or still missing its eBay price.
  const realSku = (v) => (v.sku && !/^SHOPIFY-/i.test(v.sku)) ? String(v.sku).trim() : null;
  const needsEbay = variants.some(v => {
    const sku = realSku(v); if (!sku) return false;
    const spid = String(v.shopify_product_id || '');
    const row = prodBySpid.get(spid) || prodBySku.get(sku.toUpperCase());
    if (!row) return true;                                   // new product → may link/price
    if (spid && !linkedSpid.has(spid)) return true;          // unlinked → may link
    return !(row.price_ebay > 0);                            // linked but no eBay price
  });

  // eBay listings keyed by normalised SKU AND by itemId — to re-link by code and
  // to backfill the eBay price even on items that are already linked.
  const ebayBySku = new Map();
  const ebayByItemId = new Map();
  if (needsEbay) {
    try {
      const listings = await getAllListingsAcrossStores();
      for (const l of listings) {
        ebayByItemId.set(String(l.itemId), l);
        const k = normCode(l.sku); if (k && !ebayBySku.has(k)) ebayBySku.set(k, l);
      }
    } catch (e) { console.warn('[import] eBay pull failed (links/prices skipped):', e.message); }
  }

  let created = 0, enriched = 0, ebayLinked = 0, pricesBackfilled = 0, skuFixed = 0, skippedExisting = 0, skippedNoSku = 0;
  const errors = [];
  const skippedItems = [];
  const seenProduct = new Set(); // one warehouse row per Shopify product (first variant wins)
  for (const v of variants) {
    const spid = String(v.shopify_product_id || '');
    if (spid && seenProduct.has(spid)) continue;
    if (spid) seenProduct.add(spid);
    // Skip Shopify's synthetic placeholder SKUs — the warehouse SKU is UNIQUE and
    // the printed identifier, so a real code is required.
    const sku = (v.sku && !/^SHOPIFY-/i.test(v.sku)) ? String(v.sku).trim() : null;
    if (!sku) {
      skippedNoSku++;
      if (skippedItems.length < 100) skippedItems.push({ productId: spid, title: v.title || '(untitled)', handle: v.shopify_handle || null });
      continue;
    }
    const img = v.image_url || null;
    try {
      let row = prodBySpid.get(spid) || prodBySku.get(sku.toUpperCase());
      let productId;
      if (!row) {
        const ins = await query(`
          INSERT INTO products (sku, title, barcode, qty_on_hand, price_shopify, image_url,
                                shopify_product_id, shopify_variant_id, shopify_inventory_id, active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
          ON CONFLICT (sku) DO UPDATE SET
            shopify_product_id   = EXCLUDED.shopify_product_id,
            shopify_variant_id   = EXCLUDED.shopify_variant_id,
            shopify_inventory_id = COALESCE(EXCLUDED.shopify_inventory_id, products.shopify_inventory_id),
            image_url            = COALESCE(products.image_url, EXCLUDED.image_url),
            active = true, updated_at = now()
          RETURNING id, price_ebay`,
          [sku, v.title || sku, v.barcode || sku,
           v.qty_on_hand != null ? v.qty_on_hand : 0,
           v.price_shopify != null ? v.price_shopify : null, img,
           spid || null,
           v.shopify_variant_id ? String(v.shopify_variant_id) : null,
           v.shopify_inventory_id ? String(v.shopify_inventory_id) : null]);
        productId = ins.rows[0].id;
        row = { id: productId, image_url: img, price_ebay: ins.rows[0].price_ebay, shopify_product_id: spid };
        prodBySpid.set(spid, row); prodBySku.set(sku.toUpperCase(), row);
        created++;
      } else {
        productId = row.id;
        // Fill the gaps the first import left: photo + Shopify ids. Never touch
        // title / stock / Shopify price — the warehouse owns those.
        const needsPhoto = !row.image_url && img;
        const needsLink = !String(row.shopify_product_id || '');
        // Adopt the REAL Shopify SKU/barcode when the warehouse row still carries a
        // synthetic SHOPIFY-<variant> placeholder (created by an early sync before
        // the product had a code). This is how a freshly-SKU'd Shopify product gets
        // its proper code pushed down into the warehouse.
        const placeholder = /^SHOPIFY-/i.test(String(row.sku || ''));
        const skuNeedsFix = placeholder && sku.toUpperCase() !== String(row.sku || '').toUpperCase();
        if (skuNeedsFix) {
          try {
            await query(`UPDATE products SET sku = $2, barcode = $3, updated_at = now() WHERE id = $1`,
              [productId, sku, v.barcode || sku]);
            skuFixed++;
            row.sku = sku; // keep the in-memory cache consistent with the new code
            prodBySku.set(sku.toUpperCase(), row);
          } catch (e) {
            if (e.code === '23505') { errors.push({ sku, error: 'real SKU already used by another warehouse product — resolve the duplicate first' }); }
            else throw e;
          }
        }
        if (needsPhoto || needsLink || skuNeedsFix) {
          await query(`
            UPDATE products SET
              image_url            = COALESCE(image_url, $2),
              shopify_product_id   = COALESCE(shopify_product_id, $3),
              shopify_variant_id   = COALESCE(shopify_variant_id, $4),
              shopify_inventory_id = COALESCE(shopify_inventory_id, $5),
              active = true, updated_at = now()
            WHERE id = $1`,
            [productId, img, spid || null,
             v.shopify_variant_id ? String(v.shopify_variant_id) : null,
             v.shopify_inventory_id ? String(v.shopify_inventory_id) : null]);
          enriched++;
        } else {
          skippedExisting++;
        }
      }

      // Resolve the eBay listing for this product: prefer an existing mirror_link
      // (by itemId), else match by SKU. Create the link if missing, and backfill
      // the eBay price in BOTH cases (already-linked rows could still be at £0).
      let listing = null;
      const existingItemId = spid ? itemIdBySpid.get(spid) : null;
      if (existingItemId) listing = ebayByItemId.get(String(existingItemId));
      if (!listing) listing = ebayBySku.get(normCode(sku));

      if (listing) {
        if (spid && !linkedSpid.has(spid)) {
          await query(`
            INSERT INTO mirror_links (ebay_item_id, shopify_product_id, store_code, last_mirrored_at, last_synced_sku, last_synced_title)
            VALUES ($1,$2,$3,now(),$4,$5)
            ON CONFLICT (ebay_item_id) DO UPDATE SET
              shopify_product_id = EXCLUDED.shopify_product_id,
              store_code = COALESCE(EXCLUDED.store_code, mirror_links.store_code),
              last_mirrored_at = now()`,
            [String(listing.itemId), spid, listing.storeCode || null, sku, v.title || listing.title || null]);
          linkedSpid.add(spid);
          ebayLinked++;
        }
        if (listing.priceEbay > 0 && !(row.price_ebay > 0)) {
          const upd = await query(
            `UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2 AND (price_ebay IS NULL OR price_ebay <= 0) RETURNING id`,
            [listing.priceEbay, productId]);
          if (upd.rows.length) pricesBackfilled++;
        }
      }
    } catch (e) { errors.push({ sku, error: e.message }); }
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN || '';
  return {
    scanned: variants.length, created, enriched, ebayLinked, pricesBackfilled, skuFixed, skippedExisting, skippedNoSku, errors,
    skippedItems,
    adminUrlBase: domain ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/products` : null,
  };
}

// Background job state — the import pulls ALL Shopify products + ALL eBay
// listings, which can take well over the platform's HTTP timeout. So the route
// kicks it off and returns immediately; the UI polls /status for the result.
let _importState = { running: false, startedAt: null, finishedAt: null, result: null, error: null, triggeredBy: null };

// Single-flight gate shared by BOTH the manual button and the cron, so the two
// can never run a full import concurrently (which would race upserts on the same
// products/mirror_links rows). Returns { skipped:'already_running' } when busy.
async function runImportSingleFlight(triggeredBy) {
  if (_importState.running) return { skipped: 'already_running' };
  _importState = { running: true, startedAt: Date.now(), finishedAt: null, result: null, error: null, triggeredBy: triggeredBy || 'manual' };
  try {
    const result = await runShopifyWarehouseImport();
    _importState.result = result;
    return result;
  } catch (e) {
    _importState.error = e.message;
    throw e;
  } finally {
    _importState.running = false;
    _importState.finishedAt = Date.now();
  }
}

// Kick the import off in the background (detached). The worker sets running:true
// synchronously before its first await, so _importState reflects the run at once.
function startWarehouseImport(triggeredBy) {
  if (_importState.running) return false;
  runImportSingleFlight(triggeredBy).catch(e => console.error('[import-shopify-to-warehouse] failed:', e.message));
  return true;
}

// POST /api/listings/import-shopify-to-warehouse — kick off the background import.
router.post('/import-shopify-to-warehouse', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const started = startWarehouseImport('manual');
  if (started) await audit(req, 'import_shopify_to_warehouse', null, null, { triggeredBy: 'manual' });
  res.json({ started, alreadyRunning: !started });
});

// GET /api/listings/import-shopify-to-warehouse/status — poll for progress/result.
router.get('/import-shopify-to-warehouse/status', requireAdmin, (req, res) => {
  res.json(_importState);
});

// POST /api/listings/create-listing — WAREHOUSE-FIRST listing creation.
// Creates the warehouse product (master), pushes it to Shopify with price =
// eBay − [Shopify %], plus category / tags / custom metafields, links them, and
// returns the new productId so the caller can run the (proven) eBay-create flow.
router.post('/create-listing', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  const title = String(b.title || '').trim();
  // Part number is what links listings that fit several models into ONE shared
  // stock pool. Each listing keeps its own unique SKU; a shared part number is
  // what makes them draw from the same quantity. Defaults to the SKU when blank
  // (the common single-model case where SKU == part number).
  const partNumber = String(b.partNumber || '').trim() || sku;
  // Barcode = the SCANNED code = the physical part. Multi-fitment siblings (same
  // part, different make/model) share one barcode but each have a unique SKU.
  const barcode = String(b.barcode || '').trim() || sku;
  const ebayPrice = parseFloat(b.ebayPrice);
  if (!sku || !title) return res.status(400).json({ error: 'sku_and_title_required' });
  if (isNaN(ebayPrice) || ebayPrice < 0) return res.status(400).json({ error: 'invalid_price' });

  const dup = await query(`SELECT id, sku, title, part_number, barcode FROM products WHERE TRIM(LOWER(sku)) = TRIM(LOWER($1))`, [sku]);
  if (dup.rows[0]) return res.status(409).json({
    error: 'sku_exists', productId: dup.rows[0].id,
    existing: { sku: dup.rows[0].sku, title: dup.rows[0].title, part_number: dup.rows[0].part_number, barcode: dup.rows[0].barcode },
  });

  // Shopify price is derived from the eBay (master) price using the configured %.
  const sr = await query(`SELECT price_link_pct, bank_transfer_pct FROM app_settings WHERE id = 1`);
  const s = sr.rows[0] || {};
  const shopPct = s.price_link_pct != null ? parseFloat(s.price_link_pct)
    : (s.bank_transfer_pct != null ? parseFloat(s.bank_transfer_pct) : 10);
  const shopifyPrice = +(ebayPrice * (1 - shopPct / 100)).toFixed(2);

  let qty = Number.isInteger(b.qty) ? b.qty : (parseInt(b.qty) || 0);
  const imageUrls = Array.isArray(b.imageUrls) ? b.imageUrls.filter(Boolean) : [];
  const imageData = Array.isArray(b.imagesBase64) ? b.imagesBase64.filter(Boolean) : [];
  const metafields = Array.isArray(b.metafields) ? b.metafields : [];
  let tags = b.tags || null;
  let status = ['active', 'draft'].includes(b.status) ? b.status : 'draft';
  const taxable = b.taxable !== false;                       // Shopify "charge tax (VAT)"
  const templateSuffix = b.templateSuffix || null;           // theme product template
  const shippingProfileId = b.shippingProfileId || null;     // Shopify delivery profile
  // Alternate / sub part numbers — stored in the warehouse, mirrored to a Shopify
  // metafield, and added to the eBay listing (via create-ebay) as Interchange PN.
  const subPartNumbers = Array.isArray(b.subPartNumbers) ? b.subPartNumbers.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (subPartNumbers.length) {
    metafields.push({ namespace: 'custom', key: 'alternate_part_numbers', type: 'single_line_text_field', value: subPartNumbers.join(', ') });
  }

  // ── Pre-listing / pre-order ────────────────────────────────────────────────
  // A product created BEFORE its stock arrives. On Shopify it's listed active but
  // sold as a pre-order: keeps selling at 0 stock ('continue'), carries the
  // 'preorder' tag (auto-joins the "Pre-order & Incoming Stock" smart collection),
  // and the ETA metafields (custom.preorder_eta + custom.preorder_ships_note) that
  // the theme snippet renders. The title/description stay CLEAN — the storefront
  // presentation comes from the tag/metafields, not text baked into the title.
  // On eBay it's held by us and published at a go-live time (see ebayPrelist + cron).
  const isPrelisted = !!b.prelisted;
  if (isPrelisted) qty = 0;                              // not in stock yet
  const preorderEta = (isPrelisted && b.preorderEta) ? String(b.preorderEta).slice(0, 10) : null;
  const ebayScheduledAt = (isPrelisted && b.ebayScheduledAt) ? new Date(b.ebayScheduledAt) : null;
  // The full create-ebay payload to replay at go-live (storeCode, categoryId,
  // price, itemSpecifics, etc.). Stored verbatim; productId is injected at publish.
  const ebayPrelistPayload = (isPrelisted && b.ebayPrelist && b.ebayPrelist.storeCode)
    ? { ...b.ebayPrelist } : null;

  if (isPrelisted) {
    status = 'active';                                   // listed now, sells as pre-order
    tags = preorder.addPreorderTag(tags);               // 'preorder' tag (theme/coll filters)
    metafields.push({ namespace: 'custom', key: 'preorder_eta', type: 'date', value: preorderEta || '' });
    metafields.push({ namespace: 'custom', key: 'preorder_ships_note', type: 'single_line_text_field', value: preorder.shipsNote(preorderEta) });
  }

  const result = { ok: true, sku, ebayPrice, shopifyPrice, shopPct };
  let shopifyProduct = null;
  if (shopify.isConfigured()) {
    try {
      shopifyProduct = await shopify.createProduct({
        title, sku, price: shopifyPrice, imageUrls, imageData, status, metafields, qty, tags,
        description: b.description || null, taxable, templateSuffix,
        // Pre-orders are CAPPED to the incoming quantity (not unlimited): 'deny' so
        // Shopify won't oversell beyond the available count we push (= units on the
        // way). The available qty is set just after the incoming line is created.
        inventoryPolicy: isPrelisted ? 'deny' : null,
      });
      if (isPrelisted) { try { await shopify.ensurePreorderCollection(); } catch (_) {} }
      for (const mf of (shopifyProduct?.__metafieldResults || [])) {
        if (!mf.ok) (result.metafieldIssues = result.metafieldIssues || []).push({ key: `${mf.namespace}.${mf.key}`, error: mf.error });
      }
      if (b.categoryId && shopifyProduct?.id) {
        try { await shopify.applyProductSeo(shopifyProduct.id, { categoryId: b.categoryId }); }
        catch (e) { result.categoryError = e.message; }
      }
      // Assign the chosen Shopify delivery (shipping) profile, best-effort.
      if (shippingProfileId && shopifyProduct?.id && shopify.assignProductToDeliveryProfile) {
        try { await shopify.assignProductToDeliveryProfile(shopifyProduct.id, shippingProfileId); }
        catch (e) { result.shippingProfileError = e.message; }
      }
    } catch (e) {
      return res.status(502).json({ error: 'shopify_create_failed', message: e.message });
    }
  } else {
    result.shopifySkipped = 'not_configured';
  }

  // Warehouse product = master. Store the Shopify ids so stock/price sync works.
  const v = shopifyProduct?.variants?.[0];
  // The Shopify create response already carries the hosted image URLs — capture
  // them so the eBay create can use the exact same photos (the live Shopify
  // product can lag for a moment after an attachment upload).
  // Sort by position so imgSrcs[0] is the real main image (Shopify can return
  // base64 uploads out of order) — this is what becomes the warehouse thumbnail
  // and the eBay gallery order.
  const imgSrcs = (shopifyProduct?.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => im.src).filter(Boolean);
  result.imageUrls = imgSrcs;
  const ins = await query(`
    INSERT INTO products (sku, title, barcode, part_number, qty_on_hand, price_ebay, price_shopify, image_url,
                          shopify_product_id, shopify_variant_id, shopify_inventory_id, active,
                          is_prelisted, preorder_active, preorder_eta, ebay_scheduled_at, ebay_prelist_payload, ebay_prelist_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [sku, title, barcode, partNumber, qty, ebayPrice, shopifyPrice, imgSrcs[0] || null,
     shopifyProduct ? String(shopifyProduct.id) : null,
     v?.id ? String(v.id) : null,
     v?.inventory_item_id ? String(v.inventory_item_id) : null,
     isPrelisted,
     isPrelisted,            // preorder_active — a pre-listing sells as a pre-order from day one
     preorderEta,
     ebayScheduledAt,
     ebayPrelistPayload ? JSON.stringify(ebayPrelistPayload) : null,
     ebayPrelistPayload ? 'scheduled' : null]);
  const productId = ins.rows[0].id;

  // Store the alternate / sub part numbers against the new product (searchable).
  for (const code of subPartNumbers) {
    try { await query(`INSERT INTO product_part_numbers (product_id, code) VALUES ($1, $2)`, [productId, code]); }
    catch (e) { /* dupe / table issue — non-fatal */ }
  }

  // If another active listing already uses this part number, link them into a
  // shared stock pool so a sale on any one decrements them all.
  try {
    const { autoPoolByPartNumber } = require('./products');
    const pool = await autoPoolByPartNumber(productId, partNumber);
    if (pool) result.stockPool = pool;
  } catch (e) { /* best-effort — never fail the create over pooling */ }

  // Pre-listing: create a linked incoming_stock line (existing or new container)
  // so the arriving units are tracked and "receiving" them later flips this
  // product live. Best-effort — never fail the listing over the incoming link.
  if (isPrelisted && b.incoming && (b.incoming.containerRef || b.incoming.qtyOrdered)) {
    try {
      const incoming = require('./incoming');
      await incoming.ensureIncomingTable();
      const inc = b.incoming;
      const incQty = parseInt(inc.qtyOrdered) || 0;
      const incCurrency = String(inc.currency || 'CNY').toUpperCase();
      const { gbp: incGbp, rate: incRate } = await incoming.costToGbp(inc.unitCostForeign, incCurrency, inc.expectedDate || preorderEta, inc.fxRate);
      const incIns = await query(
        `INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date, status, notes, created_by,
                                     unit_cost_foreign, currency, fx_rate, unit_cost_gbp, freight_total, duty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [productId, sku, title, partNumber, incQty, inc.containerRef || null, inc.supplier || null,
         inc.expectedDate || preorderEta || null, inc.status || 'on_order', inc.notes || 'Pre-listing', req.user.id,
         (inc.unitCostForeign != null && inc.unitCostForeign !== '') ? parseFloat(inc.unitCostForeign) : null,
         incCurrency, incRate, incGbp,
         (inc.freightTotal != null && inc.freightTotal !== '') ? parseFloat(inc.freightTotal) : null,
         (inc.duty != null && inc.duty !== '') ? parseFloat(inc.duty) : null]);
      result.incomingId = incIns.rows[0].id;
    } catch (e) { result.incomingError = e.message; }
  }

  // Pre-order: now that the incoming line exists, push the CAPPED available qty
  // (units on the way) to Shopify so the listing shows a real, limited count.
  if (isPrelisted) {
    try { await require('./products').pushProductStockToChannels(productId); } catch (e) { /* best-effort */ }
  }

  await audit(req, 'create_listing', 'product', productId, { sku, partNumber, ebayPrice, shopifyPrice, subPartNumbers: subPartNumbers.length, shopify: !!shopifyProduct, pooled: !!result.stockPool, prelisted: isPrelisted });
  res.status(201).json({ ...result, productId, partNumber, prelisted: isPrelisted, preorderEta, shopifyProductId: shopifyProduct ? String(shopifyProduct.id) : null });
});

// GET /api/listings/listing-detail/:productId — gather EVERYTHING needed to
// pre-fill the Edit-listing page: the warehouse master fields, the live Shopify
// product (title/desc/price/tags/images), and the live eBay listing (title/
// price/qty/description/item specifics). Best-effort per channel.
router.get('/listing-detail/:productId', requireAdmin, async (req, res) => {
  const pr = await query(
    `SELECT p.*, sg.code AS stock_group_code, l.name AS location_name
     FROM products p
     LEFT JOIN stock_groups sg ON sg.id = p.stock_group_id
     LEFT JOIN locations l ON l.id = p.location_id
     WHERE p.id = $1`, [req.params.productId]);
  const product = pr.rows[0];
  if (!product) return res.status(404).json({ error: 'not_found' });

  const out = { product };
  try {
    const spn = await query(`SELECT code FROM product_part_numbers WHERE product_id = $1 ORDER BY id`, [product.id]);
    out.subPartNumbers = spn.rows.map(r => r.code);
  } catch (_) { out.subPartNumbers = []; }

  if (product.shopify_product_id && shopify.isConfigured()) {
    try { out.shopify = await shopify.getShopifyProductFull(product.shopify_product_id); }
    catch (e) { out.shopifyError = e.message; }
  }

  // Find the linked eBay listing(s); pull the first one's full detail to pre-fill.
  try {
    const links = await query(
      `SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`,
      [product.shopify_product_id]);
    out.ebayLinks = links.rows.map(r => ({ itemId: r.ebay_item_id, storeCode: r.store_code }));
    if (links.rows[0]) {
      try {
        out.ebay = await ebay.getItemDetails(links.rows[0].ebay_item_id, links.rows[0].store_code);
        out.ebay.itemId = links.rows[0].ebay_item_id;
        out.ebay.storeCode = links.rows[0].store_code;
        // Live quantity (GetItem's price block doesn't carry it reliably).
        try { out.ebay.quantity = await ebay.getQuantityTradingAPI(links.rows[0].ebay_item_id, links.rows[0].store_code); } catch (_) {}
      } catch (e) { out.ebayError = e.message; }
    }
  } catch (e) { out.ebayLinks = []; }

  // Persisted eBay config on the product is the fallback source of truth for the
  // edit form, so specifics reload even when there's no live listing yet (draft)
  // or the GetItem read failed — this is what stops an edit from wiping them.
  const persisted = Array.isArray(product.ebay_item_specifics) ? product.ebay_item_specifics : [];
  out.persisted = { specifics: persisted, categoryId: product.ebay_category_id || null,
    conditionId: product.ebay_condition_id || null, description: product.ebay_description || '' };
  if (out.ebay) {
    if (!Array.isArray(out.ebay.specifics) || !out.ebay.specifics.length) out.ebay.specifics = persisted;
  } else if (persisted.length || product.ebay_category_id) {
    out.ebay = { specifics: persisted, categoryId: product.ebay_category_id, conditionId: product.ebay_condition_id,
      description: product.ebay_description || '', quantity: product.qty_on_hand, price: product.price_ebay, fromPersisted: true };
  }

  res.json(out);
});

// POST /api/listings/update-listing — EDIT a live listing and push the changes
// to the warehouse (master), Shopify, and eBay in one go. Mirrors create-listing
// but for an existing product. Each channel is best-effort so one failure is
// reported without blocking the others.
router.post('/update-listing', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const productId = parseInt(b.productId);
  if (!productId) return res.status(400).json({ error: 'productId_required' });
  const cur = await query(`SELECT * FROM products WHERE id = $1`, [productId]);
  const product = cur.rows[0];
  if (!product) return res.status(404).json({ error: 'not_found' });

  const sku = String(b.sku || '').trim() || product.sku;
  const shopTitle = String(b.title || '').trim() || product.title;
  const ebayTitle = String(b.ebayTitle || '').trim() || shopTitle;
  const partNumber = String(b.partNumber || '').trim() || product.part_number || sku;
  const ebayPrice = b.ebayPrice != null && b.ebayPrice !== '' ? parseFloat(b.ebayPrice) : (product.price_ebay != null ? parseFloat(product.price_ebay) : null);
  const qty = b.qty != null && b.qty !== '' ? (parseInt(b.qty) || 0) : product.qty_on_hand;

  // SKU change must not collide with another product.
  if (sku.toLowerCase() !== String(product.sku || '').toLowerCase()) {
    const dup = await query(`SELECT id FROM products WHERE TRIM(LOWER(sku)) = TRIM(LOWER($1)) AND id <> $2`, [sku, productId]);
    if (dup.rows[0]) return res.status(409).json({ error: 'sku_exists', productId: dup.rows[0].id });
  }

  // Shopify price derived from the eBay (master) price using the configured %.
  const sr = await query(`SELECT price_link_pct, bank_transfer_pct FROM app_settings WHERE id = 1`);
  const s = sr.rows[0] || {};
  const shopPct = s.price_link_pct != null ? parseFloat(s.price_link_pct)
    : (s.bank_transfer_pct != null ? parseFloat(s.bank_transfer_pct) : 10);
  const shopifyPrice = ebayPrice != null ? +(ebayPrice * (1 - shopPct / 100)).toFixed(2) : (product.price_shopify != null ? parseFloat(product.price_shopify) : null);

  const result = { ok: true, productId };

  // 1) Warehouse master.
  await query(
    `UPDATE products SET sku = $1, title = $2, part_number = $3, price_ebay = $4, price_shopify = $5, qty_on_hand = $6, updated_at = now() WHERE id = $7`,
    [sku, shopTitle, partNumber, ebayPrice, shopifyPrice, qty, productId]);
  result.warehouse = { ok: true };

  // Keep sub / alternate part numbers in sync (replace the set if provided).
  if (Array.isArray(b.subPartNumbers)) {
    const codes = b.subPartNumbers.map(x => String(x || '').trim()).filter(Boolean);
    try {
      await query(`DELETE FROM product_part_numbers WHERE product_id = $1`, [productId]);
      for (const code of codes) {
        try { await query(`INSERT INTO product_part_numbers (product_id, code) VALUES ($1, $2)`, [productId, code]); } catch (_) {}
      }
    } catch (_) {}
  }

  // 2) Shopify.
  const metafields = Array.isArray(b.metafields) ? b.metafields.slice() : [];
  if (Array.isArray(b.subPartNumbers) && b.subPartNumbers.length) {
    metafields.push({ namespace: 'custom', key: 'alternate_part_numbers', type: 'single_line_text_field', value: b.subPartNumbers.join(', ') });
  }
  // Image changes (e.g. swapping out watermarked photos). `images` is an ordered
  // list mixing already-hosted URLs and freshly-uploaded base64 data URLs. We
  // host them on Shopify, then reuse the resulting URLs on eBay so both channels
  // show the same photos. Only touched when the user actually changed them.
  const imagesChanged = !!b.imagesChanged && Array.isArray(b.images);
  let hostedImageUrls = null;   // resulting Shopify-hosted URLs, in order
  if (product.shopify_product_id && shopify.isConfigured()) {
    try {
      await shopify.updateProduct(product.shopify_product_id, {
        title: shopTitle, sku, price: shopifyPrice,
        status: ['active', 'draft'].includes(b.status) ? b.status : undefined,
        tags: b.tags != null ? b.tags : null,
        templateSuffix: b.templateSuffix != null ? b.templateSuffix : null,
        description: b.description != null ? b.description : null,
        metafields,
        imageUrls: [],   // images handled separately below (supports base64 uploads)
      });
      if (b.categoryId) {
        try { await shopify.applyProductSeo(product.shopify_product_id, { categoryId: b.categoryId }); }
        catch (e) { result.categoryError = e.message; }
      }
      if (b.shippingProfileId && shopify.assignProductToDeliveryProfile) {
        try { await shopify.assignProductToDeliveryProfile(product.shopify_product_id, b.shippingProfileId); }
        catch (e) { result.shippingProfileError = e.message; }
      }
      if (imagesChanged && b.images.length && shopify.replaceProductImagesOrdered) {
        try {
          hostedImageUrls = await shopify.replaceProductImagesOrdered(product.shopify_product_id, b.images);
          result.images = { ok: true, count: hostedImageUrls.length };
          if (hostedImageUrls[0]) await query(`UPDATE products SET image_url = $1 WHERE id = $2`, [hostedImageUrls[0], productId]);
        } catch (e) { result.images = { error: e.message }; }
      }
      result.shopify = { ok: true };
    } catch (e) { result.shopify = { error: e.message }; }
  } else {
    result.shopify = { skipped: product.shopify_product_id ? 'not_configured' : 'no_shopify_product' };
  }
  // eBay can only point at hosted URLs. Prefer the freshly-hosted Shopify set;
  // fall back to the submitted list if it's already all URLs (no new uploads).
  let ebayPictureUrls;
  if (imagesChanged) {
    if (hostedImageUrls && hostedImageUrls.length) ebayPictureUrls = hostedImageUrls;
    else { const urlsOnly = (b.images || []).filter(u => /^https?:\/\//.test(String(u))); if (urlsOnly.length) ebayPictureUrls = urlsOnly; }
  }

  // 3) eBay — revise every linked listing. CRITICAL: eBay's ReviseItem treats a
  // submitted <ItemSpecifics> block as a FULL REPLACEMENT, so we must send the
  // COMPLETE set, never a subset (that was the bug: the edit form posts only a
  // few fields and everything else got wiped). We rebuild the full set per
  // listing as: live listing specifics  <  our persisted set  <  derived from
  // warehouse (Make/Model/Placement/Country/MPN/Interchange/Product Number)  <
  // the edit form's values (highest priority). Nothing the user didn't touch is
  // lost. The edit form only sets values — it never clears (empties are dropped).
  const formSpecifics = Array.isArray(b.itemSpecifics)
    ? b.itemSpecifics.filter(it => it && it.name && it.value != null && String(it.value).trim() !== '')
        .map(it => ({ name: String(it.name), value: String(it.value) }))
    : [];
  // Product-level pieces (same for every linked store).
  const storedSpecifics = Array.isArray(product.ebay_item_specifics) ? product.ebay_item_specifics : [];
  const derivedNow = await deriveEbaySpecifics(
    { ...product, part_number: partNumber, sku, title: shopTitle },
    { countryOfOrigin: b.countryOfOrigin != null ? b.countryOfOrigin : undefined });
  // Persist our best full set (without the per-listing live layer) for next time.
  const persistSpecifics = mergeSpecificsByName(storedSpecifics, derivedNow, formSpecifics);
  try {
    await query(`UPDATE products SET ebay_item_specifics = $1::jsonb,
                   ebay_description = COALESCE($2, ebay_description), updated_at = now() WHERE id = $3`,
      [JSON.stringify(persistSpecifics),
       (b.ebayDescription != null && String(b.ebayDescription).trim() !== '') ? String(b.ebayDescription) : null,
       productId]);
  } catch (_) {}

  result.ebay = [];
  try {
    const links = await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`, [product.shopify_product_id]);
    const stores = ebay.listStores().filter(st => st.hasToken && !st.disabled);
    for (const link of links.rows) {
      const store = stores.find(st => st.code === link.store_code) || (link.store_code ? null : (stores.find(st => st.primary) || stores[0]));
      if (!store) { result.ebay.push({ itemId: link.ebay_item_id, skipped: 'store_unavailable' }); continue; }
      try {
        // Read the listing's CURRENT specifics so anything set directly on eBay
        // (or that we never persisted) also survives. Best-effort.
        let liveSpecifics = [], liveOk = false;
        try {
          const det = await ebay.getItemDetails(link.ebay_item_id, store.code);
          if (det && Array.isArray(det.specifics)) { liveSpecifics = det.specifics; liveOk = true; }
        } catch (_) { /* fall back to persisted + derived */ }
        // Only REPLACE specifics when we have a trustworthy full baseline — a
        // successful live read OR a previously-persisted set. If the live read
        // failed and we've never persisted (a listing predating this feature),
        // we OMIT the <ItemSpecifics> block so eBay keeps the listing's existing
        // specifics: sending a partial set would wipe the rest (the original bug).
        const haveBaseline = liveOk || storedSpecifics.length > 0;
        const fullSpecifics = mergeSpecificsByName(liveSpecifics, storedSpecifics, derivedNow, formSpecifics);
        const specificsToSend = (haveBaseline && fullSpecifics.length) ? fullSpecifics : undefined;
        await ebay.reviseItem(link.ebay_item_id, {
          sku,
          title: ebayTitle ? ebayTitle.slice(0, 80) : undefined,
          price: ebayPrice != null ? ebayPrice : undefined,
          description: b.ebayDescription != null && String(b.ebayDescription).trim() !== '' ? b.ebayDescription : undefined,
          itemSpecifics: specificsToSend,
          pictureUrls: ebayPictureUrls && ebayPictureUrls.length ? ebayPictureUrls : undefined,
        }, store.code);
        try { await ebay.setQuantityTradingAPI(link.ebay_item_id, qty, store.code); } catch (e) { /* qty push best-effort */ }
        result.ebay.push({ itemId: link.ebay_item_id, store: store.code, ok: true, specificsSent: fullSpecifics.length });
      } catch (e) {
        result.ebay.push({ itemId: link.ebay_item_id, store: store.code, error: e.message });
      }
    }
    if (!links.rows.length) result.ebay.push({ skipped: 'no_ebay_link' });
  } catch (e) { result.ebay.push({ error: e.message }); }

  // 4) Make sure the shared stock pool (if any) stays in lockstep with the new qty.
  try {
    const { pushProductStockToChannels } = require('./products');
    result.stockSync = await pushProductStockToChannels(productId);
  } catch (e) { /* best-effort */ }

  await audit(req, 'update_listing', 'product', productId, { sku, ebayPrice, shopifyPrice, qty });
  res.json(result);
});

// POST /api/listings/repush-ebay-images { productId }
// Re-send a product's Shopify photos to its linked eBay listing(s) — fixes
// listings that ended up with no images.
router.post('/repush-ebay-images', requireAdmin, async (req, res) => {
  const productId = req.body?.productId;
  if (!productId) return res.status(400).json({ error: 'productId_required' });
  const pr = await query(`SELECT id, sku, shopify_product_id, image_url FROM products WHERE id = $1`, [productId]);
  const product = pr.rows[0];
  if (!product) return res.status(404).json({ error: 'not_found' });

  // Source images: prefer the full Shopify set, fall back to the stored image_url.
  let imageUrls = product.image_url ? [product.image_url] : [];
  if (product.shopify_product_id && shopify.isConfigured()) {
    try { const sp = await shopify.getShopifyProductFull(product.shopify_product_id); if (sp.imageUrls?.length) imageUrls = sp.imageUrls; }
    catch (e) { /* fall back to image_url */ }
  }
  if (!imageUrls.length) return res.status(400).json({ error: 'no_images', message: 'No Shopify images found for this product.' });

  const links = await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`, [product.shopify_product_id]);
  if (!links.rows.length) return res.status(400).json({ error: 'no_ebay_link', message: 'This product has no linked eBay listing.' });

  const ebay = require('../services/ebay');
  const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
  let pushed = 0; const errors = [];
  for (const link of links.rows) {
    const store = stores.find(s => s.code === link.store_code) || (link.store_code ? null : (stores.find(s => s.primary) || stores[0]));
    if (!store) { errors.push(`${link.ebay_item_id}: store unavailable`); continue; }
    try { await ebay.reviseItem(link.ebay_item_id, { pictureUrls: imageUrls }, store.code); pushed++; }
    catch (e) { errors.push(`${link.ebay_item_id}: ${e.message}`); }
  }
  await audit(req, 'repush_ebay_images', 'product', product.id, { pushed, images: imageUrls.length });
  res.json({ ok: pushed > 0, pushed, images: imageUrls.length, errors });
});

// POST /api/listings/resync-images — one-click re-push of the SELECTED images only.
// Deliberately separate from /mirror: it touches images and nothing else (no
// title/price/metafields), so refreshing photos to full resolution can't disturb
// the rest of the product. Body: { items: [{ itemId, sku, imageUrls }] }.
router.post('/resync-images', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const items = req.body.items || [];
  const results = { updated: 0, skipped: 0, errors: [] };

  const itemIds = items.map(i => i.itemId).filter(Boolean);
  const linkRows = itemIds.length
    ? await query(`SELECT * FROM mirror_links WHERE ebay_item_id = ANY($1)`, [itemIds])
    : { rows: [] };
  const linkByItemId = {};
  for (const r of linkRows.rows) linkByItemId[r.ebay_item_id] = r;

  for (const item of items) {
    try {
      if (!item.imageUrls || !item.imageUrls.length) { results.skipped++; continue; }
      // Resolve the Shopify product: stable mirror link first, then SKU.
      let pid = linkByItemId[item.itemId]?.shopify_product_id;
      if (!pid && item.sku) {
        const found = await shopify.findProductsBySkus([item.sku]);
        if (found[item.sku]) pid = found[item.sku].product_id;
      }
      if (!pid) { results.skipped++; results.errors.push({ sku: item.sku, error: 'not linked to a Shopify product' }); continue; }
      const r = await shopify.setProductImages(pid, item.imageUrls);
      if (r.ok) results.updated++; else { results.skipped++; results.errors.push({ sku: item.sku, error: r.skipped || 'no images uploaded' }); }
    } catch (e) {
      results.errors.push({ sku: item.sku, error: e.message });
    }
  }
  await audit(req, 'resync_images', null, null, results);
  res.json({ ok: true, ...results });
});

// PUSH TO EBAY — write SKU / title / price back to a specific eBay listing.
// Body: { itemId, sku?, title?, price?, store? }
// `store` is the store code (e.g. 'evbodyparts'). Required for multi-store brands.
// For single-store brands (Razoryn), defaults to the primary store.
router.post('/push-to-ebay', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  const { itemId, sku, title, price, store } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'missing_item_id' });
  try {
    const r = await ebay.reviseItem(itemId, { sku, title, price }, store);
    await audit(req, 'push_to_ebay', 'ebay_listing', itemId, { sku, title, price, store: r.storeCode });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[listings/push-to-ebay]', e.message);
    res.status(500).json({ error: 'revise_failed', message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/bulk-sku
// Set ONE canonical SKU across both channels for a batch of linked listings:
// pushes the SKU to eBay (custom label, via ReviseItem), to Shopify (variant SKU
// + barcode), and to the warehouse product (+ optional part_number for labels).
// Body: { items: [{ itemId, store, sku, partNumber?, oldSku? }], pushEbay, pushShopify }
// Returns per-item results so partial failures are visible.
// ──────────────────────────────────────────────────────────────────────────
router.post('/bulk-sku', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const pushEbay = req.body?.pushEbay !== false;
  const pushShopify = req.body?.pushShopify !== false;
  if (!items.length) return res.status(400).json({ error: 'no_items' });

  const results = [];
  for (const it of items) {
    const itemId = String(it.itemId || '');
    const sku = String(it.sku || '').trim();
    const partNumber = it.partNumber != null && String(it.partNumber).trim() ? String(it.partNumber).trim() : null;
    const r = { itemId, sku, ebay: null, shopify: null, warehouse: null, errors: [] };
    if (!sku) { r.errors.push('no_sku'); results.push(r); continue; }

    // Resolve the linked Shopify product for this eBay item.
    let shopifyProductId = null;
    try {
      const lk = await query(`SELECT shopify_product_id FROM mirror_links WHERE ebay_item_id = $1`, [itemId]);
      shopifyProductId = lk.rows[0]?.shopify_product_id ? String(lk.rows[0].shopify_product_id) : null;
    } catch (_) {}

    // eBay
    if (pushEbay && itemId && ebay.isConfigured(it.store)) {
      try { await ebay.reviseItem(itemId, { sku }, it.store); r.ebay = 'ok'; }
      catch (e) { r.ebay = 'error'; r.errors.push('eBay: ' + e.message); }
    } else if (pushEbay) { r.ebay = ebay.isConfigured() ? 'ok' : 'not_configured'; if (!itemId) r.ebay = 'no_item'; }

    // Shopify
    if (pushShopify && shopifyProductId && shopify.isConfigured()) {
      try { await shopify.setVariantSku(shopifyProductId, sku); r.shopify = 'ok'; }
      catch (e) { r.shopify = 'error'; r.errors.push('Shopify: ' + e.message); }
    } else if (pushShopify) { r.shopify = shopifyProductId ? 'not_configured' : 'no_link'; }

    // Warehouse product — by linked Shopify id, else by the previous SKU.
    try {
      let upd = null;
      if (shopifyProductId) {
        upd = await query(`UPDATE products SET sku = $1, part_number = COALESCE($2, part_number), updated_at = now() WHERE shopify_product_id = $3 RETURNING id`, [sku, partNumber, shopifyProductId]);
      }
      if ((!upd || !upd.rowCount) && it.oldSku) {
        upd = await query(`UPDATE products SET sku = $1, part_number = COALESCE($2, part_number), updated_at = now() WHERE sku = $3 RETURNING id`, [sku, partNumber, String(it.oldSku)]);
      }
      r.warehouse = (upd && upd.rowCount) ? 'ok' : 'no_match';
    } catch (e) { r.warehouse = 'error'; r.errors.push('Warehouse: ' + e.message); }

    // Keep the link + override in step so future drift detection is accurate.
    try { await query(`UPDATE mirror_links SET last_synced_sku = $1 WHERE ebay_item_id = $2`, [sku, itemId]); } catch (_) {}
    try { await query(`UPDATE ebay_listing_overrides SET override_sku = $1 WHERE ebay_item_id = $2`, [sku, itemId]); } catch (_) {}

    results.push(r);
  }

  await audit(req, 'bulk_sku_sync', null, null, { count: items.length });
  const okCount = results.filter(r => !r.errors.length).length;
  res.json({ ok: true, results, summary: { total: items.length, ok: okCount, errors: items.length - okCount } });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/push-warehouse-sku — warehouse is master. For each selected
// eBay item we resolve its linked Shopify product → its warehouse product, then
// force eBay + Shopify to that product's master SKU. Use this to make the live
// channels match the printed warehouse SKU (the opposite of typing a SKU per row).
// Body: { itemIds: [..] }
// ──────────────────────────────────────────────────────────────────────────
router.post('/push-warehouse-sku', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const itemIds = (Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(String).filter(Boolean);
  if (!itemIds.length) return res.status(400).json({ error: 'no_items' });

  const links = await query(
    `SELECT ebay_item_id, shopify_product_id, store_code FROM mirror_links WHERE ebay_item_id = ANY($1)`,
    [itemIds]
  );
  const linkByItem = new Map(links.rows.map(l => [String(l.ebay_item_id), l]));

  const results = [];
  for (const itemId of itemIds) {
    const r = { itemId, sku: null, ebay: null, shopify: null, errors: [] };
    const link = linkByItem.get(itemId);
    if (!link || !link.shopify_product_id) { r.errors.push('not_linked'); results.push(r); continue; }
    const spId = String(link.shopify_product_id);

    // Resolve the warehouse product + its master SKU.
    const prod = await query(`SELECT id, sku FROM products WHERE shopify_product_id = $1 LIMIT 1`, [spId]);
    const sku = prod.rows[0]?.sku ? String(prod.rows[0].sku).trim() : '';
    if (!sku) { r.errors.push('no_warehouse_product'); results.push(r); continue; }
    r.sku = sku;

    // eBay (custom label) — needs the store the listing belongs to.
    if (ebay.isConfigured(link.store_code)) {
      try { await ebay.reviseItem(itemId, { sku }, link.store_code); r.ebay = 'ok'; }
      catch (e) { r.ebay = 'error'; r.errors.push('eBay: ' + e.message); }
    } else { r.ebay = link.store_code ? 'store_not_configured' : 'not_configured'; }

    // Shopify variant SKU + barcode, and the "Part Number" metafield.
    if (shopify.isConfigured()) {
      try { await shopify.setVariantSku(spId, sku); r.shopify = 'ok'; }
      catch (e) { r.shopify = 'error'; r.errors.push('Shopify: ' + e.message); }
      try { await shopify.setPartNumberMetafield(spId, sku); } catch (_) { /* non-critical */ }
    } else { r.shopify = 'not_configured'; }

    try { await query(`UPDATE mirror_links SET last_synced_sku = $1 WHERE ebay_item_id = $2`, [sku, itemId]); } catch (_) {}
    results.push(r);
  }

  await audit(req, 'push_warehouse_sku', null, null, { count: itemIds.length });
  const okCount = results.filter(r => !r.errors.length).length;
  res.json({ ok: true, results, summary: { total: itemIds.length, ok: okCount, errors: itemIds.length - okCount } });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/listings/shopify-duplicates — scan the whole Shopify catalogue and
// group products that share a part number. Past pushes that failed to match an
// existing Shopify product (eBay SKU EB-<itemid> vs Shopify part number) created
// DUPLICATE products with different SKUs, so same-SKU dedup misses them. We group
// by the part number (variant barcode), falling back to the trailing title code,
// then the SKU — and report any code carried by more than one product. Read-only;
// nothing is deleted.
// ──────────────────────────────────────────────────────────────────────────
router.get('/shopify-duplicates', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const byCode = new Map(); // normalised code -> Map(productId -> {productId,title,sku,partNumber,price,qty,handle,image})
  let variants = 0;
  try {
    for await (const v of shopify.iterateAllProductsAndVariants()) {
      variants++;
      // Prefer the part number (barcode), then a trailing "- CODE" in the title,
      // then the SKU (ignoring the SHOPIFY-<id> placeholders).
      let code = normCode(v.part_number);
      if (!code) { const t = (v.title || '').match(/\s[-–]\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*$/); if (t) code = normCode(t[1]); }
      if (!code && v.sku && !/^SHOPIFY/i.test(v.sku)) code = normCode(v.sku);
      if (!code || code.length < 4) continue;
      if (!byCode.has(code)) byCode.set(code, new Map());
      const m = byCode.get(code);
      if (!m.has(v.shopify_product_id)) {
        m.set(v.shopify_product_id, {
          productId: v.shopify_product_id, title: v.title, sku: /^SHOPIFY/i.test(v.sku) ? null : v.sku,
          partNumber: v.part_number || null, price: v.price_shopify, qty: v.qty_on_hand,
          handle: v.shopify_handle, image: v.image_url,
        });
      }
    }
  } catch (e) { return res.status(502).json({ error: 'shopify_scan_failed', message: e.message }); }

  const groups = [];
  for (const [code, m] of byCode) {
    if (m.size > 1) groups.push({ code, count: m.size, products: [...m.values()] });
  }
  groups.sort((a, b) => b.count - a.count);
  await audit(req, 'shopify_duplicate_scan', null, null, { variants, dupGroups: groups.length });
  const domain = process.env.SHOPIFY_STORE_DOMAIN || '';
  res.json({
    summary: { variantsScanned: variants, duplicateGroups: groups.length, duplicateProducts: groups.reduce((n, g) => n + g.count, 0) },
    adminUrlBase: domain ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/products` : null,
    groups,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/update-identity — change a product's code (SKU = barcode =
// part number) in ONE place and push it everywhere: warehouse record + Shopify
// variant (SKU & barcode) + the linked eBay listing (custom label). This is the
// fix for "I edited the SKU in inventory but Shopify/eBay still show the old one"
// — the inventory modal only touches the warehouse row; this pushes to channels.
// Body: { shopifyProductId?, ebayItemId?, sku, partNumber?, barcode? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/update-identity', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku_required' });
  const partNumber = b.partNumber != null && String(b.partNumber).trim() ? String(b.partNumber).trim() : sku;
  let shopifyProductId = b.shopifyProductId ? String(b.shopifyProductId) : null;
  let ebayItemId = b.ebayItemId ? String(b.ebayItemId) : null;
  let warehouseProductId = b.warehouseProductId ? Number(b.warehouseProductId) : null;
  let storeCode = null;

  // If we were given a specific warehouse product, use its own Shopify link as the
  // target (unambiguous when several products share a bad SKU — pick the exact row).
  if (warehouseProductId && !shopifyProductId) {
    const pr = await query(`SELECT shopify_product_id FROM products WHERE id = $1`, [warehouseProductId]);
    if (pr.rows[0]?.shopify_product_id) shopifyProductId = String(pr.rows[0].shopify_product_id);
  }

  // Fill in the missing side from mirror_links.
  if (shopifyProductId && !ebayItemId) {
    const lk = await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id = $1 LIMIT 1`, [shopifyProductId]);
    if (lk.rows[0]) { ebayItemId = String(lk.rows[0].ebay_item_id); storeCode = lk.rows[0].store_code; }
  } else if (ebayItemId && !shopifyProductId) {
    const lk = await query(`SELECT shopify_product_id, store_code FROM mirror_links WHERE ebay_item_id = $1 LIMIT 1`, [ebayItemId]);
    if (lk.rows[0]) { shopifyProductId = lk.rows[0].shopify_product_id ? String(lk.rows[0].shopify_product_id) : null; storeCode = lk.rows[0].store_code; }
  } else if (ebayItemId) {
    const lk = await query(`SELECT store_code FROM mirror_links WHERE ebay_item_id = $1 LIMIT 1`, [ebayItemId]);
    if (lk.rows[0]) storeCode = lk.rows[0].store_code;
  }
  if (!shopifyProductId && !ebayItemId && !warehouseProductId) return res.status(400).json({ error: 'no_target' });

  const r = { sku, partNumber, warehouse: null, shopify: null, ebay: null, errors: [] };

  // 1. Warehouse product — by explicit id when given (exact row), else by Shopify link.
  try {
    let upd = { rowCount: 0 };
    if (warehouseProductId) {
      upd = await query(`UPDATE products SET sku = $1, barcode = $2, part_number = $3, updated_at = now() WHERE id = $4 RETURNING id`,
        [sku, sku, partNumber, warehouseProductId]);
    } else if (shopifyProductId) {
      upd = await query(`UPDATE products SET sku = $1, barcode = $2, part_number = $3, updated_at = now() WHERE shopify_product_id = $4 RETURNING id`,
        [sku, sku, partNumber, shopifyProductId]);
    }
    r.warehouse = upd.rowCount ? 'ok' : 'no_match';
  } catch (e) { r.warehouse = 'error'; r.errors.push('Warehouse: ' + e.message); }

  // 2. Shopify variant — SKU + barcode (setVariantSku sets both to the same value),
  //    plus the product's "Part Number" metafield (separate from SKU/barcode, so it
  //    stays blank otherwise).
  if (shopifyProductId) {
    if (shopify.isConfigured()) {
      try { await shopify.setVariantSku(shopifyProductId, sku); r.shopify = 'ok'; }
      catch (e) { r.shopify = 'error'; r.errors.push('Shopify: ' + e.message); }
      try {
        const mf = await shopify.setPartNumberMetafield(shopifyProductId, partNumber);
        r.shopifyPartNumber = mf.ok ? 'ok' : (mf.skipped || mf.error || 'n/a');
      } catch (e) { r.shopifyPartNumber = 'error'; r.errors.push('Shopify part-number metafield: ' + e.message); }
    } else { r.shopify = 'not_configured'; }
  } else { r.shopify = 'no_target'; }

  // 3. eBay custom label.
  if (ebayItemId) {
    if (ebay.isConfigured(storeCode)) {
      try { await ebay.reviseItem(ebayItemId, { sku }, storeCode); r.ebay = 'ok'; }
      catch (e) { r.ebay = 'error'; r.errors.push('eBay: ' + e.message); }
    } else { r.ebay = storeCode ? 'store_not_configured' : 'not_configured'; }
  } else { r.ebay = 'no_target'; }

  // Keep the link's last-synced SKU in step.
  try { if (ebayItemId) await query(`UPDATE mirror_links SET last_synced_sku = $1 WHERE ebay_item_id = $2`, [sku, ebayItemId]); } catch (_) {}

  await audit(req, 'update_listing_identity', null, null, { sku, partNumber, shopifyProductId, ebayItemId, warehouseProductId });
  res.json({ ok: !r.errors.length, result: r });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/delete-listing — remove a duplicate listing from a channel.
// Destructive + outward-facing: ENDS a live eBay listing (EndFixedPriceItem) or
// DELETES a Shopify product. The warehouse product is kept; we just drop the
// link(s). Body: { channel: 'ebay'|'shopify', id, storeCode? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/delete-listing', requireAdmin, async (req, res) => {
  await ensureMirrorLinksColumns();
  const channel = String(req.body?.channel || '');
  const id = String(req.body?.id || '').trim();
  if (!id || !['ebay', 'shopify'].includes(channel)) return res.status(400).json({ error: 'bad_request' });

  if (channel === 'ebay') {
    if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
    let storeCode = req.body?.storeCode || null;
    if (!storeCode) {
      const lk = await query(`SELECT store_code FROM mirror_links WHERE ebay_item_id = $1 LIMIT 1`, [id]);
      storeCode = lk.rows[0]?.store_code || null;
    }
    try {
      const r = await ebay.endItem(id, {}, storeCode);
      await query(`DELETE FROM mirror_links WHERE ebay_item_id = $1`, [id]);
      await audit(req, 'delete_ebay_listing', null, null, { itemId: id, storeCode });
      return res.json({ ok: true, channel, id, alreadyGone: !!r.alreadyEnded });
    } catch (e) { return res.status(502).json({ error: 'ebay_end_failed', message: e.message }); }
  }

  // Shopify
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  try {
    const r = await shopify.deleteProduct(id);
    await query(`DELETE FROM mirror_links WHERE shopify_product_id = $1`, [id]);
    await query(`UPDATE products SET shopify_product_id = NULL, updated_at = now() WHERE shopify_product_id = $1`, [id]);
    await audit(req, 'delete_shopify_product', null, null, { productId: id });
    return res.json({ ok: true, channel, id, alreadyGone: !!r.alreadyDeleted });
  } catch (e) { return res.status(502).json({ error: 'shopify_delete_failed', message: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// PHASE 2 — bulk title / description / item specifics across linked listings.
// ──────────────────────────────────────────────────────────────────────────

// Branded eBay-description wrapper (the "Ad-Lister look"). The user-chosen mode
// is "wrap existing description in a header/footer". Header/footer HTML live in
// app_settings.data (ebay_desc_header / ebay_desc_footer) with sensible brand
// defaults. Tokens: {{brand}} {{tagline}} {{domain}} {{title}} {{sku}} {{partno}}.
const DESC_BODY_START = '<!--RZN_DESC_BODY-->';
const DESC_BODY_END = '<!--/RZN_DESC_BODY-->';

function defaultDescTemplate() {
  const brand = require('../lib/brand');
  const color = brand.primaryColor || '#c8202d';       // brand bar / structure
  const accent = brand.accentColor || brand.primaryColor || '#c8202d';  // red CTA/headings
  // Clean, icon-led, storefront-style layout (inline CSS only — eBay strips
  // <style>, scripts, external CSS). Tokens: {{brand}} {{tagline}} {{domain}}
  // {{title}} {{sku}} {{partno}} {{vehicle}} {{storeurl}} {{related}}. The body
  // (spec table) sits between the RZN_DESC_BODY sentinels; {{related}} is the
  // "You might be interested in" product cards. Icons are emoji so they render
  // everywhere (incl. the eBay mobile app) with no external images.
  const badge = (icon, top, bot) =>
    `<td style="width:25%;text-align:center;vertical-align:top;padding:6px 8px">` +
      `<div style="font-size:26px;line-height:1">${icon}</div>` +
      `<div style="font-size:11px;color:#555;margin-top:5px">${top}</div>` +
      `<div style="font-size:11px;font-weight:700;color:#222;margin-top:1px">${bot}</div>` +
    `</td>`;
  const header =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:0 auto;color:#1a1a1a;border:1px solid #e7e7e7;border-radius:10px;overflow:hidden">` +
      // brand bar
      `<div style="background:${color};color:#fff;padding:18px 22px">` +
        `<div style="font-size:24px;font-weight:800;letter-spacing:.4px;line-height:1.1">{{brand}}</div>` +
        `<div style="font-size:13px;opacity:.95;margin-top:3px">{{tagline}}</div>` +
      `</div>` +
      // trust badges (icons, not text walls)
      `<table role="presentation" width="100%" style="border-collapse:collapse;background:#fafafa;border-bottom:1px solid #eee"><tr>` +
        badge('&#128230;', 'All parts', 'NEW &amp; PRIMED') +
        badge('&#128683;', "We don't", 'PAINT PANELS') +
        badge('&#128737;&#65039;', 'Quality', 'INSURANCE-GRADE') +
        badge('&#128666;', 'Next-day', 'TRACKED DELIVERY') +
      `</tr></table>` +
      // title + part number, then the body container
      `<div style="padding:20px 22px">` +
        `<div style="font-size:19px;font-weight:700;margin-bottom:4px;line-height:1.3">{{title}}</div>` +
        `<div style="font-size:13px;color:#777;margin-bottom:16px">Part No: <strong style="color:${accent}">{{partno}}</strong></div>`;
  const footer =
      // key notices (concise, boxed, accent bar)
      `<div style="margin:4px 0 2px;border:1px solid #f0d9dc;background:#fdf6f7;border-left:4px solid ${accent};border-radius:6px;padding:12px 14px;font-size:13px;line-height:1.55;color:#333">` +
        `<div style="margin-bottom:8px">&#9888;&#65039; <strong>Please don't rely on eBay's compatibility guide</strong> — it's a guide only. Message us your registration and we'll confirm this part fits your exact vehicle.</div>` +
        `<div style="margin:0">&#128312; All panels are supplied <strong>primed and require painting</strong> unless otherwise stated. <strong>We do not paint panels.</strong></div>` +
      `</div>` +
      `</div>` +   // close body container
      // "You might be interested in" — real product cards (or a fallback CTA)
      `{{related}}` +
      // info strip: payment / delivery / returns (compact, icon-led)
      `<table role="presentation" width="100%" style="border-collapse:collapse;border-top:1px solid #e7e7e7;font-size:12.5px;color:#333"><tr>` +
        `<td style="width:33%;vertical-align:top;padding:14px 16px;border-right:1px solid #eee"><div style="font-weight:700;margin-bottom:3px">&#128179; Secure payment</div>Visa, Mastercard, PayPal, Apple &amp; Google Pay</div></td>` +
        `<td style="width:34%;vertical-align:top;padding:14px 16px;border-right:1px solid #eee"><div style="font-weight:700;margin-bottom:3px">&#128666; Fast delivery</div>Same-day dispatch when paid before 12pm (Mon&ndash;Fri). Leave a mobile number with your order.</div></td>` +
        `<td style="width:33%;vertical-align:top;padding:14px 16px"><div style="font-weight:700;margin-bottom:3px">&#8617;&#65039; 30-day returns</div>Faulty items replaced or refunded. Check the part number &amp; photos first.</div></td>` +
      `</tr></table>` +
      // dark footer
      `<div style="background:#141414;color:#ddd;padding:14px 22px;font-size:12px;line-height:1.6">` +
        `<div style="color:#fff;font-weight:700">Why buy from {{brand}}</div>` +
        `<div style="margin:4px 0 8px">Trade-quality body panels &middot; fast dispatch &middot; expert fitment help &mdash; just message us your reg.</div>` +
        `<div style="color:#999">{{brand}} &middot; {{domain}}</div>` +
      `</div>` +
    `</div>`;
  return { header, footer };
}

async function getDescTemplate() {
  const def = defaultDescTemplate();
  try {
    const r = await query(`SELECT data FROM app_settings WHERE id = 1`);
    const d = r.rows[0]?.data || {};
    return {
      header: d.ebay_desc_header != null ? d.ebay_desc_header : def.header,
      footer: d.ebay_desc_footer != null ? d.ebay_desc_footer : def.footer,
    };
  } catch (_) { return def; }
}

// Strip a previously-applied wrapper so re-applying never double-wraps.
function unwrapDesc(desc) {
  const s = String(desc || '');
  const i = s.indexOf(DESC_BODY_START), j = s.indexOf(DESC_BODY_END);
  if (i >= 0 && j > i) return s.slice(i + DESC_BODY_START.length, j);
  return s;
}
function wrapDesc(body, tpl, ctx) {
  const brand = require('../lib/brand');
  const domain = (brand.domain || '').replace(/^https?:\/\//, '');
  const accent = brand.accentColor || brand.primaryColor || '#c8202d';
  const vehicle = ctx.vehicle || '';
  const base = domain ? `https://${domain}` : '';
  const storeurl = ctx.storeurl || (base ? (vehicle ? `${base}/search?q=${encodeURIComponent(vehicle)}` : base) : '#');
  // {{related}} = the "You might be interested in" cards when we have them, else a
  // simple CTA button linking to more parts for this vehicle.
  const related = ctx.related || (base
    ? `<div style="background:#f5f7fb;border-top:1px solid #e7e7e7;padding:16px 22px;text-align:center">` +
        `<div style="font-size:15px;font-weight:700;margin-bottom:10px">Need more parts for your ${escapeHtmlServer(vehicle || 'vehicle')}?</div>` +
        `<a href="${storeurl}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:6px">Shop more parts &rarr;</a>` +
      `</div>`
    : '');
  const fill = (s) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const map = { brand: brand.name || 'Our Store', tagline: brand.tagline || '',
      domain, title: ctx.title || '', sku: ctx.sku || '', partno: ctx.partno || '',
      vehicle: vehicle || 'vehicle', storeurl, related };
    return map[k] != null ? map[k] : '';
  });
  return fill(tpl.header) + DESC_BODY_START + (body || '') + DESC_BODY_END + fill(tpl.footer);
}

// A styled spec table + intro used as the description BODY when the listing has
// no rich Shopify description of its own — so a new listing never renders as a
// bare wall of text. eBay-safe (inline CSS, table, no scripts).
function buildStyledDescBody(product, specifics) {
  const color = (require('../lib/brand').primaryColor) || '#c8202d';
  const specMap = {};
  for (const s of (specifics || [])) {
    if (!s || !s.name) continue;
    specMap[String(s.name).toLowerCase()] = Array.isArray(s.values) ? s.values.join(', ') : (s.value != null ? String(s.value) : '');
  }
  const rows = [];
  const add = (label, val) => { if (val && String(val).trim()) rows.push([label, String(val).trim()]); };
  add('Part number', product.part_number || specMap['manufacturer part number']);
  add('Interchange / alt part numbers', specMap['interchange part number']);
  add('Brand', specMap['brand']);
  add('Fits make', specMap['make'] || product.brand);
  add('Model', specMap['model'] || product.model);
  add('Year', specMap['year']);
  add('Placement on vehicle', specMap['placement on vehicle'] || product.position);
  add('Colour / finish', specMap['colour'] || specMap['surface finish']);
  add('Material', specMap['material']);
  add('Reference OE/OEM', specMap['reference oe/oem number']);
  const table = rows.map(([k, v], i) =>
    `<tr style="background:${i % 2 ? '#fafafa' : '#fff'}">` +
      `<td style="padding:9px 12px;border-bottom:1px solid #eee;color:#666;white-space:nowrap;width:42%">${escapeHtmlServer(k)}</td>` +
      `<td style="padding:9px 12px;border-bottom:1px solid #eee;font-weight:600;color:#111">${escapeHtmlServer(v)}</td>` +
    `</tr>`).join('');
  return `<div style="font-size:14px;color:#333;line-height:1.6;margin-bottom:14px">Brand-new, ready-to-fit replacement part &mdash; supplied primed. <strong>Match the part number and photos to your original before buying</strong>, or send us your reg and we'll confirm the fit.</div>` +
    (table ? `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px">${table}</table>` : '');
}

// "You might be interested in" — up to 4 OTHER live eBay listings for the SAME
// make/model, as photo + title + price cards linking to those eBay items (staying
// on eBay is policy-safe). Returns '' when there are no matching linked listings,
// in which case wrapDesc falls back to the storefront CTA.
async function buildRelatedItemsHtml(product, storeCode) {
  const brand = require('../lib/brand');
  const accent = brand.accentColor || brand.primaryColor || '#c8202d';
  const make = product.brand, model = product.model;
  if (!make && !model) return '';
  let rows = [];
  try {
    const r = await query(
      `SELECT p.title, p.price_ebay, p.image_url, ml.ebay_item_id
         FROM products p
         JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id::text
        WHERE p.active = true AND p.id <> $1 AND p.image_url IS NOT NULL
          AND ml.ebay_item_id IS NOT NULL
          AND ($4 = '' OR ml.store_code = $4 OR ml.store_code IS NULL)
          AND ( ($2 <> '' AND p.brand = $2) )
          AND ( ($3 = '') OR p.model = $3 )
        ORDER BY (p.model = $3) DESC, p.updated_at DESC
        LIMIT 4`,
      [product.id, make || '', model || '', storeCode || '']);
    rows = r.rows;
  } catch (_) { return ''; }
  if (!rows.length) return '';
  const cards = rows.map(it => {
    const url = `https://www.ebay.co.uk/itm/${escapeHtmlServer(String(it.ebay_item_id))}`;
    const price = it.price_ebay != null ? `£${parseFloat(it.price_ebay).toFixed(2)}` : '';
    return `<td style="width:25%;vertical-align:top;padding:8px">` +
      `<a href="${url}" style="text-decoration:none;color:#111;display:block;border:1px solid #eee;border-radius:8px;overflow:hidden">` +
        `<img src="${escapeHtmlServer(it.image_url)}" alt="" style="width:100%;height:120px;object-fit:cover;display:block;background:#f4f4f4">` +
        `<div style="padding:8px 10px">` +
          `<div style="font-size:12px;line-height:1.35;height:50px;overflow:hidden">${escapeHtmlServer(String(it.title || '').slice(0, 70))}</div>` +
          (price ? `<div style="font-size:14px;font-weight:800;color:${accent};margin-top:4px">${price}</div>` : '') +
        `</div>` +
      `</a></td>`;
  }).join('');
  return `<div style="background:#f5f7fb;border-top:1px solid #e7e7e7;padding:16px 18px">` +
    `<div style="font-size:15px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;margin:0 4px 8px">You might be interested in</div>` +
    `<table role="presentation" width="100%" style="border-collapse:collapse"><tr>${cards}</tr></table>` +
  `</div>`;
}

// One place that builds the FULL wrapped eBay description for a product, used by
// create AND the "push design to existing listings" bulk action so they match.
async function composeEbayDescription(product, { specifics, storeCode, rawBody } = {}) {
  const body = (rawBody && String(rawBody).trim()) ? unwrapDesc(rawBody) : buildStyledDescBody(product, specifics || []);
  const vehicle = [product.brand || parseVehicleFromTitle(product.title || '').make,
                   product.model || parseVehicleFromTitle(product.title || '').model].filter(Boolean).join(' ').trim();
  let related = '';
  try { related = await buildRelatedItemsHtml(product, storeCode); } catch (_) {}
  const tpl = await getDescTemplate();
  return wrapDesc(body, tpl, {
    title: product.title, sku: product.sku, partno: product.part_number || product.sku, vehicle, related,
  });
}

const skuKeyify = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

async function shopifyIdForItem(itemId) {
  try {
    const lk = await query(`SELECT shopify_product_id FROM mirror_links WHERE ebay_item_id = $1`, [String(itemId)]);
    return lk.rows[0]?.shopify_product_id ? String(lk.rows[0].shopify_product_id) : null;
  } catch (_) { return null; }
}

// GET current eBay listing details (title, description, specifics, pictures).
router.get('/item-details', requireAdmin, async (req, res) => {
  const { itemId, store } = req.query;
  if (!itemId) return res.status(400).json({ error: 'missing_item_id' });
  try {
    res.json(await ebay.getItemDetails(itemId, store));
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// Pull each listing's eBay item specifics and write them to the linked Shopify
// product as custom.<name> metafields. Read-eBay / write-Shopify only (low risk).
router.post('/pull-specifics-to-shopify', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const results = [];
  for (const it of items) {
    const r = { itemId: String(it.itemId || ''), specifics: 0, ok: false, error: null };
    try {
      const shopifyProductId = await shopifyIdForItem(it.itemId);
      if (!shopifyProductId) { r.error = 'not linked to Shopify'; results.push(r); continue; }
      const details = await ebay.getItemDetails(it.itemId, it.store);
      const metafields = (details.specifics || [])
        .filter(s => s.name && s.values.length)
        .map(s => ({ namespace: 'custom', key: skuKeyify(s.name), value: s.values.join(', '), type: 'single_line_text_field' }))
        .filter(m => m.key);
      r.specifics = metafields.length;
      if (metafields.length) await shopify.applyMetafields(shopifyProductId, metafields);
      r.ok = true;
    } catch (e) { r.error = e.message; }
    results.push(r);
  }
  await audit(req, 'pull_specifics_to_shopify', null, null, { count: items.length });
  res.json({ ok: true, results, summary: { total: items.length, ok: results.filter(r => r.ok).length } });
});

// Apply the branded header/footer template to each listing's eBay description
// (wrapping the listing's CURRENT description; idempotent via body sentinels).
router.post('/apply-ebay-template', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const tpl = await getDescTemplate();
  const results = [];
  for (const it of items) {
    const r = { itemId: String(it.itemId || ''), ok: false, error: null };
    try {
      const details = await ebay.getItemDetails(it.itemId, it.store);
      const body = unwrapDesc(details.description);
      const wrapped = wrapDesc(body, tpl, { title: details.title, sku: details.sku, partno: it.partNumber || '' });
      await ebay.reviseItem(it.itemId, { description: wrapped }, it.store);
      r.ok = true;
    } catch (e) { r.error = e.message; }
    results.push(r);
  }
  await audit(req, 'apply_ebay_template', null, null, { count: items.length });
  res.json({ ok: true, results, summary: { total: items.length, ok: results.filter(r => r.ok).length } });
});

// Bulk title edit. Frontend computes each new title (find/replace or prefix);
// we push to eBay (ReviseItem) and, if linked, Shopify (product title).
router.post('/bulk-title', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const pushShopify = req.body?.pushShopify !== false;
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const results = [];
  for (const it of items) {
    const title = String(it.title || '').trim().slice(0, 80); // eBay caps titles at 80
    const r = { itemId: String(it.itemId || ''), title, ebay: null, shopify: null, error: null };
    if (!title) { r.error = 'empty_title'; results.push(r); continue; }
    try { await ebay.reviseItem(it.itemId, { title }, it.store); r.ebay = 'ok'; }
    catch (e) { r.ebay = 'error'; r.error = 'eBay: ' + e.message; }
    if (pushShopify) {
      const shopifyProductId = await shopifyIdForItem(it.itemId);
      if (shopifyProductId) {
        try { await shopify.updateProduct(shopifyProductId, { title }); r.shopify = 'ok'; }
        catch (e) { r.shopify = 'error'; r.error = (r.error ? r.error + '; ' : '') + 'Shopify: ' + e.message; }
      } else r.shopify = 'no_link';
    }
    results.push(r);
  }
  await audit(req, 'bulk_title', null, null, { count: items.length });
  res.json({ ok: true, results, summary: { total: items.length, ok: results.filter(r => !r.error).length } });
});

// Bulk price update from the Mirror. Set/adjust the eBay (anchor) price, derive
// the Shopify "website" price as a fixed % cheaper, and push to both channels +
// warehouse. Respects per-product price_locked (those keep their manual Shopify
// price; eBay is still the anchor so it's updated unless skipEbayWhenLocked).
// Body: { items:[{ itemId, store, currentEbay }], mode:'set'|'adjust_amount'|'adjust_pct',
//         value, websitePct, pushEbay, pushShopify }
router.post('/bulk-price', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const mode = ['set', 'adjust_amount', 'adjust_pct'].includes(req.body?.mode) ? req.body.mode : 'set';
  const value = parseFloat(req.body?.value);
  const websitePct = req.body?.websitePct != null ? parseFloat(req.body.websitePct) : 0;
  const pushEbay = req.body?.pushEbay !== false;
  const pushShopify = req.body?.pushShopify !== false;
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  if (isNaN(value)) return res.status(400).json({ error: 'invalid_value' });
  if (isNaN(websitePct) || websitePct < 0 || websitePct >= 100) return res.status(400).json({ error: 'invalid_website_pct' });

  const results = [];
  for (const it of items) {
    const r = { itemId: String(it.itemId || ''), newEbay: null, newShopify: null, ebay: null, shopify: null, warehouse: null, locked: false, error: null };
    const cur = parseFloat(it.currentEbay);
    let newEbay;
    if (mode === 'set') newEbay = value;
    else if (mode === 'adjust_amount') newEbay = (isNaN(cur) ? 0 : cur) + value;
    else newEbay = (isNaN(cur) ? 0 : cur) * (1 + value / 100);
    newEbay = Math.round(newEbay * 100) / 100;
    if (!(newEbay > 0)) { r.error = 'price_must_be_positive'; results.push(r); continue; }
    const newShopify = Math.round(newEbay * (1 - websitePct / 100) * 100) / 100;
    r.newEbay = newEbay; r.newShopify = newShopify;

    // Resolve linked Shopify product + lock state.
    let shopifyProductId = await shopifyIdForItem(it.itemId);
    let locked = false, productId = null;
    if (shopifyProductId) {
      try { const pr = await query(`SELECT id, price_locked FROM products WHERE shopify_product_id = $1`, [shopifyProductId]); productId = pr.rows[0]?.id || null; locked = !!pr.rows[0]?.price_locked; } catch (_) {}
    }
    r.locked = locked;

    // eBay (the anchor) — always updated when requested.
    if (pushEbay) {
      try { await ebay.reviseItem(it.itemId, { price: newEbay }, it.store); r.ebay = 'ok'; }
      catch (e) { r.ebay = 'error'; r.error = 'eBay: ' + e.message; }
    }
    // Shopify (derived) — skipped for locked products.
    if (pushShopify && !locked && shopifyProductId && shopify.isConfigured()) {
      try { await shopify.setVariantPrice(shopifyProductId, newShopify); r.shopify = 'ok'; }
      catch (e) { r.shopify = 'error'; r.error = (r.error ? r.error + '; ' : '') + 'Shopify: ' + e.message; }
    } else if (pushShopify) { r.shopify = locked ? 'locked' : (shopifyProductId ? 'skip' : 'no_link'); }

    // Warehouse: always store the new eBay anchor; store derived Shopify unless locked.
    try {
      if (productId) {
        if (locked) await query(`UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`, [newEbay, productId]);
        else await query(`UPDATE products SET price_ebay = $1, price_shopify = $2, updated_at = now() WHERE id = $3`, [newEbay, newShopify, productId]);
        r.warehouse = 'ok';
      } else r.warehouse = 'no_match';
    } catch (e) { r.warehouse = 'error'; }
    results.push(r);
  }
  await audit(req, 'bulk_price', null, null, { count: items.length, mode, value, websitePct });
  res.json({ ok: true, results, summary: { total: items.length, ok: results.filter(r => !r.error).length } });
});

// Read the effective eBay description template (+ defaults, for "reset").
router.get('/ebay-template', requireAdmin, async (req, res) => {
  res.json({ ...(await getDescTemplate()), defaults: defaultDescTemplate() });
});
// Save the eBay description header/footer into app_settings.data.
router.post('/ebay-template', requireAdmin, async (req, res) => {
  const { header, footer } = req.body || {};
  const cur = await query(`SELECT data FROM app_settings WHERE id = 1`);
  const data = { ...(cur.rows[0]?.data || {}) };
  if (header !== undefined) data.ebay_desc_header = header;
  if (footer !== undefined) data.ebay_desc_footer = footer;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify(data)]);
  await audit(req, 'save_ebay_template');
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/listings/test-ebay-connection
// Pings eBay per-store with a tiny GetMyeBaySelling call and reports back the
// exact result for each store. Used to diagnose silent eBay failures (expired
// tokens, missing scopes, network issues) that hydrate / force-match would
// otherwise swallow with just a console.warn.
//
// Returns: { results: [ { store, ok, sampleCount?, error?, likelyCause? } ] }
// ──────────────────────────────────────────────────────────────────────────
router.get('/test-ebay-connection', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  const stores = ebay.listStores();
  const results = [];
  // Try fetching the App-level quota usage via the Developer Analytics API.
  // This is an OAuth client_credentials call — it doesn't need a per-store
  // user token and is on a separate quota plane from the Trading API, so it's
  // safe to call even when the Trading API daily cap is exceeded.
  //
  // (Replaces the deprecated GetAPIAccessRules Trading-API call that eBay
  // decommissioned on 2023-03-10.)
  let quota = null;
  let quotaError = null;
  try {
    const rules = await ebay.getRateLimits('tradingapi');
    // Filter to the call-names that this app actually uses. Empty `name` is
    // the aggregate row eBay returns for the whole context.
    const interesting = ['', 'GetMyeBaySelling', 'GetItem', 'GetOrders', 'ReviseItem', 'AddItem', 'CompleteSale', 'AddMemberMessageAAQToPartner', 'ReviseInventoryStatus', 'GetSellerList'];
    quota = rules
      .filter(r => interesting.includes(r.callName) || rules.length <= 12)  // if eBay returns few, show all
      .map(r => ({
        ...r,
        // legacy aliases for the existing renderer
        hourlyHardLimit: 0,
        hourlyUsage: 0,
        dailyRemaining: r.dailyRemaining,
        hourlyRemaining: null,
      }));
  } catch (e) {
    quotaError = e.message;
    console.warn('[test-ebay-connection] getRateLimits failed:', e.message);
  }
  for (const s of stores) {
    const result = { store: s.code, name: s.name, hasToken: !!s.hasToken, disabled: !!s.disabled };
    if (s.disabled) {
      result.ok = false;
      result.reason = 'disabled';
      result.error = `Store disabled via EBAY_STORE_DISABLED env var: ${s.disabledReason || '(reason unknown)'}`;
      results.push(result);
      continue;
    }
    if (!s.hasToken) {
      result.ok = false;
      result.reason = 'no_token';
      const envName = s.code === 'razoryn' ? 'EBAY_AUTH_TOKEN' : 'EBAY_AUTH_TOKEN_' + s.code.toUpperCase();
      result.error = `No auth token configured. Set ${envName} in Railway.`;
      results.push(result);
      continue;
    }
    // Try a minimal call — just fetch active listings. Surfaces auth/scope errors.
    try {
      const listings = await ebay.getActiveListings(s.code);
      result.ok = true;
      result.sampleCount = listings.length;
      result.firstItem = listings[0]
        ? { itemId: listings[0].itemId, title: (listings[0].title || '').slice(0, 60), sku: listings[0].sku }
        : null;
    } catch (e) {
      result.ok = false;
      result.reason = 'api_error';
      result.error = e.message;
      // Surface human-readable likely-causes from the raw eBay error.
      // Order matters: rate-limit detection must run BEFORE "expired" matching
      // because eBay's rate-limit message contains the word "exceeded" which
      // could otherwise be misread as a generic error.
      const msg = (e.message || '').toLowerCase();
      if (msg.includes('usage limit') || msg.includes('exceeded usage') || msg.includes('call limit') || msg.includes('getapiaccessrules') || msg.includes('21917')) {
        // eBay's daily Trading API quota — per-App (EBAY_CLIENT_ID), not per-store.
        // Default for new apps is 5,000 calls/day per call-name; resets midnight Pacific Time.
        result.reason = 'rate_limit';
        result.likelyCause = `eBay app has hit its daily API call quota for this call type. The quota is PER-APP (shared by all your stores using the same EBAY_CLIENT_ID), and resets at midnight Pacific Time (≈ 8am UK winter / 7am UK BST). To increase the limit permanently, apply for the Compatible Application Check at developer.ebay.com → My Account → Compatible Application.`;
      } else if (msg.includes('auth') || msg.includes('token') || msg.includes('expired') || msg.includes('invalid') || msg.includes('iaf') || msg.includes('17470') || msg.includes('931') || msg.includes('932')) {
        result.likelyCause = 'Token expired or invalid. Generate a fresh user token at https://developer.ebay.com/my/auth/?env=production and update the Railway env var.';
      } else if (msg.includes('scope') || msg.includes('21916')) {
        result.likelyCause = 'Token lacks the right scope. Regenerate with at least the Trading API access.';
      } else if (msg.includes('network') || msg.includes('timeout') || msg.includes('socket') || msg.includes('econnreset')) {
        result.likelyCause = 'Network / timeout — probably transient. Retry in a minute.';
      } else if (msg.includes('iaf-token-expired') || msg.includes('iaf-token-invalid')) {
        result.likelyCause = 'IAF (OAuth) token expired. The OAuth refresh-token flow may have lapsed.';
      }
    }
    results.push(result);
  }
  res.json({ results, quota, quotaError });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/create-ebay
// Create a NEW eBay listing for a product that's on Shopify but not yet on
// eBay. Uses the Trading API AddItem call so it works with per-store
// Auth'n'Auth tokens (Calibre's two stores) or the OAuth fallback (Razoryn).
//
// Required body fields:
//   productId    — warehouse products.id (the source-of-truth row)
//   storeCode    — eBay store code (e.g. 'evbodyparts', 'evantagrande', or the
//                  single-store brand's primary store code)
//   categoryId   — eBay numeric category ID
//   conditionId  — 1000 = New, 1500 = New other, 3000 = Used, etc.
//   price        — listing price in GBP
//   quantity     — stock to list
//
// Optional:
//   titleOverride — override the auto-generated title (max 80 chars)
//   businessPolicies — { paymentId, shippingId, returnId } if not relying on
//                       per-store defaults from app_settings
//   useShopifyDescription — fetch the rich HTML description from Shopify
//                            (default true; turn off for faster listing creation)
//   itemSpecifics — array of extra { name, value } pairs
//
// On success, inserts a row into mirror_links so the product is treated as
// "linked" by the rest of the warehouse system.
// ──────────────────────────────────────────────────────────────────────────
// HTTP-aware error helper so doCreateEbay (used by the route, "Push live now" and
// the scheduled go-live cron) can signal a specific status + JSON body that the
// route wrapper maps to res.status(...).json(...). Programmatic callers just see a
// thrown Error.
function httpErr(status, body) {
  const e = new Error(body && (body.message || body.error) || 'error');
  e.httpStatus = status; e.body = body;
  return e;
}

// Core eBay listing creation, extracted from the route so it can be replayed for
// pre-listings (warehouse-held items published at their go-live time). Resolves
// settings/policies/Shopify content fresh on every call, so a listing scheduled
// today and published next week still uses current config. `b` is the same body
// the POST /create-ebay route accepts. Returns the route's JSON payload, or throws
// (httpErr for validation, plain Error for eBay failures).
// Normalise a specific's value(s) to a plain array of non-empty strings.
function specValues(s) {
  if (!s) return [];
  const raw = Array.isArray(s.values) ? s.values : (Array.isArray(s.value) ? s.value : [s.value]);
  return raw.map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
}

// Merge several [{name, value|values}] lists into ONE full set, keyed by
// case-insensitive name. LATER lists win on a name collision. Empty values drop
// the entry. This is the primitive that lets a Revise send the COMPLETE specifics
// set (live + derived + edits) so eBay's full-replace never wipes a field.
function mergeSpecificsByName(...lists) {
  const byName = new Map();   // lowerName -> { name, values }
  for (const list of lists) {
    for (const s of (list || [])) {
      if (!s || !s.name) continue;
      const vals = specValues(s);
      const key = String(s.name).toLowerCase();
      if (vals.length) byName.set(key, { name: String(s.name), values: vals });
      // an explicit empty value from a LATER list clears the field
      else if (Array.isArray(s.values) || 'value' in s) byName.delete(key);
    }
  }
  return [...byName.values()].map(e => e.values.length > 1
    ? { name: e.name, values: e.values }
    : { name: e.name, value: e.values[0] });
}

// The specifics we can always rebuild from persisted warehouse data — so an edit
// (or any re-push) never loses them even if the form/live read omitted them.
// Used by BOTH create and revise so the two paths agree.
async function deriveEbaySpecifics(product, { countryOfOrigin, includeProductNumber = true } = {}) {
  const derived = [];
  const vehicle = parseVehicleFromTitle(product.title || '');
  const vMake = product.brand || vehicle.make;
  const vModel = product.model || vehicle.model;
  const vYear = vehicle.year;
  if (product.part_number) derived.push({ name: 'Manufacturer Part Number', value: product.part_number });
  if (product.position) derived.push({ name: 'Placement on Vehicle', value: product.position });
  if (vMake) derived.push({ name: 'Make', value: vMake });
  if (vModel) derived.push({ name: 'Model', value: vModel });
  if (vYear) derived.push({ name: 'Year', value: vYear });
  if (countryOfOrigin) derived.push({ name: 'Country of Origin', value: countryOfOrigin });
  if (includeProductNumber && product.shopify_product_id) derived.push({ name: 'Product Number', value: String(product.shopify_product_id) });
  // Sub / alternate part numbers → "Interchange Part Number" (comma-joined).
  try {
    const spn = await query(`SELECT code FROM product_part_numbers WHERE product_id = $1 ORDER BY id`, [product.id]);
    const codes = spn.rows.map(r => r.code).filter(Boolean);
    if (codes.length) derived.push({ name: 'Interchange Part Number', value: codes.join(', ') });
  } catch (_) { /* non-fatal */ }
  return derived;
}

async function doCreateEbay(b, { req } = {}) {
  const ebay = require('../services/ebay');
  const shopify = require('../services/shopify');
  const brand = require('../lib/brand');
  await ensureListingColumns();

  if (!b.productId)  throw httpErr(400, { error: 'productId required' });
  if (!b.storeCode)  throw httpErr(400, { error: 'storeCode required' });
  // categoryId is resolved after settings load (falls back to the Settings default).
  if (b.price == null || isNaN(parseFloat(b.price))) throw httpErr(400, { error: 'valid price required' });

  // Look up the product. We need at minimum: sku, title, image_url, brand, mpn.
  const pr = await query(`SELECT * FROM products WHERE id = $1`, [b.productId]);
  const product = pr.rows[0];
  if (!product) throw httpErr(404, { error: 'product_not_found' });

  // Resolve the store. For multi-store brands the user must pass storeCode.
  const store = brand.getStore(b.storeCode);
  if (!store) throw httpErr(400, { error: 'unknown_store', message: `No eBay store configured with code "${b.storeCode}". Available: ${brand.stores.map(s => s.code).join(', ')}` });

  // Pull eBay listing defaults from app_settings (per-store policies + location).
  // The settings UI lets the user save these once so they don't have to type them
  // for every new listing.
  const settings = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};

  // Per-store business policies, namespaced by store code in the DB column names.
  // Falls back to the brand-wide default keys (no store suffix) for single-store brands.
  // Precedence: a per-listing override (chosen at generation time) wins, then
  // the per-store saved policy, then the brand-wide default.
  const polPrefix = `ebay_policy_${store.code}_`;
  const pol = {
    paymentId:  b.businessPolicies?.paymentId  || settings[`${polPrefix}payment`]  || settings['ebay_policy_payment']  || null,
    shippingId: b.businessPolicies?.shippingId || settings[`${polPrefix}shipping`] || settings['ebay_policy_shipping'] || null,
    returnId:   b.businessPolicies?.returnId   || settings[`${polPrefix}return`]   || settings['ebay_policy_return']   || null,
  };

  const loc = {
    country:    settings.ebay_location_country    || 'GB',
    postalCode: settings.ebay_location_postcode   || '',
    city:       settings.ebay_location_city       || '',
  };

  // Try to enrich with Shopify-side content (description + extra images).
  // Best-effort; if Shopify fetch fails we fall back to the warehouse data.
  let description = '';
  // Explicit image URLs (passed by the unified create flow) are the most reliable
  // — they're the exact Shopify CDN URLs captured at create time.
  let imageUrls = (Array.isArray(b.imageUrls) && b.imageUrls.length)
    ? b.imageUrls.filter(Boolean)
    : (product.image_url ? [product.image_url] : []);
  // A description typed/edited in the listing form takes priority over everything.
  if (b.descriptionOverride && String(b.descriptionOverride).trim()) {
    description = String(b.descriptionOverride);
  }
  // Pull Shopify images (and the description if we still need one) — independent
  // of whether a description override was given, so photos always come through.
  if (product.shopify_product_id) {
    try {
      const sp = await shopify.getShopifyProductFull(product.shopify_product_id);
      if (!(Array.isArray(b.imageUrls) && b.imageUrls.length) && sp.imageUrls?.length) imageUrls = sp.imageUrls;
      if (!description && b.useShopifyDescription !== false && sp.description) description = sp.description;
    } catch (e) {
      console.warn('[create-ebay] Shopify fetch failed (continuing with warehouse data):', e.message);
    }
  }
  // `description` now holds the RAW body (from the form override or Shopify).
  // If none, we build a styled spec-table body below (after specifics are known).
  // Either way it gets wrapped in the branded template before listing.
  const rawBody = description;

  const title = (b.titleOverride || product.title || '').trim();
  if (!title) throw httpErr(400, { error: 'no_title', message: 'Product has no title — set one in inventory before listing.' });

  // Resolve category — fall back to the Settings default if none was passed.
  const categoryId = b.categoryId || settings.ebay_default_category_id;
  if (!categoryId) throw httpErr(400, { error: 'no_category', message: 'No eBay category — pass categoryId or set a default in Settings.' });

  // Vehicle fitment + part-number specifics we can always rebuild from the
  // warehouse (Placement/Make/Model/Year/Country/Product Number/MPN/Interchange).
  // Country of Origin — default from Settings (configurable), overridable per listing.
  const countryOfOrigin = (b.countryOfOrigin != null ? b.countryOfOrigin : (settings.ebay_country_of_origin || 'China'));
  const derivedSpecifics = await deriveEbaySpecifics(product, { countryOfOrigin });
  // User-provided specifics WIN on name collisions (form overlays the derived set).
  const mergedSpecifics = mergeSpecificsByName(derivedSpecifics, Array.isArray(b.itemSpecifics) ? b.itemSpecifics : []);

  // Build the FINAL description: use the raw body (form/Shopify) if present, else
  // a styled spec-table body, then wrap it in the branded storefront template so
  // every new listing looks designed (header/trust bar/spec table/similar-items
  // CTA/payment+delivery+returns/footer). Skip wrapping only if the caller opts
  // out (b.wrapDescription === false) or already sent a pre-wrapped body.
  if (b.wrapDescription === false) {
    description = (rawBody && String(rawBody).trim()) ? unwrapDesc(rawBody) : buildStyledDescBody(product, mergedSpecifics);
  } else {
    description = await composeEbayDescription(
      { ...product, title, part_number: product.part_number || product.sku },
      { specifics: mergedSpecifics, storeCode: store.code, rawBody });
  }

  // eBay "Brand" = who MADE the part (company name / "Unbranded"), NOT the
  // vehicle make. Per-listing override wins, else the saved Settings default.
  const ebayBrand = b.brand || settings.ebay_default_brand || 'Unbranded';

  // Pre-validate the category's REQUIRED item specifics (best-effort — if the
  // lookup itself fails we don't block the listing). Surfaces exactly which
  // required specifics are missing instead of letting AddItem fail cryptically.
  if (!b.skipSpecificsCheck) {
    try {
      const { specifics } = await ebay.getCategorySpecifics(store.code, categoryId);
      const provided = new Set(mergedSpecifics.filter(s => s.name && s.value).map(s => s.name.toLowerCase()));
      provided.add('brand');  // we always send a Brand (default/override)
      if (product.part_number) provided.add('manufacturer part number');
      const missing = specifics.filter(s => s.required && !provided.has(s.name.toLowerCase())).map(s => s.name);
      if (missing.length) {
        throw httpErr(422, {
          error: 'missing_item_specifics', missing,
          message: `eBay category ${categoryId} requires item specifics you haven't provided: ${missing.join(', ')}. Add them via itemSpecifics, or resend with skipSpecificsCheck=true.`,
        });
      }
    } catch (e) {
      console.warn('[create-ebay] category-specifics validation skipped:', e.message);
    }
  }

  const result = await ebay.addItem(store.code, {
    sku: product.sku,
    title,
    description,
    categoryId,
    conditionId: b.conditionId || 1000,
    price: parseFloat(b.price),
    quantity: parseInt(b.quantity) || product.qty_on_hand || 1,
    currency: 'GBP',
    imageUrls,
    businessPolicies: pol,
    location: loc,
    brand: ebayBrand,
    mpn: product.part_number,
    itemSpecifics: mergedSpecifics,
    // Shop/store category — per-listing choice, else the saved default.
    storeCategoryId: b.storeCategoryId || settings.ebay_default_store_category_id || null,
    // VAT — per-listing override, else dedicated eBay VAT %, else the general
    // VAT rate, else 20%. Sent only when > 0 (addItem omits it otherwise).
    vatPercent: b.vatPercent != null ? b.vatPercent
      : (settings.ebay_vat_percent != null ? settings.ebay_vat_percent
      : (settings.vat_rate != null ? settings.vat_rate : 20)),
    verify: !!b.preview,
  });

  // Preview mode (VerifyAddItem) — validated only, no live listing, nothing
  // persisted. Returns the fees + ack so the user can review before listing.
  if (b.preview) {
    return { ok: true, preview: true, ack: result.ack, fees: result.fees,
      message: 'Validated successfully — no live listing was created. Untick Preview to publish.' };
  }

  if (!result.itemId) throw new Error('AddItem succeeded but returned no ItemID');

  // Save the new ItemID into mirror_links so the rest of the system treats
  // this product as linked to eBay. mirror_links is keyed on ebay_item_id;
  // there is no `sku` column (SKU lives in last_synced_sku).
  try {
    await query(`ALTER TABLE mirror_links ADD COLUMN IF NOT EXISTS store_code TEXT`);
  } catch (e) {}
  await query(`
    INSERT INTO mirror_links (ebay_item_id, shopify_product_id, store_code, last_mirrored_at, last_synced_sku, last_synced_title)
    VALUES ($1, $2, $3, now(), $4, $5)
    ON CONFLICT (ebay_item_id) DO UPDATE
      SET shopify_product_id = EXCLUDED.shopify_product_id,
          store_code = EXCLUDED.store_code,
          last_synced_sku = EXCLUDED.last_synced_sku,
          last_mirrored_at = now()
  `, [String(result.itemId), product.shopify_product_id, store.code, product.sku, product.title]).catch(async (e) => {
    // No unique constraint on ebay_item_id (older schema) — insert plainly.
    console.warn('[create-ebay] mirror_links upsert fell back to plain insert:', e.message);
    await query(`INSERT INTO mirror_links (ebay_item_id, shopify_product_id, store_code, last_mirrored_at, last_synced_sku, last_synced_title) VALUES ($1, $2, $3, now(), $4, $5)`,
      [String(result.itemId), product.shopify_product_id, store.code, product.sku, product.title]);
  });

  // Persist the FULL eBay config on the product so a later edit can rebuild the
  // complete item-specifics set (never wiping fields the edit form omits), and so
  // the description/category/condition survive re-pushes. Best-effort.
  try {
    await query(
      `UPDATE products SET ebay_category_id = $1, ebay_condition_id = $2,
              ebay_item_specifics = $3::jsonb, ebay_description = COALESCE($4, ebay_description),
              updated_at = now() WHERE id = $5`,
      [String(categoryId), b.conditionId || 1000, JSON.stringify(mergedSpecifics),
       description || null, product.id]);
  } catch (e) { console.warn('[create-ebay] persist listing config:', e.message); }

  if (req) {
    await audit(req, 'create_ebay_listing', 'product', product.id, {
      sku: product.sku, itemId: result.itemId, store: store.code, categoryId: b.categoryId,
    });
  }

  // Promoted Listings (General) — best-effort. Runs only when the user asked,
  // and only on a live listing. A failure here (e.g. marketing scope not
  // granted) never fails the listing — it's surfaced in the response so the
  // user knows the item is live but wasn't promoted.
  let promotion = null;
  if (b.promote?.enabled && result.itemId) {
    try {
      const pr = await ebay.promoteListing(store.code, { itemId: result.itemId, bidPercent: b.promote.percent });
      promotion = { ok: true, ...pr };
    } catch (e) {
      console.warn('[create-ebay] promotion failed:', e.message);
      promotion = { ok: false, message: e.message };
    }
  }

  return {
    ok: true,
    itemId: result.itemId,
    url: `https://www.ebay.co.uk/itm/${result.itemId}`,
    fees: result.fees,
    ack: result.ack,
    promotion,
  };
}

// POST /api/listings/create-ebay — thin wrapper over doCreateEbay.
router.post('/create-ebay', requireAdmin, async (req, res) => {
  try {
    const out = await doCreateEbay(req.body || {}, { req });
    res.json(out);
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json(e.body || { error: 'create_failed', message: e.message });
    console.error('[create-ebay]', e.message);
    res.status(500).json({ error: 'create_failed', message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Pre-listing eBay go-live.
//
// A pre-listed product is held in the warehouse (status 'scheduled') with the
// captured create-ebay payload in products.ebay_prelist_payload and a go-live
// time in ebay_scheduled_at. publishPrelisting() replays that payload through
// doCreateEbay to create the real listing now, marking the product 'live' (or
// 'failed' with a notification). Both the go-live cron and the "Push live now"
// button call it.
// ──────────────────────────────────────────────────────────────────────────
async function publishPrelisting(product, { req } = {}) {
  let payload = product.ebay_prelist_payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = null; } }
  if (!payload || !payload.storeCode) {
    throw new Error('no eBay pre-listing payload stored for this product');
  }
  // Force a live publish (never a preview), and list the current quantity.
  const b = { ...payload, productId: product.id, preview: false };
  try {
    const out = await doCreateEbay(b, { req });
    await query(`UPDATE products SET ebay_prelist_status = 'live', ebay_scheduled_at = NULL WHERE id = $1`, [product.id]);
    // Cap the freshly-listed eBay quantity to the available-to-promise (units on
    // the way − already pre-ordered), now that a mirror_link exists.
    try { await require('./products').pushProductStockToChannels(product.id); } catch (_) {}
    return { ok: true, itemId: out.itemId, url: out.url };
  } catch (e) {
    await query(`UPDATE products SET ebay_prelist_status = 'failed' WHERE id = $1`, [product.id]).catch(() => {});
    // Best-effort notification so staff know an automatic go-live failed.
    try {
      await query(
        `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
         VALUES ('ebay_prelist_failed', $1, $2, 'error', 'product', $3)`,
        [`eBay go-live failed: ${product.title || product.sku}`,
         `The scheduled eBay listing for "${product.title || product.sku}" (SKU ${product.sku}) could not be published automatically: ${e.message}. Try "Push live now" from the product.`,
         product.id]
      );
      require('../services/push').sendToAll({
        title: 'eBay go-live failed', body: product.title || product.sku, url: '/', tag: 'prelist-fail-' + product.id, category: 'ebay_prelist_failed',
      }).catch(() => {});
    } catch (_) { /* notifications table/push optional */ }
    throw e;
  }
}

// Publish every scheduled pre-listing whose go-live time has passed. Called by the
// boot cron. Returns a small summary for logging.
async function publishDuePrelistings() {
  let due;
  try {
    due = await query(
      `SELECT * FROM products
        WHERE ebay_prelist_status = 'scheduled'
          AND ebay_scheduled_at IS NOT NULL
          AND ebay_scheduled_at <= now()
        ORDER BY ebay_scheduled_at ASC
        LIMIT 25`);
  } catch (e) {
    // Columns may not exist yet on a very old DB — non-fatal.
    return { published: 0, failed: 0, skipped: true };
  }
  let published = 0, failed = 0;
  for (const product of due.rows) {
    try { await publishPrelisting(product); published++; }
    catch (e) { failed++; console.warn('[prelist go-live] failed for', product.sku, '-', e.message); }
  }
  return { published, failed, total: due.rows.length };
}

// POST /api/listings/:id/publish-ebay — "Push live now". Publishes a scheduled
// pre-listing immediately, regardless of its go-live time.
router.post('/:id/publish-ebay', requireAdmin, async (req, res) => {
  try {
    const pr = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
    const product = pr.rows[0];
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    const out = await publishPrelisting(product, { req });
    if (req) await audit(req, 'publish_prelisting_ebay', 'product', product.id, { itemId: out.itemId });
    res.json(out);
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json(e.body || { error: 'publish_failed', message: e.message });
    res.status(500).json({ error: 'publish_failed', message: e.message });
  }
});

// POST /api/listings/backfill-preorder-presentation — one-off cleanup. For every
// product currently sold as a pre-order (is_prelisted or preorder_active), push the
// CLEAN title/description back to Shopify (stripping any legacy "Pre-order — ships…"
// text), ensure the 'preorder' tag + ETA metafields + continue-selling, and ensure
// the smart collection exists. Safe to run repeatedly.
router.post('/backfill-preorder-presentation', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  let rows;
  try {
    rows = (await query(
      `SELECT id, sku, title, preorder_eta, shopify_product_id
         FROM products
        WHERE (is_prelisted = true OR preorder_active = true) AND shopify_product_id IS NOT NULL`)).rows;
  } catch (e) { return res.status(500).json({ error: 'query_failed', message: e.message }); }

  await shopify.ensurePreorderCollection().catch(() => {});
  let updated = 0; const errors = [];
  for (const p of rows) {
    try {
      // ETA: prefer the product's preorder_eta, else the earliest incoming ETA.
      let eta = p.preorder_eta;
      if (!eta) {
        const inc = await query(
          `SELECT MIN(expected_date) AS eta FROM incoming_stock
            WHERE product_id = $1 AND status NOT IN ('received','cancelled')`, [p.id]);
        eta = inc.rows[0]?.eta || null;
      }
      const full = await shopify.getShopifyProductFull(p.shopify_product_id);
      await shopify.updateProduct(p.shopify_product_id, {
        title: preorder.stripTitleNotice(full.title),
        description: preorder.stripBodyNotice(full.description),
        tags: preorder.addPreorderTag(full.tags),
        inventoryPolicy: 'deny',   // capped to the incoming quantity
        metafields: [
          { namespace: 'custom', key: 'preorder_eta', type: 'date', value: eta ? String(eta).slice(0, 10) : '' },
          { namespace: 'custom', key: 'preorder_ships_note', type: 'single_line_text_field', value: preorder.shipsNote(eta) },
        ],
      });
      try { await require('./products').pushProductStockToChannels(p.id); } catch (_) {}
      updated++;
    } catch (e) { errors.push({ sku: p.sku, error: e.message }); }
  }
  if (req) await audit(req, 'backfill_preorder_presentation', null, null, { updated, total: rows.length });
  res.json({ ok: true, updated, total: rows.length, errors: errors.slice(0, 20) });
});

router.publishDuePrelistings = publishDuePrelistings;

// Helper: minimal HTML-escape for server-side description fallback strings
function escapeHtmlServer(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/listings/stores
// Returns the configured eBay stores with their enabled/disabled state.
// Used by the Listing Mirror UI to show a "X disabled" banner and to power
// the "Clean up disabled-store links" button.
// ──────────────────────────────────────────────────────────────────────────
router.get('/stores', requireAdmin, (req, res) => {
  const ebay = require('../services/ebay');
  res.json({ stores: ebay.listStores() });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/cleanup-disabled-store-links
// Deletes mirror_links rows whose store_code matches a currently-disabled
// store. Used to clear out stale links after temporarily disabling a store
// — so the listing-mirror counts and the Quote Builder's eBay link logic
// reflect reality.
//
// Behaviour:
//   • Looks up the disabled stores from ebay.listStores() (server-side, not
//     trusting client input)
//   • Deletes any mirror_links row whose store_code is in that set
//   • Returns the deleted-count + a sample of deleted rows for confirmation
//
// Safe to re-run — idempotent. After re-enabling a store, running force-match
// re-creates the links from the live eBay listings.
// ──────────────────────────────────────────────────────────────────────────
router.post('/cleanup-disabled-store-links', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  const disabled = ebay.listStores().filter(s => s.disabled).map(s => s.code);
  if (disabled.length === 0) {
    return res.json({ ok: true, deleted: 0, disabledStores: [], message: 'No disabled stores — nothing to clean.' });
  }
  // Get a sample of what will be deleted (for audit + user confirmation in toast)
  const sampleRes = await query(
    `SELECT ebay_item_id, store_code, last_synced_sku, last_synced_title
     FROM mirror_links WHERE store_code = ANY($1) LIMIT 20`,
    [disabled]
  );
  const delRes = await query(
    `DELETE FROM mirror_links WHERE store_code = ANY($1)`,
    [disabled]
  );
  await audit(req, 'cleanup_disabled_store_links', null, null, {
    disabledStores: disabled, deleted: delRes.rowCount,
  });
  res.json({
    ok: true,
    deleted: delRes.rowCount || 0,
    disabledStores: disabled,
    sample: sampleRes.rows,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/listings/resolve-legacy-links
// Handles mirror_links rows with store_code = NULL (the "N linked products
// have unknown eBay store (legacy)" banner). These predate per-store tracking.
//
// Two-phase, cheap (no bulk GetMyeBaySelling scan):
//   Phase 1 — for each NULL-store link, call GetItem (1 call each) to find which
//             store the ItemID belongs to by checking the seller user ID against
//             each configured store. Far cheaper than a full re-scan because
//             there are only a handful of legacy rows.
//   Phase 2 — anything still unresolved (item ended, GetItem failed, store
//             disabled) can be cleared if ?clearUnresolved=true is passed.
//
// Body: { clearUnresolved?: boolean }
// ──────────────────────────────────────────────────────────────────────────
router.post('/resolve-legacy-links', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  const clearUnresolved = !!req.body?.clearUnresolved;

  // Find the NULL-store links
  const legacy = await query(
    `SELECT ebay_item_id, last_synced_sku FROM mirror_links WHERE store_code IS NULL`
  );
  if (legacy.rows.length === 0) {
    return res.json({ ok: true, resolved: 0, cleared: 0, unresolved: 0, message: 'No legacy links — nothing to resolve.' });
  }

  const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
  let resolved = 0, cleared = 0;
  const unresolvedRows = [];

  for (const link of legacy.rows) {
    let matchedStore = null;
    // Try each active store: ask its account for this ItemID. The store whose
    // token can see the item as its own listing is the owner.
    for (const s of stores) {
      try {
        const owns = await ebay.itemBelongsToStore(link.ebay_item_id, s.code);
        if (owns) { matchedStore = s.code; break; }
      } catch (e) { /* try next store */ }
    }
    if (matchedStore) {
      await query(`UPDATE mirror_links SET store_code = $1 WHERE ebay_item_id = $2`, [matchedStore, link.ebay_item_id]);
      resolved++;
    } else {
      unresolvedRows.push(link);
    }
  }

  // Phase 2 — optionally clear the ones we couldn't attribute to any active
  // store (likely Evanta listings now that Evanta is disabled, or ended items).
  if (clearUnresolved && unresolvedRows.length) {
    const ids = unresolvedRows.map(r => r.ebay_item_id);
    const del = await query(`DELETE FROM mirror_links WHERE ebay_item_id = ANY($1)`, [ids]);
    cleared = del.rowCount || 0;
  }

  await audit(req, 'resolve_legacy_links', null, null, {
    total: legacy.rows.length, resolved, cleared, unresolved: unresolvedRows.length - cleared,
  });

  res.json({
    ok: true,
    total: legacy.rows.length,
    resolved,
    cleared,
    unresolved: unresolvedRows.length - cleared,
    unresolvedSample: unresolvedRows.slice(0, 10).map(r => ({ itemId: r.ebay_item_id, sku: r.last_synced_sku })),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DRAFT LISTINGS — save a listing's full form state (eBay category, condition,
// item specifics, sub part numbers, photos, descriptions, prices) to the
// warehouse WITHOUT pushing to any channel. Drafts are separate from inventory
// (their own table) so they don't touch stock, costs, or the stock-take. New
// stock with no photos yet can be drafted now and published when photos arrive.
// Publishing runs the normal create-listing + create-ebay flow client-side, then
// deletes the draft. Reopening a draft restores every field — nothing is lost.
// ──────────────────────────────────────────────────────────────────────────
let _draftsReady = false;
async function ensureDraftsTable() {
  if (_draftsReady) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS listing_drafts (
      id           SERIAL PRIMARY KEY,
      title        TEXT,
      sku          TEXT,
      part_number  TEXT,
      vehicle      TEXT,
      image_count  INTEGER NOT NULL DEFAULT 0,
      incoming_id  INTEGER REFERENCES incoming_stock(id) ON DELETE SET NULL,
      payload      JSONB NOT NULL,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    _draftsReady = true;
  } catch (e) { console.warn('[listings] ensureDraftsTable:', e.message); }
}
ensureDraftsTable();

// GET /api/listings/drafts — list drafts (summary only, no heavy payload/images).
router.get('/drafts', requireAdmin, async (req, res) => {
  await ensureDraftsTable();
  try {
    const { rows } = await query(
      `SELECT id, title, sku, part_number, vehicle, image_count, incoming_id, created_at, updated_at
         FROM listing_drafts ORDER BY updated_at DESC`);
    res.json({ drafts: rows });
  } catch (e) { res.status(500).json({ error: 'list_failed', message: e.message }); }
});

// GET /api/listings/drafts/:id — full draft incl. payload (for reopening).
router.get('/drafts/:id', requireAdmin, async (req, res) => {
  await ensureDraftsTable();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  const { rows } = await query(`SELECT * FROM listing_drafts WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ draft: rows[0] });
});

// POST /api/listings/drafts — create or update a draft (SAVE ONLY, no channel push).
// Body: { draftId?, payload, incomingId? }. payload is the whole captured form
// (core + eBay + images base64 + subPartNumbers). We derive a few summary columns
// for the list view; everything else lives verbatim in payload so nothing is lost.
router.post('/drafts', requireAdmin, async (req, res) => {
  await ensureDraftsTable();
  const b = req.body || {};
  const payload = b.payload && typeof b.payload === 'object' ? b.payload : null;
  if (!payload) return res.status(400).json({ error: 'payload_required' });
  // The frontend sends the opaque form snapshot as `payload` plus explicit
  // summary fields for the list view (title/sku/partNumber/vehicle/imageCount).
  const title = (b.title != null ? String(b.title) : '').trim() || null;
  const sku = (b.sku != null ? String(b.sku) : '').trim() || null;
  const partNumber = (b.partNumber != null ? String(b.partNumber) : '').trim() || null;
  const vehicle = (b.vehicle != null ? String(b.vehicle) : '').trim() || null;
  const imageCount = parseInt(b.imageCount) || 0;
  const incomingId = b.incomingId != null ? (parseInt(b.incomingId) || null) : null;
  try {
    if (b.draftId) {
      const r = await query(
        `UPDATE listing_drafts SET title=$1, sku=$2, part_number=$3, vehicle=$4, image_count=$5,
                incoming_id=COALESCE($6, incoming_id), payload=$7::jsonb, updated_at=now()
           WHERE id=$8 RETURNING id`,
        [title, sku, partNumber, vehicle, imageCount, incomingId, JSON.stringify(payload), b.draftId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      await audit(req, 'save_draft', 'listing_draft', b.draftId, { title, sku });
      return res.json({ ok: true, draftId: r.rows[0].id, updated: true });
    }
    const r = await query(
      `INSERT INTO listing_drafts (title, sku, part_number, vehicle, image_count, incoming_id, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
      [title, sku, partNumber, vehicle, imageCount, incomingId, JSON.stringify(payload), req.user.id]);
    await audit(req, 'save_draft', 'listing_draft', r.rows[0].id, { title, sku });
    res.json({ ok: true, draftId: r.rows[0].id, created: true });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// DELETE /api/listings/drafts/:id — discard a draft (also called after publish).
router.delete('/drafts/:id', requireAdmin, async (req, res) => {
  await ensureDraftsTable();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  await query(`DELETE FROM listing_drafts WHERE id = $1`, [id]);
  await audit(req, 'delete_draft', 'listing_draft', id, {});
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// PUSH THE NEW STYLED DESCRIPTION TO EXISTING LIVE LISTINGS.
// Regenerates the full branded description (spec table + notices + related-item
// cards) for every linked eBay listing and revises it. Runs in the BACKGROUND
// (hundreds of ReviseItem calls) with pollable progress. Optionally also sets the
// Shopify body_html. Best-effort per item — one failure never stops the run.
// ──────────────────────────────────────────────────────────────────────────
let restyleStatus = { state: 'idle', startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, sampleError: null, includeShopify: false };

router.post('/restyle-descriptions', requireAdmin, async (req, res) => {
  if (restyleStatus.state === 'running') return res.json({ ok: true, started: false, alreadyRunning: true, status: restyleStatus });
  const includeShopify = !!(req.body && req.body.includeShopify);
  const onlyProductId = req.body && req.body.productId ? parseInt(req.body.productId) : null;
  restyleStatus = { state: 'running', startedAt: Date.now(), finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, sampleError: null, includeShopify };
  await audit(req, 'restyle_descriptions', null, null, { includeShopify, onlyProductId });
  res.json({ ok: true, started: true, includeShopify });
  setImmediate(async () => {
    try {
      const stores = ebay.listStores().filter(st => st.hasToken && !st.disabled);
      const linkRows = (await query(
        `SELECT ml.ebay_item_id, ml.store_code, p.*
           FROM mirror_links ml JOIN products p ON p.shopify_product_id::text = ml.shopify_product_id::text
          WHERE ml.ebay_item_id IS NOT NULL ${onlyProductId ? 'AND p.id = ' + onlyProductId : ''}`)).rows;
      restyleStatus.total = linkRows.length;
      for (const row of linkRows) {
        const store = stores.find(st => st.code === row.store_code) || (stores.find(st => st.primary) || stores[0]);
        try {
          if (!store) throw new Error('no eBay store for link');
          const specifics = Array.isArray(row.ebay_item_specifics) ? row.ebay_item_specifics : [];
          const html = await composeEbayDescription(row, { specifics, storeCode: store.code });
          await ebay.reviseItem(row.ebay_item_id, { description: html }, store.code);
          await query(`UPDATE products SET ebay_description = $1, updated_at = now() WHERE id = $2`, [html, row.id]).catch(() => {});
          if (includeShopify && row.shopify_product_id && shopify.isConfigured()) {
            try { await shopify.updateProduct(row.shopify_product_id, { description: html, imageUrls: [] }); } catch (_) {}
          }
          restyleStatus.ok++;
        } catch (e) {
          restyleStatus.failed++;
          if (!restyleStatus.sampleError) restyleStatus.sampleError = e.message;
        }
        restyleStatus.done++;
      }
      restyleStatus.state = 'done'; restyleStatus.finishedAt = Date.now();
      await query(`INSERT INTO notifications (type, title, body, severity) VALUES ('sync','Listing descriptions updated',$1,$2)`,
        [`${restyleStatus.ok} updated${restyleStatus.failed ? `, ${restyleStatus.failed} failed` : ''}`, restyleStatus.failed ? 'warn' : 'success']).catch(() => {});
    } catch (e) {
      restyleStatus.state = 'error'; restyleStatus.finishedAt = Date.now(); restyleStatus.sampleError = e.message;
      console.error('[restyle-descriptions] failed:', e.message);
    }
  });
});

// GET /api/listings/restyle-descriptions/status — poll live progress.
router.get('/restyle-descriptions/status', requireAdmin, (req, res) => res.json(restyleStatus));

// Expose the single-flight runner so the sync cron can run the warehouse import
// automatically without racing a manual run.
router.runWarehouseImport = runImportSingleFlight;
module.exports = router;
