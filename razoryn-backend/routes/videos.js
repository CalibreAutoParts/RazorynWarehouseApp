// routes/videos.js — feature 10: how-to videos
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePermission('videos'), async (req, res) => {
  const { category } = req.query;
  const where = [], params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM videos ${w} ORDER BY created_at DESC`, params
  );
  res.json({ videos: rows });
});

router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.videoUrl) return res.status(400).json({ error: 'title_and_url_required' });
  const { rows } = await query(
    `INSERT INTO videos (title, description, category, video_url, thumbnail_url, duration_seconds, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.title, b.description || null, b.category || null, b.videoUrl,
     b.thumbnailUrl || null, b.durationSeconds || null, req.user.id]
  );
  await audit(req, 'create_video', 'video', rows[0].id);
  res.status(201).json({ video: rows[0] });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(`DELETE FROM videos WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
