// routes/bundles.js — manage eBay bundle listings (virtual sets of warehouse
// products). See services/bundles.js for the availability model.
const express = require('express');
const { query } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const bundles = require('../services/bundles');

const router = express.Router();

// GET /api/bundles — every bundle with its components, derived availability, and
// the component titles/stock so the UI can render and explain each one.
router.get('/', requireAdmin, async (req, res) => {
  await bundles.ensureBundleTables();
  const { rows: bs } = await query(`SELECT * FROM bundles ORDER BY created_at DESC`);
  const out = [];
  for (const b of bs) {
    const { rows: comps } = await query(
      `SELECT bc.id, bc.qty, bc.product_id, p.sku, p.title, p.qty_on_hand, p.active
         FROM bundle_components bc LEFT JOIN products p ON p.id = bc.product_id
        WHERE bc.bundle_id = $1 ORDER BY bc.id`,
      [b.id]
    );
    out.push({
      id: b.id, ebayItemId: b.ebay_item_id, storeCode: b.store_code,
      sku: b.sku, title: b.title, active: b.active,
      available: await bundles.computeAvailable(b.id),
      components: comps.map(c => ({
        id: c.id, productId: c.product_id, qty: c.qty, sku: c.sku,
        title: c.title, stock: c.qty_on_hand, missing: c.product_id != null && c.qty_on_hand == null,
      })),
    });
  }
  res.json({ bundles: out });
});

// POST /api/bundles  { ebayItemId, storeCode, sku, title, components:[{productId, qty}] }
router.post('/', requireAdmin, async (req, res) => {
  await bundles.ensureBundleTables();
  const { ebayItemId, storeCode, sku, title } = req.body || {};
  const components = Array.isArray(req.body?.components) ? req.body.components : [];
  const clean = components
    .map(c => ({ productId: parseInt(c.productId), qty: Math.max(1, parseInt(c.qty) || 1) }))
    .filter(c => Number.isInteger(c.productId));
  if (clean.length < 2) return res.status(400).json({ error: 'need_at_least_two_components' });

  if (ebayItemId) {
    const dup = await query(`SELECT id FROM bundles WHERE ebay_item_id = $1`, [String(ebayItemId)]);
    if (dup.rows[0]) return res.status(409).json({ error: 'bundle_exists_for_listing', bundleId: dup.rows[0].id });
  }

  const ins = await query(
    `INSERT INTO bundles (ebay_item_id, store_code, sku, title, active)
     VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [ebayItemId ? String(ebayItemId) : null, storeCode || null, sku || null, title || null]
  );
  const bundleId = ins.rows[0].id;
  for (const c of clean) {
    await query(`INSERT INTO bundle_components (bundle_id, product_id, qty) VALUES ($1,$2,$3)`, [bundleId, c.productId, c.qty]);
  }
  const result = await bundles.recomputeAndPush(bundleId);
  await audit(req, 'create_bundle', 'bundle', bundleId, { ebayItemId, components: clean.length, available: result.available });
  res.status(201).json({ id: bundleId, ...result });
});

// PATCH /api/bundles/:id  { sku?, title?, storeCode?, active?, components? }
router.patch('/:id', requireAdmin, async (req, res) => {
  await bundles.ensureBundleTables();
  const id = parseInt(req.params.id);
  const exists = await query(`SELECT id FROM bundles WHERE id = $1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const sets = [], params = [];
  for (const [field, col] of [['sku', 'sku'], ['title', 'title'], ['storeCode', 'store_code'], ['active', 'active'], ['ebayItemId', 'ebay_item_id']]) {
    if (b[field] !== undefined) { params.push(b[field]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length) {
    params.push(id);
    await query(`UPDATE bundles SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  if (Array.isArray(b.components)) {
    const clean = b.components
      .map(c => ({ productId: parseInt(c.productId), qty: Math.max(1, parseInt(c.qty) || 1) }))
      .filter(c => Number.isInteger(c.productId));
    if (clean.length < 2) return res.status(400).json({ error: 'need_at_least_two_components' });
    await query(`DELETE FROM bundle_components WHERE bundle_id = $1`, [id]);
    for (const c of clean) await query(`INSERT INTO bundle_components (bundle_id, product_id, qty) VALUES ($1,$2,$3)`, [id, c.productId, c.qty]);
  }
  const result = await bundles.recomputeAndPush(id);
  await audit(req, 'update_bundle', 'bundle', id, {});
  res.json({ id, ...result });
});

// DELETE /api/bundles/:id — removes the bundle (does NOT touch the eBay listing
// or any component stock; the listing simply stops being qty-managed here).
router.delete('/:id', requireAdmin, async (req, res) => {
  await bundles.ensureBundleTables();
  const id = parseInt(req.params.id);
  await query(`DELETE FROM bundles WHERE id = $1`, [id]);
  await audit(req, 'delete_bundle', 'bundle', id, {});
  res.json({ ok: true });
});

// POST /api/bundles/:id/recompute — force a recompute + push now.
router.post('/:id/recompute', requireAdmin, async (req, res) => {
  await bundles.ensureBundleTables();
  const result = await bundles.recomputeAndPush(parseInt(req.params.id));
  res.json(result);
});

module.exports = router;
