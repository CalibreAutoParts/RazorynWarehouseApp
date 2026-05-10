// routes/settings.js — global app settings + manual sync trigger
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const sync = require('../services/sync');

const router = express.Router();
router.use(requireAuth);

// GET /api/settings
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM app_settings WHERE id = 1');
  res.json({ settings: rows[0] || {} });
});

// PATCH /api/settings (admin)
router.patch('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  for (const [k, v] of Object.entries({
    cash_discount_pct: b.cashDiscountPct,
    vat_rate: b.vatRate,
    free_delivery_threshold: b.freeDeliveryThreshold,
    same_day_cutoff_hour: b.sameDayCutoffHour,
  })) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (b.data) { params.push(JSON.stringify(b.data)); sets.push(`data = $${params.length}::jsonb`); }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  sets.push('updated_at = now()');
  const { rows } = await query(
    `UPDATE app_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    params
  );
  await audit(req, 'update_settings');
  res.json({ settings: rows[0] });
});

// POST /api/settings/clear-catalogue (admin) — deletes ALL products, locations,
// mirror tracking, and per-listing overrides. Does NOT touch users, schedule,
// KB, settings, audit log. Does NOT delete anything on Shopify or eBay.
router.post('/clear-catalogue', requireAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM stock_movements`);
    await query(`DELETE FROM stock_checks`);
    await query(`DELETE FROM sale_items`);
    await query(`DELETE FROM return_photos`);
    await query(`DELETE FROM returns`);
    await query(`DELETE FROM products`);
    await query(`DELETE FROM locations`);
    // Also clear listing-mirror tracking so freshly mirrored listings appear as "New" again
    try { await query(`DELETE FROM mirror_links`); } catch (e) {}
    try { await query(`DELETE FROM ebay_listing_overrides`); } catch (e) {}
    await audit(req, 'clear_catalogue', null, null, {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[clear-catalogue]', e);
    res.status(500).json({ error: 'clear_failed', message: e.message });
  }
});

// POST /api/settings/sync-now (admin) — manual sync trigger
router.post('/sync-now', requireAdmin, async (req, res) => {
  try {
    const result = await sync.runFullSync();
    await audit(req, 'manual_sync', null, null, result);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// POST /api/settings/import-shopify (admin) — pull all products from Shopify into the warehouse DB.
// Upsert by shopify_variant_id (so re-running it is safe and updates titles/prices/images).
router.post('/import-shopify', requireAdmin, async (req, res) => {
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) {
    return res.status(400).json({ error: 'shopify_not_configured' });
  }
  let inserted = 0, updated = 0, errors = [];
  try {
    for await (const v of shopify.iterateAllProductsAndVariants()) {
      try {
        const existing = await query(
          `SELECT id FROM products WHERE shopify_variant_id = $1 OR sku = $2 LIMIT 1`,
          [v.shopify_variant_id, v.sku]
        );
        if (existing.rows.length) {
          await query(`
            UPDATE products SET
              shopify_product_id = $1, shopify_variant_id = $2, shopify_inventory_id = $3,
              title = $4, brand = COALESCE($5, brand), model = COALESCE($6, model),
              barcode = COALESCE($7, barcode),
              price_shopify = $8, image_url = COALESCE($9, image_url),
              qty_on_hand = $10, updated_at = now()
            WHERE id = $11`,
            [v.shopify_product_id, v.shopify_variant_id, v.shopify_inventory_id,
             v.title, v.brand, v.model, v.barcode,
             v.price_shopify, v.image_url, v.qty_on_hand, existing.rows[0].id]
          );
          updated++;
        } else {
          await query(`
            INSERT INTO products
              (sku, title, brand, model, barcode, price_shopify, image_url,
               qty_on_hand, shopify_product_id, shopify_variant_id, shopify_inventory_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [v.sku, v.title, v.brand, v.model, v.barcode,
             v.price_shopify, v.image_url, v.qty_on_hand,
             v.shopify_product_id, v.shopify_variant_id, v.shopify_inventory_id]
          );
          inserted++;
        }
      } catch (e) {
        errors.push({ sku: v.sku, error: e.message });
      }
    }
    await audit(req, 'import_shopify', null, null, { inserted, updated, errors: errors.length });
    res.json({ ok: true, inserted, updated, errors });
  } catch (e) {
    console.error('[import-shopify] failed:', e);
    res.status(500).json({ error: 'import_failed', message: e.message });
  }
});

// GET /api/settings/shopify-locations (admin) — helper to find the warehouse location ID
router.get('/shopify-locations', requireAdmin, async (req, res) => {
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) {
    return res.status(400).json({ error: 'shopify_not_configured' });
  }
  try {
    const locations = await shopify.getLocations();
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// GET /api/settings/sync-state
router.get('/sync-state', async (req, res) => {
  const { rows } = await query('SELECT * FROM sync_state ORDER BY channel');
  res.json({ state: rows });
});

module.exports = router;
