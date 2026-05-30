// Calibre Warehouse Hub — desktop wrapper.
//
// This is a thin native shell around the live web app. It loads the production
// URL in its own window, so the desktop app always runs the latest deployed
// version — no rebuild needed when the web app updates. Build installers with
// `npm run dist` (or via the GitHub Actions workflow) to get .dmg/.exe/.AppImage.
const { app, BrowserWindow, shell, session, Menu } = require('electron');

// The live site to load. Override at launch with WAREHOUSE_URL=... to point at
// Razoryn or a staging deploy.
const APP_URL = process.env.WAREHOUSE_URL || 'https://warehouse.calibreautoparts.co.uk';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0D1B2A',
    title: 'Calibre Warehouse Hub',
    autoHideMenuBar: true,           // clean, app-like chrome
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Links that leave the app (eBay, Shopify, tracking, external help) open in the
  // user's normal browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Allow camera (barcode scanning) and notifications inside the app.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

  // Minimal native menu: keep platform niceties (copy/paste, reload, quit) but
  // hidden by default via autoHideMenuBar above.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
