// services/competitor-sources/index.js
//
// Resolver: maps a competitor row to its source adapter. Every adapter exports
//   async fetchListings(competitorRow) -> normalizedListing[]
// where a normalized listing is
//   { external_id, title, price, currency, url, image_url, raw }.
//
// Phase 1 ships the eBay adapter. Website scraping adapters (Phase 2) live under
// ./web and are gated behind COMPETITOR_SCRAPE_ENABLED so they stay inert until
// explicitly enabled.
const ebayBrowse = require('./ebay-browse');

function getAdapter(competitor) {
  if (competitor.source_type === 'ebay') return ebayBrowse;

  if (competitor.source_type === 'website') {
    if (String(process.env.COMPETITOR_SCRAPE_ENABLED || '').toLowerCase() !== 'true') {
      throw new Error('website scraping disabled (set COMPETITOR_SCRAPE_ENABLED=true to enable)');
    }
    // Phase 2: per-competitor web adapters resolved by code, e.g.
    //   return require(`./web/${competitor.code}`);
    throw new Error(`no website adapter for competitor "${competitor.code}" yet (Phase 2)`);
  }

  throw new Error(`unknown source_type "${competitor.source_type}"`);
}

module.exports = { getAdapter };
