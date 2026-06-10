# Calibre Auto Parts — Video & Ad Factory

A [Remotion](https://www.remotion.dev) project that programmatically generates
**hundreds of high-quality, on-brand vertical videos and image ads** for
Calibre Auto Parts, ready to upload to **TikTok** and **Instagram**.

Everything is data-driven: products, scripts, hooks, stories and offers live in
`src/data`, and a catalog generator turns them into **664+ unique assets**
(≈590 videos + ≈75 stills) across 12 creative formats. Add a product or a hook
and you get dozens more videos for free.

> Brand colours are sampled directly from the official logo
> (`public/logo-calibre.png`): **navy `#223E78`** and **red `#D62828`** on white.
> The real logo PNG is used in every video, so output is always on-brand.

---

## Quick start

```bash
cd calibre-videos
npm install

# 1. Generate the content plan (catalog.json + posting-plan.csv + schedule.csv)
npm run plan

# 2. Preview & tweak any video live in the browser
npm run studio

# 3a. Render ONE of every format (fast quality check) → out/videos, out/stills
npm run render-sample

# 3b. Render EVERYTHING (the full library — long running)
npm run render-all

# 3c. Render just the photo/carousel stills
npm run render-stills
```

Rendered files land in:

- `out/videos/<id>.mp4` — 1080×1920 H.264, ready for TikTok / Reels
- `out/stills/<id>.png` — 1080×1350 photo ads & 1080×1080 carousel slides

### Render a subset

```bash
npx tsx scripts/render-all.ts --only=ad,story   # ids starting "ad" or "story"
npx tsx scripts/render-all.ts --kind=still       # only stills
npx tsx scripts/render-all.ts --limit=50         # first 50 assets
```

---

## The 12 creative formats

| Format | Template | What it's for |
| --- | --- | --- |
| **Product ad** | `AdSpot` | Scroll-stopping hook → part → price → CTA. The workhorse. |
| **Price comparison** | `Comparison` | Main-dealer price vs Calibre, with the £ saving. |
| **UGC review** | `UgcReview` | "Filmed on my phone" customer-style review with stars. |
| **Story time** | `StoryTime` | Multi-part car-flipping / stumble-across-Calibre stories. |
| **Animated explainer** | `Cartoon` | Fully animated cartoon — who Calibre is & what they stand for. |
| **Parts showcase** | `PartsShowcase` | A category (bumpers, headlights…) across makes. |
| **Offer / promo** | `Promo` | Discount codes, drives follows for "exclusive" offers. |
| **Trust / eBay** | `TrustEbay` | Leans on the 100% eBay feedback (evbodyparts). |
| **Testimonial** | `Testimonial` | Clean 5-star review card. |
| **Quick tip** | `TipCard` | Educational how-to — builds authority, earns saves/shares. |
| **Photo ad** *(still)* | `PhotoAd` | Single 1080×1350 feed image. |
| **Carousel** *(stills)* | `Carousel` | Multi-slide swipe posts (each slide a 1080×1080 still). |

Every video ends on a **3-second end card** held long enough to read the
website, eBay status, socials and "Watford, family-run" message.

---

## Audience targeting

The brief's three audiences are baked into the copy and tagged in the plan:

- **Car flippers** — protect your margin, source panels cheap, flip for profit.
- **Garages / trade** — trade accounts, fast turnaround, "we answer the phone".
- **General public** — pranged it? back on the road for less than the quote.

Each asset's `meta.audience`, caption and hashtags are exported to
`out/posting-plan.csv`.

---

## The content plan

`npm run plan` writes three files:

- **`out/catalog.json`** — every asset (id, format, dimensions, duration, props).
- **`out/posting-plan.csv`** — one row per asset: file, type, audience, series,
  duration, ready-to-paste **caption** and **hashtags**.
- **`out/schedule.csv`** — a **5-videos-per-day** upload calendar, with each day
  balanced across formats so the feed stays varied (for A/B testing what works).

Multi-part **story-time** series share a `series` id so you can post Part 1/2/3
on consecutive days and tell viewers to follow for the next part.

---

## Project structure

```
calibre-videos/
├── public/
│   ├── logo-calibre.png        # official logo (used in every video)
│   └── fonts/                  # Anton + Montserrat, bundled locally
├── src/
│   ├── brand/                  # colours, gradients, fonts (the brand kit)
│   ├── components/             # Logo, backgrounds, captions, CTAs, part SVGs,
│   │                           #   cartoon car, phone frame, end card…
│   ├── compositions/           # the 12 templates
│   ├── data/                   # products, stories, hooks, testimonials + the
│   │                           #   catalog generator (pure, Node-readable)
│   ├── Root.tsx                # registers every catalog entry as a composition
│   └── index.ts
└── scripts/
    ├── gen-plan.ts             # builds catalog.json / posting-plan / schedule
    └── render-all.ts           # bundles once, renders all (or a subset)
```

## Scaling to 1,000+

It's all data. To grow the library:

- **Add products** in `src/data/products.ts` — each new part adds ~11 assets
  (ad variants, comparisons, a UGC review and a photo ad).
- **Add hooks** in `src/data/brandFacts.ts` (`HOOKS`) — multiplies ad spots.
- **Add stories / tips / promos / carousels** in `src/data/catalog.ts`.

No rendering code changes needed — `Root.tsx`, the plan and the renderer pick up
new entries automatically.

---

*Family-run, Watford · Quality parts, trade prices · calibreautoparts.co.uk*
