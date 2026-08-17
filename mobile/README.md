# Warehouse Hub — Android App (JR-927M handheld)

A native Android app (Capacitor) that wraps the live Warehouse Hub. It installs
and runs like any downloaded app — its own icon, full-screen, standalone — **not**
a browser tab. It's built for the rugged **JR-927M** handheld scanners.

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
   …or run the **Build Android app** workflow from the **Actions** tab (you can
   optionally override the site URL there to build a Razoryn/staging variant).
2. When it finishes, download **`warehouse-hub-apk`** from the run's **Artifacts**
   (tag builds also attach the APK to a GitHub Release).
3. Sideload onto each device: copy `warehouse-hub.apk` over, enable **Install
   unknown apps** for your file manager, tap to install. Installing a newer APK
   over the old one keeps its data.

## Build locally (optional)

Requires Node 20+, JDK 17 and the Android SDK.

```
cd mobile
npm install
npx cap add android      # generates the native project (git-ignored)
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

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

The default build uses Capacitor's placeholder icon. To brand it, drop a square
**1024×1024 PNG** logo and run `@capacitor/assets` (generates every Android
density), or replace the icons under `android/app/src/main/res/mipmap-*` after
`npx cap add android`, then rebuild.

## Signed release (before wide rollout)

The CI ships a **debug-signed** APK — fine for sideloading onto your own devices.
For a Play Store / managed-device (MDM) rollout, generate an upload keystore, add
it as repo secrets, and add a `assembleRelease` + signing step to the workflow.
