# Razoryn e-Parts — Remotion video templates

Seven vertical (1080×1920) **sound-on, captioned** social videos, on-brand (Barlow
Condensed + Inter, brand red/navy, white logo):

- **OrderStory** (~13s) — story ad: order a part on the phone → **"ORDER PLACED ✓"** →
  the **doorbell rings** → camera **zooms out** to a Razoryn parcel at the door → cuts to
  **"ORDER FROM RAZORYN E-PARTS"** with all the contact/offer info.
- **PriceReveal** (~10s) — punchy hook "Paying too much for car parts?" → part reveal →
  **price slam** → CTA.
- **TradeAccount** (~10s) — "Run a garage or bodyshop?" → trade benefits (pricing, priority
  dispatch, account billing, support) → **"Apply for a trade account"**.
- **FitmentSupport** (~10s) — "Will it fit your car?" → send your reg (number-plate + chat) →
  **"✓ Confirmed before you buy"** → CTA.
- **SameDayDispatch** (~9s) — clock ticks to **12:00** → **"DISPATCHED TODAY"** stamp → CTA.
- **PartsShowcase** (~23s) — snappy montage: each part (model + name + price) on a card.
- **EbayTrust** (~12s) — eBay credibility (top-rated · 1,700+ sold · 98.2% feedback ·
  Razoryn e-Parts / “2daypartsuk”) → buy direct on the website.
- **GenZParts** (~10s) — youth/Gen-Z cut: fast jump-cuts, hand-held shake, trap beat,
  “POV: your bumper’s wrecked” → price-slam → “we got you”.
- **TikTokDeal** (~10s) — TikTok-native (action rail + @handle), promotes **code TIKTOK5
  = 5% off**, viral framing.
- **SiteShowcase** (~11s) — address bar **types `razoryn.co.uk`**, the homepage loads, then
  **scrolls the "Shop by vehicle model" range** → URL + free-delivery CTA.

Data is pulled from the collections:
`python3 gen_parts.py` → `src/parts.json`, `python3 gen_models.py` → `src/models.json`.

## Captions (muted-autoplay)
`src/Captions.tsx` renders big bottom captions; each message ad passes a `cues` array
(`{text, start, end}` in frames; wrap a word in `*asterisks*` to colour it red). Edit the
`cues` at the top of each composition to retime/reword.

## Audio
Royalty-free SFX + a light beat bed are **synthesized** (no licensing) into `public/audio/`
by `python3 gen_audio.py`: `doorbell, tap, pop, whoosh, chime, tick` + **four beds** (`beat`, `beat-drive`,
`beat-lofi`, `beat-trap` via `gen_audio_beds.py`) — each video uses a different bed so they don’t all sound the same. Each composition
wires them via `<Audio>`. **To use your own music**, drop a file in `public/audio/` and swap
the `beat.wav` reference (or add another `<Audio>`).

## Run
```bash
cd ad-system/video
npm install
npm run dev                 # Remotion Studio — preview/scrub all 7 (with sound)
npm run render              # render every composition to out/*.mp4
# individually:
npm run render:order · render:price · render:trade · render:fitment
npm run render:dispatch · render:parts · render:site
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

## Per-collection conversion ads (drive to the website)

A parameterized `CollectionAd` produces a video for **every collection**, in two variants,
plus a UK-market **RHD headlights** ad — all CTA-to-`razoryn.co.uk`:

- `col-<slug>`        — **showcase**: collection car render → parts montage → "N in stock" → SHOP NOW.
- `col-<slug>-deal`   — **deal**: "<model> owner? Stop overpaying" → hero price-slam → buy-direct → CTA.
- `RhdHeadlights`     — right-hand-drive / UK-spec headlights across models → CTA.

Data is generated from the collections: `python3 gen_collections.py` →
`src/collections.json` + `src/headlights.json`.

Render them all in one pass (bundles once — much faster than 44 separate renders):
```bash
npm run render:collections     # → out/collections/col-*.mp4 + RhdHeadlights.mp4
npm run render:rhd             # just the RHD headlights ad
```
Preview/scrub any of them in `npm run dev` (search the composition list for `col-` or `RhdHeadlights`).

## Render everything, organised into folders
```bash
npm run render:all          # bundles once → renders ALL videos into:
#   out/collections/<slug>/showcase.mp4  &  deal.mp4
#   out/promos/<id>.mp4   (brand, RHD, eBay, Gen-Z, TikTok, etc.)
npm run render:collections  # just the per-collection ads
npm run render:tiktok       # single: out/promos/tiktok-deal.mp4  (code TIKTOK5)
npm run render:ebay         # single: eBay trust
npm run render:genz         # single: Gen-Z cut
```
JPEG ads (from `ad-system/`, `npm run export`) are likewise foldered:
`export/collections/<slug>/`, `export/showcases/<slug>/`, `export/promos/<name>/`.

## TikTok deals per collection (A/B which model converts)
`TikTokDeal` is now parameterised by collection — one TikTok-native ad (code **TIKTOK5**,
5% off) **per model**, plus a generic "all cars" one. Product gets its own clean card
(no image behind text). They render to their **own folder**:
```bash
npm run render:tiktok-all   # → out/tiktok/<slug>.mp4  (+ all.mp4)  — every model
npm run render:tiktok       # just the generic "all cars" one → out/tiktok/all.mp4
# single model:  npx remotion render tiktok-i20 out/tiktok/i20.mp4
```
Run each model as its own TikTok ad and compare interactions to see which collection performs.
