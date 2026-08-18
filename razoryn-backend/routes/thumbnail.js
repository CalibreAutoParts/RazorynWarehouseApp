// routes/thumbnail.js — integration surface for the Thumbnail Maker app
// (github.com/calibreautoparts/thumbnail_maker). The thumbnail app looks up
// SKUs here, pulls a product's current Shopify photos as processing inputs,
// and pushes finished ordered image sets back — we host them on Shopify (the
// de-facto image CDN) and re-point the linked eBay listing(s) at the result.
//
// Auth mirrors routes/dropfleet.js: every machine endpoint requires the
// X-Integration-Key header, checked against THUMBNAIL_INTEGRATION_KEY (env)
// or app_settings.thumbnail_integration_key. The key is a secret — the admin
// config endpoint reports only whether it is set + its last 4 chars.
// Mounted BEFORE requireAuth in server.js; the two /config endpoints carry
// their own requireAdmin guard.

const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const shopify = require('../services/shopify');

const router = express.Router();

// Constant-time string comparison (hash both sides so unequal lengths don't
// throw or leak).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Self-healing migration (convention: routes own their columns/tables).
let _migrated = false;
async function ensureThumbnailSchema() {
  if (_migrated) return;
  await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS thumbnail_integration_key TEXT`);
  await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS thumbnail_app_url TEXT`);
  await query(`CREATE TABLE IF NOT EXISTS thumbnail_pushes (
    id              SERIAL PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    product_id      INTEGER,
    response        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _migrated = true;
}

// Base URL of the Thumbnail Maker deployment (for importing studio photos
// into listings). Same convention as the key: env wins, settings fallback.
async function getThumbnailAppUrl() {
  await ensureThumbnailSchema();
  const envUrl = (process.env.THUMBNAIL_APP_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/$/, '');
  const r = await query(`SELECT thumbnail_app_url FROM app_settings LIMIT 1`);
  return (r.rows[0]?.thumbnail_app_url || '').trim().replace(/\/$/, '');
}

// Call the thumbnail app's inbound integration API with the shared key.
async function studioFetch(path, { method = 'GET' } = {}) {
  const [appUrl, key] = await Promise.all([getThumbnailAppUrl(), getIntegrationKey()]);
  if (!appUrl || !key) {
    const err = new Error('studio_not_configured');
    err.status = 400;
    throw err;
  }
  const res = await fetch(`${appUrl}/api/integration/warehouse${path}`, {
    method,
    headers: { 'X-Integration-Key': key },
  });
  return res;
}

async function getIntegrationKey() {
  await ensureThumbnailSchema();
  const envKey = (process.env.THUMBNAIL_INTEGRATION_KEY || '').trim();
  if (envKey) return envKey;
  const r = await query(`SELECT thumbnail_integration_key FROM app_settings LIMIT 1`);
  return (r.rows[0]?.thumbnail_integration_key || '').trim();
}

async function requireIntegrationKey(req, res, next) {
  try {
    const expected = await getIntegrationKey();
    const provided = String(req.get('X-Integration-Key') || '').trim();
    if (!expected || !provided || !safeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'server_error', message: e.message });
  }
}

// ── Admin config (browser, session-guarded) ────────────────────────────────

router.get('/config', requireAuth, requireAdmin, async (req, res) => {
  await ensureThumbnailSchema();
  const r = await query(`SELECT thumbnail_integration_key FROM app_settings LIMIT 1`);
  const stored = (r.rows[0]?.thumbnail_integration_key || '').trim();
  const envSet = !!(process.env.THUMBNAIL_INTEGRATION_KEY || '').trim();
  const active = envSet ? (process.env.THUMBNAIL_INTEGRATION_KEY || '').trim() : stored;
  const appUrl = await getThumbnailAppUrl();
  res.json({
    keySet: !!active,
    keyLast4: active ? active.slice(-4) : null,
    source: envSet ? 'env' : (stored ? 'settings' : null),
    appUrl: appUrl || null,
    appUrlSource: (process.env.THUMBNAIL_APP_URL || '').trim() ? 'env' : (appUrl ? 'settings' : null),
  });
});

router.post('/config', requireAuth, requireAdmin, async (req, res) => {
  await ensureThumbnailSchema();
  // Only touch the key when the field is present — omitting it keeps the
  // stored key (the settings form leaves it blank to mean "no change").
  const apiKey = (req.body && 'apiKey' in req.body) ? String(req.body.apiKey || '').trim() : null;
  if (req.body && 'apiKey' in req.body) {
    await query(`UPDATE app_settings SET thumbnail_integration_key = $1`, [apiKey || null]);
  }
  if (req.body && 'appUrl' in req.body) {
    const appUrl = String(req.body.appUrl || '').trim().replace(/\/$/, '');
    if (appUrl && !/^https?:\/\//i.test(appUrl)) {
      return res.status(400).json({ error: 'invalid_app_url' });
    }
    await query(`UPDATE app_settings SET thumbnail_app_url = $1`, [appUrl || null]);
  }
  await audit(req, 'thumbnail.config', 'settings', null, { keySet: !!apiKey });
  res.json({ ok: true, keySet: !!apiKey });
});

// ── Studio photo import (browser, session-guarded) ─────────────────────────
// While creating/editing a listing, find finished photo sets in the thumbnail
// app by part number (or title search) and pull their public image URLs
// straight into the listing's photo list.

// Round-trip check: proves the app URL is reachable AND the shared key is
// accepted by the studio's inbound integration.
router.get('/studio/test', requireAuth, async (req, res) => {
  try {
    const r = await studioFetch('/health');
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) {
      return res.json({ ok: false, message: 'Studio reachable but the key was rejected — it must equal the studio\'s warehouse integration key.' });
    }
    if (!r.ok) {
      return res.json({ ok: false, message: `Studio responded HTTP ${r.status} — check the app URL points at the thumbnail app.` });
    }
    res.json({ ok: true, service: body.service || 'thumbnail' });
  } catch (e) {
    if (e.status === 400) {
      return res.json({ ok: false, message: 'Not configured — set the Thumbnail app URL (and key) first.' });
    }
    res.json({ ok: false, message: `Could not reach the studio: ${e.message}` });
  }
});

router.get('/studio/match', requireAuth, async (req, res) => {
  try {
    const partNumber = String(req.query.partNumber || '').trim();
    const q = String(req.query.q || '').trim();
    if (!partNumber && !q) return res.json({ photoSets: [], configured: true });
    const params = new URLSearchParams();
    if (partNumber) params.set('part_number', partNumber);
    if (q) params.set('q', q);
    const r = await studioFetch(`/photo-sets?${params.toString()}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return res.status(502).json({ error: 'studio_error', message: body.detail?.error || `HTTP ${r.status}` });
    }
    const body = await r.json();
    res.json({ configured: true, photoSets: body.photo_sets || [] });
  } catch (e) {
    if (e.status === 400) return res.json({ configured: false, photoSets: [] });
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

router.get('/studio/sets/:id/thumb', requireAuth, async (req, res) => {
  try {
    const r = await studioFetch(`/photo-sets/${parseInt(req.params.id, 10)}/thumb`);
    if (!r.ok) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(e.status === 400 ? 400 : 500).end();
  }
});

router.post('/studio/sets/:id/image-urls', requireAuth, async (req, res) => {
  try {
    const r = await studioFetch(`/photo-sets/${parseInt(req.params.id, 10)}/image-urls`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({
        error: 'studio_error',
        message: body.detail?.message || body.detail?.error || `HTTP ${r.status}`,
      });
    }
    await audit(req, 'thumbnail.studio.import', 'photo_set', req.params.id, { images: (body.images || []).length });
    res.json({ images: body.images || [], sku: body.sku || null });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: 'studio_not_configured', message: 'Set the Thumbnail app URL and key in Settings → Thumbnail integration.' });
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// Everything below is machine-to-machine.
router.use(requireIntegrationKey);

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'warehouse-thumbnail-integration' });
});

// ── Product lookup ─────────────────────────────────────────────────────────
// GET /api/thumbnail/products?sku=&partNumber=&q=&limit=
// sku: exact (case-insensitive). partNumber: matches part_number or any
// alternate code. q: fuzzy on sku/title/part_number.

router.get('/products', async (req, res) => {
  const sku = String(req.query.sku || '').trim();
  const partNumber = String(req.query.partNumber || '').trim();
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  let rows = [];
  const COLS = ['id', 'sku', 'title', 'brand', 'model', 'part_number', 'position',
    'barcode', 'image_url', 'shopify_product_id', 'stock_group_id', 'qty_on_hand', 'active'];
  const cols = COLS.join(', ');
  const colsP = COLS.map(c => `p.${c}`).join(', ');
  if (sku) {
    rows = (await query(
      `SELECT ${cols} FROM products WHERE upper(sku) = upper($1) LIMIT 1`, [sku]
    )).rows;
  } else if (partNumber) {
    const norm = partNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
    rows = (await query(
      `SELECT DISTINCT ${colsP} FROM products p
       LEFT JOIN product_part_numbers ppn ON ppn.product_id = p.id
       WHERE regexp_replace(upper(p.part_number), '[^A-Z0-9]', '', 'g') = $1
          OR regexp_replace(upper(ppn.code), '[^A-Z0-9]', '', 'g') = $1
       LIMIT $2`, [norm, limit]
    )).rows;
  } else if (q) {
    rows = (await query(
      `SELECT ${cols} FROM products
       WHERE sku ILIKE $1 OR title ILIKE $1 OR part_number ILIKE $1
       ORDER BY active DESC, updated_at DESC LIMIT $2`, [`%${q}%`, limit]
    )).rows;
  } else {
    return res.status(400).json({ error: 'query_required', message: 'Pass sku, partNumber or q.' });
  }

  const products = [];
  for (const p of rows) {
    const alts = (await query(
      `SELECT code, note FROM product_part_numbers WHERE product_id = $1 ORDER BY id`, [p.id]
    )).rows;
    let siblings = [];
    if (p.stock_group_id) {
      siblings = (await query(
        `SELECT sku, title FROM products WHERE stock_group_id = $1 AND id <> $2 ORDER BY sku`,
        [p.stock_group_id, p.id]
      )).rows;
    }
    products.push({
      id: p.id,
      sku: p.sku,
      title: p.title,
      brand: p.brand,
      model: p.model,
      part_number: p.part_number,
      position: p.position,
      barcode: p.barcode,
      image_url: p.image_url,
      shopify_product_id: p.shopify_product_id,
      qty_on_hand: p.qty_on_hand,
      active: p.active,
      partNumbers: alts,
      stockGroupSiblings: siblings,
    });
  }
  res.json({ products });
});

// ── Current listing images (inputs for the thumbnail app) ──────────────────
// GET /api/thumbnail/products/:sku/images → ordered public Shopify CDN URLs.

router.get('/products/:sku/images', async (req, res) => {
  const pr = await query(
    `SELECT id, sku, image_url, shopify_product_id FROM products WHERE upper(sku) = upper($1)`,
    [String(req.params.sku || '').trim()]
  );
  const product = pr.rows[0];
  if (!product) return res.status(404).json({ error: 'not_found' });
  let images = product.image_url ? [product.image_url] : [];
  if (product.shopify_product_id && shopify.isConfigured()) {
    try {
      const sp = await shopify.getShopifyProductFull(product.shopify_product_id);
      if (sp.imageUrls?.length) images = sp.imageUrls;
    } catch (e) { /* fall back to the stored primary image */ }
  }
  res.json({ sku: product.sku, images });
});

// ── Push finished image sets ───────────────────────────────────────────────
// POST /api/thumbnail/products/:sku/images
//   { images: ["https://<thumb-app>/public/r/<token>", ...],  // ordered, hero first
//     pushEbay: true, idempotencyKey: "tnm-..." }
// Replaces the product's Shopify images (order preserved, first = hero) and,
// when pushEbay, re-points every linked eBay listing at the new CDN URLs.

const EBAY_REVISE_IMAGE_CAP = 24; // eBay ReviseItem picture cap

router.post('/products/:sku/images', async (req, res) => {
  await ensureThumbnailSchema();
  const skuParam = String(req.params.sku || '').trim();
  const body = req.body || {};
  const images = Array.isArray(body.images)
    ? body.images.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const pushEbay = body.pushEbay !== false;
  const idempotencyKey = String(body.idempotencyKey || '').trim();

  if (!images.length) return res.status(400).json({ error: 'images_required' });
  if (images.some(u => !/^https:\/\//i.test(u))) {
    return res.status(400).json({ error: 'https_urls_only' });
  }
  if (!shopify.isConfigured()) return res.status(400).json({ error: 'shopify_not_configured' });

  // Replay protection, claimed ATOMICALLY before any Shopify/eBay write so a
  // concurrent duplicate can't double-apply: first request inserts the key
  // (response NULL = in flight), duplicates either replay the stored response
  // or get 409 while the original is still running. Failure paths release the
  // claim so a genuine retry can proceed.
  let claimed = false;
  const releaseClaim = async () => {
    if (!claimed) return;
    claimed = false;
    try {
      await query(
        `DELETE FROM thumbnail_pushes WHERE idempotency_key = $1 AND response IS NULL`,
        [idempotencyKey]
      );
    } catch (e) { /* best-effort */ }
  };
  if (idempotencyKey) {
    const claim = await query(
      `INSERT INTO thumbnail_pushes (idempotency_key) VALUES ($1)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [idempotencyKey]
    );
    if (claim.rows.length) {
      claimed = true;
    } else {
      const prev = await query(
        `SELECT response FROM thumbnail_pushes WHERE idempotency_key = $1`, [idempotencyKey]
      );
      const stored = prev.rows[0]?.response;
      if (stored) return res.json({ ...stored, replayed: true });
      return res.status(409).json({ error: 'push_in_progress' });
    }
  }

  try {
  const pr = await query(
    `SELECT id, sku, shopify_product_id FROM products WHERE upper(sku) = upper($1)`, [skuParam]
  );
  const product = pr.rows[0];
  if (!product) { await releaseClaim(); return res.status(404).json({ error: 'not_found' }); }
  if (!product.shopify_product_id) {
    await releaseClaim();
    return res.status(400).json({ error: 'no_shopify_product', message: 'Product is not linked to Shopify.' });
  }

  // 1) Shopify: replace the image set in order (first = hero). Shopify fetches
  //    the URLs itself, so bodies stay small.
  let cdnUrls;
  try {
    cdnUrls = await shopify.replaceProductImagesOrdered(product.shopify_product_id, images);
  } catch (e) {
    await releaseClaim();
    return res.status(502).json({ error: 'shopify_error', message: e.message });
  }
  if (!cdnUrls.length) {
    await releaseClaim();
    return res.status(502).json({ error: 'shopify_no_images', message: 'Shopify accepted no images.' });
  }
  await query(`UPDATE products SET image_url = $1, updated_at = now() WHERE id = $2`,
    [cdnUrls[0], product.id]);

  // 2) eBay: revise pictures on every linked listing (same guts as
  //    /api/listings/repush-ebay-images).
  const ebayResult = { pushed: 0, errors: [], truncated: false, skipped: !pushEbay };
  if (pushEbay) {
    let ebayUrls = cdnUrls;
    if (ebayUrls.length > EBAY_REVISE_IMAGE_CAP) {
      ebayUrls = ebayUrls.slice(0, EBAY_REVISE_IMAGE_CAP);
      ebayResult.truncated = true;
    }
    try {
      const links = await query(
        `SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`,
        [product.shopify_product_id]
      );
      if (!links.rows.length) {
        ebayResult.errors.push('no_ebay_link');
      } else {
        const ebay = require('../services/ebay');
        const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
        for (const link of links.rows) {
          const store = stores.find(s => s.code === link.store_code)
            || (link.store_code ? null : (stores.find(s => s.primary) || stores[0]));
          if (!store) { ebayResult.errors.push(`${link.ebay_item_id}: store unavailable`); continue; }
          try {
            await ebay.reviseItem(link.ebay_item_id, { pictureUrls: ebayUrls }, store.code);
            ebayResult.pushed++;
          } catch (e) {
            ebayResult.errors.push(`${link.ebay_item_id}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      ebayResult.errors.push(e.message);
    }
  }

  const response = {
    ok: true,
    sku: product.sku,
    shopifyImages: cdnUrls,
    ebay: ebayResult,
  };
  if (idempotencyKey && claimed) {
    await query(
      `UPDATE thumbnail_pushes SET product_id = $2, response = $3 WHERE idempotency_key = $1`,
      [idempotencyKey, product.id, JSON.stringify(response)]
    );
  }
  await audit(req, 'thumbnail.images.replace', 'product', product.id, {
    sku: product.sku, images: images.length, ebayPushed: ebayResult.pushed,
  });
  res.json(response);
  } catch (e) {
    // Never strand an in-flight idempotency claim — a retry must be able to run.
    await releaseClaim();
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

module.exports = router;
