// routes/listings.js — eBay → Shopify listing mirror
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { query } = require('../db');
const ebay = require('../services/ebay');
const shopify = require('../services/shopify');

const router = express.Router();

router.use(requireAuth);

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
  const { rows: products } = await query(`
    SELECT p.id, p.sku, p.title, p.barcode, p.part_number,
           p.shopify_product_id, p.shopify_inventory_id,
           ml.ebay_item_id, ml.last_synced_sku, ml.last_synced_title, ml.last_mirrored_at
    FROM products p
    LEFT JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id
    WHERE p.active = true
    ORDER BY p.id DESC
    LIMIT 1000
  `);
  const { rows: orphanMirrors } = await query(`
    SELECT ml.ebay_item_id, ml.shopify_product_id, ml.last_synced_sku, ml.last_synced_title, ml.last_mirrored_at
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
    orphan: products.filter(p => !p.shopify_product_id && !p.ebay_item_id).length,
    orphanMirrors: orphanMirrors.length,
  };
  res.json({ summary, products, orphanMirrors });
});

// POST /api/listings/link-status/link
router.post('/link-status/link', requireAdmin, async (req, res) => {
  const { productId, ebayItemId, shopifyProductId } = req.body || {};
  if (!ebayItemId) return res.status(400).json({ error: 'ebay_item_id_required' });
  const p = await query(`SELECT shopify_product_id, sku, title FROM products WHERE id = $1`, [productId]);
  if (!p.rows[0]) return res.status(404).json({ error: 'product_not_found' });
  const spId = shopifyProductId || p.rows[0].shopify_product_id;
  if (!spId) return res.status(400).json({ error: 'no_shopify_product_id', message: 'Product has no Shopify product_id. Sync from Shopify first.' });
  await query(
    `INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_mirrored_at, last_synced_sku, last_synced_title)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (ebay_item_id) DO UPDATE SET shopify_product_id = EXCLUDED.shopify_product_id, last_mirrored_at = now()`,
    [String(ebayItemId), spId, p.rows[0].sku, p.rows[0].title]
  );
  await audit(req, 'create_mirror_link', 'product', productId, { ebayItemId, shopifyProductId: spId });
  res.json({ ok: true });
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
// every eBay store the brand has configured and aggregates the results.
router.post('/link-status/force-match', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  const sync = require('../services/sync');
  const stores = ebay.listStores().filter(s => s.hasToken && !s.standalone);

  let allListings = [];
  for (const s of stores) {
    try {
      const part = await ebay.getActiveListings(s.code);
      allListings = allListings.concat(part);
    } catch (e) {
      console.warn(`[force-match] store=${s.code} fetch failed: ${e.message}`);
    }
  }

  let matched = 0, alreadyLinked = 0, noMatch = 0;
  const matches = [];
  for (const l of allListings) {
    const existing = await query(`SELECT 1 FROM mirror_links WHERE ebay_item_id = $1`, [String(l.itemId)]);
    if (existing.rows[0]) { alreadyLinked++; continue; }

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
      `INSERT INTO mirror_links (ebay_item_id, shopify_product_id, last_mirrored_at, last_synced_sku, last_synced_title)
       VALUES ($1, $2, now(), $3, $4)
       ON CONFLICT (ebay_item_id) DO NOTHING`,
      [String(l.itemId), product.shopify_product_id, l.sku || product.sku, l.title]
    );
    matched++;
    if (matches.length < 20) matches.push({ ebayItemId: l.itemId, productId: product.id, sku: product.sku, title: l.title, store: l.storeCode });
  }
  await audit(req, 'force_match_links', null, null, { matched, alreadyLinked, noMatch, stores: stores.map(s => s.code) });
  res.json({ scanned: allListings.length, matched, alreadyLinked, noMatch, sample: matches, stores: stores.map(s => s.code) });
});

// POST /api/listings/hydrate-ebay-prices
// Pull live eBay listings, then update products.price_ebay for any matching SKUs.
// Useful when products were imported from Shopify but their eBay price is blank,
// causing phone-pricing quotes to show £0.
// POST /api/listings/hydrate-ebay-prices
// Pull live eBay listings, then update products.price_ebay for any matching products.
//
// PRIOR BUG: This used to match purely by `WHERE sku = $1`. That fails when:
//  - The eBay listing has no SKU set (common on older listings)
//  - The SKU on eBay is formatted differently (spaces, dashes, case)
// Result: phone pricing showed many items "pulled from Shopify" because price_ebay
// was null, even though the listing was already linked via mirror_links.
//
// FIX: Try three strategies in order, falling through to the next if no match:
//   A) mirror_links — most reliable since the link is explicit
//   B) Exact SKU match
//   C) Normalised SKU (uppercase, strip non-alphanumeric)
// Returns a detailed breakdown so the user can see which strategies fired.
router.post('/hydrate-ebay-prices', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });
  try {
    // 1) Pull active listings from every configured eBay store
    const stores = ebay.listStores().filter(s => s.hasToken && !s.standalone);
    let allListings = [];
    for (const s of stores) {
      try {
        const part = await ebay.getActiveListings(s.code);
        allListings = allListings.concat(part);
      } catch (e) { console.warn(`[hydrate-ebay-prices] store=${s.code} failed: ${e.message}`); }
    }

    // 2) Pre-load mirror_links into an in-memory map. One query instead of N.
    const linksResult = await query(`SELECT ebay_item_id, shopify_product_id FROM mirror_links`);
    const linkMap = {};
    for (const row of linksResult.rows) {
      linkMap[String(row.ebay_item_id)] = row.shopify_product_id;
    }

    let updated = 0;
    let matchedViaLink = 0, matchedViaSku = 0, matchedViaNormalizedSku = 0;
    let unmatched = 0, zeroPrice = 0;
    const unmatchedSample = [];

    for (const l of allListings) {
      const ebayPrice = parseFloat(l.priceEbay) || 0;
      if (ebayPrice <= 0) { zeroPrice++; continue; }

      let productId = null;

      // Strategy A — mirror_links (most reliable, handles listings without SKU on eBay)
      const linkedShopifyId = linkMap[String(l.itemId)];
      if (linkedShopifyId) {
        const r = await query(
          `SELECT id FROM products WHERE shopify_product_id = $1 LIMIT 1`,
          [linkedShopifyId]
        );
        if (r.rows[0]) { productId = r.rows[0].id; matchedViaLink++; }
      }

      // Strategy B — exact SKU match
      if (!productId && l.sku) {
        const r = await query(`SELECT id FROM products WHERE sku = $1 LIMIT 1`, [l.sku]);
        if (r.rows[0]) { productId = r.rows[0].id; matchedViaSku++; }
      }

      // Strategy C — normalised SKU (case + punctuation tolerant)
      if (!productId && l.sku) {
        const norm = l.sku.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (norm.length >= 5) {
          const r = await query(
            `SELECT id FROM products WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`,
            [norm]
          );
          if (r.rows[0]) { productId = r.rows[0].id; matchedViaNormalizedSku++; }
        }
      }

      if (productId) {
        await query(`UPDATE products SET price_ebay = $1 WHERE id = $2`, [ebayPrice, productId]);
        updated++;
      } else {
        unmatched++;
        if (unmatchedSample.length < 10) {
          unmatchedSample.push({
            itemId: l.itemId,
            sku: l.sku || '(no sku)',
            title: (l.title || '').slice(0, 60),
            price: ebayPrice,
            store: l.storeCode || null,
          });
        }
      }
    }

    res.json({
      ok: true,
      listingsFound: allListings.length,
      updated,
      matchedViaLink,
      matchedViaSku,
      matchedViaNormalizedSku,
      unmatched,
      zeroPrice,
      unmatchedSample,
      stores: stores.map(s => s.code),
    });
  } catch (e) {
    console.error('[hydrate-ebay-prices]', e);
    res.status(500).json({ error: 'hydrate_failed', message: e.message });
  }
});

// GET /api/listings/ebay-price-coverage
// Diagnostic: how many products have eBay prices vs not. Used by the Phone
// Pricing page to show a "X of Y products have eBay prices" banner so staff
// know when quotes might be falling back to Shopify prices.
router.get('/ebay-price-coverage', requireAdmin, async (req, res) => {
  const totals = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE price_ebay IS NOT NULL AND price_ebay::numeric > 0)::int AS with_ebay_price,
      COUNT(*) FILTER (WHERE price_shopify IS NOT NULL AND price_shopify::numeric > 0)::int AS with_shopify_price,
      COUNT(*) FILTER (WHERE shopify_product_id IS NOT NULL)::int AS linked_to_shopify,
      COUNT(*) FILTER (WHERE (price_ebay IS NULL OR price_ebay::numeric = 0) AND shopify_product_id IS NOT NULL)::int AS linked_no_ebay_price
    FROM products
  `);
  const missing = await query(`
    SELECT id, sku, title, price_shopify
    FROM products
    WHERE (price_ebay IS NULL OR price_ebay::numeric = 0)
      AND shopify_product_id IS NOT NULL
    ORDER BY title
    LIMIT 50
  `);
  res.json({ totals: totals.rows[0], missingSample: missing.rows });
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
    const stores = ebay.listStores().filter(s => s.hasToken && !s.standalone);
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
    const stores = ebay.listStores().filter(s => s.hasToken && !s.standalone);
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

module.exports = router;
