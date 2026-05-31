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
| `data/03-yaris-cross.json` | Live Shopify data for the Yaris Cross collection. |
| `razoryn-03-toyota-yaris-cross.html` | Listing file (18 products × 3 schemes, front/back). |
| `promo-*.html` | One file per promo (each × 3 schemes). |
| `razoryn-promos.html` | Combined review sheet — all 6 promos × 3 schemes in one print job. |

## Promo formats (`build_promos.py`)

1. **Beat eBay / Buy Direct** — price-led hero: "SAVE 7% BUY DIRECT", eBay vs website price compare.
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

## Canva workflow

Open a file in a browser → **Print → Save as PDF** (Margins: None, Background graphics: **ON**)
→ Canva **Create design → Import** the PDF (becomes an editable multi-page design).
Each ad is its own clean 1080×1350 page via `@page` + `@media print`.

## Notes

- Product photos are loaded live from the Shopify CDN — they render in any normal browser
  and in Canva. (A sandbox with `cdn.shopify.com` blocked will show empty photo cards only.)
- Copy rules honoured: stock is **aftermarket** (never "genuine"/"OEM"); no manufacturer logos;
  eBay price = website × 1.07 shown as "save 7%".
