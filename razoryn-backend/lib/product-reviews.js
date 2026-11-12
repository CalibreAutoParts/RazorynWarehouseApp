// lib/product-reviews.js — our own product reviews (replaces Judge.me / SendWILL).
//
// Source of truth is the product_reviews table here (it keeps the reviewer's
// email + order link, which never leave the Hub). Published reviews are copied
// onto each Shopify product so they live in the store itself:
//   razoryn.reviews      (json)  { v, avg, count, ebay_avg, ebay_count, items:[…] } — the theme renders this
//   reviews.rating        (rating) + reviews.rating_count — website reviews AND eBay feedback combined
//                                    (the eBay part comes from services/reviews-sync.js)
// Reviews come from: the product-page form (POST /api/product-reviews, public),
// the "rate this part" links in the review-request emails (signed → verified buyer),
// and imports (Judge.me, or a CSV export from any review app).
const crypto = require('crypto');
const { query } = require('../db');
const brand = require('./brand');

const MAX_ON_PRODUCT = 50;    // newest N published reviews copied onto the product

// ── Settings ───────────────────────────────────────────────────────────────
function normaliseSettings(raw = {}) {
  return {
    autoPublishVerified: raw.autoPublishVerified === undefined ? true : !!raw.autoPublishVerified,
    ...(raw.judgemeImportedAt ? { judgemeImportedAt: String(raw.judgemeImportedAt) } : {}),
  };
}
async function getSettings() {
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  return normaliseSettings(d.productReviews);
}
async function saveSettings(patch) {
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = normaliseSettings({ ...(cur.productReviews || {}), ...(patch || {}) });
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, productReviews: next })]);
  return next;
}

let _ready = false;
async function ensureSchema() {
  if (_ready) return;
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle TEXT`);
  await query(`CREATE TABLE IF NOT EXISTS product_reviews (
    id                 SERIAL PRIMARY KEY,
    shopify_product_id TEXT,
    product_handle     TEXT,
    product_title      TEXT,
    rating             SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title              TEXT,
    body               TEXT NOT NULL,
    author_name        TEXT,
    author_email       TEXT,
    verified           BOOLEAN NOT NULL DEFAULT false,
    sale_id            INTEGER REFERENCES sales(id) ON DELETE SET NULL,
    source             TEXT NOT NULL DEFAULT 'website',
    external_id        TEXT UNIQUE,
    is_shop_review     BOOLEAN NOT NULL DEFAULT false,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')),
    reply              TEXT,
    ip                 TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    moderated_at       TIMESTAMPTZ,
    moderated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);
  await query(`CREATE INDEX IF NOT EXISTS product_reviews_product_idx ON product_reviews (shopify_product_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS product_reviews_status_idx ON product_reviews (status, created_at DESC)`);
  // eBay feedback aggregate per product, written by services/reviews-sync.js so
  // the combined star rating can be recomputed whenever a website review changes.
  await query(`CREATE TABLE IF NOT EXISTS product_rating_sources (
    shopify_product_id TEXT PRIMARY KEY,
    ebay_sum           NUMERIC NOT NULL DEFAULT 0,
    ebay_count         INTEGER NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ready = true;
}

// ── Signed "verified buyer" tokens for the review-request email links ───────
function secret() {
  return process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me';
}
function signSaleToken(saleId) {
  const sig = crypto.createHmac('sha256', secret()).update(`product-review:${saleId}`).digest('base64url').slice(0, 20);
  return `${saleId}.${sig}`;
}
function verifySaleToken(token) {
  const m = /^(\d{1,10})\.([A-Za-z0-9_-]{20})$/.exec(String(token || ''));
  if (!m) return null;
  const want = signSaleToken(m[1]).split('.')[1];
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want)) ? parseInt(m[1], 10) : null;
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────
// "barry kempton" → "Barry K." · "m h hoffman" → "M. H." · "" → "Customer"
function displayName(name) {
  const parts = String(name || '').replace(/[<>@]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  if (/^anonymous$/i.test(parts[0]) && parts.length === 1) return 'Anonymous';
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const first = parts[0].length === 1 ? parts[0].toUpperCase() + '.' : cap(parts[0]);
  if (parts.length === 1) return first.slice(0, 30);
  return `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`.slice(0, 32);
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

// Validate a public submission. Returns { ok, error?, review? }.
function validateSubmission(b = {}) {
  const rating = parseInt(b.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: 'rating_required', message: 'Please choose a star rating.' };
  const body = cleanText(b.body, 3000);
  if (body.length < 10) return { ok: false, error: 'review_too_short', message: 'Please write a few words about the part (10+ characters).' };
  const name = cleanText(b.name, 60).replace(/\n/g, ' ');
  if (!name) return { ok: false, error: 'name_required', message: 'Please add your name (we only show your first name and initial).' };
  const email = cleanText(b.email, 200).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'bad_email', message: 'That email address doesn’t look right.' };
  if (!email && !b.token) return { ok: false, error: 'email_required', message: 'Please add your email so we can check your order.' };
  const productId = String(b.productId || '').split('/').pop().replace(/\D/g, '');
  if (!productId && !b.handle) return { ok: false, error: 'product_required' };
  if (/https?:\/\/|www\./i.test(body) && (body.match(/https?:\/\/|www\./gi) || []).length > 1) {
    return { ok: false, error: 'links_not_allowed', message: 'Please leave links out of your review.' };
  }
  return { ok: true, review: {
    rating, body, name, email,
    title: cleanText(b.title, 120).replace(/\n/g, ' '),
    productId: productId || null,
    handle: cleanText(b.handle, 255) || null,
    token: b.token ? String(b.token).slice(0, 40) : null,
  } };
}

// What gets written onto the Shopify product (razoryn.reviews). Pure.
function buildProductPayload(reviews, ebay = {}) {
  const pub = reviews.filter(r => r.status === 'published')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const count = pub.length;
  const sum = pub.reduce((s, r) => s + Number(r.rating), 0);
  const ebayCount = Number(ebay.ebay_count) || 0;
  const ebaySum = Number(ebay.ebay_sum) || 0;
  const round1 = n => Math.round(n * 10) / 10;
  const day = d => new Date(d).toISOString().slice(0, 10);
  return {
    v: 1,
    avg: count ? round1(sum / count) : 0,
    count,
    ebay_avg: ebayCount ? round1(ebaySum / ebayCount) : 0,
    ebay_count: ebayCount,
    total_avg: (count + ebayCount) ? round1((sum + ebaySum) / (count + ebayCount)) : 0,
    total_count: count + ebayCount,
    updated: day(new Date()),
    items: pub.slice(0, MAX_ON_PRODUCT).map(r => ({
      id: r.id, r: Number(r.rating), t: r.title || '', b: r.body,
      n: displayName(r.author_name), d: day(r.created_at), vb: !!r.verified,
      ...(r.reply ? { reply: r.reply } : {}),
    })),
  };
}

// ── CSV / Judge.me import mapping (pure) ───────────────────────────────────
const COLS = {
  rating: ['rating', 'stars', 'score', 'star_rating', 'review_rating', 'review rating'],
  title: ['title', 'review_title', 'review title', 'headline', 'subject'],
  body: ['body', 'content', 'review', 'review_content', 'review content', 'review_body', 'review body', 'text', 'comment', 'message'],
  name: ['reviewer_name', 'reviewer name', 'author', 'name', 'customer_name', 'customer name', 'nickname', 'display_name'],
  email: ['reviewer_email', 'reviewer email', 'email', 'customer_email', 'customer email', 'author_email'],
  date: ['review_date', 'review date', 'created_at', 'created at', 'date', 'submitted_at', 'published_at', 'time'],
  handle: ['product_handle', 'product handle', 'handle'],
  productId: ['product_id', 'product id', 'shopify_product_id', 'product_external_id'],
  productUrl: ['product_url', 'product url', 'url'],
  productTitle: ['product_title', 'product title', 'product', 'product_name', 'product name'],
  verified: ['verified', 'verified_buyer', 'verified buyer', 'is_verified', 'verified_purchase'],
  reply: ['reply', 'reply_content', 'shop_reply', 'store_reply', 'merchant_reply'],
  status: ['status', 'curated', 'published', 'state'],
  id: ['id', 'review_id', 'review id', 'uuid'],
};
function pick(row, keys) {
  const lower = {};
  for (const k of Object.keys(row)) lower[k.trim().toLowerCase()] = row[k];
  for (const k of keys) if (lower[k] !== undefined && String(lower[k]).trim() !== '') return String(lower[k]).trim();
  return '';
}
function truthy(v) { return /^(1|true|yes|y|verified|published|ok)$/i.test(String(v || '').trim()); }

// One CSV/JSON row → a review to store, or { skip: reason }.
function mapImportRow(row, source = 'import:csv') {
  let rating = parseFloat(pick(row, COLS.rating));
  if (rating > 5 && rating <= 10) rating = rating / 2;          // some apps export /10
  if (rating > 10 && rating <= 100) rating = rating / 20;       // …or a percentage
  rating = Math.round(rating);
  if (!(rating >= 1 && rating <= 5)) return { skip: 'no_rating' };
  const body = cleanText(pick(row, COLS.body), 5000);
  const title = cleanText(pick(row, COLS.title), 200);
  if (!body && !title) return { skip: 'no_text' };
  const url = pick(row, COLS.productUrl);
  const handleFromUrl = (/\/products\/([^/?#]+)/.exec(url) || [])[1] || '';
  const status = pick(row, COLS.status);
  const dateRaw = pick(row, COLS.date);
  const date = dateRaw && !isNaN(new Date(dateRaw)) ? new Date(dateRaw).toISOString() : null;
  const id = pick(row, COLS.id);
  return {
    rating, title, body: body || title, date,
    name: cleanText(pick(row, COLS.name), 80),
    email: cleanText(pick(row, COLS.email), 200).toLowerCase() || null,
    handle: pick(row, COLS.handle) || decodeURIComponent(handleFromUrl) || null,
    productId: (pick(row, COLS.productId).split('/').pop() || '').replace(/\D/g, '') || null,
    productTitle: cleanText(pick(row, COLS.productTitle), 255) || null,
    verified: truthy(pick(row, COLS.verified)),
    reply: cleanText(pick(row, COLS.reply), 2000) || null,
    // Imported reviews were already live on the old app unless the export says otherwise.
    hidden: /^(hidden|unpublished|rejected|spam|false|0|no|not-yet|pending)$/i.test(status),
    externalId: id ? `${source}:${id}` : null,
  };
}

// Judge.me keeps a copy of every review in the shop metafield judgeme.reviews_grid.
function rowsFromJudgeMe(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const list = d?.all_reviews?.reviews || d?.reviews || [];
  return list.map(r => ({
    id: r.uuid, rating: r.rating, title: r.title, body: r.body, reviewer_name: r.reviewer_name,
    review_date: r.created_at, verified: r.verified_buyer ? 'true' : 'false', product_url: r.product_url,
    product_title: r.product_title, reply: r.reply_content, is_shop_review: !!r.is_shop_review,
  }));
}

// ── DB + Shopify ───────────────────────────────────────────────────────────
// Resolve a Shopify product from an id or handle via the warehouse catalogue
// (falls back to whatever the caller gave us).
async function resolveProduct({ productId, handle }) {
  if (productId) {
    const r = await query(`SELECT shopify_product_id, shopify_handle, title FROM products WHERE shopify_product_id = $1 LIMIT 1`, [String(productId)]);
    if (r.rows[0]) return { id: String(r.rows[0].shopify_product_id), handle: r.rows[0].shopify_handle || handle || null, title: r.rows[0].title };
  }
  if (handle) {
    const r = await query(`SELECT shopify_product_id, shopify_handle, title FROM products WHERE shopify_handle = $1 AND shopify_product_id IS NOT NULL LIMIT 1`, [String(handle)]);
    if (r.rows[0]) return { id: String(r.rows[0].shopify_product_id), handle: r.rows[0].shopify_handle, title: r.rows[0].title };
  }
  if (handle) {
    try {
      const p = await require('../services/shopify').findProductByHandle(handle);
      if (p) return p;
    } catch (e) { console.warn('[product-reviews] handle lookup', handle, e.message); }
  }
  return productId ? { id: String(productId), handle: handle || null, title: null } : null;
}

// Did this email (or signed order link) buy this product?
async function findPurchase({ email, saleId, productId }) {
  const params = [];
  let where;
  if (saleId) { params.push(saleId); where = `s.id = $1`; }
  else if (email) { params.push(email); where = `lower(s.customer_email) = $1`; }
  else return null;
  const r = await query(`
    SELECT s.id, s.customer_email, s.customer_name,
           bool_or(p.shopify_product_id::text = $${params.length + 1}) AS has_product
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE ${where} AND s.is_estimate = false AND s.status NOT IN ('cancelled')
     GROUP BY s.id ORDER BY s.id DESC LIMIT 20`, [...params, String(productId || '')]);
  if (!r.rows.length) return null;
  const hit = r.rows.find(x => x.has_product);
  if (hit) return { saleId: hit.id, email: hit.customer_email, name: hit.customer_name, productMatch: true };
  // A signed email link proves the order even when the line can't be matched to
  // a catalogue product (e.g. a listing created after the sale).
  if (saleId) return { saleId: r.rows[0].id, email: r.rows[0].customer_email, name: r.rows[0].customer_name, productMatch: false };
  return null;
}

async function submitReview(input, { ip } = {}) {
  await ensureSchema();
  const v = validateSubmission(input);
  if (!v.ok) return v;
  const rv = v.review;
  const product = await resolveProduct({ productId: rv.productId, handle: rv.handle });
  if (!product || !product.id) return { ok: false, error: 'product_not_found' };
  const tokenSale = rv.token ? verifySaleToken(rv.token) : null;
  const purchase = await findPurchase({ email: tokenSale ? null : rv.email, saleId: tokenSale, productId: product.id });
  const email = rv.email || purchase?.email || null;
  // One review per person per product: a second submission replaces the first
  // (it goes back through moderation unless auto-published).
  let replacedPublished = false;
  if (email) {
    const dupe = await query(`SELECT id, status FROM product_reviews WHERE shopify_product_id = $1 AND lower(author_email) = $2 AND source IN ('website','email') LIMIT 1`, [product.id, email]);
    if (dupe.rows[0]) {
      await query(`DELETE FROM product_reviews WHERE id = $1`, [dupe.rows[0].id]);
      replacedPublished = dupe.rows[0].status === 'published';
    }
  }
  const settings = await getSettings();
  const verified = !!purchase;
  const status = verified && settings.autoPublishVerified ? 'published' : 'pending';
  const ins = await query(`
    INSERT INTO product_reviews (shopify_product_id, product_handle, product_title, rating, title, body,
      author_name, author_email, verified, sale_id, source, status, ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [product.id, product.handle, product.title, rv.rating, rv.title || null, rv.body, rv.name, email,
     verified, purchase?.saleId || null, tokenSale ? 'email' : 'website', status, ip || null]);
  const id = ins.rows[0].id;
  if (status === 'published' || replacedPublished) {
    publishProduct(product.id).catch(e => console.warn('[product-reviews] publish', product.id, e.message));
  }
  if (status !== 'published') {
    try {
      await require('./notify').notifyEvent({
        type: 'product_review', title: `⭐ New ${rv.rating}★ review to check`,
        body: `${product.title || product.handle || 'Product'}: “${rv.body.slice(0, 80)}”`,
        relatedType: 'product_review', relatedId: id, audience: 'admin', url: '/#settings',
      });
    } catch (_) {}
  }
  return { ok: true, id, status, verified };
}

// Copy a product's published reviews (+ combined rating) onto the Shopify product.
async function publishProduct(shopifyProductId) {
  await ensureSchema();
  const pid = String(shopifyProductId);
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) return { skipped: 'shopify_not_configured' };
  const reviews = (await query(`SELECT * FROM product_reviews WHERE shopify_product_id = $1 AND status = 'published'`, [pid])).rows;
  const ebay = (await query(`SELECT ebay_sum, ebay_count FROM product_rating_sources WHERE shopify_product_id = $1`, [pid])).rows[0] || {};
  const payload = buildProductPayload(reviews, ebay);
  await shopify.setProductReviews(pid, payload);
  return { ok: true, count: payload.count, total: payload.total_count };
}

async function republishAll() {
  await ensureSchema();
  const r = await query(`
    SELECT DISTINCT shopify_product_id AS id FROM product_reviews WHERE shopify_product_id IS NOT NULL
    UNION SELECT shopify_product_id FROM product_rating_sources`);
  let ok = 0, failed = 0;
  for (const row of r.rows) {
    try { await publishProduct(row.id); ok++; } catch (e) { failed++; console.warn('[product-reviews] republish', row.id, e.message); }
  }
  return { products: r.rows.length, ok, failed };
}

async function moderate(id, action, { userId, reply } = {}) {
  await ensureSchema();
  const cur = (await query(`SELECT * FROM product_reviews WHERE id = $1`, [id])).rows[0];
  if (!cur) return { ok: false, error: 'not_found' };
  if (action === 'delete') {
    await query(`DELETE FROM product_reviews WHERE id = $1`, [id]);
  } else if (action === 'publish' || action === 'hide') {
    await query(`UPDATE product_reviews SET status = $2, moderated_at = now(), moderated_by = $3 WHERE id = $1`,
      [id, action === 'publish' ? 'published' : 'hidden', userId || null]);
  } else if (action === 'reply') {
    await query(`UPDATE product_reviews SET reply = $2 WHERE id = $1`, [id, cleanText(reply, 2000) || null]);
  } else return { ok: false, error: 'bad_action' };
  if (cur.shopify_product_id) await publishProduct(cur.shopify_product_id);
  return { ok: true };
}

async function list({ status = 'pending', limit = 100 } = {}) {
  await ensureSchema();
  const r = await query(`
    SELECT id, shopify_product_id, product_handle, product_title, rating, title, body, author_name, author_email,
           verified, source, status, reply, is_shop_review, created_at
      FROM product_reviews WHERE ($1 = 'all' OR status = $1)
     ORDER BY created_at DESC LIMIT $2`, [status, Math.min(500, limit)]);
  const c = await query(`SELECT status, COUNT(*)::int AS n FROM product_reviews GROUP BY status`);
  const counts = { pending: 0, published: 0, hidden: 0 };
  for (const row of c.rows) counts[row.status] = row.n;
  return { reviews: r.rows, counts };
}

// Store mapped import rows. Idempotent on external id (re-importing a file is safe).
async function importRows(rows, source) {
  await ensureSchema();
  const out = { rows: rows.length, imported: 0, updated: 0, skipped: 0, unmatched: 0, reasons: {} };
  const touched = new Set();
  for (const raw of rows) {
    const m = mapImportRow(raw, source);
    if (m.skip) { out.skipped++; out.reasons[m.skip] = (out.reasons[m.skip] || 0) + 1; continue; }
    const shop = !!raw.is_shop_review;
    const product = shop ? null : await resolveProduct({ productId: m.productId, handle: m.handle });
    if (!shop && !product) out.unmatched++;
    const ext = m.externalId || `${source}:${crypto.createHash('sha1').update([m.handle, m.productId, m.name, m.date, m.body].join('|')).digest('hex').slice(0, 20)}`;
    const r = await query(`
      INSERT INTO product_reviews (shopify_product_id, product_handle, product_title, rating, title, body, author_name,
        author_email, verified, source, external_id, is_shop_review, status, reply, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15::timestamptz, now()))
      ON CONFLICT (external_id) DO UPDATE SET
        shopify_product_id = COALESCE(EXCLUDED.shopify_product_id, product_reviews.shopify_product_id),
        product_handle = COALESCE(EXCLUDED.product_handle, product_reviews.product_handle),
        rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body, reply = EXCLUDED.reply
      RETURNING (xmax = 0) AS inserted, shopify_product_id`,
      [product?.id || null, product?.handle || m.handle, m.productTitle || product?.title || null, m.rating, m.title || null,
       m.body, m.name || null, m.email, m.verified, source, ext, shop, m.hidden ? 'hidden' : 'published', m.reply, m.date]);
    if (r.rows[0].inserted) out.imported++; else out.updated++;
    if (r.rows[0].shopify_product_id) touched.add(r.rows[0].shopify_product_id);
  }
  out.products = touched.size;
  for (const pid of touched) {
    try { await publishProduct(pid); } catch (e) { console.warn('[product-reviews] import publish', pid, e.message); }
  }
  return out;
}

async function importJudgeMe() {
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) return { error: 'shopify_not_configured' };
  const raw = await shopify.getShopMetafieldValue('judgeme', 'reviews_grid');
  if (!raw) return { error: 'judgeme_not_found', message: 'No Judge.me reviews found on the store.' };
  return importRows(rowsFromJudgeMe(raw), 'import:judgeme');
}

// Once per install (Razoryn only): copy the Judge.me reviews in, so they're kept
// even if Judge.me is uninstalled — and so the nightly eBay sync, which rewrites
// each product's reviews from this table, never drops them.
async function importJudgeMeOnce() {
  if (brand.code !== 'razoryn') return { skipped: 'brand' };
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) return { skipped: 'shopify_not_configured' };
  await ensureSchema();
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  if (d.productReviews?.judgemeImportedAt) return { skipped: 'already_imported' };
  const out = await importJudgeMe();
  if (out.error && out.error !== 'judgeme_not_found') return out;   // try again next boot
  await saveSettings({ judgemeImportedAt: new Date().toISOString() });
  console.log('[product-reviews] Judge.me import:', JSON.stringify(out));
  return out;
}

function parseCsv(text) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(String(text || ''), { type: 'string', raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return ws ? XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }) : [];
}

// Called by services/reviews-sync.js with the eBay aggregate for one product.
async function setEbaySource(shopifyProductId, sum, count) {
  await ensureSchema();
  await query(`INSERT INTO product_rating_sources (shopify_product_id, ebay_sum, ebay_count, updated_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (shopify_product_id) DO UPDATE SET ebay_sum = EXCLUDED.ebay_sum, ebay_count = EXCLUDED.ebay_count, updated_at = now()`,
    [String(shopifyProductId), sum, count]);
}

module.exports = {
  ensureSchema, getSettings, saveSettings,
  signSaleToken, verifySaleToken, displayName, validateSubmission, buildProductPayload,
  mapImportRow, rowsFromJudgeMe, parseCsv,
  submitReview, publishProduct, republishAll, moderate, list, importRows, importJudgeMe, importJudgeMeOnce, setEbaySource,
};
