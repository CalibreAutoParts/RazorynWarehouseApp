// services/competitor-sources/ebay-browse.js
//
// Source adapter for competitors who sell on eBay. Thin wrapper over the eBay
// Buy Browse API (ebay.getSellerActiveListings) — the orchestrator only sees the
// normalized listing shape, never eBay specifics.
const ebay = require('../ebay');

// Returns: [{ external_id, title, price, currency, url, image_url, raw }]
async function fetchListings(competitor) {
  const username = competitor.ebay_username;
  if (!username) throw new Error(`competitor "${competitor.code}" has source_type=ebay but no ebay_username`);
  const cfg = competitor.config || {};
  // Track NEW parts only by default (these are trade competitors); a competitor
  // can override via config.conditionIds (e.g. "1000|1500"). Set to null/"all"
  // in config to capture every condition.
  let conditionIds = cfg.conditionIds === undefined ? '1000' : cfg.conditionIds;
  if (conditionIds === 'all' || conditionIds === null) conditionIds = undefined;
  const items = await ebay.getSellerActiveListings(username, {
    marketplaceId: cfg.marketplaceId,
    limit: cfg.limit || 1000,
    conditionIds,
  });
  // getSellerActiveListings already returns the normalized shape; attach raw.
  return items.map(it => ({ ...it, raw: it }));
}

module.exports = { fetchListings };
