# Razoryn e-Parts — Remotion video templates

Two short vertical (1080×1920) social videos, on-brand (Barlow Condensed + Inter,
brand red/navy, white logo):

- **PartsShowcase** — snappy montage: each part (model + name + price) on a card, ~1.6s
  each, with intro & CTA (≈23s for 12 parts).
- **SiteShowcase** — quick & snappy (~9s): the address bar **types `razoryn.co.uk`**, the
  homepage loads, then it **scrolls down through the product range** (live grid of parts),
  ending on the URL + free-delivery offer.

Both pull their parts from the collection data — run `python3 gen_parts.py` to refresh
`src/parts.json` (one hero part per model, premium-first).

## Run
```bash
cd ad-system/video
npm install
npm run dev                 # opens Remotion Studio to preview/tweak
npm run render              # renders both MP4s into out/
# or individually:
npm run render:parts
npm run render:site
```
> Needs internet at render time (product photos load from the Shopify CDN) and
> Chromium (Remotion downloads it on first render).

## Customise
- **Parts shown:** `python3 gen_parts.py` regenerates `src/parts.json` from the
  collections. Edit `CAP` (count) / selection logic there, or hand-edit `parts.json`.
- **Colours/fonts/site URL:** `src/brand.ts`.
- **Timing/size:** `src/Root.tsx` (durations, fps, 1080×1920).
- **Real webpage footage:** drop a screen-recording or homepage screenshot into
  `public/` and use it inside the `Browser` component in `src/SiteShowcase.tsx`
  instead of the product-tile grid.

## Notes
- Logos live in `public/logo_white.png` / `public/logo_red.png` (copied from the ad system).
- Output is MP4 (H.264) — ready for Instagram Reels / TikTok / YouTube Shorts.
