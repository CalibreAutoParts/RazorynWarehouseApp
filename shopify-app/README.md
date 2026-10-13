# Razoryn Warehouse — Shopify admin extensions

Adds the Warehouse Hub invoice to every order page in Shopify admin:

| Where | What |
|-------|------|
| **More actions → Apps → Warehouse invoice** | Window with a **Download invoice** button |
| **More actions → Print → Warehouse invoice** | Print preview of the invoice PDF |
| **Blocks → Warehouse invoice** (add once via *+ Block*) | Card with the invoice number and **Download** |

All three read the order metafields `razoryn.invoice_url` / `razoryn.invoice_number`.
The Hub writes these when it syncs (`services/sync.js` → `pushInvoiceLinksToShopify`).

## Deploy

```bash
npm install
npm run config:link   # pulls the app's live config into shopify.app.toml (keeps scopes/URLs as they are)
npm run deploy        # builds the extensions and releases a new app version
```
