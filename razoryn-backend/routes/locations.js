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

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const LOC_DIR = path.join(UPLOAD_DIR, 'locations');
fs.mkdirSync(LOC_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOC_DIR),
    filename: (req, file, cb) => {
      const stamp = Date.now() + '-' + Math.round(Math.random() * 1e6);
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '') || '.jpg';
      cb(null, `loc-${stamp}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('only_images'));
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

// GET /api/locations
router.get('/', requirePermission('locations'), async (req, res) => {
  const { rows } = await query(`
    SELECT l.*, COUNT(p.id)::int AS product_count
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

// POST /api/locations  (multipart - optional photo)
router.post('/', requirePermission('locations'), upload.single('photo'), async (req, res) => {
  const { code, name, description } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code_and_name_required' });
  const photoPath = req.file ? path.relative(UPLOAD_DIR, req.file.path) : null;
  try {
    const { rows } = await query(
      `INSERT INTO locations (code, name, description, photo_path)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, name, description || null, photoPath]
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
  const { code, name, description } = req.body || {};
  const sets = [], params = [];
  if (code) { params.push(code); sets.push(`code = $${params.length}`); }
  if (name) { params.push(name); sets.push(`name = $${params.length}`); }
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (req.file) {
    const photoPath = path.relative(UPLOAD_DIR, req.file.path);
    params.push(photoPath); sets.push(`photo_path = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE locations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_location', 'location', rows[0].id);
  res.json({ location: rows[0] });
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
