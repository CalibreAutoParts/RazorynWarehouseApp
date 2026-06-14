// Scheduled job: eBay feedback → Shopify product review metafields.
// Writes reviews.rating (rating type) + reviews.rating_count (integer) so the
// theme's stars + aggregateRating schema light up automatically (snippets/
// stars.liquid reads exactly these). Run: `npm run sync:ebay` (cron it nightly).
//
// eBay feedback is seller-level and approximate per item — treat these as
// "verified eBay buyer" signals, and override individual products manually in
// admin where you have better data.

import { unauthenticated } from "../shopify.server"; // from the Remix template
import { fetchSellerFeedback, aggregateBySku } from "../lib/ebay.server";

const SHOP = process.env.SHOP_DOMAIN || "rc1bje-4u.myshopify.com";

async function findProductIdBySku(admin, sku) {
  const res = await admin.graphql(
    `#graphql
    query BySku($q: String!) {
      productVariants(first: 1, query: $q) { nodes { product { id } } }
    }`,
    { variables: { q: `sku:${sku}` } },
  );
  const body = await res.json();
  return body.data?.productVariants?.nodes?.[0]?.product?.id || null;
}

async function writeRating(admin, productId, rating, count) {
  const res = await admin.graphql(
    `#graphql
    mutation SetReviews($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: "reviews",
            key: "rating",
            type: "rating",
            value: JSON.stringify({
              value: String(rating),
              scale_min: "1.0",
              scale_max: "5.0",
            }),
          },
          {
            ownerId: productId,
            namespace: "reviews",
            key: "rating_count",
            type: "number_integer",
            value: String(count),
          },
        ],
      },
    },
  );
  const body = await res.json();
  const errs = body.data?.metafieldsSet?.userErrors || [];
  if (errs.length) console.error(`[sync] ${productId}`, errs);
}

export async function syncEbayReviews() {
  const rows = await fetchSellerFeedback();
  if (!rows.length) {
    console.log("[sync] no feedback rows (check eBay credentials) — nothing to do");
    return;
  }
  const bySku = aggregateBySku(rows);
  const { admin } = await unauthenticated.admin(SHOP);

  let written = 0;
  for (const sku of Object.keys(bySku)) {
    const productId = await findProductIdBySku(admin, sku);
    if (!productId) continue;
    await writeRating(admin, productId, bySku[sku].rating, bySku[sku].count);
    written += 1;
  }
  console.log(`[sync] updated ${written} products from ${rows.length} feedback rows`);
}

// Allow `node ./app/jobs/sync-ebay-reviews.server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  syncEbayReviews().then(() => process.exit(0));
}
