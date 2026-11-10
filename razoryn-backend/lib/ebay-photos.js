// lib/ebay-photos.js — which photos each eBay account gets.
//
// The Thumbnail Maker sends two galleries: the website set (Shopify, the main
// logo's watermark) and an eBay set watermarked with its "eBay logo" — which is
// the SOLE-TRADER shop's own trading name/logo. So:
//   • an eBay account branded as its own shop (Settings → eBay shops →
//     listing branding "shop", the default for sole traders) gets the eBay set;
//   • company accounts (Razoryn's own) get the same photos as the website.
// The latest eBay set is kept on the product so later listings, copies and
// re-pushes on a sole-trader account can use it.
const { query } = require('../db');

let _col = false;
async function ensureColumn() {
  if (_col) return;
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS studio_ebay_images JSONB`);
  _col = true;
}

async function isShopBranded(storeCode) {
  if (!storeCode) return false;
  try { return (await require('./store-vat').getProfile(storeCode)).listingBranding === 'shop'; }
  catch (_) { return false; }
}

const clean = list => (Array.isArray(list) ? list : []).map(u => String(u || '').trim()).filter(u => /^https:\/\//i.test(u));

// The photos for ONE eBay account. studio = the Thumbnail Maker's eBay set;
// website = the Shopify set. Returns null when there's nothing suitable.
async function forStore(storeCode, { studio, website } = {}) {
  const s = clean(studio), w = clean(website);
  if (await isShopBranded(storeCode)) return s.length ? s : (w.length ? w : null);
  return w.length ? w : null;   // never the sole trader's watermark on a company account
}

async function saveStudioSet(productId, urls) {
  const u = clean(urls);
  if (!productId || !u.length) return;
  await ensureColumn();
  await query(`UPDATE products SET studio_ebay_images = $2::jsonb WHERE id = $1`, [productId, JSON.stringify(u)]);
}
async function studioSet(productId) {
  if (!productId) return [];
  await ensureColumn();
  const r = (await query(`SELECT studio_ebay_images FROM products WHERE id = $1`, [productId])).rows[0];
  return clean(r?.studio_ebay_images);
}

module.exports = { forStore, isShopBranded, saveStudioSet, studioSet, ensureColumn };
