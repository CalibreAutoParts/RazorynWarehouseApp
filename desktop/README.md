# Calibre Warehouse Hub — Desktop App

A native desktop wrapper (Electron) around the live Warehouse Hub web app. It
opens the production site in its own window with an app icon — so it installs
and runs like any downloaded desktop program, not a browser tab or extension.

Because it loads the **live** site, the desktop app is always up to date — you
never have to rebuild it when the web app is updated. You only rebuild to ship a
new icon, name, or app behaviour.

## Get the installers (no local setup needed)

The installers are built automatically by GitHub Actions on **real Windows, Mac
and Linux runners** (this can't be done on the Linux container the web app is
developed in).

1. In GitHub, push a tag to trigger a build:
   ```
   git tag desktop-v1.0.0
   git push origin desktop-v1.0.0
   ```
   (or run the **Build desktop app** workflow manually from the **Actions** tab).
2. When it finishes, download from either:
   - the workflow run's **Artifacts** (`warehouse-macos-latest` → `.dmg`,
     `warehouse-windows-latest` → `.exe`, `warehouse-ubuntu-latest` →
     `.AppImage`), or
   - the **Release** it creates for the tag.
3. Install:
   - **Windows** — run the `.exe`, pick an install location, it adds a desktop
     shortcut.
   - **macOS** — open the `.dmg`, drag the app to Applications.
   - **Linux** — make the `.AppImage` executable and run it.

## Build locally (optional)

Requires Node 20+. Only builds for the OS you're on.

```
cd desktop
npm install
npm run dist      # outputs installers to desktop/dist/
npm start         # run the app without packaging (for testing)
```

## How updates work

- **App content** (features, fixes, pages, colours): updates **automatically** —
  the app loads the live site, so the latest deploy shows on the next relaunch
  (or an in-app refresh). No reinstall, ever.
- **The shell** (this Electron wrapper): auto-updates via `electron-updater`
  from GitHub Releases. On launch it checks for a newer release, downloads it in
  the background, and installs on the next relaunch.
  - Windows (`.exe`) and Linux (`.AppImage`) auto-update out of the box.
  - **macOS auto-update requires a signed + notarised app.** Until signing is
    configured, Mac users update by downloading the new `.dmg`.
  - Auto-update activates from the **second** release onward (the first install
    is the baseline it updates *from*). Bump `version` in `package.json` for
    each new release.

## App icon

By default electron-builder uses a placeholder icon. To use the Calibre brand:
drop a square **1024×1024 PNG** at `desktop/build/icon.png` (electron-builder
generates the Windows `.ico` and macOS `.icns` from it automatically), then
rebuild.

## Pointing at a different deployment

The app loads `https://warehouse.calibreautoparts.co.uk` by default. To build a
**Razoryn** variant or point at staging, change `APP_URL` in `main.js` (and the
`productName` / `appId` in `package.json`), or launch with an env override:

```
WAREHOUSE_URL=https://razorynwarehouseapp-production-2077.up.railway.app npm start
```

## Code signing (recommended before wide distribution)

Unsigned apps trigger OS warnings ("unidentified developer" on macOS,
SmartScreen on Windows). To sign, add your certificates as repo secrets and
configure electron-builder signing — then remove `CSC_IDENTITY_AUTO_DISCOVERY:
false` from `.github/workflows/build-desktop.yml`.
