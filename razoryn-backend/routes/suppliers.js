// routes/suppliers.js — a saved supplier list you load from (and reuse when
// re-ordering). Suppliers accumulate automatically: any supplier name typed on a
// cost or incoming entry is upserted here, so the dropdowns fill themselves over
// time. Also editable directly.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureSuppliersTable() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS suppliers (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      default_currency TEXT,
      contact       TEXT,
      lead_time_days INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Case-insensitive uniqueness on name so a supplier isn't saved twice.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_lower_uq ON suppliers (LOWER(name))`);
    _ready = true;
  } catch (e) { console.warn('[suppliers] migration warning:', e.message); }
}
ensureSuppliersTable();

// Upsert a supplier by name; returns its id (or null). Used by the cost/incoming
// routes so suppliers self-populate. Best-effort — never throws.
async function ensureSupplierByName(name, extra = {}) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  try {
    await ensureSuppliersTable();
    const r = await query(
      `INSERT INTO suppliers (name, default_currency, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (LOWER(name)) DO UPDATE SET
         default_currency = COALESCE(suppliers.default_currency, EXCLUDED.default_currency),
         updated_at = now()
       RETURNING id`,
      [nm, extra.currency || null]);
    return r.rows[0]?.id || null;
  } catch (e) { return null; }
}

// GET /api/suppliers — the list (for dropdowns + management).
router.get('/', requirePermission('inventory'), async (req, res) => {
  await ensureSuppliersTable();
  const { rows } = await query(`SELECT * FROM suppliers ORDER BY LOWER(name)`);
  res.json({ suppliers: rows });
});

// POST /api/suppliers — create/upsert by name.
router.post('/', requireAdmin, async (req, res) => {
  await ensureSuppliersTable();
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    const r = await query(
      `INSERT INTO suppliers (name, default_currency, contact, lead_time_days, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (LOWER(name)) DO UPDATE SET
         default_currency = COALESCE(EXCLUDED.default_currency, suppliers.default_currency),
         contact = COALESCE(EXCLUDED.contact, suppliers.contact),
         lead_time_days = COALESCE(EXCLUDED.lead_time_days, suppliers.lead_time_days),
         notes = COALESCE(EXCLUDED.notes, suppliers.notes),
         updated_at = now()
       RETURNING *`,
      [name, b.defaultCurrency || null, b.contact || null,
       (b.leadTimeDays != null && b.leadTimeDays !== '') ? parseInt(b.leadTimeDays) : null, b.notes || null]);
    await audit(req, 'supplier_save', 'supplier', r.rows[0].id, { name });
    res.json({ ok: true, supplier: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// PATCH /api/suppliers/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  await ensureSuppliersTable();
  const b = req.body || {};
  const map = { name: 'name', defaultCurrency: 'default_currency', contact: 'contact', leadTimeDays: 'lead_time_days', notes: 'notes' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    let v = b[k];
    if (col === 'lead_time_days') v = (v === '' || v == null) ? null : parseInt(v);
    params.push(v); sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  params.push(req.params.id);
  const { rows } = await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, supplier: rows[0] });
});

// DELETE /api/suppliers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  await ensureSuppliersTable();
  await query(`DELETE FROM suppliers WHERE id = $1`, [req.params.id]);
  await audit(req, 'supplier_delete', 'supplier', req.params.id, null);
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Supplier SKUs — per-product supplier links. A product can be sourced from
// several suppliers, each with their OWN part code (the "supplier SKU") and
// price. Warehouse-internal only: nothing here is ever pushed to eBay or
// Shopify. Powers: per-supplier pricing (with a fallback supplier when one is
// out of stock), the reorder picker + Excel/CSV export, and "who did we buy
// this from" lookups by supplier SKU.
// ──────────────────────────────────────────────────────────────────────────
let _linksReady = false;
async function ensureLinksTable() {
  if (_linksReady) return;
  try {
    await ensureSuppliersTable();
    await query(`CREATE TABLE IF NOT EXISTS product_suppliers (
      id                SERIAL PRIMARY KEY,
      product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      supplier_id       INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      supplier_sku      TEXT,
      unit_cost         NUMERIC(12,2),
      currency          TEXT DEFAULT 'GBP',
      preferred         BOOLEAN NOT NULL DEFAULT false,
      in_stock          BOOLEAN NOT NULL DEFAULT true,
      notes             TEXT,
      last_purchased_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (product_id, supplier_id)
    )`);
    await query(`CREATE INDEX IF NOT EXISTS product_suppliers_sku_idx ON product_suppliers (LOWER(supplier_sku))`);
    // Price basis (incoterm) for the supplier's price: FOB = they get it onto the
    // ship (freight on top); EXW = ex-works, collected from their factory (freight
    // + local haulage on top). Makes supplier prices comparable at a glance.
    await query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS price_basis TEXT`);
    // Reorder history — a record of every repurchase list exported/placed, so
    // "what did we last order from X and when" has an answer.
    await query(`CREATE TABLE IF NOT EXISTS supplier_reorders (
      id          SERIAL PRIMARY KEY,
      supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      lines       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    _linksReady = true;
  } catch (e) { console.warn('[suppliers] links migration warning:', e.message); }
}

// GET /api/suppliers/links/:productId — this product's supplier links.
// Preferred supplier first, then in-stock ones, so the top row is "order from
// here"; the rows below are the fallbacks when that supplier is out of stock.
router.get('/links/:productId', requirePermission('inventory'), async (req, res) => {
  try {
    await ensureLinksTable();
    const { rows } = await query(`
      SELECT ps.*, s.name AS supplier_name, s.default_currency, s.lead_time_days
      FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = $1
      ORDER BY ps.preferred DESC, ps.in_stock DESC, LOWER(s.name)`, [req.params.productId]);
    res.json({ links: rows });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

// POST /api/suppliers/links — upsert one product↔supplier link (admin).
// { productId, supplierName, supplierSku?, unitCost?, currency?, preferred?, inStock?, notes?, lastPurchasedAt? }
router.post('/links', requireAdmin, async (req, res) => {
  try {
    await ensureLinksTable();
    const b = req.body || {};
    const productId = parseInt(b.productId);
    if (!productId) return res.status(400).json({ error: 'product_required' });
    const supplierId = await ensureSupplierByName(b.supplierName, { currency: b.currency });
    if (!supplierId) return res.status(400).json({ error: 'supplier_required', message: 'Enter a supplier name.' });
    const cost = (b.unitCost === '' || b.unitCost == null) ? null : parseFloat(b.unitCost);
    const { rows } = await query(`
      INSERT INTO product_suppliers (product_id, supplier_id, supplier_sku, unit_cost, currency, preferred, in_stock, notes, last_purchased_at, price_basis, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      ON CONFLICT (product_id, supplier_id) DO UPDATE SET
        supplier_sku = EXCLUDED.supplier_sku, unit_cost = EXCLUDED.unit_cost,
        currency = EXCLUDED.currency, preferred = EXCLUDED.preferred,
        in_stock = EXCLUDED.in_stock, notes = EXCLUDED.notes,
        last_purchased_at = COALESCE(EXCLUDED.last_purchased_at, product_suppliers.last_purchased_at),
        price_basis = COALESCE(EXCLUDED.price_basis, product_suppliers.price_basis),
        updated_at = now()
      RETURNING *`,
      [productId, supplierId, (b.supplierSku || '').trim() || null, Number.isFinite(cost) ? cost : null,
       (b.currency || 'GBP').toUpperCase(), !!b.preferred, b.inStock !== false,
       (b.notes || '').trim() || null, b.lastPurchasedAt || null,
       String(b.priceBasis || '').trim().toUpperCase().slice(0, 12) || null]);
    // Only one preferred supplier per product — flipping one on flips the rest off.
    if (b.preferred) {
      await query(`UPDATE product_suppliers SET preferred = false WHERE product_id = $1 AND id <> $2`, [productId, rows[0].id]);
    }
    await audit(req, 'supplier_link_save', 'product', productId, { supplierId, sku: rows[0].supplier_sku });
    res.json({ ok: true, link: rows[0] });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// PATCH /api/suppliers/links/:id — small updates (in-stock toggle, cost, preferred).
router.patch('/links/:id', requireAdmin, async (req, res) => {
  try {
    await ensureLinksTable();
    const b = req.body || {};
    const map = { supplierSku: 'supplier_sku', unitCost: 'unit_cost', currency: 'currency',
                  preferred: 'preferred', inStock: 'in_stock', notes: 'notes', lastPurchasedAt: 'last_purchased_at',
                  priceBasis: 'price_basis' };
    const sets = [], params = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (col === 'unit_cost') v = (v === '' || v == null) ? null : parseFloat(v);
      params.push(v); sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no_fields' });
    sets.push('updated_at = now()');
    params.push(req.params.id);
    const { rows } = await query(`UPDATE product_suppliers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    if (b.preferred === true) {
      await query(`UPDATE product_suppliers SET preferred = false WHERE product_id = $1 AND id <> $2`, [rows[0].product_id, rows[0].id]);
    }
    res.json({ ok: true, link: rows[0] });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// DELETE /api/suppliers/links/:id
router.delete('/links/:id', requireAdmin, async (req, res) => {
  try {
    await ensureLinksTable();
    await query(`DELETE FROM product_suppliers WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete_failed', message: e.message }); }
});

// GET /api/suppliers/find?q= — "who did we buy this from?" Search by supplier
// SKU (their part code), our SKU/part number, or product title; returns the
// matching links with product + supplier context.
router.get('/find', requirePermission('inventory'), async (req, res) => {
  try {
    await ensureLinksTable();
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const { rows } = await query(`
      SELECT ps.*, s.name AS supplier_name, s.contact, s.lead_time_days,
             p.sku, p.title, p.part_number, p.qty_on_hand, p.low_stock_threshold
      FROM product_suppliers ps
      JOIN suppliers s ON s.id = ps.supplier_id
      JOIN products p ON p.id = ps.product_id
      WHERE ps.supplier_sku ILIKE $1 OR p.sku ILIKE $1 OR p.part_number ILIKE $1 OR p.title ILIKE $1 OR s.name ILIKE $1
      ORDER BY ps.preferred DESC, LOWER(s.name), p.title
      LIMIT 100`, [`%${q}%`]);
    res.json({ results: rows });
  } catch (e) { res.status(500).json({ error: 'search_failed', message: e.message }); }
});

// GET /api/suppliers/:id/catalogue — everything linked to this supplier, with
// live stock levels. Feeds the reorder picker: low-stock lines float to the top
// with a suggested reorder quantity.
router.get('/:id/catalogue', requirePermission('inventory'), async (req, res) => {
  try {
    await ensureLinksTable();
    const { rows } = await query(`
      SELECT ps.id AS link_id, ps.supplier_sku, ps.unit_cost, ps.currency, ps.preferred, ps.in_stock,
             ps.notes, ps.last_purchased_at,
             p.id AS product_id, p.sku, p.title, p.part_number, p.brand, p.model,
             p.qty_on_hand, p.low_stock_threshold
      FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
      WHERE ps.supplier_id = $1 AND p.active = true
      ORDER BY (p.qty_on_hand <= COALESCE(p.low_stock_threshold, 3)) DESC, p.title`, [req.params.id]);
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

// POST /api/suppliers/:id/reorder — record a reorder (admin). Stamps
// last_purchased_at on the touched links and files the list in
// supplier_reorders. The CSV itself is built client-side from the same lines.
// { lines: [{ linkId, productId, qty }] }
router.post('/:id/reorder', requireAdmin, async (req, res) => {
  try {
    await ensureLinksTable();
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.filter(l => l && parseInt(l.qty) > 0) : [];
    if (!lines.length) return res.status(400).json({ error: 'no_lines' });
    const linkIds = lines.map(l => parseInt(l.linkId)).filter(Boolean);
    if (linkIds.length) {
      await query(`UPDATE product_suppliers SET last_purchased_at = now(), updated_at = now() WHERE id = ANY($1::int[])`, [linkIds]);
    }
    const r = await query(
      `INSERT INTO supplier_reorders (supplier_id, lines, created_by) VALUES ($1, $2::jsonb, $3) RETURNING id, created_at`,
      [req.params.id, JSON.stringify(lines), req.user.id]);
    await audit(req, 'supplier_reorder', 'supplier', req.params.id, { lines: lines.length });
    res.json({ ok: true, reorderId: r.rows[0].id, createdAt: r.rows[0].created_at });
  } catch (e) { res.status(500).json({ error: 'reorder_failed', message: e.message }); }
});

// GET /api/suppliers/:id/reorders — recent reorder history for one supplier.
router.get('/:id/reorders', requirePermission('inventory'), async (req, res) => {
  try {
    await ensureLinksTable();
    const { rows } = await query(`
      SELECT r.id, r.lines, r.created_at, u.name AS created_by_name
      FROM supplier_reorders r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.supplier_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [req.params.id]);
    res.json({ reorders: rows });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

router.ensureSupplierByName = ensureSupplierByName;
module.exports = router;
