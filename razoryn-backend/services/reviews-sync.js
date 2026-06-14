// services/reviews-sync.js — eBay seller feedback → Shopify review metafields.
//
// eBay feedback is the only large body of buyer sentiment this seller has, so we
// reuse it as product social-proof: pull received feedback, map each eBay ItemID
// to a warehouse product (via the mirror_links / ebay_listing_id columns), get a
// Shopify product id, aggregate sentiment into a 1–5 star rating per product, and
// write reviews.rating + reviews.rating_count metafields the theme already reads.
const { query } = require('../db');
const ebay = require('./ebay');
const shopify = require('./shopify');
const brand = require('../lib/brand');

// Map eBay ItemID -> { shopifyProductId } using the products table's per-store
// eBay listing id columns. Returns a Map(itemId -> shopify_product_id).
async function buildItemIdMap() {
  const r = await query(`
    SELECT shopify_product_id, ebay_listing_id_em, ebay_listing_id_cl
      FROM products
     WHERE shopify_product_id IS NOT NULL
       AND (ebay_listing_id_em IS NOT NULL OR ebay_listing_id_cl IS NOT NULL)`);
  const map = new Map();
  for (const row of r.rows) {
    if (row.ebay_listing_id_em) map.set(String(row.ebay_listing_id_em), row.shopify_product_id);
    if (row.ebay_listing_id_cl) map.set(String(row.ebay_listing_id_cl), row.shopify_product_id);
  }
  return map;
}

async function syncEbayReviews() {
  if (!ebay.isConfigured() || !shopify.isConfigured()) {
    return { skipped: 'not_configured', updated: 0 };
  }
  // Pull feedback across every configured store (feedback is account-level, but
  // multi-store sellers each have their own account/token).
  const stores = (typeof ebay.listStores === 'function' ? ebay.listStores() : [])
    .filter(s => s.hasToken && !s.disabled);
  const targets = stores.length ? stores.map(s => s.code) : [undefined];

  let rows = [];
  for (const code of targets) {
    try { rows = rows.concat(await ebay.getSellerFeedback(code)); }
    catch (e) { console.warn('[reviews-sync] store', code, e.message); }
  }
  if (!rows.length) return { feedback: 0, updated: 0 };

  // Aggregate per eBay ItemID → then collapse onto the Shopify product.
  const itemMap = await buildItemIdMap();
  const byProduct = {}; // shopifyProductId -> { sum, count }
  for (const { itemId, score } of rows) {
    const pid = itemMap.get(String(itemId));
    if (!pid) continue;
    byProduct[pid] = byProduct[pid] || { sum: 0, count: 0 };
    byProduct[pid].sum += score;
    byProduct[pid].count += 1;
  }

  let updated = 0, errors = 0;
  for (const pid of Object.keys(byProduct)) {
    const { sum, count } = byProduct[pid];
    const rating = Math.round((sum / count) * 10) / 10; // 1 dp
    try { await shopify.setProductRating(pid, rating, count); updated++; }
    catch (e) { errors++; console.warn('[reviews-sync] write', pid, e.message); }
  }
  console.log(`[reviews-sync] ${rows.length} feedback rows → ${updated} product(s) updated (${errors} errors)`);
  return { feedback: rows.length, matched: Object.keys(byProduct).length, updated, errors };
}

module.exports = { syncEbayReviews };
