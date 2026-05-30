// routes/listings.js — eBay → Shopify listing mirror
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { query } = require('../db');
const ebay = require('../services/ebay');
const shopify = require('../services/shopify');

const router = express.Router();

router.use(requireAuth);

// Best-effort parse of vehicle Make / Model / Year(range) from a product title,
// used to auto-populate eBay item specifics. Conservative — only emits a value
// when reasonably confident (make matched against a known list, etc.).
const VEHICLE_MAKES = ['Abarth','Alfa Romeo','Aston Martin','Audi','Bentley','BMW','Citroen','Citroën','Cupra','Dacia','DS','Ferrari','Fiat','Ford','Honda','Hyundai','Jaguar','Jeep','Kia','Lamborghini','Land Rover','Lexus','Maserati','Mazda','McLaren','Mercedes-Benz','Mercedes','MG','Mini','Mitsubishi','Nissan','Peugeot','Polestar','Porsche','Renault','Seat','Skoda','Škoda','Smart','SsangYong','Subaru','Suzuki','Tesla','Toyota','Vauxhall','Volkswagen','VW','Volvo'];
function parseVehicleFromTitle(title) {
  const t = ' ' + String(title || '') + ' ';
  let make = null, makeRe = null;
  for (const m of VEHICLE_MAKES) {
    const re = new RegExp('\\b' + m.replace(/-/g, '[- ]?') + '\\b', 'i');
    if (re.test(t)) { make = (m === 'VW' ? 'Volkswagen' : m); makeRe = re; break; }
  }
  // Year range (2019-2024, 2019–2024, 2019 to 2024) else single year.
  let year = null;
  const range = t.match(/\b((?:19|20)\d{2})\s*(?:[-–]|to)\s*((?:19|20)\d{2})\b/i);
  if (range) year = `${range[1]}-${range[2]}`;
  else { const single = t.match(/\b((?:19|20)\d{2})\b/); if (single) year = single[1]; }
  // Model — the 1-2 tokens after the make, up to a year or a part-type keyword.
  let model = null;
  if (makeRe) {
    const after = t.split(makeRe)[1] || '';
    const stopIdx = after.search(/\b(?:19|20)\d{2}\b|\b(?:front|rear|left|right|lh|rh|bumper|bonnet|hood|headlight|headlamp|taillight|wing|fender|door|mirror|grille|grill|tailgate|panel|arch|spoiler|skirt|sill)\b/i);
    const seg = (stopIdx > 0 ? after.slice(0, stopIdx) : after).trim();
    const tokens = seg.split(/\s+/).filter(Boolean).slice(0, 2);
    if (tokens.length) model = tokens.join(' ');
  }
  return { make, model, year };
}

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
    SELECT p.id, p.sku, p.title, p.barcode, p.part_number,
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
  const p = await query(`SELECT id, shopify_product_id, sku, title FROM products WHERE id = $1`, [productId]);
  if (!p.rows[0]) return res.status(404).json({ error: 'product_not_found' });
  const spId = shopifyProductId || p.rows[0].shopify_product_id;
  if (!spId) return res.status(400).json({ error: 'no_shopify_product_id', message: 'Product has no Shopify product_id. Sync from Shopify first.' });

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
    [String(ebayItemId), spId, detectedStoreCode || null, p.rows[0].sku, p.rows[0].title]
  );

  // If we have the live listing, also bump price_ebay on the warehouse product
  // so the quote builder + invoices reflect reality immediately.
  let priceUpdated = false;
  if (listing && listing.priceEbay > 0) {
    await query(
      `UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`,
      [listing.priceEbay, p.rows[0].id]
    );
    priceUpdated = true;
  }

  await audit(req, 'create_mirror_link', 'product', productId, { ebayItemId, shopifyProductId: spId, storeCode: detectedStoreCode, priceUpdated });
  res.json({ ok: true, storeCode: detectedStoreCode, priceUpdated, livePrice: listing?.priceEbay || null });
});

router.post('/link-status/unlink', requireAdmin, async (req, res) => {
  const { ebayItemId } = req.body || {};
  if (!ebayItemId) return res.status(400).json({ error: 'ebay_item_id_required' });
  await query(`DELETE FROM mirror_links WHERE ebay_item_id = $1`, [String(ebayItemId)]);
  await audit(req, 'delete_mirror_link', 'mirror_link', null, { ebayItemId });
  res.json({ ok: true });
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
    res.json({ profiles });
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
    const stores = ebay.listStores().filter(s => s.hasToken);
    let listings = [];
    for (const s of stores) {
      try {
        const part = await ebay.getActiveListings(s.code);
        listings = listings.concat(part);
      } catch (e) {
        console.warn(`[mirror.pull] store=${s.code} failed: ${e.message}`);
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
      }
      const link = linkMap[l.itemId];
      if (link) {
        l.existsOnShopify = true;
        l.shopifyProductId = String(link.shopify_product_id);
        l.lastMirroredAt = link.last_mirrored_at;
      }
    }

    // For listings with no link, fall back to SKU lookup (legacy mirrors before mirror_links existed)
    if (shopify.isConfigured()) {
      const unlinked = listings.filter(l => !l.existsOnShopify);
      const skusToCheck = unlinked.map(l => l.overrideSku || l.sku).filter(Boolean);
      if (skusToCheck.length) {
        const found = await shopify.findProductsBySkus(skusToCheck);
        for (const l of unlinked) {
          const effectiveSku = l.overrideSku || l.sku;
          if (effectiveSku && found[effectiveSku]) {
            l.existsOnShopify = true;
            l.shopifyProductId = String(found[effectiveSku].product_id);
            l.shopifyTitle = found[effectiveSku].title;
            // Backfill the mirror_links table so future pulls don't need to SKU-search
            try {
              await query(`
                INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_synced_sku, last_synced_title)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (ebay_item_id) DO NOTHING
              `, [l.itemId, found[effectiveSku].product_id, effectiveSku, found[effectiveSku].title]);
            } catch (e) { /* ignore — non-critical */ }
          }
        }
      }
    }

    res.json({ listings, count: listings.length });
  } catch (e) {
    console.error('[listings/ebay-active]', e.message);
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// Persist override (SKU/title/price/metafield edits)
router.post('/save-override', requireAdmin, async (req, res) => {
  const { itemId, overrideSku, overrideTitle, customPrice, metafields, shippingProfileId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'missing_item_id' });
  try {
    await query(`
      INSERT INTO ebay_listing_overrides (ebay_item_id, override_sku, override_title, custom_price, metafields, shipping_profile_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (ebay_item_id) DO UPDATE SET
        override_sku = EXCLUDED.override_sku,
        override_title = EXCLUDED.override_title,
        custom_price = EXCLUDED.custom_price,
        metafields = EXCLUDED.metafields,
        shipping_profile_id = EXCLUDED.shipping_profile_id,
        updated_at = now()
    `, [
      itemId,
      overrideSku || null,
      overrideTitle || null,
      customPrice != null ? customPrice : null,
      metafields ? JSON.stringify(metafields) : null,
      shippingProfileId || null,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[listings/save-override]', e);
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

// Check existing Shopify products by SKU
router.post('/check-conflicts', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
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
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

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
        status: item.status || 'draft',
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
router.post('/create-ebay', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  const shopify = require('../services/shopify');
  const brand = require('../lib/brand');
  const b = req.body || {};

  if (!b.productId)  return res.status(400).json({ error: 'productId required' });
  if (!b.storeCode)  return res.status(400).json({ error: 'storeCode required' });
  // categoryId is resolved after settings load (falls back to the Settings default).
  if (b.price == null || isNaN(parseFloat(b.price))) return res.status(400).json({ error: 'valid price required' });

  // Look up the product. We need at minimum: sku, title, image_url, brand, mpn.
  const pr = await query(`SELECT * FROM products WHERE id = $1`, [b.productId]);
  const product = pr.rows[0];
  if (!product) return res.status(404).json({ error: 'product_not_found' });

  // Resolve the store. For multi-store brands the user must pass storeCode.
  const store = brand.getStore(b.storeCode);
  if (!store) return res.status(400).json({ error: 'unknown_store', message: `No eBay store configured with code "${b.storeCode}". Available: ${brand.stores.map(s => s.code).join(', ')}` });

  // Pull eBay listing defaults from app_settings (per-store policies + location).
  // The settings UI lets the user save these once so they don't have to type them
  // for every new listing.
  const settings = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};

  // Per-store business policies, namespaced by store code in the DB column names.
  // Falls back to the brand-wide default keys (no store suffix) for single-store brands.
  const polPrefix = `ebay_policy_${store.code}_`;
  const pol = {
    paymentId:  settings[`${polPrefix}payment`]  || settings['ebay_policy_payment']  || b.businessPolicies?.paymentId  || null,
    shippingId: settings[`${polPrefix}shipping`] || settings['ebay_policy_shipping'] || b.businessPolicies?.shippingId || null,
    returnId:   settings[`${polPrefix}return`]   || settings['ebay_policy_return']   || b.businessPolicies?.returnId   || null,
  };

  const loc = {
    country:    settings.ebay_location_country    || 'GB',
    postalCode: settings.ebay_location_postcode   || '',
    city:       settings.ebay_location_city       || '',
  };

  // Try to enrich with Shopify-side content (description + extra images).
  // Best-effort; if Shopify fetch fails we fall back to the warehouse data.
  let description = '';
  let imageUrls = product.image_url ? [product.image_url] : [];
  if (b.useShopifyDescription !== false && product.shopify_product_id) {
    try {
      const sp = await shopify.getShopifyProductFull(product.shopify_product_id);
      if (sp.description) description = sp.description;
      if (sp.imageUrls?.length) imageUrls = sp.imageUrls;
    } catch (e) {
      console.warn('[create-ebay] Shopify fetch failed (continuing with warehouse data):', e.message);
    }
  }
  // Fallback description if Shopify didn't supply one
  if (!description) {
    description = `<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>${escapeHtmlServer(product.title)}</h2>` +
      (product.brand ? `<p><strong>Brand:</strong> ${escapeHtmlServer(product.brand)}</p>` : '') +
      (product.part_number ? `<p><strong>Part number:</strong> ${escapeHtmlServer(product.part_number)}</p>` : '') +
      `<p>Listed by ${escapeHtmlServer(brand.name || 'our warehouse')}. Please contact us with any fitment questions before purchase.</p></div>`;
  }

  const title = (b.titleOverride || product.title || '').trim();
  if (!title) return res.status(400).json({ error: 'no_title', message: 'Product has no title — set one in inventory before listing.' });

  // Resolve category — fall back to the Settings default if none was passed.
  const categoryId = b.categoryId || settings.ebay_default_category_id;
  if (!categoryId) return res.status(400).json({ error: 'no_category', message: 'No eBay category — pass categoryId or set a default in Settings.' });

  // Derive item specifics from the product + title. eBay auto-parts categories
  // commonly require these. User-supplied b.itemSpecifics override the derived
  // ones (addItem dedupes by name, later entries win).
  const vehicle = parseVehicleFromTitle(title);
  const derivedSpecifics = [];
  if (product.position) derivedSpecifics.push({ name: 'Placement on Vehicle', value: product.position });
  if (vehicle.make)  derivedSpecifics.push({ name: 'Make',  value: vehicle.make });
  if (vehicle.model) derivedSpecifics.push({ name: 'Model', value: vehicle.model });
  if (vehicle.year)  derivedSpecifics.push({ name: 'Year',  value: vehicle.year });
  const mergedSpecifics = [...derivedSpecifics, ...(Array.isArray(b.itemSpecifics) ? b.itemSpecifics : [])];

  // Pre-validate the category's REQUIRED item specifics (best-effort — if the
  // lookup itself fails we don't block the listing). Surfaces exactly which
  // required specifics are missing instead of letting AddItem fail cryptically.
  if (!b.skipSpecificsCheck) {
    try {
      const { specifics } = await ebay.getCategorySpecifics(store.code, categoryId);
      const provided = new Set(mergedSpecifics.filter(s => s.name && s.value).map(s => s.name.toLowerCase()));
      if (product.brand) provided.add('brand');
      if (product.part_number) provided.add('manufacturer part number');
      const missing = specifics.filter(s => s.required && !provided.has(s.name.toLowerCase())).map(s => s.name);
      if (missing.length) {
        return res.status(422).json({
          error: 'missing_item_specifics', missing,
          message: `eBay category ${categoryId} requires item specifics you haven't provided: ${missing.join(', ')}. Add them via itemSpecifics, or resend with skipSpecificsCheck=true.`,
        });
      }
    } catch (e) {
      console.warn('[create-ebay] category-specifics validation skipped:', e.message);
    }
  }

  try {
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
      brand: product.brand,
      mpn: product.part_number,
      itemSpecifics: mergedSpecifics,
    });

    if (!result.itemId) throw new Error('AddItem succeeded but returned no ItemID');

    // Save the new ItemID into mirror_links so the rest of the system treats
    // this product as linked to eBay. Self-healing migration ensures store_code
    // column exists.
    try {
      await query(`ALTER TABLE mirror_links ADD COLUMN IF NOT EXISTS store_code TEXT`);
    } catch (e) {}
    await query(`
      INSERT INTO mirror_links (sku, shopify_product_id, ebay_item_id, store_code, created_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (sku) DO UPDATE SET ebay_item_id = EXCLUDED.ebay_item_id, store_code = EXCLUDED.store_code
    `, [product.sku, product.shopify_product_id, result.itemId, store.code]).catch(async () => {
      // If there's no unique constraint on sku, just insert plainly
      await query(`INSERT INTO mirror_links (sku, shopify_product_id, ebay_item_id, store_code, created_at) VALUES ($1, $2, $3, $4, now())`,
        [product.sku, product.shopify_product_id, result.itemId, store.code]);
    });

    await audit(req, 'create_ebay_listing', 'product', product.id, {
      sku: product.sku, itemId: result.itemId, store: store.code, categoryId: b.categoryId,
    });

    res.json({
      ok: true,
      itemId: result.itemId,
      url: `https://www.ebay.co.uk/itm/${result.itemId}`,
      fees: result.fees,
      ack: result.ack,
    });
  } catch (e) {
    console.error('[create-ebay]', e.message);
    res.status(500).json({ error: 'create_failed', message: e.message });
  }
});

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

module.exports = router;
