# Razoryn Ops

A custom Shopify app for Razoryn e-Parts that improves **tracking, orders and conversions** — the pieces off-the-shelf apps don't do well for an auto-parts store. It lives in this folder but deploys **separately** from the theme (via the Shopify CLI). Shopify's theme-GitHub sync ignores non-theme folders, so this never touches the live theme.

## What it does

| Area | What | Files |
|------|------|-------|
| **Tracking** | A sandboxed **Web Pixel** relays storefront + checkout events to the app, which forwards them **server-side** to GA4 (Measurement Protocol) and Meta (Conversions API). Survives ad-blockers / cookie loss; consent-gated. | `extensions/tracking-pixel/`, `app/routes/api.track.jsx`, `app/lib/ga4.server.js`, `app/lib/meta.server.js` |
| **Orders + fitment** | `orders/create` webhook stores each order enriched with the customer's **`Vehicle reg`** (captured by the theme cart) and a **large-panel (LP)** flag for courier routing. Embedded Polaris dashboard with a "needs fitment confirmation" queue. | `app/routes/webhooks.jsx`, `app/routes/app._index.jsx` |
| **eBay → reviews** | Nightly job pulls eBay feedback, aggregates per SKU, and writes `reviews.rating` + `reviews.rating_count` product metafields. The theme already renders these as stars + Google `aggregateRating` (`snippets/stars.liquid`). | `app/jobs/sync-ebay-reviews.server.js`, `app/lib/ebay.server.js` |
| **Back-in-stock** | The theme's "Email me when back in stock" form posts to `/api/notify`; `inventory_levels/update` auto-emails waiting customers when stock returns. | `app/routes/api.notify.jsx`, `app/lib/backinstock.server.js` |
| **Abandoned cart** | `checkouts/create|update` webhooks store carts; a scheduled sweep emails an on-brand recovery ("send your reg, we'll confirm fitment"). | `app/routes/webhooks.jsx`, `app/lib/email.server.js` |

## How the theme feeds the app (already built)
- **`Vehicle reg`** — saved as a cart attribute on the cart page → arrives as an order note attribute.
- **`reviews.rating` / `reviews.rating_count`** — the star display + `aggregateRating` JSON-LD read these; the eBay sync writes them.
- **`LP` tag** — large-panel products; the order webhook flags these for the courier.

## First-time setup
This folder contains the **custom** code. Generate the standard app base around it, then run:

```bash
# 1. Scaffold the official Remix template (gives you app/shopify.server.js,
#    app/db.server.js, app/root.jsx, vite config, etc.) into this folder.
npm init @shopify/app@latest -- --template remix
#    Keep the generated app/shopify.server.js + app/db.server.js; merge the
#    package.json deps; copy in the app/ , extensions/ , prisma/ files here.

# 2. Install + env
npm install
cp .env.example .env   # fill in GA4, Meta, eBay, email, DB

# 3. DB
npm run setup          # prisma generate + migrate

# 4. Link to your Partner app + run
npm run config:link
npm run dev            # opens the dev store, installs the app + Web Pixel
```

Set the Web Pixel's **Track endpoint** setting to `https://<app-url>/api/track` (Settings → Customer events, or via the CLI on install).

## One small theme wire-up (optional, enables auto back-in-stock)
The product page's notify form currently emails you via Shopify's contact form. To let the app auto-send when stock returns, also POST signups to `/api/notify`. In `assets/global.js`, on submit of `.rz-notify-form`, `fetch('https://<app-url>/api/notify', { method:'POST', body: JSON.stringify({ email, productId, shop }) })`. (CORS is already open on that route.)

## Owner checklist (free, parallel — do in Shopify admin)
- Turn on **Shop Pay / Apple Pay / Google Pay** (Settings → Payments).
- Enable the native **abandoned-checkout email** (until the custom sequence ships).
- Connect **GA4** (native Google channel) so data flows immediately.
- Wire the **WELCOME10** email so newsletter signups receive the code.

## Status
Phase 1 (tracking) and the dashboard/webhooks/eBay-sync/back-in-stock modules are scaffolded and ready to run once the template base + credentials are in place. eBay's feedback pull (`fetchSellerFeedback`) is stubbed — it's the one provider-specific piece to finish, and is a safe no-op until configured.
