# Razoryn e-Parts — Remotion video templates

Four vertical (1080×1920) **sound-on** social videos, on-brand (Barlow Condensed + Inter,
brand red/navy, white logo):

- **OrderStory** (~13s) — story ad: order a part on the phone → **"ORDER PLACED ✓"** →
  the **doorbell rings** → camera **zooms out** to a Razoryn parcel at the door → cuts to
  **"ORDER FROM RAZORYN E-PARTS"** with all the contact/offer info.
- **PriceReveal** (~10s) — punchy hook "Paying too much for car parts?" → part reveal →
  **price slam** → CTA. High-retention.
- **PartsShowcase** (~23s) — snappy montage: each part (model + name + price) on a card.
- **SiteShowcase** (~11s) — address bar **types `razoryn.co.uk`**, the homepage loads, then
  **scrolls the "Shop by vehicle model" range** → URL + free-delivery CTA.

Data is pulled from the collections:
`python3 gen_parts.py` → `src/parts.json`, `python3 gen_models.py` → `src/models.json`.

## Audio
Royalty-free SFX + a light beat bed are **synthesized** (no licensing) into `public/audio/`
by `python3 gen_audio.py`: `doorbell, tap, pop, whoosh, chime, beat`. Each composition wires
them via `<Audio>`. **To use your own music**, drop a file in `public/audio/` and swap the
`beat.wav` reference (or add another `<Audio>`), e.g. in `OrderStory.tsx`.

## Run
```bash
cd ad-system/video
npm install
npm run dev                 # Remotion Studio — preview/scrub all 4 (with sound)
npm run render              # render every composition to out/*.mp4
# individually:
npm run render:order  ·  render:price  ·  render:parts  ·  render:site
```
> Needs internet at render time (product photos load from the Shopify CDN) and
> Chromium (Remotion downloads it on first render). Output is MP4 (H.264 + AAC audio).

## Customise
- **Parts / models:** `gen_parts.py` / `gen_models.py` (or hand-edit the JSON).
- **Colours / fonts / site URL:** `src/brand.ts`.
- **Timing / size:** `src/Root.tsx`.
- **Audio:** `gen_audio.py` or drop your own into `public/audio/`.
- **Real webpage / phone footage:** drop a screen-recording into `public/` and use it
  inside `SiteShowcase.tsx` / `OrderStory.tsx`.

## Notes
- Logos: `public/logo_white.png` / `public/logo_red.png`.
- Output: MP4 — ready for Instagram Reels / TikTok / YouTube Shorts.
