# Razoryn e-Parts — Remotion video templates

Two short vertical (1080×1920) social videos, on-brand (Barlow Condensed + Inter,
brand red/navy, white logo):

- **PartsShowcase** — animated montage of parts (photo + name + price) with intro &
  CTA. ~`intro + parts×2.6s + outro` (≈25s with 6 parts).
- **SiteShowcase** — "shop the full range online": a stylised browser window of
  `razoryn.co.uk` with product tiles popping in, ending on the URL + offers. ~14s.

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
- **Parts shown:** edit `PARTS` in `src/brand.ts` (image URL + name + price). Pull
  fresh ones from `../data/*.json` (each product has `imgs`, a name and `price`).
- **Colours/fonts/site URL:** `src/brand.ts`.
- **Timing/size:** `src/Root.tsx` (durations, fps, 1080×1920).
- **Real webpage footage:** drop a screen-recording or homepage screenshot into
  `public/` and use it inside the `Browser` component in `src/SiteShowcase.tsx`
  instead of the product-tile grid.

## Notes
- Logos live in `public/logo_white.png` / `public/logo_red.png` (copied from the ad system).
- Output is MP4 (H.264) — ready for Instagram Reels / TikTok / YouTube Shorts.
