# Razoryn Warehouse — Shopify admin extensions

Adds the Warehouse Hub invoice to every order page in Shopify admin:

| Where | What |
|-------|------|
| **More actions → Apps → Warehouse invoice** | Window with a **Download invoice** button |
| **More actions → Print → Warehouse invoice** | Print preview of the invoice PDF |
| **Blocks → Warehouse invoice** (add once via *+ Block*) | Card with the invoice number and **Download** |

Each lives in its own extension (`extensions/warehouse-invoice`, `-print`, `-block`), because
Shopify doesn't allow a block and an action, or two print actions, in one extension.
All three read the order metafields `razoryn.invoice_url` / `razoryn.invoice_number`.
The Hub writes these when it syncs (`services/sync.js` → `pushInvoiceLinksToShopify`).

## Deploy

```bash
npm install
npm run config:link   # pulls the app's live config into shopify.app.toml (keeps scopes/URLs as they are)
npm run deploy -- --allow-updates   # builds the extensions and releases a new app version
```

`shopify app config link` / `deploy` log in with a one-time browser code (Shopify account that
manages the app on dev.shopify.com). Each extension's `tsconfig.json` sets `jsxImportSource: preact`;
without it the CLI compiles JSX for React and the build fails.
