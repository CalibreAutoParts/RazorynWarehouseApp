// routes/listings.js — eBay → Shopify listing mirror
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { query } = require('../db');
const ebay = require('../services/ebay');
const shopify = require('../services/shopify');

const router = express.Router();

router.use(requireAuth);

// GET /api/listings/ebay-active — pulls all active eBay listings, enriches with photos,
// merges in any persisted SKU/title overrides, and batch-checks Shopify for already-mirrored SKUs.
router.get('/ebay-active', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) {
    return res.status(400).json({
      error: 'ebay_not_configured',
      message: 'Set either (EBAY_AUTH_TOKEN + EBAY_CLIENT_ID + EBAY_CLIENT_SECRET) for Auth\'n\'Auth, or (EBAY_CLIENT_ID + EBAY_CLIENT_SECRET + EBAY_REFRESH_TOKEN) for OAuth, in Railway.',
    });
  }
  try {
    const listings = await ebay.getActiveListings();

    // Merge in saved overrides
    const overridesRows = await query(
      `SELECT * FROM ebay_listing_overrides WHERE ebay_item_id = ANY($1)`,
      [listings.map(l => l.itemId)]
    );
    const overridesMap = {};
    for (const row of overridesRows.rows) overridesMap[row.ebay_item_id] = row;
    for (const l of listings) {
      const o = overridesMap[l.itemId];
      if (o) {
        l.overrideSku = o.override_sku;
        l.overrideTitle = o.override_title;
        l.customPrice = o.custom_price != null ? parseFloat(o.custom_price) : null;
      }
    }

    // Batch-check Shopify for which SKUs already exist (use override SKU if set)
    if (shopify.isConfigured()) {
      const skusToCheck = listings.map(l => l.overrideSku || l.sku).filter(Boolean);
      const found = await shopify.findProductsBySkus(skusToCheck);
      for (const l of listings) {
        const effectiveSku = l.overrideSku || l.sku;
        if (effectiveSku && found[effectiveSku]) {
          l.existsOnShopify = true;
          l.shopifyProductId = found[effectiveSku].product_id;
          l.shopifyTitle = found[effectiveSku].title;
        }
      }
    }

    res.json({ listings, count: listings.length });
  } catch (e) {
    console.error('[listings/ebay-active]', e.message);
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// POST /api/listings/save-override — persist SKU/title/price edits per eBay item
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

// POST /api/listings/check-conflicts
router.post('/check-conflicts', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const skus = (req.body.skus || []).filter(Boolean);
  const found = await shopify.findProductsBySkus(skus);
  const conflicts = Object.entries(found).map(([sku, info]) => ({ sku, ...info }));
  res.json({ conflicts });
});

// POST /api/listings/mirror
router.post('/mirror', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const items = req.body.items || [];
  const overwrite = !!req.body.overwriteConflicts;
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  const skus = items.map(i => i.sku).filter(Boolean);
  const existingMap = await shopify.findProductsBySkus(skus);

  for (const item of items) {
    if (!item.sku) {
      results.errors.push({ title: item.title, error: 'missing SKU' });
      continue;
    }
    try {
      const existing = existingMap[item.sku];
      if (existing && !overwrite) {
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
      };
      if (existing && overwrite) {
        await shopify.updateProduct(existing.product_id, args);
        results.updated++;
      } else {
        await shopify.createProduct(args);
        results.created++;
      }
    } catch (e) {
      console.error('[listings/mirror] failed for', item.sku, e.message);
      results.errors.push({ sku: item.sku, title: item.title, error: e.message });
    }
  }

  await audit(req, 'mirror_listings', null, null, results);
  res.json({ ok: true, ...results });
});

module.exports = router;
