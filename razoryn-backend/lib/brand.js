// lib/brand.js — Per-tenant brand configuration.
//
// Selected at boot from the APP_BRAND env var. All hard-coded company / colour /
// logo references should go through this module rather than being baked into
// templates or HTML. Adding a new brand = add a new entry below.
//
// The eBay store list is also brand-scoped: Razoryn has 1 store, Calibre has 2.
// Each store entry tells the eBay service which env var holds its Auth'n'Auth token.

const BRANDS = {
  razoryn: {
    code: 'razoryn',
    name: 'Razoryn e-Parts',
    fullName: 'Razoryn e-Parts',
    domain: 'razoryn.co.uk',
    logoUrl: '/logo.png',
    logoUrlDark: '/logo-dark.png',  // shown when dark theme is active
    primaryColor: '#c8202d',        // brand red — sidebar, primary buttons, accents
    primaryColorDark: '#e2545f',    // lifted red for dark mode (legible on dark bg)
    secondaryColor: '#1a1a1a',       // ink colour for headers
    accentColor: '#c8202d',          // CTA / section-heading colour (red)
    supportColor: '#ffffff',
    invoicePrefix: 'REP',
    appTitle: 'Razoryn Warehouse Hub',
    tagline: 'Quality aftermarket vehicle parts',
    collectionArea: 'Watford, London & Hertfordshire',
    stores: [
      {
        code: 'razoryn',
        name: 'Razoryn',
        channelCode: 'ebay_em',
        tokenEnv: 'EBAY_AUTH_TOKEN',
        // No longer the primary — razorynecommerceltd is now the main account
        // (see the razoryn2 entry). Legacy NULL-store_code mirror_links are
        // pinned to this account by a one-time backfill in routes/listings.js so
        // the primary swap can't mis-route their edits.
      },
      // Second Razoryn eBay selling account. Shares the same App credentials
      // (EBAY_APP_ID/CERT_ID/DEV_ID) — only its Auth'n'Auth token differs
      // (EBAY_AUTH_TOKEN_RAZORYN2). Stays hidden everywhere until that token is
      // set (brand.js nulls a missing token and every listing/sync/sales path
      // filters by hasToken), so shipping this entry is a no-op until go-live.
      //
      // channelCode 'ebay_cl' is reused deliberately: it's already an allowed
      // value in the sales.channel CHECK constraint + sync_state, so no schema
      // migration is needed, and the sales UI labels the pill from this store's
      // `name` (see channelPill in public/index.html). Display name is
      // env-overridable so the real eBay shop name can be set without a code
      // change/redeploy.
      {
        code: 'razoryn2',
        name: process.env.EBAY_STORE2_NAME || 'Razoryn 2',
        channelCode: 'ebay_cl',
        tokenEnv: 'EBAY_AUTH_TOKEN_RAZORYN2',
        primary: true,                    // MAIN account — default for new listings + cross-listing source
      },
    ],
  },

  calibre: {
    code: 'calibre',
    name: 'Calibre Auto Parts',
    fullName: 'Calibre Auto Parts Ltd',
    domain: 'calibreautoparts.co.uk',
    logoUrl: '/logo-calibre.png',           // transparent PNG — clean on the light UI
    logoUrlDark: '/logo-calibre-dark.jpeg',  // white-bg version stays visible on the dark top bar
    primaryColor: '#0D1B2A',         // navy — sidebar, headings
    primaryColorDark: '#4a7fc0',     // legible blue for dark mode (navy is invisible on dark bg)
    secondaryColor: '#E30613',        // red accent — primary buttons, links
    accentColor: '#E30613',          // CTA / section-heading colour (red)
    supportColor: '#ffffff',
    invoicePrefix: 'CAP',
    appTitle: 'Calibre Warehouse Hub',
    tagline: 'EV and modern vehicle body parts',
    collectionArea: 'Watford, London & Hertfordshire',
    stores: [
      {
        code: 'evbodyparts',
        name: 'EVBODYPARTS',
        channelCode: 'ebay_em',          // keep legacy code for sales schema continuity
        tokenEnv: 'EBAY_AUTH_TOKEN_EVBODYPARTS',
        primary: true,                    // source of truth for cross-listing
      },
      {
        code: 'evantagrande',
        name: 'Evanta Grande',
        channelCode: 'ebay_cl',
        tokenEnv: 'EBAY_AUTH_TOKEN_EVANTAGRANDE',
        standalone: true,
      },
    ],
  },
};

const requestedCode = (process.env.APP_BRAND || 'razoryn').toLowerCase().trim();
const brand = BRANDS[requestedCode];

if (!brand) {
  console.error(`[brand] Unknown APP_BRAND="${requestedCode}" — falling back to razoryn.`);
}

const active = brand || BRANDS.razoryn;

// Resolve each store's token at import time so callers can do
// `brand.stores[0].token` instead of re-reading env every call. A missing token
// is logged but doesn't throw — useful for dev environments without all creds.
//
// EBAY_STORE_DISABLED (env var) — comma-separated list of store codes to disable
// at boot. The store entry is kept (so the rest of the codebase doesn't crash
// looking it up) but its token is nulled out so `s.hasToken` is false. Every
// listing/sync/match endpoint already filters by `.hasToken`, so a disabled
// store becomes a no-op everywhere automatically.
//
// Example: EBAY_STORE_DISABLED=evantagrande temporarily disables Calibre's
// Evanta Grande store so all linking/syncing happens against EVBODYPARTS only.
// To re-enable, remove the env var (or remove the code from the list) and
// redeploy.
const disabledList = (process.env.EBAY_STORE_DISABLED || '')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

for (const s of active.stores) {
  const rawToken = process.env[s.tokenEnv] || null;
  if (disabledList.includes(s.code)) {
    s.token = null;
    s.disabled = true;
    s.disabledReason = `EBAY_STORE_DISABLED env var includes "${s.code}"`;
    console.warn(`[brand] Store "${s.code}" is DISABLED (token suppressed at boot).`);
  } else {
    s.token = rawToken;
    s.disabled = false;
    if (!rawToken) {
      console.warn(`[brand] Store "${s.code}" has no token (${s.tokenEnv} not set).`);
    }
  }
}

module.exports = active;
module.exports.all = BRANDS;
// Helper: get store by code, or null
module.exports.getStore = function (code) {
  return active.stores.find(s => s.code === code) || null;
};
// Helper: get the primary store (used by cross-listing — content flows FROM here)
module.exports.getPrimaryStore = function () {
  return active.stores.find(s => s.primary) || active.stores[0];
};
