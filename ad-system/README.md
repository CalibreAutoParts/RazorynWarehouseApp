# Razoryn e-Parts — Ad & Promo Generation System

Print-ready, on-brand social ads for **Razoryn e-Parts** (razoryn.co.uk).
Every ad is rendered in **3 colour schemes** (White / Red / Navy) at **1080×1350**
(Instagram portrait). Print each file → Save as PDF → import into Canva, or post directly.

Built from the design tokens in `razoryn-theme-v16-2`: **Barlow Condensed** (display) +
**Inter** (body), brand red `#c8202d` / navy `#0f1318`, embedded RAZORYN E-PARTS wordmark.

## Files

| File | What it is |
|---|---|
| `build_collection.py` | Canonical **listing** builder (one product per slide, front + back). |
| `build_promos.py` | **Promotional ad** builder — 6 high-converting formats. |
| `logo_red.png` / `logo_white.png` | Trimmed wordmark (red for light bg, white for Red/Navy). |
| `data/NN-<slug>.json` | Live Shopify data per collection (normalised). |
| `data/raw/NN-<slug>.json` | Verbatim GraphQL pull (provenance / re-gen without re-querying). |
| `tools/normalize.py` | Converts a raw GraphQL pull into builder data format. |
| `razoryn-NN-<slug>.html` | Listing file per collection (×3 schemes, front/back, per-product QR). |

**Collections built (03–24):** Toyota Yaris Cross · Hyundai i20 / Kona SX2 / Tucson /
Ioniq 5 / Ioniq / Bayon / Kona (2018-23) · Kia Sportage NX5 / Picanto / Niro SG2 /
Niro (2018-22) / EV6 · Peugeot 208 / 2008 · Nissan Qashqai / X-Trail / Juke ·
Vauxhall Combo / Astra / Crossland / Grandland. (01 C-HR, 02 Yaris were done earlier.)

Rebuild every collection at once:
```bash
for f in data/[0-9]*-*.json; do python3 build_collection.py "$f"; done
```
| `promo-*.html` | One file per promo (each × 3 schemes). |
| `razoryn-promos.html` | Combined review sheet — all 6 promos × 3 schemes in one print job. |

## Promo formats (`build_promos.py`)

1. **Website Exclusive / Buy Direct** — price-led hero: "BUY DIRECT & SAVE 7%", framed as your own
   eBay store vs ordering direct (soft, no jabs at the platform).
2. **Same-Day Dispatch** — "Order by 12 noon, dispatched today".
3. **Free UK Delivery** — "Free UK delivery over £50".
4. **Model Showcase** — "All parts for your [MODEL]" + 6-part price grid.
5. **Fitment Support** — three trust badges, "the right part, first time".
6. **Brand / Carousel Cover** — section-divider slide on Red/Navy.

## Regenerate

```bash
pip install Pillow                      # one-time (logo tooling)
python3 build_promos.py                 # rebuilds all promo-*.html + razoryn-promos.html
python3 build_collection.py data/03-yaris-cross.json   # rebuilds a listing file
```

## Export ready-to-post images (high resolution)

Render each ad straight from the HTML with headless Chrome — **pixel-identical to the
browser, no PDF step** (so nothing in the design shifts). True 1080×1350 at **2×
(2160×2700)**.

```bash
node export_jpg.js                      # JPEG (quality 92) — all promos + showcases
node export_jpg.js razoryn-03-*.html    # specific file(s)
FORMAT=png node export_jpg.js           # PNG instead (transparent-safe)
node export_png.js                      # (PNG-only sibling, same output)
```
Output: `export/<name>_<scheme>.{jpg,png}` (white / red / navy).

> Run on a machine with normal internet so the Shopify product photos load
> (requested at `width=1600`, crisp at 1080px). These exports — **not** the small
> chat previews — are the deliverable. Drag the JPEGs straight into Canva (Uploads),
> post directly, or hand them to a design tool.

## Video templates (Remotion) — `video/`

Two vertical 1080×1920 social videos (parts montage + storefront showcase), same brand
system. See `video/README.md`.
```bash
cd video && npm install && npm run dev      # preview in Remotion Studio
npm run render                              # -> out/parts-showcase.mp4 + site-showcase.mp4
```

## Canva workflow

Two options:
1. **Drag-in (keeps the design exactly):** export JPEGs (`node export_jpg.js`) → in Canva,
   **Uploads → upload** the JPEGs → drop onto a 1080×1350 design. No quality loss, no PDF.
2. **Editable text:** open a file → **Print → Save as PDF** (Margins: None, Background
   graphics: ON) → Canva **Create design → Import** the PDF. (PDF can shift fonts slightly —
   use option 1 if you only need the image.)

## QR codes (direct links — no tracking)

## QR codes (direct links — no tracking)

Every ad carries a QR in a white card (scannable on all three schemes). Each QR
links **straight to the page** — no redirect, no database, no backend:

- **Listings** → the product page (`<SITE>/products/<handle>`).
- **Model showcase** → the collection page (`<SITE>/collections/<handle>`).
- **Website / promo ads** → the storefront home (`<SITE>`).

`SITE` defaults to `https://www.razoryn.co.uk` (override via `SITE_URL`). That's it —
scanning opens the page. (If you ever want scan/conversion numbers later, add UTM
params in `qr.py` and read them in Shopify Analytics — no infra needed.)

## Notes

- Product photos are loaded live from the Shopify CDN — they render in any normal browser
  and in Canva. (A sandbox with `cdn.shopify.com` blocked will show empty photo cards only.)
- Copy rules honoured: stock is **aftermarket** (never "genuine"/"OEM"); no manufacturer logos;
  eBay price = website × 1.07 shown as "save 7%".
