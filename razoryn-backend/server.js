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

// ---------- Static: PWA ----------
app.use(express.static(path.join(__dirname, 'public'), {
  // index.html should not be aggressively cached — it changes on every deploy
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
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
const cronExpr = process.env.SYNC_CRON;
if (cronExpr && cronExpr.trim()) {
  if (cron.validate(cronExpr)) {
    cron.schedule(cronExpr, async () => {
      console.log(`[cron] running sync (${cronExpr})`);
      try {
        const sync = require('./services/sync');
        const result = await sync.runFullSync();
        console.log('[cron] sync complete', JSON.stringify(result));
      } catch (e) {
        console.error('[cron] sync failed:', e.message);
      }
    });
    console.log(`[boot] cron scheduled: ${cronExpr}`);
  } else {
    console.warn(`[boot] invalid SYNC_CRON expression: ${cronExpr}`);
  }
}

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[boot] Razoryn warehouse listening on :${PORT}`);
  console.log(`[boot] env=${process.env.NODE_ENV || 'development'} upload_dir=${UPLOAD_DIR}`);
});
