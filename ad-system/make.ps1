# Razoryn e-Parts — build all JPEGs + both videos (Windows PowerShell)
#
# Requirements: Node 18+ and a normal internet connection (product photos load
# from the Shopify CDN; Playwright + Remotion download a browser on first run).
#
# Run from the ad-system folder:
#   powershell -ExecutionPolicy Bypass -File make.ps1
# (or, if your policy allows scripts:  ./make.ps1 )

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> [1/3] Installing exporter (Playwright + Chromium)..." -ForegroundColor Cyan
npm install

Write-Host "==> [2/3] Rendering JPEGs for every ad..." -ForegroundColor Cyan
node export_jpg.js
Write-Host "    JPEGs ready in: $PSScriptRoot\export\"

Write-Host "==> [3/3] Rendering the two videos (Remotion)..." -ForegroundColor Cyan
npm --prefix video install
npm --prefix video run render
Write-Host "    Videos ready in: $PSScriptRoot\video\out\"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Images: $PSScriptRoot\export\        (*.jpg - drag into Canva / post)"
Write-Host "  Videos: $PSScriptRoot\video\out\     (parts-showcase.mp4, site-showcase.mp4)"
