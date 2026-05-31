#!/usr/bin/env bash
# One command to produce everything:
#   • JPEGs for every ad  -> ad-system/export/
#   • both videos (MP4)   -> ad-system/video/out/
#
# Requirements: Node 18+ and a normal internet connection (the product photos
# load from the Shopify CDN; Playwright + Remotion download a browser on first run).
#
# Run:  cd ad-system && bash make.sh
set -e
cd "$(dirname "$0")"

echo "==> [1/3] Installing exporter (Playwright + Chromium)…"
npm install

echo "==> [2/3] Rendering JPEGs for every ad…"
node export_jpg.js
echo "    JPEGs ready in: ad-system/export/"

echo "==> [3/3] Rendering the two videos (Remotion)…"
npm --prefix video install
npm --prefix video run render
echo "    Videos ready in: ad-system/video/out/"

echo ""
echo "✅ Done."
echo "   • Images : $(pwd)/export/        (*.jpg — drag into Canva / post)"
echo "   • Videos : $(pwd)/video/out/     (parts-showcase.mp4, site-showcase.mp4)"
