// server.js — Razoryn warehouse Express boot
require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ---------- Middleware ----------
app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

if (process.env.CORS_ORIGIN) {
  app.use(cors({
    origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()),
    credentials: true,
  }));
}

// Request logging in dev
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[${req.method}] ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });
}

// ---------- Static: uploaded photos ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Photos are not public — gate them behind auth so a leaked URL doesn't expose
// internal warehouse images. requireAuth runs on every /uploads request.
const { requireAuth } = require('./middleware/auth');
app.use('/uploads', requireAuth, express.static(UPLOAD_DIR, {
  maxAge: '7d',
  fallthrough: false,
}));

// ---------- Health (must be before everything for Railway healthcheck) ----------
app.get('/health', async (req, res) => {
  try {
    const { query } = require('./db');
    await query('SELECT 1');
    res.json({ ok: true, db: 'up', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

// ---------- API routes ----------
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/stock-checks', require('./routes/stock-checks'));
app.use('/api/sales',        require('./routes/sales'));
app.use('/api/returns',      require('./routes/returns'));
app.use('/api/locations',    require('./routes/locations'));
app.use('/api/schedule',     require('./routes/schedule'));
app.use('/api/kb',           require('./routes/knowledge'));
app.use('/api/videos',       require('./routes/videos'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/staff',        require('./routes/staff'));
app.use('/api/pricing',      require('./routes/pricing'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/listings',     require('./routes/listings'));
app.use('/api/notes',        require('./routes/notes'));
app.use('/api/brand',        require('./routes/brand'));
app.use('/api/dispatch',     require('./routes/dispatch'));
app.use('/api/messages',     require('./routes/messages'));
app.use('/api/customers',    require('./routes/customers'));
app.use('/api/desktop',      require('./routes/desktop'));
// Public logo serving — mounted at /public-logo (NOT /api/settings) so it
// completely bypasses the auth middleware that the settings router applies
// to its whole namespace. Used by <img src="/public-logo"> in invoice HTML
// when an uploaded logo should be visible without auth (email previews, etc).
const settingsModule = require('./routes/settings');
if (settingsModule.publicLogoRouter) {
  app.use('/', settingsModule.publicLogoRouter);
}

// ---------- PWA: brand-aware manifest + app icon ----------
// Defined BEFORE the static/SPA fallback so they aren't swallowed by index.html.
app.get('/manifest.webmanifest', (req, res) => {
  const b = require('./lib/brand');
  const code = b.code || 'razoryn';
  res.type('application/manifest+json').json({
    name: b.appTitle || 'Warehouse Hub',
    short_name: b.name || 'Warehouse',
    description: b.tagline || '',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: b.primaryColor || '#111111',
    icons: [
      { src: `/icons/${code}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `/icons/${code}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      { src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  });
});

// iOS home-screen icon — served per-brand so "Add to Home Screen" uses the
// proper PNG (iOS doesn't render SVG apple-touch icons).
app.get('/apple-touch-icon.png', (req, res) => {
  const code = require('./lib/brand').code || 'razoryn';
  res.sendFile(path.join(__dirname, 'public', 'icons', `${code}-180.png`));
});
app.get('/apple-touch-icon-precomposed.png', (req, res) => {
  const code = require('./lib/brand').code || 'razoryn';
  res.sendFile(path.join(__dirname, 'public', 'icons', `${code}-180.png`));
});

// Brand-aware app icon — a clean monogram (brand colour + white initial). SVG so
// it renders crisply at any size without needing pre-rendered raster icons.
app.get('/app-icon.svg', (req, res) => {
  const b = require('./lib/brand');
  const safe = (c, fb) => (/^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : fb);
  const bg = safe(b.primaryColor, '#111111');
  const accent = safe(b.secondaryColor, '#ffffff');
  const initial = (b.name || 'W').trim().charAt(0).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'W';
  // Monogram on the brand colour with an accent bar echoing the wordmark's
  // accent (Calibre's red dashes / Razoryn's ink). Kept inside the maskable
  // safe zone so it survives circular/rounded OS masks.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${bg}"/>
  <text x="256" y="246" font-family="Arial, Helvetica, sans-serif" font-size="290" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initial}</text>
  <rect x="176" y="372" width="160" height="22" rx="11" fill="${accent}"/>
</svg>`;
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

// ---------- Static: PWA ----------
app.use(express.static(path.join(__dirname, 'public'), {
  // index.html should not be aggressively cached — it changes on every deploy
  setHeaders: (res, filePath) => {
    // index.html changes every deploy; sw.js must update promptly so the cache
    // strategy can't get stuck on an old worker.
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback — anything not matching a file or /api/* serves index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  next();
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error('[err]', req.method, req.path, err.message, err.stack);
  if (err.message === 'only_images') {
    return res.status(400).json({ error: 'only_images' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large' });
  }
  res.status(500).json({ error: 'server_error' });
});

// ---------- Cron: periodic sync ----------
// The sync cron pulls new orders from Shopify + eBay and re-pushes warehouse
// stock to every channel (warehouse = master). It MUST always arm — a silently
// dead scheduler let auto-ingested sales fall ~37 hrs stale before this default
// was added. So, like the returns cron, it defaults to a fixed expression when
// SYNC_CRON is unset, and the only two boot outcomes are "armed" or "warned" —
// never a silent no-op.
const DEFAULT_SYNC_CRON = '*/30 * * * *'; // every 30 min
const cronExpr = (process.env.SYNC_CRON || DEFAULT_SYNC_CRON).trim();
if (cron.validate(cronExpr)) {
  cron.schedule(cronExpr, async () => {
    // Heartbeat: prove the scheduler is alive on every tick, even if the run
    // itself is a no-op (no new orders). Grep Railway logs for "[cron sync]".
    console.log(`[cron sync] tick @ ${new Date().toISOString()} (${cronExpr})`);
    try {
      const sync = require('./services/sync');
      const result = await sync.runFullSync();
      console.log('[cron sync] complete', JSON.stringify(result));
    } catch (e) {
      console.error('[cron sync] failed:', e.message);
    }
  });
  const usingDefault = !process.env.SYNC_CRON;
  console.log(`[boot] sync cron scheduled: ${cronExpr}${usingDefault ? ' (default — SYNC_CRON not set)' : ''}`);
} else {
  // Loud, unmissable: an invalid expression means NO automatic sync at all.
  console.error(`[boot] ⚠️  invalid SYNC_CRON expression "${cronExpr}" — AUTOMATIC SYNC IS DISABLED. Fix SYNC_CRON or unset it to use the default (${DEFAULT_SYNC_CRON}).`);
}

// Auto-pull eBay returns every 15 minutes (or per RETURNS_SYNC_CRON env var).
// Creates notifications for new return cases and state changes — so staff don't have
// to manually click "Pull from eBay" to discover new returns or status updates.
const returnsCronExpr = (process.env.RETURNS_SYNC_CRON || '*/15 * * * *').trim();
if (cron.validate(returnsCronExpr)) {
  cron.schedule(returnsCronExpr, async () => {
    try {
      const { syncEbayReturnsCore } = require('./routes/returns');
      if (typeof syncEbayReturnsCore !== 'function') return;
      const result = await syncEbayReturnsCore({ days: 90 });
      if (result.created || result.updated) {
        console.log(`[cron returns] synced — ${result.created} new, ${result.updated} updated, ${result.notifications} notifications`);
      }
    } catch (e) {
      // Don't spam the log if eBay isn't configured or the token lost scope
      if (!/ebay_not_configured|post_order_api/.test(e.message)) {
        console.error('[cron returns] failed:', e.message);
      }
    }
  });
  console.log(`[boot] returns auto-pull scheduled: ${returnsCronExpr}`);
}

// Nightly cleanup: permanently delete staff_notes older than 31 days.
// Notes are already filtered out of the GET response after 31 days, but this
// keeps the table from growing unbounded.
cron.schedule('15 3 * * *', async () => {
  try {
    const { query } = require('./db');
    const r = await query(`DELETE FROM staff_notes WHERE created_at < now() - INTERVAL '31 days'`);
    if (r.rowCount) console.log(`[cron notes] cleaned ${r.rowCount} expired notes`);
  } catch (e) {
    console.error('[cron notes] cleanup failed:', e.message);
  }
});

// ---------- Start ----------
const brand = require('./lib/brand');

// ──────────────────────────────────────────────────────────────────────────
// Brand-aware boot guard. With two deployments (Calibre + Razoryn) sharing one
// codebase, the common failure modes are config mistakes, not code bugs:
// pointing the new service at an unknown brand, or forgetting JWT_SECRET /
// DATABASE_URL. Fail LOUD in production so a half-working instance never
// silently starts; only warn in development.
// ──────────────────────────────────────────────────────────────────────────
(function bootGuard() {
  const problems = [];
  const requested = (process.env.APP_BRAND || '').toLowerCase().trim();
  if (requested && !brand.all[requested]) {
    problems.push(`APP_BRAND="${process.env.APP_BRAND}" is not a known brand (fell back to "${brand.code}"). Known: ${Object.keys(brand.all).join(', ')}.`);
  }
  if (!process.env.JWT_SECRET) problems.push('JWT_SECRET is not set — auth tokens cannot be signed securely.');
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is not set — no database to connect to.');
  if (!brand.stores.some(s => s.token)) {
    console.warn(`[boot] WARNING: brand "${brand.code}" has no eBay store token — eBay features stay inert until its token env var is set.`);
  }
  if (problems.length) {
    console.error('[boot] Configuration problems:\n  - ' + problems.join('\n  - '));
    if (process.env.NODE_ENV === 'production') {
      console.error('[boot] Refusing to start in production. Fix the env vars and redeploy.');
      process.exit(1);
    }
  }
})();

app.listen(PORT, () => {
  console.log(`[boot] ${brand.appTitle} (${brand.code}) listening on :${PORT}`);
  console.log(`[boot] env=${process.env.NODE_ENV || 'development'} upload_dir=${UPLOAD_DIR}`);
  console.log(`[boot] eBay stores: ${brand.stores.map(s => s.code + (s.token ? '✓' : '✗')).join(', ')}`);
});
