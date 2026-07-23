# Product Reels — render & upload (manual)

Three vertical (1080×1920, ~20s) single-product video ads for Instagram Reels, built
from the newest live listings. Each is one reusable Remotion composition (`ProductAd`)
driven by `src/products.json`. They fetch the real product photo from the Shopify CDN
at render time, so **render on a machine with internet** (this is why they can't be
rendered in the locked-down cloud sandbox).

## Render (Windows PowerShell)

```powershell
cd ad-system\video
npm install          # first time only
npm run render:products
```

Output MP4s land in `ad-system\video\out\products\`:

| File | Product | Price | Caption to use |
|------|---------|-------|----------------|
| `juke-f16-rear-arch.mp4` | Nissan Juke F16 Rear Quarter Wheel Arch Moulding | £25.26 | caption #1 |
| `yaris-foglamp-grille.mp4` | Toyota Yaris Front Foglamp Cover Grille | £55.57 | caption #2 |
| `qashqai-j12-foglamp-grille.mp4` | Nissan Qashqai J12 Front Foglamp Cover Grille | £33.24 | caption #3 |

Captions (fresh, truthful, 14–15 hashtags each) are in
`../../overnight/out/captions.md`.

## Preview / tweak before rendering

```powershell
npm run dev          # opens Remotion Studio; pick a "product-…" composition
```

Edit copy or prices in `src/products.json` and re-render — nothing is hard-coded in
the component.

## Upload to Instagram

Post each MP4 as a **Reel** on @razorynautoparts and paste the matching caption. Uploading
in the Instagram app also lets you add a trending audio track (the videos carry only a
soft background bed, which you can mute/replace in-app).

## Design

Dark automotive look (near-black navy + Razoryn red accent, bold condensed headlines):
1. **0–3s** — "NEW IN" + vehicle name over the product photo
2. **3–14s** — product with slow zoom, animated callouts: part name, fitment (years +
   side), price
3. **14–20s** — CTA card: SHOP NOW, razoryn.co.uk, product + price, UK delivery line

Prices and fitment come straight from the live Shopify listings — no invented claims,
no "genuine/OEM" wording (aftermarket, direct-fit). The free-delivery line only appears
on the item priced over £50 (the Yaris grille).
