# Warehouse Hub — Android App (JR-927M handheld)

A native Android app (Capacitor) that wraps the live Warehouse Hub. It installs
and runs like any downloaded app — its own icon, full-screen, standalone — **not**
a browser tab. It's built for the rugged **JR-927M** handheld scanners.

## Two branded apps

The build produces a separate APK per brand, each with its **own launcher icon,
name and live URL** — so a device gets the right one:

| Brand   | App name           | Loads                                   | Icon source |
|---------|--------------------|-----------------------------------------|-------------|
| Calibre | Calibre Warehouse  | `warehouse.calibreautoparts.co.uk`      | `razoryn-backend/public/icons/calibre-1024.png` |
| Razoryn | Razoryn Warehouse  | `warehouse.razoryn.co.uk`               | `razoryn-backend/public/icons/razoryn-1024.png` |

Each brand's settings live in `brands/<brand>.json` (app id, name, URL, icon).
`scripts/prepare.js <brand>` writes `capacitor.config.json` and stages that
brand's logo; `capacitor-assets` then generates the Android launcher icons from
it. Because both are just shells over the live site, the two apps can be installed
side by side and each always shows its own brand's latest deployed web app.

> Razoryn's URL defaults to `warehouse.razoryn.co.uk` — if that host differs,
> change it in `brands/razoryn.json` (or override with `APP_URL=` when building).

## How updates work (no re-downloading the APK)

- **The app content** — every page, feature, fix and price change — updates
  **automatically**. The shell always loads the **live** site, so whatever is
  deployed to the server is what staff see on the next screen load / pull-to-
  refresh. You never redistribute an APK for a normal update.
- **The shell itself** (this native wrapper) only needs a new APK for a *large*
  change: a new app icon/name, a different site URL, camera/scanner permissions,
  or a Capacitor upgrade. That's the "larger update through the app" case — build
  a new APK (below) and install it over the old one.

So day-to-day you change the web app and it's instantly live on every device;
you only touch this project for the occasional shell-level change.

## App mode (what staff see on the device)

The web app detects it's running inside this shell (via the `CalibreApp` user-
agent / Capacitor) and automatically switches to **app mode**:

- Nav is stripped to the warehouse workflow — Dashboard, Clock, Inventory,
  Incoming, Scan, Stock Check, Locations, Returns, Dispatch, Notifications — plus
  **Settings**. All the admin/marketing management pages are hidden (even for
  admins) so the device stays focused.
- A **bottom quick-bar** gives one-tap access to Scan / Stock / Dispatch /
  Returns / Home.
- Bigger touch targets, no zoom-on-focus, and safe-area padding so everything
  fits the device screen.

No app-mode work is needed here — it's all in the web app and ships automatically.

## The built-in scanner

The JR-927M's scanner works as a **keyboard wedge** (a trigger-pull "types" the
barcode + Enter). The web app captures that stream **globally**, so pulling the
trigger works from any screen:

- On the **Scan** / **Stock Check** pages it feeds those pages' scan handlers.
- Anywhere else it opens **Inventory** filtered to the scanned code.

If your devices are set to **broadcast/intent** mode instead of keyboard wedge,
either switch them to keyboard/HID output in the device's ScanSettings app (the
simplest fix), or tell us the scanner service and we'll add a Capacitor intent
bridge.

## Get the APK (no local Android setup needed)

Built automatically by GitHub Actions.

1. In GitHub, either push a tag:
   ```
   git tag android-v1.0.0
   git push origin android-v1.0.0
   ```
   …or run the **Build Android app** workflow from the **Actions** tab (pick
   `both`, `calibre` or `razoryn`).
2. When it finishes, download the APK for the brand you want from the run's
   **Artifacts** — **`warehouse-calibre-apk`** and/or **`warehouse-razoryn-apk`**
   (tag builds also attach each APK to a GitHub Release).
3. Sideload onto each device: copy `warehouse-<brand>.apk` over, enable **Install
   unknown apps** for your file manager, tap to install. Installing a newer APK
   over the old one keeps its data.

## Build locally (optional)

Requires Node 20+, JDK 17 and the Android SDK.

```
cd mobile
npm install
node scripts/prepare.js calibre   # or: razoryn  → writes config + stages the icon
npx cap add android               # generates the native project (git-ignored)
npx capacitor-assets generate --android   # brand launcher icons
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Or use the shortcuts: `npm run build:calibre` / `npm run build:razoryn`.

## Configuration

Everything is in `capacitor.config.json`:

- `server.url` — the site the app loads. Defaults to
  `https://warehouse.calibreautoparts.co.uk`. Change it (or use the workflow's
  URL override) for a Razoryn/staging build.
- `appId` / `appName` — the Android package id and app name.
- `appendUserAgent` — `CalibreApp`; this is how the web app knows it's running in
  the shell and enables app mode. Keep it if you change branding, or update the
  matching check in the web app's `detectAppShell()`.

The native `android/` project is **not** committed — it's generated from this
config on every build, so config is the single source of truth.

## App icon (branding)

Each brand's launcher icon is generated automatically from its logo
(`brands/<brand>.json` → `icon`), which points at the existing brand logos in
`razoryn-backend/public/icons/` (`calibre-1024.png`, `razoryn-1024.png`). To
change an icon, replace that PNG (keep it square, 1024×1024) — the next build
regenerates every Android density from it. No manual icon steps needed.

## Signed release (before wide rollout)

The CI ships a **debug-signed** APK — fine for sideloading onto your own devices.
For a Play Store / managed-device (MDM) rollout, generate an upload keystore, add
it as repo secrets, and add a `assembleRelease` + signing step to the workflow.
