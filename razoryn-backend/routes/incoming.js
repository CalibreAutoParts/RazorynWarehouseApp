// routes/incoming.js — incoming / on-order stock.
//
// Tracks stock that has been ORDERED (containers on the way) but isn't with us
// yet, so the team can: see what's coming, avoid double-ordering, and — when a
// container is unloaded — "receive" the units, which bumps warehouse stock and
// pushes the new quantity to Shopify + every linked eBay store.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  await query(`CREATE TABLE IF NOT EXISTS incoming_stock (
    id            SERIAL PRIMARY KEY,
    product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
    sku           TEXT,
    title         TEXT,
    part_number   TEXT,
    qty_ordered   INTEGER NOT NULL DEFAULT 0,
    qty_received  INTEGER NOT NULL DEFAULT 0,
    container_ref TEXT,
    supplier      TEXT,
    expected_date DATE,
    status        TEXT NOT NULL DEFAULT 'on_order',
    notes         TEXT,
    created_by    INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at   TIMESTAMPTZ
  )`);
  await query(`CREATE INDEX IF NOT EXISTS incoming_status_idx ON incoming_stock (status)`);
  await query(`CREATE INDEX IF NOT EXISTS incoming_product_idx ON incoming_stock (product_id)`);
  _ready = true;
}
ensureTable();

// GET /api/incoming?status=&container=&q=
// Returns incoming rows joined to the live product (current on-hand) + a small
// summary so the UI can show "what's coming" at a glance.
router.get('/', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const { status, container, q } = req.query;
  const where = ["i.status <> 'cancelled'"], params = [];
  if (status) { params.push(status); where.push(`i.status = $${params.length}`); }
  if (container) { params.push(container); where.push(`i.container_ref = $${params.length}`); }
  if (q) { params.push(`%${q}%`); const n = params.length; where.push(`(i.sku ILIKE $${n} OR i.title ILIKE $${n} OR i.part_number ILIKE $${n} OR i.container_ref ILIKE $${n} OR i.supplier ILIKE $${n})`); }
  const { rows } = await query(`
    SELECT i.*, p.qty_on_hand AS product_qty_on_hand, p.title AS product_title, p.sku AS product_sku
    FROM incoming_stock i
    LEFT JOIN products p ON p.id = i.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY (i.status = 'received'), i.expected_date NULLS LAST, i.created_at DESC
    LIMIT 1000`, params);
  const summary = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('on_order','in_transit','arrived'))::int AS open_lines,
      COALESCE(SUM(GREATEST(qty_ordered - qty_received, 0)) FILTER (WHERE status IN ('on_order','in_transit','arrived')), 0)::int AS units_incoming,
      COUNT(DISTINCT container_ref) FILTER (WHERE container_ref IS NOT NULL AND status <> 'received')::int AS open_containers
    FROM incoming_stock WHERE status <> 'cancelled'`);
  res.json({ items: rows, summary: summary.rows[0] });
});

// GET /api/incoming/containers — distinct open container refs (for the filter).
router.get('/containers', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const { rows } = await query(`
    SELECT container_ref AS ref, COUNT(*)::int AS lines,
           COALESCE(SUM(GREATEST(qty_ordered - qty_received,0)),0)::int AS units, MIN(expected_date) AS expected
    FROM incoming_stock
    WHERE container_ref IS NOT NULL AND container_ref <> '' AND status <> 'cancelled'
    GROUP BY container_ref ORDER BY MIN(expected_date) NULLS LAST`);
  res.json({ containers: rows });
});

// POST /api/incoming  { productId?, sku, title, partNumber, qtyOrdered, containerRef, supplier, expectedDate, notes }
router.post('/', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const b = req.body || {};
  const qty = parseInt(b.qtyOrdered);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'qty_required' });

  // Resolve a product link: explicit productId, else look up by SKU/part number.
  let productId = b.productId || null;
  let sku = b.sku || null, title = b.title || null, partNumber = b.partNumber || null;
  if (!productId && (sku || partNumber)) {
    const pr = await query(
      `SELECT id, sku, title, part_number FROM products
        WHERE active = true AND (($1 <> '' AND sku = $1) OR ($2 <> '' AND part_number = $2)) LIMIT 1`,
      [sku || '', partNumber || '']);
    if (pr.rows[0]) { productId = pr.rows[0].id; sku = sku || pr.rows[0].sku; title = title || pr.rows[0].title; partNumber = partNumber || pr.rows[0].part_number; }
  }
  if (productId && (!sku || !title)) {
    const pr = await query(`SELECT sku, title, part_number FROM products WHERE id = $1`, [productId]);
    if (pr.rows[0]) { sku = sku || pr.rows[0].sku; title = title || pr.rows[0].title; partNumber = partNumber || pr.rows[0].part_number; }
  }

  const { rows } = await query(
    `INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [productId, sku, title, partNumber, qty, b.containerRef || null, b.supplier || null,
     b.expectedDate || null, b.status || 'on_order', b.notes || null, req.user.id]);
  await audit(req, 'incoming_create', 'incoming', rows[0].id, { qty, container: b.containerRef });
  res.status(201).json({ item: rows[0] });
});

// POST /api/incoming/bulk
//   { containerRef, supplier, expectedDate, status, lines: [{ productId?, sku?, partNumber?, qty }] }
// Add a whole container of stock at once (a 45HQ is 2000+ pcs across many
// products). Each line links to an existing product — resolved by productId, or
// by SKU / part number (case-insensitive) — so there's no need to retype item
// details. Lines that can't be matched are returned so the user can fix them.
router.post('/bulk', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'no_lines' });

  // Resolve all referenced SKUs/parts in one go.
  const skus = [...new Set(lines.map(l => (l.sku || '').trim()).filter(Boolean))];
  const parts = [...new Set(lines.map(l => (l.partNumber || '').trim()).filter(Boolean))];
  const prodRows = (await query(
    `SELECT id, sku, title, part_number FROM products
      WHERE active = true AND (sku = ANY($1) OR part_number = ANY($2)
        OR LOWER(sku) = ANY($3) OR LOWER(part_number) = ANY($4))`,
    [skus, parts, skus.map(s => s.toLowerCase()), parts.map(s => s.toLowerCase())]
  )).rows;
  const bySku = new Map(), byPart = new Map();
  for (const p of prodRows) {
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
    if (p.part_number) byPart.set(p.part_number.toLowerCase(), p);
  }
  const byId = new Map(prodRows.map(p => [p.id, p]));
  // Also fetch any productId-only lines not already loaded.
  const extraIds = [...new Set(lines.map(l => l.productId).filter(id => id && !byId.has(id)))];
  if (extraIds.length) {
    for (const p of (await query(`SELECT id, sku, title, part_number FROM products WHERE id = ANY($1)`, [extraIds])).rows) byId.set(p.id, p);
  }

  const created = [], unmatched = [];
  for (const l of lines) {
    const qty = parseInt(l.qty);
    if (!Number.isInteger(qty) || qty <= 0) { unmatched.push({ ...l, reason: 'bad qty' }); continue; }
    let prod = (l.productId && byId.get(l.productId))
      || (l.sku && bySku.get(String(l.sku).trim().toLowerCase()))
      || (l.partNumber && byPart.get(String(l.partNumber).trim().toLowerCase()))
      || null;
    if (!prod) { unmatched.push({ ...l, reason: 'no matching product' }); continue; }
    const ins = await query(
      `INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [prod.id, prod.sku, prod.title, prod.part_number, qty, b.containerRef || null, b.supplier || null,
       b.expectedDate || null, b.status || 'on_order', b.notes || null, req.user.id]);
    created.push({ id: ins.rows[0].id, productId: prod.id, sku: prod.sku, qty });
  }
  await audit(req, 'incoming_bulk_add', 'incoming', null, { created: created.length, unmatched: unmatched.length, container: b.containerRef });
  res.json({ ok: true, created: created.length, createdUnits: created.reduce((a, c) => a + c.qty, 0), unmatched });
});

// POST /api/incoming/receive-container  { containerRef, push }
// Receive EVERY remaining line on a container in one action (when it's unloaded)
// — adds all units to stock and pushes each linked product to Shopify + eBay.
router.post('/receive-container', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const ref = (req.body?.containerRef || '').trim();
  if (!ref) return res.status(400).json({ error: 'containerRef_required' });
  const push = req.body?.push !== false;
  const { rows } = await query(
    `SELECT * FROM incoming_stock WHERE container_ref = $1 AND status NOT IN ('received','cancelled')`, [ref]);
  let receivedLines = 0, receivedUnits = 0, pushed = 0;
  const { pushProductStockToChannels } = require('./products');
  for (const row of rows) {
    const remaining = Math.max(0, row.qty_ordered - row.qty_received);
    if (remaining <= 0) continue;
    await query(`UPDATE incoming_stock SET qty_received = qty_ordered, status = 'received', received_at = COALESCE(received_at, now()), updated_at = now() WHERE id = $1`, [row.id]);
    receivedLines++; receivedUnits += remaining;
    if (row.product_id) {
      await query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [remaining, row.product_id]);
      await query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'incoming_received',$3,$4)`, [row.product_id, remaining, row.id, req.user.id]).catch(() => {});
      if (push) { try { await pushProductStockToChannels(row.product_id); pushed++; } catch (e) {} }
    }
  }
  await audit(req, 'incoming_receive_container', 'incoming', null, { container: ref, receivedLines, receivedUnits });
  res.json({ ok: true, receivedLines, receivedUnits, pushed });
});

// PATCH /api/incoming/:id — edit fields (qty, container, supplier, expected, status, notes, product link).
router.patch('/:id', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const b = req.body || {};
  const map = {
    qtyOrdered: 'qty_ordered', containerRef: 'container_ref', supplier: 'supplier',
    expectedDate: 'expected_date', status: 'status', notes: 'notes',
    sku: 'sku', title: 'title', partNumber: 'part_number', productId: 'product_id',
  };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    let v = b[k];
    if (col === 'qty_ordered') v = parseInt(v) || 0;
    if (col === 'expected_date' && !v) v = null;
    params.push(v); sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  params.push(req.params.id);
  const { rows } = await query(`UPDATE incoming_stock SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ item: rows[0] });
});

// POST /api/incoming/:id/receive  { qty, push }
// Receive units off a container: bump qty_received, and (when linked to a
// product) add them to warehouse stock + push to Shopify/eBay. Status advances
// to 'received' once fully received, else 'arrived' (partially received).
router.post('/:id/receive', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const b = req.body || {};
  const row = (await query(`SELECT * FROM incoming_stock WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  const remaining = Math.max(0, row.qty_ordered - row.qty_received);
  const qty = b.qty != null ? parseInt(b.qty) : remaining;
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'invalid_qty' });
  if (qty > remaining) return res.status(400).json({ error: 'over_receive', message: `Only ${remaining} remaining on this line.` });

  const newReceived = row.qty_received + qty;
  const fully = newReceived >= row.qty_ordered;
  await query(
    `UPDATE incoming_stock SET qty_received = $1, status = $2, received_at = COALESCE(received_at, now()), updated_at = now() WHERE id = $3`,
    [newReceived, fully ? 'received' : 'arrived', row.id]);

  // Add to warehouse stock + push to channels when linked to a product.
  let channelPush = null, stockUpdated = false;
  if (row.product_id) {
    await query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [qty, row.product_id]);
    await query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'incoming_received',$3,$4)`,
      [row.product_id, qty, row.id, req.user.id]).catch(() => {});
    stockUpdated = true;
    if (b.push !== false) {
      try {
        const { pushProductStockToChannels } = require('./products');
        channelPush = await pushProductStockToChannels(row.product_id);
      } catch (e) { channelPush = { error: e.message }; }
    }
  }
  await audit(req, 'incoming_receive', 'incoming', row.id, { qty, fully });
  res.json({ ok: true, received: qty, fully, stockUpdated, notLinked: !row.product_id, channelPush });
});

// DELETE /api/incoming/:id
router.delete('/:id', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  await query(`DELETE FROM incoming_stock WHERE id = $1`, [req.params.id]);
  await audit(req, 'incoming_delete', 'incoming', req.params.id, null);
  res.json({ ok: true });
});

module.exports = router;
