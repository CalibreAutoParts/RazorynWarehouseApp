// routes/locations.js — feature 3: storage locations with photo + description
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// Photos are stored as base64 data URLs in the database (photo_data_url column)
// rather than as files on disk. This is deliberate: Railway's filesystem is
// EPHEMERAL — anything written to a local uploads/ folder is wiped on every
// redeploy. Storing the image inline in Postgres means location photos survive
// deploys without needing a mounted volume. Images are capped at 5MB and
// downscaled client-side isn't required (8MB upload limit, but we reject >5MB
// decoded to keep rows reasonable). The frontend auto-downscales to ~400 KB,
// so this cap is only a safety net for unusual cases.
//
// We use multer memoryStorage so the file lands in req.file.buffer, which we
// convert to a data URL.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('only_images'));
    cb(null, true);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Self-healing: ensure the photo_data_url column exists (older DBs only have
// photo_path). Idempotent.
let _migrated = false;
async function ensureColumns() {
  if (_migrated) return;
  try {
    await query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS photo_data_url TEXT`);
    _migrated = true;
  } catch (e) { console.warn('[locations] migration warning:', e.message); }
}
ensureColumns();

// Convert an uploaded file buffer to a data URL, rejecting oversized images.
function fileToDataUrl(file) {
  if (!file) return null;
  const decodedSize = file.buffer.length;
  if (decodedSize > 5 * 1024 * 1024) {
    const err = new Error('photo_too_large');
    err.userMessage = `Photo is ~${Math.round(decodedSize / 1024)} KB — please use an image under 5 MB.`;
    throw err;
  }
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// GET /api/locations
router.get('/', requirePermission('locations'), async (req, res) => {
  await ensureColumns();
  const { rows } = await query(`
    SELECT l.id, l.code, l.name, l.description, l.photo_path, l.photo_data_url,
           l.created_at, l.updated_at,
           COUNT(p.id)::int AS product_count
    FROM locations l
    LEFT JOIN products p ON p.location_id = l.id AND p.active = true
    GROUP BY l.id
    ORDER BY l.code
  `);
  res.json({ locations: rows });
});

// GET /api/locations/:id  (with products)
router.get('/:id', requirePermission('locations'), async (req, res) => {
  const l = await query('SELECT * FROM locations WHERE id = $1', [req.params.id]);
  if (!l.rows[0]) return res.status(404).json({ error: 'not_found' });
  const products = await query(
    `SELECT id, sku, title, qty_on_hand, low_stock_threshold
     FROM products WHERE location_id = $1 AND active = true
     ORDER BY title`,
    [req.params.id]
  );
  res.json({ location: l.rows[0], products: products.rows });
});

// POST /api/locations  (multipart - optional photo stored as base64)
router.post('/', requirePermission('locations'), upload.single('photo'), async (req, res) => {
  await ensureColumns();
  const { code, name, description } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code_and_name_required' });
  let photoDataUrl = null;
  try { photoDataUrl = fileToDataUrl(req.file); }
  catch (e) { return res.status(413).json({ error: 'photo_too_large', message: e.userMessage }); }
  try {
    const { rows } = await query(
      `INSERT INTO locations (code, name, description, photo_data_url)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, name, description || null, photoDataUrl]
    );
    await audit(req, 'create_location', 'location', rows[0].id, { code });
    res.status(201).json({ location: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code_exists' });
    throw e;
  }
});

// PATCH /api/locations/:id (multipart - optional photo replacement)
router.patch('/:id', requirePermission('locations'), upload.single('photo'), async (req, res) => {
  await ensureColumns();
  const { code, name, description } = req.body || {};
  const sets = [], params = [];
  if (code) { params.push(code); sets.push(`code = $${params.length}`); }
  if (name) { params.push(name); sets.push(`name = $${params.length}`); }
  if (description !== undefined) { params.push(description || null); sets.push(`description = $${params.length}`); }
  if (req.file) {
    let photoDataUrl;
    try { photoDataUrl = fileToDataUrl(req.file); }
    catch (e) { return res.status(413).json({ error: 'photo_too_large', message: e.userMessage }); }
    params.push(photoDataUrl); sets.push(`photo_data_url = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE locations SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'update_location', 'location', rows[0].id);
    res.json({ location: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code_exists' });
    throw e;
  }
});

// DELETE /api/locations/:id
router.delete('/:id', requirePermission('locations'), async (req, res) => {
  // Set products at this location to NULL location to avoid orphans
  await query(`UPDATE products SET location_id = NULL WHERE location_id = $1`, [req.params.id]);
  const { rows } = await query(`DELETE FROM locations WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'delete_location', 'location', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
