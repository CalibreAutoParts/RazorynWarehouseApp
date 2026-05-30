// routes/settings.js — global app settings + manual sync trigger
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const sync = require('../services/sync');

const router = express.Router();
router.use(requireAuth);

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration — adds columns to app_settings + products that are
// referenced by this route but might not exist yet on older databases.
// Idempotent; runs once on cold boot.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureSocialColumns() {
  if (_migrationDone) return;
  try {
    // Socials on app_settings
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_instagram TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_facebook  TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_tiktok    TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS social_linkedin  TEXT`);
    // Reviews + phone-prefix settings (also touched by routes/messages.js migration)
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS trustpilot_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_review_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_platform TEXT DEFAULT 'trustpilot'`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_country_code TEXT DEFAULT '44'`);
    // Shopify product handle on products
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle TEXT`);
    // eBay listing defaults — used by the Shopify→eBay listing creator. These
    // are the values pre-filled into the "Create eBay listing" modal so the user
    // doesn't have to type them every time. Per-store columns let multi-store
    // brands (Calibre) have different defaults per eBay account.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_default_category_id TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_description_template TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_markup_pct NUMERIC`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_default_condition_id TEXT DEFAULT '1000'`);
    // Default eBay "Brand" item specific. For aftermarket parts this should be
    // the seller's company name or "Unbranded" — NOT the vehicle make (which
    // belongs in the "Make" specific). Overridable per-listing.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_default_brand TEXT DEFAULT 'Unbranded'`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_location_country TEXT DEFAULT 'GB'`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_location_postcode TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_location_city TEXT`);
    // Business policy IDs — brand-wide fallback (used if no per-store override).
    // For per-store overrides we add columns dynamically below based on the stores.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_payment TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_shipping TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_return TEXT`);
    // Logo — uploaded image stored as base64 data URL. Used on invoices + the
    // app's top-bar logo (overrides the static /logo.png fallback). Storing
    // inline avoids needing a file-host; size is capped client-side at ~500KB.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logo_data_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logo_filename TEXT`);
    // Separate dark-mode logo so a navy/dark wordmark can have a light variant
    // that stays visible on the dark top bar.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logo_dark_data_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logo_dark_filename TEXT`);
    // Stock-check reminder — fires once per month on the configured day of
    // month. Day stored 1-31; empty/null = disabled. The actual "did the user
    // dismiss it this month" tracking lives in localStorage per-device.
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS stock_check_day INTEGER`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS stock_check_enabled BOOLEAN DEFAULT false`);
    // Per-store policy overrides — created lazily on read/write. The brand
    // service exposes brand.stores so we can pre-create columns for every store.
    try {
      const brand = require('../lib/brand');
      for (const s of brand.stores || []) {
        await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_${s.code}_payment TEXT`).catch(()=>{});
        await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_${s.code}_shipping TEXT`).catch(()=>{});
        await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ebay_policy_${s.code}_return TEXT`).catch(()=>{});
      }
    } catch (e) { /* brand module may not be ready */ }
    _migrationDone = true;
  } catch (e) {
    console.warn('[settings.js] migration warning:', e.message);
  }
}
ensureSocialColumns();

// GET /api/settings
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM app_settings WHERE id = 1');
  res.json({ settings: rows[0] || {} });
});

// ──────────────────────────────────────────────────────────────────────────
// Notification sound preferences — synced across ALL devices.
//
// Stored in app_settings.data->'soundPrefs' (JSONB) so every workstation and
// phone shares the same configuration. Replaces the old per-device localStorage
// approach. Structure (one entry per event category):
//   {
//     "sale":          { "choice": "custom", "customDataUrl": "data:audio/mp3;base64,…", "customName": "register.mp3" },
//     "return":        { "choice": "chime" },
//     "return_closed": { "choice": "pop" },
//     "low_stock":     { "choice": "bell" }
//   }
// Each event can have its OWN custom uploaded sound (customDataUrl), unlike the
// old single shared upload.
//
// GET is available to any authenticated user (sounds must play for warehouse
// staff too). PUT is admin-only (configuration is a management action).
// ──────────────────────────────────────────────────────────────────────────
router.get('/sound-prefs', async (req, res) => {
  const { rows } = await query(`SELECT data FROM app_settings WHERE id = 1`);
  const prefs = (rows[0]?.data && rows[0].data.soundPrefs) || {};
  res.json({ soundPrefs: prefs });
});

router.put('/sound-prefs', requireAdmin, async (req, res) => {
  const incoming = req.body?.soundPrefs;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'soundPrefs object required' });
  }
  // Validate + size-guard each event. A custom data URL must be a base64 audio
  // data URL under ~1.2MB decoded (so the whole soundPrefs blob stays well
  // within reasonable JSONB row limits even with 4 custom sounds).
  const ALLOWED_CHOICES = new Set(['chaching', 'bell', 'chime', 'ding', 'pop', 'custom', 'none']);
  const MAX_DECODED = 1_200_000;
  const clean = {};
  for (const [key, val] of Object.entries(incoming)) {
    if (!val || typeof val !== 'object') continue;
    const choice = String(val.choice || '');
    if (!ALLOWED_CHOICES.has(choice)) continue;
    const entry = { choice };
    if (choice === 'custom') {
      const dataUrl = val.customDataUrl;
      if (typeof dataUrl !== 'string' || !/^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
        return res.status(400).json({ error: 'invalid_audio', message: `"${key}" is set to Custom but has no valid audio data.` });
      }
      const base64 = dataUrl.split(',')[1] || '';
      if (Math.ceil(base64.length * 0.75) > MAX_DECODED) {
        return res.status(413).json({ error: 'audio_too_large', message: `Custom sound for "${key}" is too large — keep each under ~1 MB.` });
      }
      entry.customDataUrl = dataUrl;
      entry.customName = String(val.customName || 'custom.audio').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
    }
    clean[key] = entry;
  }
  // Merge into the existing data JSONB without clobbering other keys.
  const cur = await query(`SELECT data FROM app_settings WHERE id = 1`);
  const data = cur.rows[0]?.data || {};
  data.soundPrefs = clean;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify(data)]);
  await audit(req, 'update_sound_prefs', null, null, { events: Object.keys(clean) });
  res.json({ ok: true, soundPrefs: clean });
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
    // Reviews — used by feedback request templates and the invoice footer
    trustpilotUrl:   r.trustpilot_url || '',
    googleReviewUrl: r.google_review_url || '',
    reviewPlatform:  r.review_platform || 'trustpilot',  // 'trustpilot' | 'google' | 'both'
    // Phone normalisation default — UK as default but configurable for non-UK
    defaultCountryCode: r.default_country_code || '44',
    // eBay listing defaults — used by the Shopify→eBay create-listing flow.
    // Defaults the modal pre-fills so users don't have to type them every time.
    ebayDefaultCategoryId:  r.ebay_default_category_id || '',
    ebayDescriptionTemplate: r.ebay_description_template || '',
    ebayMarkupPct: r.ebay_markup_pct != null ? parseFloat(r.ebay_markup_pct) : 15,
    ebayDefaultBrand:       r.ebay_default_brand || 'Unbranded',
    ebayDefaultConditionId: r.ebay_default_condition_id || '1000',
    ebayLocationCountry:    r.ebay_location_country || 'GB',
    ebayLocationPostcode:   r.ebay_location_postcode || '',
    ebayLocationCity:       r.ebay_location_city || '',
    ebayPolicyPayment:      r.ebay_policy_payment || '',
    ebayPolicyShipping:     r.ebay_policy_shipping || '',
    ebayPolicyReturn:       r.ebay_policy_return || '',
    // Logo — uploaded image data URL (base64). Front-end overrides
    // brand.logoUrl with this when present. Empty string when no upload.
    logoDataUrl:      r.logo_data_url || '',
    logoFilename:     r.logo_filename || '',
    logoDarkDataUrl:  r.logo_dark_data_url || '',
    logoDarkFilename: r.logo_dark_filename || '',
    // Stock-check reminder — fires once per month on this day of month.
    // Disabled when stock_check_enabled is false OR day is null.
    stockCheckDay:     r.stock_check_day || null,
    stockCheckEnabled: !!r.stock_check_enabled,
    // Per-store policy overrides (multi-store brands only).
    // Shape: { storeCode: { payment, shipping, return } }
    ebayPerStorePolicies:   (() => {
      const out = {};
      try {
        const brand = require('../lib/brand');
        for (const s of brand.stores || []) {
          out[s.code] = {
            payment:  r[`ebay_policy_${s.code}_payment`]  || '',
            shipping: r[`ebay_policy_${s.code}_shipping`] || '',
            return:   r[`ebay_policy_${s.code}_return`]   || '',
          };
        }
      } catch (e) {}
      return out;
    })(),
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
      // Reviews
      trustpilotUrl:      'trustpilot_url',
      googleReviewUrl:    'google_review_url',
      reviewPlatform:     'review_platform',
      defaultCountryCode: 'default_country_code',
      // eBay listing defaults
      ebayDefaultCategoryId:  'ebay_default_category_id',
      ebayDescriptionTemplate: 'ebay_description_template',
      ebayMarkupPct: 'ebay_markup_pct',
      ebayDefaultBrand:       'ebay_default_brand',
      ebayDefaultConditionId: 'ebay_default_condition_id',
      ebayLocationCountry:    'ebay_location_country',
      ebayLocationPostcode:   'ebay_location_postcode',
      ebayLocationCity:       'ebay_location_city',
      ebayPolicyPayment:      'ebay_policy_payment',
      ebayPolicyShipping:     'ebay_policy_shipping',
      ebayPolicyReturn:       'ebay_policy_return',
      // Stock-check reminder
      stockCheckDay:          'stock_check_day',
      stockCheckEnabled:      'stock_check_enabled',
    };
    const updates = [], params = [];
    for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
      if (b[bodyKey] === undefined) continue;
      let val = b[bodyKey];
      if (['cash_discount_pct','bank_transfer_pct','free_delivery_threshold','ebay_buyer_protection_markup','vat_rate','ebay_markup_pct'].includes(dbCol)) {
        val = parseFloat(val);
      }
      // Stock-check day → INTEGER (or null if empty). Day stored 1-31.
      if (dbCol === 'stock_check_day') {
        const n = parseInt(val);
        val = (Number.isFinite(n) && n >= 1 && n <= 31) ? n : null;
      }
      // Stock-check enabled → BOOLEAN
      if (dbCol === 'stock_check_enabled') {
        val = (val === true || val === 'true' || val === 1 || val === '1');
      }
      params.push(val);
      updates.push(`${dbCol} = $${params.length}`);
    }
    // Per-store policy overrides — shape: { storeCode: { payment, shipping, return } }
    // Sent under body.ebayPerStorePolicies. Column names are ebay_policy_{store}_{kind}
    // and the migration block has already ensured they exist for every known store.
    if (b.ebayPerStorePolicies && typeof b.ebayPerStorePolicies === 'object') {
      for (const [storeCode, ids] of Object.entries(b.ebayPerStorePolicies)) {
        if (!/^[a-z0-9_]+$/.test(storeCode)) continue;  // defence: only safe-char store codes
        for (const kind of ['payment', 'shipping', 'return']) {
          if (ids[kind] === undefined) continue;
          params.push(ids[kind]);
          updates.push(`ebay_policy_${storeCode}_${kind} = $${params.length}`);
        }
      }
    }
    if (!updates.length) return res.json({ ok: true, message: 'no_changes' });
    await query(`UPDATE app_settings SET ${updates.join(', ')}, updated_at = now() WHERE id = 1`, params);
    await audit(req, 'update_pricing_config', null, null, Object.keys(b));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'update_failed', message: e.message });
  }
});

// POST /api/settings/barcode-sku-sync (admin) — set every Shopify variant's
// barcode = its SKU. Body { dryRun: true } previews the change without writing;
// { dryRun: false } performs the push. Follow a real push with import-shopify to
// pull the new barcodes back into the warehouse.
router.post('/barcode-sku-sync', requireAdmin, async (req, res) => {
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });
  const dryRun = req.body?.dryRun !== false;  // default to dry-run for safety
  try {
    const result = await shopify.bulkSetBarcodeToSku({ dryRun });
    if (!dryRun) await audit(req, 'barcode_sku_push', 'shopify', null, { updated: result.updated, errors: result.errorCount });
    res.json(result);
  } catch (e) {
    console.error('[barcode-sku-sync] failed:', e.message);
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// POST /api/settings/import-shopify (admin) — pull all products from Shopify into the warehouse DB.
// Upsert by shopify_variant_id (so re-running it is safe and updates titles/prices/images).
router.post('/import-shopify', requireAdmin, async (req, res) => {
  await ensureSocialColumns();  // makes sure shopify_handle column exists
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
          // Existing row — also refresh shopify_handle. The handle is what
          // Quote Builder uses for direct-link `/products/{handle}` URLs.
          await query(`
            UPDATE products SET
              shopify_product_id = $1, shopify_variant_id = $2, shopify_inventory_id = $3,
              shopify_handle = $4,
              title = $5, brand = COALESCE($6, brand), model = COALESCE($7, model),
              barcode = COALESCE($8, barcode),
              price_shopify = $9, image_url = COALESCE($10, image_url),
              qty_on_hand = $11, updated_at = now()
            WHERE id = $12`,
            [v.shopify_product_id, v.shopify_variant_id, v.shopify_inventory_id,
             v.shopify_handle || null,
             v.title, v.brand, v.model, v.barcode,
             v.price_shopify, v.image_url, v.qty_on_hand, existing.rows[0].id]
          );
          updated++;
        } else {
          await query(`
            INSERT INTO products
              (sku, title, brand, model, barcode, price_shopify, image_url,
               qty_on_hand, shopify_product_id, shopify_variant_id, shopify_inventory_id,
               shopify_handle)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [v.sku, v.title, v.brand, v.model, v.barcode,
             v.price_shopify, v.image_url, v.qty_on_hand,
             v.shopify_product_id, v.shopify_variant_id, v.shopify_inventory_id,
             v.shopify_handle || null]
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

// ──────────────────────────────────────────────────────────────────────────
// Logo upload + delete + serve.
// POST /api/settings/logo with { dataUrl, filename } — stores as base64 data
//   URL in app_settings.logo_data_url. Validates content-type and decoded
//   size (max ~500KB to keep invoice HTML payloads reasonable).
// DELETE /api/settings/logo — clears the stored logo (falls back to brand default).
// GET /api/settings/logo — serves the binary with proper content-type so
//   <img src="/api/settings/logo"> works in static contexts (browser tab favicon
//   isn't covered — for that, use logoDataUrl from /pricing-config and inject).
// ──────────────────────────────────────────────────────────────────────────
router.post('/logo', requireAdmin, async (req, res) => {
  await ensureSocialColumns();
  const { dataUrl, filename } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'dataUrl required' });
  // Validate it's a data URL with an image content type
  const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'invalid_data_url', message: 'Logo must be a base64-encoded image data URL (PNG, JPEG, GIF, WEBP, or SVG).' });
  // Decoded size cap: 500KB. Base64 inflates ~33%, so the data URL string is up
  // to ~700KB — still safe to inline in every invoice HTML.
  const base64Len = m[2].length;
  const decodedSize = Math.ceil(base64Len * 0.75);
  if (decodedSize > 500_000) {
    return res.status(413).json({ error: 'too_large', message: `Logo is ~${(decodedSize/1024).toFixed(0)} KB — please use an image under 500 KB. Consider resizing or compressing.` });
  }
  const safeFilename = (filename || 'logo.png').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  const dark = req.body?.variant === 'dark';
  const dataCol = dark ? 'logo_dark_data_url' : 'logo_data_url';
  const nameCol = dark ? 'logo_dark_filename' : 'logo_filename';
  await query(`UPDATE app_settings SET ${dataCol} = $1, ${nameCol} = $2 WHERE id = 1`, [dataUrl, safeFilename]);
  await audit(req, 'upload_logo', null, null, { variant: dark ? 'dark' : 'light', filename: safeFilename, sizeKb: Math.round(decodedSize/1024) });
  res.json({ ok: true, variant: dark ? 'dark' : 'light', filename: safeFilename, sizeKb: Math.round(decodedSize/1024) });
});

router.delete('/logo', requireAdmin, async (req, res) => {
  const dark = req.query?.variant === 'dark';
  const dataCol = dark ? 'logo_dark_data_url' : 'logo_data_url';
  const nameCol = dark ? 'logo_dark_filename' : 'logo_filename';
  await query(`UPDATE app_settings SET ${dataCol} = NULL, ${nameCol} = NULL WHERE id = 1`);
  await audit(req, 'delete_logo', null, null, { variant: dark ? 'dark' : 'light' });
  res.json({ ok: true });
});

// Unauthenticated logo serving (so <img> tags work without auth in invoice
// HTML). Mounted at /public-logo in server.js (separate path from the
// auth-protected /api/settings namespace). Returns 404 when no logo is
// uploaded — the front-end then falls back to the brand's static /logo.png
// file in public/.
const publicLogoRouter = express.Router();
async function serveLogo(col, res) {
  try {
    const { rows } = await query(`SELECT ${col} AS d FROM app_settings WHERE id = 1`);
    const dataUrl = rows[0]?.d;
    if (!dataUrl) return res.status(404).end();
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(500).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=300');  // short cache so updates show quickly
    res.end(Buffer.from(m[2], 'base64'));
  } catch (e) {
    res.status(500).end();
  }
}
publicLogoRouter.get('/public-logo', (req, res) => serveLogo('logo_data_url', res));
publicLogoRouter.get('/public-logo-dark', (req, res) => serveLogo('logo_dark_data_url', res));
module.exports = router;
module.exports.publicLogoRouter = publicLogoRouter;
