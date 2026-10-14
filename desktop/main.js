// Warehouse Hub — desktop app + PRINT AGENT.
//
// A thin native shell around the live web app (it always runs the latest
// deployed site), plus a background print agent that works like the FedEx /
// Royal Mail Click & Drop desktop apps:
//   • lives in the system tray and starts with Windows,
//   • keeps printing with the window closed (close = hide to tray),
//   • pulls packing-label jobs from the warehouse server's print queue and
//     prints them SILENTLY to the chosen label printer — no browser, no
//     dialogs, no Chrome flags; everyday Chrome is completely unaffected,
//   • catches up the moment the PC wakes from sleep.
// The server decides WHEN jobs release (channel toggles, batch interval,
// quiet hours); the agent just prints what it's given and confirms each job.
const { app, BrowserWindow, shell, session, Menu, Tray, nativeImage, dialog, ipcMain, powerMonitor, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const SITES = [
  { name: 'Calibre Auto Parts', url: 'https://warehouse.calibreautoparts.co.uk' },
  { name: 'Razoryn e-Parts', url: 'https://warehouse.razoryn.co.uk' },
];

let APP_URL = process.env.WAREHOUSE_URL || null;
let mainWindow = null;
let tray = null;
let quitting = false;

// ── Local settings (per computer) ─────────────────────────────────────────
let cfg = {};
const cfgFile = () => path.join(app.getPath('userData'), 'agent.json');
function loadCfg() { try { cfg = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (_) { cfg = {}; } }
function saveCfg() { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (_) {} }

// One running copy only — a second launch (or autostart + a click) just
// brings the existing window forward instead of starting a second agent.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => showMain());

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ hidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: !hidden,
    backgroundColor: '#0D1B2A',
    title: 'Warehouse Hub',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(APP_URL);

  // Links that leave the app open in the user's normal browser.
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

  // With the print agent on, closing the window hides it to the tray —
  // like the shipping apps — so printing carries on.
  mainWindow.on('close', (e) => {
    if (cfg.printAgent && !quitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!cfg.toldAboutTray) {
        cfg.toldAboutTray = true; saveCfg();
        notify('Still printing in the background', 'Warehouse Hub keeps printing packing labels from the system tray. Right-click the tray icon to open it or quit.');
      }
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Hidden agent/print windows would keep the app alive — with the agent
    // off, closing the main window means quit.
    if (!cfg.printAgent && process.platform !== 'darwin') { quitting = true; app.quit(); }
  });
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch (_) {}
}

// ── The print agent ───────────────────────────────────────────────────────
const agent = { state: 'off', lastError: null, pending: 0, printing: false, lastPrintedAt: null, printed: 0 };
let agentWin = null;
let agentTimer = null;

// A hidden window parked on the warehouse site gives the agent a same-origin
// context that carries the logged-in session cookie for its API calls.
function waitLoaded(wc, ms = 30000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return resolve(true);
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    wc.once('did-finish-load', () => fin(true));
    wc.once('did-fail-load', () => fin(false));
    setTimeout(() => fin(false), ms);
  });
}
async function agentFetch(pathname, method = 'GET') {
  if (!agentWin || agentWin.isDestroyed()) {
    agentWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    agentWin.loadURL(APP_URL + '/app');
  }
  const ok = await waitLoaded(agentWin.webContents);
  if (!ok) { try { agentWin.destroy(); } catch (_) {} agentWin = null; throw new Error('offline'); }
  return agentWin.webContents.executeJavaScript(
    `fetch(${JSON.stringify(pathname)}, { method: ${JSON.stringify(method)}, credentials: 'include',
       headers: { 'Content-Type': 'application/json' }${method === 'POST' ? ", body: '{}'" : ''} })
     .then(async (r) => ({ status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null }))`, true);
}

function printUrl(url) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    let done = false;
    const finish = (ok, reason) => {
      if (done) return; done = true;
      if (!ok) agent.lastError = reason || 'print failed';
      setTimeout(() => { try { w.destroy(); } catch (_) {} }, 1500);
      resolve(ok);
    };
    w.webContents.once('did-fail-load', () => finish(false, 'could not load labels'));
    w.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const opts = {
          silent: true,
          printBackground: true,
          margins: { marginType: 'none' },
          pageSize: { width: 101600, height: 152400 },   // 4in × 6in, in microns
        };
        if (cfg.printer) opts.deviceName = cfg.printer;
        w.webContents.print(opts, (success, reason) => finish(success, reason));
      }, 400);
    });
    w.loadURL(url);
    setTimeout(() => finish(false, 'timed out'), 90000);
  });
}

function setState(state, err) {
  agent.state = state;
  if (err !== undefined) agent.lastError = err;
  updateTray();
}

async function agentPoll() {
  if (!cfg.printAgent || agent.printing || !APP_URL) return;
  agent.printing = true;
  try {
    const r = await agentFetch('/api/printing/queue');
    if (r.status === 401) {
      // Login cookie expired (30 days) — say so once instead of going quiet.
      if (agent.state !== 'login') notify('Warehouse Hub needs you to sign in', 'Packing labels are queueing but can’t print until someone signs in to the app on this computer. Click the tray icon to open it.');
      setState('login', 'Sign in to the app once so the agent can print');
      return;
    }
    if (r.status !== 200 || !r.data) { setState('error', 'Server answered ' + r.status); return; }
    const q = r.data;
    agent.pending = q.pending || 0;
    setState(q.enabled === false ? 'paused' : 'ok', null);
    if (!q.allowed || !q.jobs || !q.jobs.length) return;
    const ids = q.jobs.map(j => j.jobId);
    const ok = await printUrl(APP_URL + '/api/printing/labels?jobs=' + ids.join(','));
    for (const id of ids) {
      try { await agentFetch(`/api/printing/jobs/${id}/${ok ? 'printed' : 'requeue'}`, 'POST'); } catch (_) {}
    }
    if (ok) {
      agent.printed += ids.length;
      agent.lastPrintedAt = new Date().toISOString();
      agent.pending = Math.max(0, agent.pending - ids.length);
      setState('ok', null);
    } else {
      setState('error', agent.lastError || 'print failed');
      notify('Packing labels did not print', (agent.lastError || 'Check the label printer is on and connected.') + ' They are back in the queue.');
    }
  } catch (e) {
    setState('error', e.message === 'offline' ? 'Can’t reach the warehouse server (offline?)' : e.message);
  } finally {
    agent.printing = false;
  }
}

function startAgent() {
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = null;
  if (!cfg.printAgent) { setState('off', null); return; }
  agentTimer = setInterval(agentPoll, 30000);
  setTimeout(agentPoll, 2000);
}

function setAgentEnabled(on) {
  cfg.printAgent = !!on;
  saveCfg();
  // The agent is useless if it isn't running — switching it on also starts
  // the app with Windows (untick in the tray if not wanted).
  if (on && !app.getLoginItemSettings().openAtLogin) setStartAtLogin(true);
  startAgent();
  return agentStatus();
}
function setStartAtLogin(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); } catch (_) {}
  updateTray();
}

async function listPrinters() {
  const wc = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents
    : (agentWin && !agentWin.isDestroyed()) ? agentWin.webContents : null;
  if (!wc) return [];
  try {
    const ps = await wc.getPrintersAsync();
    return ps.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (_) { return []; }
}

function agentStatus() {
  let startAtLogin = false;
  try { startAtLogin = !!app.getLoginItemSettings().openAtLogin; } catch (_) {}
  return {
    enabled: !!cfg.printAgent, printer: cfg.printer || '', state: agent.state, lastError: agent.lastError,
    pending: agent.pending, printed: agent.printed, lastPrintedAt: agent.lastPrintedAt, startAtLogin,
  };
}

// ── Tray ──────────────────────────────────────────────────────────────────
const STATE_TEXT = {
  off: 'Print station: off', ok: 'Print station: ready', paused: 'Print station: auto-print is OFF on the server',
  login: 'Print station: sign in needed', error: 'Print station: problem',
};
async function updateTray() {
  if (!tray) return;
  const printers = await listPrinters();
  const status = STATE_TEXT[agent.state] || 'Print station';
  tray.setToolTip(`Warehouse Hub\n${status}${agent.pending ? ` · ${agent.pending} waiting` : ''}${agent.lastError && agent.state === 'error' ? '\n' + agent.lastError : ''}`);
  let startAtLogin = false;
  try { startAtLogin = !!app.getLoginItemSettings().openAtLogin; } catch (_) {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Warehouse Hub', click: showMain },
    { type: 'separator' },
    { label: 'Print packing labels on this computer', type: 'checkbox', checked: !!cfg.printAgent, click: (mi) => setAgentEnabled(mi.checked) },
    { label: status + (agent.pending ? ` · ${agent.pending} waiting` : ''), enabled: false },
    {
      label: 'Label printer', submenu: [
        { label: 'Windows default printer', type: 'radio', checked: !cfg.printer, click: () => { cfg.printer = ''; saveCfg(); updateTray(); } },
        ...printers.map(p => ({ label: p.displayName + (p.isDefault ? ' (default)' : ''), type: 'radio', checked: cfg.printer === p.name, click: () => { cfg.printer = p.name; saveCfg(); updateTray(); } })),
      ],
    },
    { label: 'Print a test label', click: () => printUrl(APP_URL + '/api/printing/labels/test') },
    { label: 'Check for labels now', click: () => agentPoll() },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startAtLogin, click: (mi) => setStartAtLogin(mi.checked) },
    { label: 'Switch business…', click: switchBusiness },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function buildTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
    tray.on('click', showMain);
    tray.on('double-click', showMain);
    updateTray();
  } catch (e) { console.warn('[tray]', e.message); }
}

// ── Which business is this computer for? ──────────────────────────────────
async function chooseSite() {
  const r = await dialog.showMessageBox({
    type: 'question',
    title: 'Warehouse Hub',
    message: 'Which business is this computer for?',
    detail: 'You can change this later from the tray icon → Switch business.',
    buttons: SITES.map(s => s.name),
    noLink: true,
  });
  return SITES[r.response] ? SITES[r.response].url : SITES[0].url;
}
async function switchBusiness() {
  const url = await chooseSite();
  if (url === cfg.siteUrl) return;
  cfg.siteUrl = url; saveCfg();
  quitting = true;
  app.relaunch();
  app.quit();
}

ipcMain.handle('agent:status', () => agentStatus());
ipcMain.handle('agent:set-enabled', (e, on) => setAgentEnabled(on));
ipcMain.handle('agent:printers', () => listPrinters());
ipcMain.handle('agent:set-printer', (e, name) => { cfg.printer = name || ''; saveCfg(); updateTray(); return agentStatus(); });
ipcMain.handle('agent:set-login', (e, on) => { setStartAtLogin(on); return agentStatus(); });
ipcMain.handle('agent:test', async () => { const ok = await printUrl(APP_URL + '/api/printing/labels/test'); return { ok, reason: ok ? null : agent.lastError }; });
ipcMain.handle('agent:poll', async () => { await agentPoll(); return agentStatus(); });

app.whenReady().then(async () => {
  if (!gotLock) return;
  loadCfg();
  if (!APP_URL) {
    if (!cfg.siteUrl) { cfg.siteUrl = await chooseSite(); saveCfg(); }
    APP_URL = cfg.siteUrl;
  }

  // Allow camera (barcode scanning) and notifications inside the app.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

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

  // Started by Windows at login with the agent on → straight to the tray.
  const startHidden = process.argv.includes('--hidden') && cfg.printAgent;
  createWindow({ hidden: startHidden });
  buildTray();
  startAgent();

  // Back from sleep / network back → print whatever queued meanwhile.
  powerMonitor.on('resume', () => setTimeout(agentPoll, 8000));
  powerMonitor.on('unlock-screen', () => setTimeout(agentPoll, 3000));

  // Self-update the desktop shell from GitHub Releases (installs on next
  // relaunch). The web content is always live already.
  try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) { /* offline / dev */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter(w => w !== agentWin).length === 0) createWindow();
    else showMain();
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  // The agent keeps running in the tray; otherwise behave normally.
  if (process.platform !== 'darwin' && !cfg.printAgent) app.quit();
});
