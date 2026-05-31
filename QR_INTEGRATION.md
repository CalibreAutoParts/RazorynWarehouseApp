# QR / Traffic Tracking — Backend Integration (hand-off)

The QR redirect + scan-tracking backend and the warehouse-UI "QR Codes" page are
implemented on branch **`claude/gifted-ritchie-yEg6k`**. That branch shares **no git
history with `main`** (main is "Add files via upload" commits with a different root),
so don't try to merge/PR it — instead apply the pieces below on your working branch.

**What it does:** each ad's QR encodes `<QR_BASE>/go/<code>`. `GET /go/:code` logs the
scan to `qr_scans` and 302-redirects to the real page with UTM tags. So **scan count**
comes from `qr_scans` (ours, free) and **conversion rate** comes from Shopify Analytics
(attributed via `utm_content=<code>`). Codes are dynamic — repoint without reprinting.

---

## 1. New file — `routes/qr.js`  (copy wholesale, it's standalone)
```bash
git fetch origin claude/gifted-ritchie-yEg6k
git checkout claude/gifted-ritchie-yEg6k -- razoryn-backend/routes/qr.js
```
Exports `{ goRouter, apiRouter }`:
- `goRouter`  → `GET /go/:code` (public, no auth; logs scan, 302 + UTMs; fails open to SITE_URL)
- `apiRouter` → admin (`requireAuth`+`requireAdmin`): `GET /links`, `GET /stats`,
  `POST /links`, `POST /import`, `DELETE /links/:code`

## 2. `server.js` — mount both routers in the API section (before the SPA `app.get('*')` fallback)
```js
app.use('/api/qr',           require('./routes/qr').apiRouter);

// Public QR redirect — customer-facing, NO auth. Mounted at /go (outside /api and
// before the SPA fallback) so scanning a printed code logs the scan and redirects.
app.use('/go', require('./routes/qr').goRouter);
```

## 3. `db/schema.sql` — append (idempotent; uses the existing `set_updated_at()` trigger fn)
```sql
-- ---------- QR redirect links + scan tracking (marketing ads) ----------
-- Dynamic QR: printed/posted codes encode <QR_BASE>/go/<code>. The /go/:code route
-- (routes/qr.js) logs the scan and 302-redirects to target_url with UTM tags, so a
-- printed code can be repointed without reprinting. scans = COUNT(qr_scans); the
-- conversion rate is read from Shopify analytics via utm_content=<code>.
CREATE TABLE IF NOT EXISTS qr_links (
  code         TEXT PRIMARY KEY,
  target_url   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'product'
                 CHECK (kind IN ('product','collection','site','promo')),
  label        TEXT,
  utm_campaign TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per scan (a hit on /go/:code).
CREATE TABLE IF NOT EXISTS qr_scans (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent  TEXT,
  referer     TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS qr_scans_code_idx ON qr_scans (code, scanned_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'qr_links_set_updated') THEN
    CREATE TRIGGER qr_links_set_updated BEFORE UPDATE ON qr_links
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
```
Apply with the existing migrator: **`node scripts/migrate.js`** (it runs `schema.sql`).

## 4. `public/index.html` — 4 small edits (don't overwrite the file; merge these in)

**(a) Sidebar nav — add after the Notifications `<button>`:**
```html
<button class="nav-item admin-only" data-page="qr">
  <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="14" y2="21"/><line x1="18" y1="14" x2="18" y2="18"/><line x1="21" y1="17" x2="21" y2="21"/></svg>
  QR Codes
</button>
```

**(b) `hasPerm()` map — add (admin-only):**
```js
qr:           false,
```

**(c) `routeTo()` `pages` map — add:**
```js
qr: renderQR
```

**(d) Add the render function (anywhere among the other `render*` fns):**
```js
/* ==================== QR CODES — SCAN TRACKING ==================== */
// Scan counts come from our own /go/:code redirect (qr_scans table). Conversion
// rate is read in Shopify Analytics via the utm_content=<code> tag on each redirect.
function qrStat(label, val) {
  return `<div class="card"><div class="card-body" style="padding:16px">
    <div style="font-size:12px;color:var(--ink-soft);font-weight:700;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(label)}</div>
    <div style="font-size:28px;font-weight:800;margin-top:4px">${escapeHtml(String(val))}</div></div></div>`;
}
async function renderQR() {
  const days = State.qrDays || 30;
  el('content').innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>QR Codes</h1><div class="desc">Scans of printed &amp; posted QR codes (from our /go redirect). Conversion rate is in Shopify Analytics, attributed by <code>utm_content</code>.</div></div>
        <div class="actions">
          <select class="filter-select" id="qr-days" onchange="State.qrDays=+this.value;renderQR()">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </select>
          <button class="btn btn-outline" onclick="renderQR()">Refresh</button>
        </div>
      </div>
      <div class="grid-4" id="qr-stats" style="margin-bottom:14px"></div>
      <div class="card"><div class="card-body" style="padding:0;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="text-align:left;border-bottom:1px solid var(--line)">
            <th style="padding:12px 14px">Code</th>
            <th style="padding:12px 14px">Label</th>
            <th style="padding:12px 14px">Type</th>
            <th style="padding:12px 14px;text-align:right">Scans (window)</th>
            <th style="padding:12px 14px;text-align:right">Scans (all-time)</th>
            <th style="padding:12px 14px">Last scan</th>
          </tr></thead>
          <tbody id="qr-rows"><tr><td colspan="6" style="padding:18px;text-align:center;color:var(--ink-soft)">Loading…</td></tr></tbody>
        </table>
      </div></div>
    </div>`;
  const sel = el('qr-days'); if (sel) sel.value = String(days);
  try {
    const [stats, links] = await Promise.all([
      Api.get('/api/qr/stats?days=' + days),
      Api.get('/api/qr/links?days=' + days),
    ]);
    const t = (stats && stats.totals) || {};
    const rows = (links && links.links) || [];
    el('qr-stats').innerHTML =
      qrStat('Scans · ' + days + 'd', t.scans || 0) +
      qrStat('Codes scanned', t.codes_scanned || 0) +
      qrStat('Registered codes', rows.length) +
      qrStat('Top code', rows[0] ? rows[0].code : '—');
    el('qr-rows').innerHTML = rows.length ? rows.map(l => `
      <tr style="border-bottom:1px solid var(--line-2)">
        <td style="padding:10px 14px;font-family:ui-monospace,monospace">${escapeHtml(l.code)}</td>
        <td style="padding:10px 14px">${escapeHtml(l.label || '—')}</td>
        <td style="padding:10px 14px"><span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ink-soft)">${escapeHtml(l.kind || '')}</span></td>
        <td style="padding:10px 14px;text-align:right;font-weight:700">${l.scans_window || 0}</td>
        <td style="padding:10px 14px;text-align:right">${l.scans_total || 0}</td>
        <td style="padding:10px 14px;color:var(--ink-soft)">${l.last_scan ? new Date(l.last_scan).toLocaleDateString('en-GB') : '—'}</td>
      </tr>`).join('') :
      `<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--ink-soft)">No QR codes registered yet. Build the ads, then import a <code>data/qr-links-*.json</code> seed via <code>POST /api/qr/import</code>.</td></tr>`;
  } catch (e) {
    el('qr-rows').innerHTML = `<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--red)">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
  }
}

```

---

## 5. Environment + routing
- `SITE_URL`   — storefront for the fail-open + UTM landing (default `https://www.razoryn.co.uk`).
- `QR_BASE_URL`— public base that resolves to THIS backend, e.g. `https://go.razoryn.co.uk`.
  **`/go/*` must reach the Express app** — point a subdomain (e.g. `go.razoryn.co.uk`) at the
  backend, or add a proxy rule. The ad builders encode `<QR_BASE_URL>/go/<code>`, so set this
  before generating the printable QRs (and in the ad-system generators via the same env var).

## 6. Register the codes (one-off per ad build)
The ad builders emit seeds in `ad-system/data/qr-links-*.json`. Push them to the backend:
```bash
curl -X POST https://<backend>/api/qr/import -H 'Content-Type: application/json' \
     -b cookies.txt --data @ad-system/data/qr-links-promos.json
# repeat for qr-links-showcases.json and qr-links-03.json … qr-links-24.json
```

## 7. Verify
1. `node scripts/migrate.js` → `qr_links` + `qr_scans` exist.
2. Import a seed (step 6) → rows appear in `qr_links`.
3. Hit `https://<backend>/go/<a-code>` in a browser → you land on the product/collection
   page with `?utm_source=qr…&utm_content=<code>`, and a row is inserted into `qr_scans`.
4. Warehouse UI → **QR Codes** page shows the scan + the table populates.
5. Shopify Analytics → traffic/conversions appear under the `qr` source / per `utm_campaign`.

> Canonical implementation lives on `claude/gifted-ritchie-yEg6k` — diff against it if anything is unclear.
