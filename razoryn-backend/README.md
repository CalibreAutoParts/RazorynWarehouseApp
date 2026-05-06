# Razoryn Warehouse Hub — Backend

Node.js + Postgres backend powering the Razoryn e-Parts warehouse PWA.
Pulls orders from Shopify and eBay, decrements stock, exposes a REST API
that the PWA front-end consumes, and pushes stock changes back out to both
sales channels. Designed to deploy to Railway as a single project.

## What's in here

```
razoryn-backend/
├── server.js              Express boot, mounts all routes, serves the PWA
├── package.json           Dependencies + npm scripts
├── railway.toml           Railway build/deploy config
├── .env.example           All environment variables documented
├── db/
│   ├── index.js           Postgres pool with SSL toggle for Railway
│   └── schema.sql         14 tables covering all 16 features
├── scripts/
│   ├── migrate.js         Runs schema.sql + creates initial admin (auto on boot)
│   ├── seed.js            Demo data — products, locations, KB, schedule
│   └── sync-cron.js       Standalone cron entry point (alternative to in-process)
├── middleware/
│   ├── auth.js            JWT verify, requireAuth, requireAdmin, requirePermission(key)
│   └── audit.js           Writes admin actions to audit_log
├── routes/                One file per resource: auth, products, sales, returns,
│                          locations, schedule, knowledge, videos, notifications,
│                          staff, pricing, stock-checks, settings
├── services/
│   ├── shopify.js         Admin API client (orders pull, inventory_levels push)
│   ├── ebay.js            Sell API client (OAuth refresh, fulfillment, inventory)
│   └── sync.js            Orchestrator — pulls + pushes + low-stock notifications
└── public/
    └── index.html         The production PWA (served at /), wired to the API
```

## Quick start (local)

```bash
# 1. Clone and install
git clone https://github.com/CalibreAutoParts/razoryn-warehouse.git
cd razoryn-warehouse
npm install

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and JWT_SECRET

# 3. Set up Postgres locally (or skip — point DATABASE_URL at any Postgres)
createdb razoryn_warehouse
npm run migrate     # creates tables + initial admin + (optional) seed data

# 4. Run
npm run dev         # auto-restarts on file changes
# or
npm start

# 5. Open http://localhost:3000
#    Login with the INITIAL_ADMIN_EMAIL/PASSWORD you set in .env,
#    or PIN 1234 (Sam — the seeded warehouse account)
```

## Deploy to Railway

This is the production deployment path. Everything runs on Railway — no AWS,
no Cloudflare, no third-party storage.

### 1. Create the project

In Railway dashboard:

1. **New Project → Deploy from GitHub repo** → select `razoryn-warehouse`
2. Railway detects Node.js and uses `railway.toml`
3. Service is created but won't start yet — it needs a database

### 2. Add Postgres

1. In the same project, **+ New → Database → PostgreSQL**
2. Railway provisions managed Postgres with backups
3. The `DATABASE_URL` variable is automatically injected into the web service —
   no manual configuration needed
4. The first deploy runs `npm run migrate` (per `railway.toml` startCommand),
   which creates the schema and seeds the initial admin

### 3. Add a volume for photo uploads

Returns and location photos need persistent storage. Railway has native volumes:

1. On the web service → **Settings → Volumes → + New Volume**
2. Mount path: `/data`
3. Add an environment variable: `UPLOAD_DIR=/data/uploads`

The volume survives restarts and redeploys. For backup, use `railway run`
to tar the volume contents periodically (or migrate to S3/R2 later if usage
grows beyond a few GB).

### 4. Set environment variables

On the web service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste the result |
| `INITIAL_ADMIN_EMAIL` | your email |
| `INITIAL_ADMIN_PASSWORD` | a strong password — change it after first login |
| `INITIAL_ADMIN_PIN` | a 4–6 digit PIN you'll use on warehouse devices |
| `UPLOAD_DIR` | `/data/uploads` |
| `SEED_ON_MIGRATE` | `true` for first deploy, `false` afterwards |
| `CORS_ORIGIN` | `https://warehouse.razoryn.co.uk` (set after step 6) |
| `SYNC_CRON` | `*/5 * * * *` (every 5 minutes — adjust as needed) |

Shopify and eBay credentials (set these once you have the apps configured —
see "Connecting Shopify" and "Connecting eBay" below):

| Variable | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `razoryn-eparts.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | from your custom app |
| `SHOPIFY_LOCATION_ID` | from `GET /admin/api/2025-01/locations.json` |
| `EBAY_CLIENT_ID` | from developer.ebay.com |
| `EBAY_CLIENT_SECRET` | from developer.ebay.com |
| `EBAY_REFRESH_TOKEN` | from OAuth consent flow |
| `EBAY_MARKETPLACE_ID` | `EBAY_GB` |

Until these are set the app runs with sync disabled — you can still log in,
manage stock manually, log direct sales, and use the PWA fully.

### 5. Deploy

Railway redeploys automatically on each push to `main`. Watch the deploy logs:

```
[migrate] schema applied
[migrate] created initial admin: ali@razoryn.co.uk
[migrate] done
[boot] cron scheduled: */5 * * * *
[boot] Razoryn warehouse listening on :3000
```

Health check: `https://<railway-domain>/health` → `{"ok":true,"db":"up",...}`

### 6. Custom domain — `warehouse.razoryn.co.uk`

In Railway:

1. Web service → **Settings → Networking → + Custom Domain**
2. Enter `warehouse.razoryn.co.uk`
3. Railway gives you a CNAME target like `xyz123.up.railway.app`

In GoDaddy DNS for `razoryn.co.uk`:

1. Add a CNAME record: name=`warehouse`, value=the Railway target, TTL 1 hour
2. Wait 5–10 minutes for propagation
3. Railway auto-provisions a Let's Encrypt certificate

This mirrors the Calibre setup (`warehouse.calibreautoparts.co.uk`).
Your main `razoryn.co.uk` Shopify store is unaffected.

### 7. Update CORS_ORIGIN

Once the custom domain works, update `CORS_ORIGIN` in Railway variables to
`https://warehouse.razoryn.co.uk` and redeploy.

---

## Connecting Shopify

1. **Create a custom app**:
   `https://admin.shopify.com/store/<your-store>/settings/apps/development`
   → **Create an app** → name it "Razoryn Warehouse"

2. **Configuration → Admin API access scopes**, enable:
   - `read_products`, `write_products`
   - `read_inventory`, `write_inventory`
   - `read_orders`
   - `read_locations`

3. **Install the app** → reveal the Admin API access token (shown once).
   Set it as `SHOPIFY_ADMIN_TOKEN` in Railway.

4. **Find your warehouse location ID**. SSH into the running service or
   use Railway's CLI:
   ```bash
   railway run node -e "require('./services/shopify').getLocations().then(l => console.log(l))"
   ```
   Copy the relevant location's `id` into `SHOPIFY_LOCATION_ID`.

5. **Match SKUs**. The sync uses SKU as the product identity — every product
   in `products` must have the same SKU as its Shopify variant. Easiest path:
   - Export Shopify's product CSV
   - Bulk-create matching products in the warehouse via direct DB insert or
     a one-off import script (let me know and we can build a CSV importer)

## Connecting eBay

1. Sign in at `developer.ebay.com` and create application keys (production)
2. Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`
3. Generate a User Access Token via the OAuth consent flow:
   - Auth URL: `https://auth.ebay.com/oauth2/authorize?client_id=...&response_type=code&redirect_uri=...&scope=https://api.ebay.com/oauth/api_scope/sell.inventory%20https://api.ebay.com/oauth/api_scope/sell.fulfillment`
   - Exchange the resulting code for a refresh token (the refresh token is
     long-lived — 18 months — and is what `services/ebay.js` uses)
4. Save the refresh token as `EBAY_REFRESH_TOKEN`

Same caveat as Shopify: SKUs must match between the warehouse's `products.sku`
and your eBay listings.

---

## What's wired vs what's stubbed

The PWA at `public/index.html` is wired to the API for the high-traffic paths.
The breakdown:

**Fully wired**
- Login (PIN + email/password) → `/api/auth/login-pin`, `/api/auth/login`
- Session restore on reload → `/api/auth/me`
- Logout → `/api/auth/logout`
- Loading every page (products, sales, returns, schedule, KB, videos, notifications, staff, settings)
- Auto-refresh every 30s while logged in
- Product create / edit / soft-delete → `/api/products`
- Stock adjustments (manual, damage) → `/api/products/:id/adjust-stock`
- Direct cash/bank sales → `/api/sales` (with VAT calc + invoice number generation)
- Stock check workflow → `/api/stock-checks`
- Returns: create, advance status, photo upload → `/api/returns` + `/api/returns/:id/photos`
- Schedule task add / toggle done / delete → `/api/schedule`
- Knowledge base add (admin) → `/api/kb`
- Notifications mark read / mark all read → `/api/notifications`
- Staff add / edit / deactivate / permission toggle → `/api/staff`
- Settings save (cash discount, etc.) → `/api/settings`
- Manual sync trigger → `/api/settings/sync-now`
- Phone pricing — quote display calculates from State; for live API quotes
  with current settings, hit `/api/pricing/quote?productId=&qty=`

**Backend only — no UI wired yet**
- Locations as first-class resource (`/api/locations`) — currently the PWA
  shows the legacy free-text "location" field on the product. Building a
  Locations admin page that uses `/api/locations` with photo upload is the
  next obvious UI addition.
- Audit log viewer — `audit_log` is being written, but there's no page that
  shows it. Useful for an admin "who did what" view.
- Bulk product import from CSV (Shopify export) — would be its own admin tool

**Configurable**
- The cron in `server.js` runs the sync in-process. If you'd rather use
  Railway's native cron service (separate service, separate logs), see the
  comment block in `scripts/sync-cron.js`.

---

## API surface (cheat sheet)

All endpoints are JSON. Auth is JWT — sent as a `rzn_token` cookie or as
`Authorization: Bearer <token>`. The login endpoints return both.

```
POST   /api/auth/login-pin          { pin } → { token, user }
POST   /api/auth/login              { email, password } → { token, user }
POST   /api/auth/logout
GET    /api/auth/me                                       → { user }

GET    /api/products                ?search=&brand=&lowStock=1
GET    /api/products/barcode/:code
GET    /api/products/low-stock
GET    /api/products/:id
POST   /api/products                (admin)
PATCH  /api/products/:id            (admin)
POST   /api/products/:id/adjust-stock { delta, reason, notes }
DELETE /api/products/:id            (admin, soft delete)

POST   /api/stock-checks            { productId, actualQty, reason, notes, photoPath }
GET    /api/stock-checks            ?productId=&days=30

GET    /api/sales                   ?channel=&from=&to=     (also returns summary)
GET    /api/sales/:id
POST   /api/sales                   { channel, items[], customerName, ... }
GET    /api/sales/:id/invoice.html  (print-ready)

GET    /api/returns                 ?status=&days=
GET    /api/returns/:id             (with photos)
POST   /api/returns
POST   /api/returns/:id/photos      (multipart)
PATCH  /api/returns/:id

GET    /api/locations
GET    /api/locations/:id           (with products)
POST   /api/locations               (multipart - optional photo)
PATCH  /api/locations/:id           (multipart - optional photo)
DELETE /api/locations/:id

GET    /api/schedule                ?date=&from=&to=
POST   /api/schedule                (admin)
PATCH  /api/schedule/:id
DELETE /api/schedule/:id            (admin)

GET    /api/kb                      ?category=
POST   /api/kb                      (admin)
PATCH  /api/kb/:id                  (admin)
DELETE /api/kb/:id                  (admin)

GET    /api/videos                  ?category=
POST   /api/videos                  (admin)
DELETE /api/videos/:id              (admin)

GET    /api/notifications           ?unread=1
POST   /api/notifications/:id/read
POST   /api/notifications/read-all

GET    /api/staff                   (admin)
POST   /api/staff                   (admin)
PATCH  /api/staff/:id               (admin)
DELETE /api/staff/:id               (admin, soft delete)

GET    /api/pricing/quote           ?productId=&qty=

GET    /api/settings
PATCH  /api/settings                (admin)
POST   /api/settings/sync-now       (admin)
GET    /api/settings/sync-state

GET    /health                      (no auth — for Railway healthcheck)
GET    /uploads/<path>              (auth required — serves stored photos)
```

---

## Native apps (iOS / Android / Windows)

The PWA is installable on all three platforms today:

- **iOS**: Open in Safari → Share → Add to Home Screen
- **Android**: Open in Chrome → menu → Install app
- **Windows**: Open in Edge or Chrome → install icon in URL bar

For App Store / Play Store distribution, wrap the PWA with **Capacitor**:

```bash
npm install -g @capacitor/cli
npx cap init razoryn-warehouse co.razoryn.warehouse
npx cap add ios
npx cap add android
# Configure capacitor.config.ts to load https://warehouse.razoryn.co.uk
npx cap open ios          # opens Xcode for App Store build
npx cap open android      # opens Android Studio for Play Store build
```

One codebase, three native packages. The PWA continues to work in browsers
unchanged.

---

## What to do next

In rough order:

1. **Configure Shopify + eBay** and run the first sync. Watch
   `/api/settings/sync-state` to confirm orders are flowing in.
2. **Match SKUs** — bulk-import or hand-curate the product catalogue so
   `products.sku` matches both channels.
3. **Build the Locations UI page** — the API is ready (`/api/locations`),
   needs a render function in the PWA. Each location can have a photo and
   a list of products stored there.
4. **Wrap with Capacitor** for App Store / Play Store distribution.
5. **Set up email notifications** for low-stock alerts (currently they
   surface in the bell icon only). Use Resend or Postmark — the
   `notifications` table already has the data.
6. **Audit log viewer** for admin oversight.

---

## Troubleshooting

**"unauthorized" on every request after a deploy.** The JWT secret changed.
Log out and back in — the old tokens are no longer valid.

**Sync fails with `shopify_not_configured` or `ebay_not_configured`.** The
environment variables haven't been set yet. The app keeps running fine; the
sync simply skips that channel. Set the variables and redeploy.

**Photos return 401.** `/uploads/*` requires auth (cookies must be sent).
This is intentional — leaked photo URLs don't expose internal images. Make
sure the front-end is requesting them with `credentials: include` (it does
by default when same-origin).

**Migration fails on first deploy with "extension citext does not exist".**
Railway Postgres has CITEXT available — the migration script creates the
extension before the schema runs. If you see this on a non-Railway Postgres,
run `CREATE EXTENSION citext;` as superuser first.

---

Built for Razoryn e-Parts · Watford UK · razoryn.co.uk
