# Overnight Instagram Reel run — Razoryn eParts — 2026-07-23

## Outcome: STOPPED before publishing — 0 Reels posted (by design, per the hard rules)

No Reels were published. This was **not** a failure of the Instagram account or its
connection — it is a tooling/authorisation problem with the posting channel in this
unattended session. Details below. Nothing was skipped silently and no paid/boosted
route was used.

## What completed successfully

1. **IG connection verified ACTIVE.** Early in the run, `COMPOSIO_MANAGE_CONNECTIONS`
   (toolkit `instagram`) returned status `active` for account **@razorynautoparts**
   (user id `27977252611965554`). So the account link itself is healthy.
2. **Products selected** (live Shopify Admin GraphQL, ACTIVE, created_at ≥ 2026-07-14,
   newest first, left/right duplicates collapsed, distinct vehicle models). See
   `out/selection.json`:
   - Nissan Juke F16 2019–2026 Rear Quarter Wheel Arch Moulding — £25.26 (L; R also available)
   - Toyota Yaris 2020–2026 Front Right Foglamp Cover Grille — £55.57
   - Nissan Qashqai J12 2020–2026 Front Left Foglamp Cover Grille — £33.24 (L; R also available)
3. **Captions written** — fresh, per-product, truthful to the listings, 14–15 hashtags
   each. Free-delivery line used only on the £55.57 item (the only one over £50). See
   `out/captions.md`.
4. **Render pipeline proven** — in the Composio open-internet sandbox I confirmed the
   three product images download (HTTP 200, 1600×1600), ffmpeg 7.1 is present, and I
   built a reusable 3-scene 1080×1920 build script (hook → product+callouts → CTA).

## Why it stopped (the blocker)

Two environment constraints combined:

- **`cdn.shopify.com` is blocked from the local machine** (HTTP 403 on both the CDN
  root and real product-image file URLs). The product photos can only be fetched from a
  route with open internet — which in this session was the **Composio remote sandbox**.
- **The Composio MCP server dropped mid-run and came back requiring interactive
  re-authentication.** This session is non-interactive, so the OAuth flow cannot be
  completed here. After the reconnect, **no `COMPOSIO_*` tools are available** — that
  server was both the sanctioned Instagram publish route (`INSTAGRAM_POST_IG_USER_MEDIA`
  → `..._PUBLISH`) **and** the open-internet sandbox used for rendering.

With Composio gone, both remaining steps are blocked: I can neither render (no image
access locally) nor publish (no Instagram publish tool).

## Why I did not use another route

The only Instagram-capable tools still connected are the **Meta Ads** MCP
(`ads_boost_ig_post`, `ads_create_campaign`, `ads_create_creative`, …). These create
**paid** ads/boosts. The hard rules for this run are explicit: *"Organic posts only. Do
NOT create, edit, boost, or fund any paid campaign,"* and *"if it isn't active, stop and
report — don't improvise another posting route."* So I deliberately did **not** publish
through them. `posted_log.json` remains `[]`.

## To finish the job (when a route is available)

Re-run in a session where **Composio is authenticated** (interactive `/mcp` re-auth, or a
cron/web run with Composio pre-authorised). Everything else is ready:
- Selection + image URLs: `out/selection.json`
- Captions: `out/captions.md`
- The three products are still not in `out/posted_log.json`, so a re-run will pick them
  up and won't double-post.

Alternatively, if `cdn.shopify.com` were reachable locally, the videos could be rendered
here with the local ffmpeg and only the publish step would need Composio.

## UPDATE — manual render kit added (build the ads yourself)

Since publishing via Composio was blocked and `cdn.shopify.com` is egress-blocked in
this cloud sandbox (so the videos can't be rendered here), the three ads are now a
one-command render you run on your own machine, where the Shopify photos are reachable:

```
cd ad-system/video
npm install
npm run render:products
```

Outputs `ad-system/video/out/products/{juke-f16-rear-arch,yaris-foglamp-grille,qashqai-j12-foglamp-grille}.mp4`
— upload each as an Instagram Reel with the matching caption from `out/captions.md`.
Full instructions + caption↔file mapping: `ad-system/video/PRODUCT_ADS_README.md`.
The new `ProductAd` Remotion composition is driven entirely by `ad-system/video/src/products.json`.

## Files
- `out/report.md` — this report
- `out/selection.json` — chosen products, prices, URLs, image URLs
- `out/captions.md` — ready-to-paste captions + hashtags
- `out/posted_log.json` — `[]` (nothing posted; nothing to de-dupe against yet)
