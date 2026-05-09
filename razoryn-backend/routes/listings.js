// routes/listings.js — eBay → Shopify listing mirror
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const ebay = require('../services/ebay');
const shopify = require('../services/shopify');

const router = express.Router();

// All listing endpoints require auth + admin
router.use(requireAuth);

// GET /api/listings/ebay-active — pulls all active eBay listings + auto-flags template images
router.get('/ebay-active', requireAdmin, async (req, res) => {
  if (!ebay.isConfigured()) {
    return res.status(400).json({ error: 'ebay_not_configured', message: 'Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN in Railway.' });
  }
  try {
    const listings = await ebay.getActiveListings();
    res.json({ listings, count: listings.length });
  } catch (e) {
    console.error('[listings/ebay-active]', e.message);
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// POST /api/listings/check-conflicts — body { skus: [..] }, returns which exist on Shopify
router.post('/check-conflicts', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.status(400).json({ error: 'shopify_not_configured' });
  }
  const skus = (req.body.skus || []).filter(Boolean);
  const conflicts = [];
  for (const sku of skus) {
    const found = await shopify.findProductBySku(sku);
    if (found) conflicts.push({ sku, ...found });
  }
  res.json({ conflicts });
});

// POST /api/listings/mirror — body { items: [{itemId, sku, title, price, imageUrls, status}], overwriteConflicts: bool }
router.post('/mirror', requireAdmin, async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.status(400).json({ error: 'shopify_not_configured' });
  }
  const items = req.body.items || [];
  const overwrite = !!req.body.overwriteConflicts;
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (const item of items) {
    if (!item.sku) {
      results.errors.push({ title: item.title, error: 'missing SKU' });
      continue;
    }
    try {
      const existing = await shopify.findProductBySku(item.sku);
      if (existing && !overwrite) {
        results.skipped++;
        continue;
      }
      if (existing && overwrite) {
        await shopify.updateProduct(existing.product_id, {
          title: item.title,
          sku: item.sku,
          price: item.price,
          imageUrls: item.imageUrls || [],
          status: item.status || 'draft',
        });
        results.updated++;
      } else {
        await shopify.createProduct({
          title: item.title,
          sku: item.sku,
          price: item.price,
          imageUrls: item.imageUrls || [],
          status: item.status || 'draft',
        });
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
