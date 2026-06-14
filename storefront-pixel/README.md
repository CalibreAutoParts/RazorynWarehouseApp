# Razoryn storefront pixel

A minimal, **extension-only** Shopify app whose sole job is to deploy the
**Web Pixel** that powers server-side conversion tracking. It deploys via the
Shopify CLI and never touches the live theme.

Everything else that used to be a separate "Razoryn Ops" app has been **folded
into the warehouse app** (`../razoryn-backend`), which already has the Shopify,
eBay, email (Resend), notifications and cron infrastructure:

| Feature | Now lives in the warehouse app |
|---------|--------------------------------|
| **Server-side tracking endpoint** | `routes/track.js` → `services/ga4.js` + `services/meta.js` (PUBLIC `POST /api/track`). Config in **Settings → Storefront integrations**. |
| **eBay → reviews** | `services/reviews-sync.js` (`ebay.getSellerFeedback` → `shopify.setProductRating`); nightly cron + **Settings → ★ Sync eBay reviews now**. |
| **Back-in-stock** | `routes/notify.js` (PUBLIC `POST /api/notify`) + a sweep cron that emails waiters when `qty_on_hand` returns. |
| **Fitment / large-panel** | Flags on `sales` (`needs_fitment`, `large_panel`); set at Shopify ingest + on manual sales; surfaced in the Sales tab (🔧 Needs fitment filter + 📦 Large panel badge). Mark a product as large-panel in its edit modal. |

## What's left here

```
extensions/tracking-pixel/   # the sandboxed Web Pixel (consent-gated)
shopify.app.toml             # extension-only app config (no webhooks/scopes)
package.json                 # just the Shopify CLI to deploy
```

The pixel subscribes to `page_viewed`, `product_viewed`, `product_added_to_cart`,
`search_submitted`, `checkout_started`, `checkout_completed` and POSTs each to
the **warehouse app's** `/api/track`, which forwards them to GA4 + Meta CAPI
server-side (resilient to ad-blockers / cookie loss).

## Deploy

```bash
npm install
npm run config:link        # link to your Partner app
npm run deploy             # pushes the Web Pixel extension
```

Then set the pixel's **Track endpoint** setting to your warehouse app URL +
`/api/track`, e.g. `https://<warehouse-host>/api/track`
(Shopify admin → Settings → Customer events → the razoryn pixel).

Configure GA4 / Meta credentials in the **warehouse app** under
**Settings → Storefront integrations** (or via env: `GA4_MEASUREMENT_ID`,
`GA4_API_SECRET`, `META_PIXEL_ID`, `META_CAPI_TOKEN`).

## Optional theme wire-up (back-in-stock)
On submit of the product page's "Email me when back in stock" form, also POST to
the warehouse app:

```js
fetch('https://<warehouse-host>/api/notify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, sku, shop })   // sku preferred; productId (gid) also accepted
});
```
(CORS is open on that route.)
