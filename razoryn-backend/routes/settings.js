// routes/settings.js — global app settings + manual sync trigger
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const sync = require('../services/sync');

const router = express.Router();
router.use(requireAuth);

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration — adds the social-media columns to app_settings if
// they don't exist yet. Runs once on cold boot; idempotent.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureSocialColumns() {
  if (_migrationDone) return;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_instagram TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_facebook  TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_tiktok    TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_linkedin  TEXT`);
    _migrationDone = true;
  } catch (e) {
    console.warn('[settings.js] social migration warning:', e.message);
  }
}
ensureSocialColumns();

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

// POST /api/settings/reset-sync-cursor (admin)
// Rewind the sync cursor so the next sync pulls older orders.
// Body: { channel: 'shopify' | 'ebay' | 'all', days: number (default 30) }
router.post('/reset-sync-cursor', requireAdmin, async (req, res) => {
  const channel = req.body.channel || 'all';
  const days = parseInt(req.body.days || 30);
  const newCursor = new Date(Date.now() - days * 86400000);
  try {
    if (channel === 'all') {
      await query(`UPDATE sync_state SET last_synced_at = $1 WHERE channel IN ('shopify','ebay')`, [newCursor]);
    } else {
      await query(`UPDATE sync_state SET last_synced_at = $1 WHERE channel = $2`, [newCursor, channel]);
    }
    await audit(req, 'reset_sync_cursor', null, null, { channel, days });
    res.json({ ok: true, channel, since: newCursor });
  } catch (e) {
    res.status(500).json({ error: 'reset_failed', message: e.message });
  }
});

// GET /api/settings/pricing-config — current phone-pricing percentages + company details
router.get('/pricing-config', async (req, res) => {
  await ensureSocialColumns();
  const { rows } = await query(`SELECT * FROM app_settings WHERE id = 1`);
  const r = rows[0] || {};
  res.json({
    cashDiscountPct: parseFloat(r.cash_discount_pct ?? 10),
    bankTransferPct: parseFloat(r.bank_transfer_pct ?? 10),
    shopifyFreeDeliveryOver: parseFloat(r.free_delivery_threshold ?? 50),
    ebayBuyerProtectionMarkup: parseFloat(r.ebay_buyer_protection_markup ?? 0),
    vatRate: parseFloat(r.vat_rate ?? 20),
    vatRegistered: !!r.vat_registered,
    vatNumber: r.vat_number || '',
    companyAddress: r.company_address || '',
    companyPhone: r.company_phone || '',
    companyEmail: r.company_email || '',
    companyWebsite: r.company_website || '',
    companyRegNo: r.company_reg_no || '',
    bankAccountName: r.bank_account_name || '',
    bankSortCode: r.bank_sort_code || '',
    bankAccountNumber: r.bank_account_number || '',
    // Socials — accepted as handles (with or without @) for ig/tiktok,
    // or full URLs for facebook/linkedin. Invoice template handles both.
    socialInstagram: r.social_instagram || '',
    socialFacebook:  r.social_facebook  || '',
    socialTiktok:    r.social_tiktok    || '',
    socialLinkedin:  r.social_linkedin  || '',
  });
});

// POST /api/settings/pricing-config — update phone-pricing + company config
router.post('/pricing-config', requireAdmin, async (req, res) => {
  await ensureSocialColumns();
  const b = req.body || {};
  try {
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const fieldMap = {
      cashDiscountPct: 'cash_discount_pct',
      bankTransferPct: 'bank_transfer_pct',
      shopifyFreeDeliveryOver: 'free_delivery_threshold',
      ebayBuyerProtectionMarkup: 'ebay_buyer_protection_markup',
      vatRate: 'vat_rate',
      vatRegistered: 'vat_registered',
      vatNumber: 'vat_number',
      companyAddress: 'company_address',
      companyPhone: 'company_phone',
      companyEmail: 'company_email',
      companyWebsite: 'company_website',
      companyRegNo: 'company_reg_no',
      bankAccountName: 'bank_account_name',
      bankSortCode: 'bank_sort_code',
      bankAccountNumber: 'bank_account_number',
      // Socials — TEXT columns, empty string is treated as "clear"
      socialInstagram: 'social_instagram',
      socialFacebook:  'social_facebook',
      socialTiktok:    'social_tiktok',
      socialLinkedin:  'social_linkedin',
    };
    const updates = [], params = [];
    for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
      if (b[bodyKey] === undefined) continue;
      let val = b[bodyKey];
      if (['cash_discount_pct','bank_transfer_pct','free_delivery_threshold','ebay_buyer_protection_markup','vat_rate'].includes(dbCol)) {
        val = parseFloat(val);
      }
      params.push(val);
      updates.push(`${dbCol} = $${params.length}`);
    }
    if (!updates.length) return res.json({ ok: true, message: 'no_changes' });
    await query(`UPDATE app_settings SET ${updates.join(', ')}, updated_at = now() WHERE id = 1`, params);
    await audit(req, 'update_pricing_config', null, null, Object.keys(b));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'update_failed', message: e.message });
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
