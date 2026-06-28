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
const fx = require('../lib/fx');

const router = express.Router();
router.use(requireAuth);

// Convert a foreign unit cost to GBP at a date, swallowing failures so a cost
// can never block adding incoming stock. Returns { gbp, rate } (gbp null on fail).
async function costToGbp(foreign, currency, date, override) {
  const amt = (foreign != null && foreign !== '') ? parseFloat(foreign) : null;
  if (amt == null || Number.isNaN(amt)) return { gbp: null, rate: null };
  const cur = String(currency || 'CNY').toUpperCase();
  if (cur === 'GBP') return { gbp: +amt.toFixed(4), rate: 1 };
  try { const c = await fx.convert(amt, cur, 'GBP', date || new Date().toISOString().slice(0, 10), { override }); return { gbp: c.gbp, rate: c.rate }; }
  catch (e) { return { gbp: null, rate: (override ? parseFloat(override) : null), failed: true }; }
}

// On receive, copy the line's captured cost into product_cost_history and set the
// product's current cost. Best-effort — never blocks stock receiving.
async function recordReceivedCost(row, qtyReceived, userId) {
  try {
    // Prefer the LANDED unit cost (goods + apportioned freight/duty); fall back to the
    // bare goods cost if the container hasn't been costed yet.
    const landed = (row.landed_unit_cost_gbp != null) ? row.landed_unit_cost_gbp : row.unit_cost_gbp;
    if (landed == null) return false;
    await query(
      `INSERT INTO product_cost_history (product_id, supplier, purchase_date, currency, unit_cost_foreign, fx_rate, unit_cost_gbp, qty, incoming_id, freight_total, duty, note, created_by)
       VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.product_id, row.supplier || null, row.received_at || row.expected_date || null,
       row.currency || 'CNY', row.unit_cost_foreign, row.fx_rate, landed, qtyReceived,
       row.id, row.freight_total, row.duty,
       (row.landed_unit_cost_gbp != null ? 'Received from incoming (landed)' : 'Received from incoming'),
       userId]);
    await query(`UPDATE products SET cost_price = $1, updated_at = now() WHERE id = $2`, [landed, row.product_id]);
    return true;
  } catch (e) { console.warn('[incoming] cost record warning:', e.message); return false; }
}

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
  // Cost capture columns (RMB on the order sheet → GBP at purchase date).
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS unit_cost_foreign NUMERIC(12,4)`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS currency          TEXT DEFAULT 'CNY'`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS fx_rate           NUMERIC(14,8)`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS unit_cost_gbp     NUMERIC(12,4)`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS freight_total     NUMERIC(12,2)`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS duty              NUMERIC(12,2)`);
  // Landed cost = goods unit cost + the apportioned share of the CONTAINER's freight
  // + duty per unit (split across lines by value). The single source of truth for the
  // product's true cost once a container is costed.
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS landed_unit_cost_gbp NUMERIC(12,4)`);
  await query(`ALTER TABLE incoming_stock ADD COLUMN IF NOT EXISTS supplier_id INTEGER`);
  // Container-level freight/duty live here (one row per container_ref). Freight +
  // duty are entered once for the whole container and apportioned across its lines.
  await query(`CREATE TABLE IF NOT EXISTS incoming_containers (
    id            SERIAL PRIMARY KEY,
    container_ref TEXT UNIQUE NOT NULL,
    freight_total NUMERIC(12,2),
    duty          NUMERIC(12,2),
    freight_currency TEXT DEFAULT 'GBP',
    freight_fx_rate  NUMERIC(14,8),
    freight_total_gbp NUMERIC(12,2),
    duty_gbp          NUMERIC(12,2),
    supplier      TEXT,
    supplier_id   INTEGER,
    expected_date DATE,
    status        TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ready = true;
}
ensureTable();

// Apportion a container's freight + duty (GBP) across its lines BY VALUE
// (qty × unit_cost_gbp) and write landed_unit_cost_gbp on each line. Lines with no
// goods cost fall back to an equal-by-qty share so freight/duty is never lost.
// Returns the per-line landed figures. Best-effort; recomputed whenever the
// container header or any of its lines change.
async function reapportionContainer(ref) {
  if (!ref) return;
  const hdr = (await query(`SELECT freight_total_gbp, duty_gbp FROM incoming_containers WHERE container_ref = $1`, [ref])).rows[0] || {};
  const addOn = (parseFloat(hdr.freight_total_gbp) || 0) + (parseFloat(hdr.duty_gbp) || 0);
  const lines = (await query(
    `SELECT id, qty_ordered, unit_cost_gbp FROM incoming_stock WHERE container_ref = $1 AND status <> 'cancelled'`, [ref])).rows;
  if (!lines.length) return;
  const valueOf = (l) => (parseFloat(l.unit_cost_gbp) || 0) * (parseInt(l.qty_ordered) || 0);
  const totalValue = lines.reduce((a, l) => a + valueOf(l), 0);
  const totalQty = lines.reduce((a, l) => a + (parseInt(l.qty_ordered) || 0), 0);
  for (const l of lines) {
    const qty = parseInt(l.qty_ordered) || 0;
    const unit = parseFloat(l.unit_cost_gbp);
    let share = 0;
    if (addOn > 0 && qty > 0) {
      const frac = totalValue > 0 ? (valueOf(l) / totalValue) : (totalQty > 0 ? (qty / totalQty) : 0);
      share = (addOn * frac) / qty;   // freight+duty per unit for this line
    }
    const landed = (unit != null && !Number.isNaN(unit)) ? +(unit + share).toFixed(4)
                 : (share > 0 ? +share.toFixed(4) : null);
    await query(`UPDATE incoming_stock SET landed_unit_cost_gbp = $1 WHERE id = $2`, [landed, l.id]);
  }
}

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

// GET /api/incoming/containers — distinct open container refs (for the filter),
// joined to the container header so the UI can show which ones still need freight/duty.
router.get('/containers', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const { rows } = await query(`
    SELECT i.container_ref AS ref, COUNT(*)::int AS lines,
           COALESCE(SUM(GREATEST(i.qty_ordered - i.qty_received,0)),0)::int AS units, MIN(i.expected_date) AS expected,
           MAX(i.supplier) AS supplier, MAX(i.notes) AS note,
           c.freight_total, c.duty, c.freight_currency, c.freight_total_gbp, c.duty_gbp
    FROM incoming_stock i
    LEFT JOIN incoming_containers c ON c.container_ref = i.container_ref
    WHERE i.container_ref IS NOT NULL AND i.container_ref <> '' AND i.status <> 'cancelled'
    GROUP BY i.container_ref, c.freight_total, c.duty, c.freight_currency, c.freight_total_gbp, c.duty_gbp
    ORDER BY MIN(i.expected_date) NULLS LAST`);
  res.json({ containers: rows });
});

// GET /api/incoming/containers/:ref — one container: header (freight/duty) + its lines
// with the live landed cost per unit + a totals summary.
router.get('/containers/:ref', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const ref = req.params.ref;
  const header = (await query(`SELECT * FROM incoming_containers WHERE container_ref = $1`, [ref])).rows[0] || { container_ref: ref };
  const lines = (await query(`
    SELECT i.*, p.qty_on_hand AS product_qty_on_hand
    FROM incoming_stock i LEFT JOIN products p ON p.id = i.product_id
    WHERE i.container_ref = $1 AND i.status <> 'cancelled'
    ORDER BY i.title NULLS LAST, i.id`, [ref])).rows;
  const goods = lines.reduce((a, l) => a + (parseFloat(l.unit_cost_gbp) || 0) * (parseInt(l.qty_ordered) || 0), 0);
  const addOn = (parseFloat(header.freight_total_gbp) || 0) + (parseFloat(header.duty_gbp) || 0);
  res.json({ header, lines, totals: {
    units: lines.reduce((a, l) => a + (parseInt(l.qty_ordered) || 0), 0),
    goodsValueGbp: +goods.toFixed(2), freightDutyGbp: +addOn.toFixed(2), landedValueGbp: +(goods + addOn).toFixed(2),
  } });
});

// PATCH /api/incoming/containers/:ref — set the container's freight + duty (and
// supplier/eta/notes), convert to GBP, then re-apportion across the lines.
router.patch('/containers/:ref', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const ref = req.params.ref;
  const b = req.body || {};
  const freightCurrency = String(b.freightCurrency || 'GBP').toUpperCase();
  // Convert freight + duty (which share the container currency + date) to GBP.
  const date = b.expectedDate || null;
  const fConv = await costToGbp(b.freightTotal, freightCurrency, date, b.freightFxRate);
  const dConv = await costToGbp(b.duty, freightCurrency, date, b.freightFxRate);
  const num = (v) => (v != null && v !== '') ? parseFloat(v) : null;
  await query(
    `INSERT INTO incoming_containers (container_ref, freight_total, duty, freight_currency, freight_fx_rate, freight_total_gbp, duty_gbp, supplier, supplier_id, expected_date, status, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (container_ref) DO UPDATE SET
       freight_total = EXCLUDED.freight_total, duty = EXCLUDED.duty,
       freight_currency = EXCLUDED.freight_currency, freight_fx_rate = EXCLUDED.freight_fx_rate,
       freight_total_gbp = EXCLUDED.freight_total_gbp, duty_gbp = EXCLUDED.duty_gbp,
       supplier = COALESCE(EXCLUDED.supplier, incoming_containers.supplier),
       supplier_id = COALESCE(EXCLUDED.supplier_id, incoming_containers.supplier_id),
       expected_date = COALESCE(EXCLUDED.expected_date, incoming_containers.expected_date),
       status = COALESCE(EXCLUDED.status, incoming_containers.status),
       notes = COALESCE(EXCLUDED.notes, incoming_containers.notes),
       updated_at = now()`,
    [ref, num(b.freightTotal), num(b.duty), freightCurrency,
     fConv.rate != null ? fConv.rate : (b.freightFxRate != null && b.freightFxRate !== '' ? parseFloat(b.freightFxRate) : null),
     fConv.gbp, dConv.gbp, b.supplier || null, b.supplierId || null, date, b.status || null, b.notes || null]);
  await reapportionContainer(ref);
  const header = (await query(`SELECT * FROM incoming_containers WHERE container_ref = $1`, [ref])).rows[0];
  await audit(req, 'incoming_container_costs', 'incoming', null, { container: ref, freightGbp: fConv.gbp, dutyGbp: dConv.gbp });
  res.json({ ok: true, header, fxFailed: !!(fConv.failed || dConv.failed) });
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

  // Cost capture (optional): foreign unit cost → GBP at the expected/purchase date.
  const currency = String(b.currency || 'CNY').toUpperCase();
  const { gbp: unitCostGbp, rate: usedRate, failed: fxFailed } =
    await costToGbp(b.unitCostForeign, currency, b.expectedDate, b.fxRate);
  const { rows } = await query(
    `INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date, status, notes, created_by,
                                 unit_cost_foreign, currency, fx_rate, unit_cost_gbp, freight_total, duty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [productId, sku, title, partNumber, qty, b.containerRef || null, b.supplier || null,
     b.expectedDate || null, b.status || 'on_order', b.notes || null, req.user.id,
     (b.unitCostForeign != null && b.unitCostForeign !== '') ? parseFloat(b.unitCostForeign) : null,
     currency, usedRate, unitCostGbp,
     (b.freightTotal != null && b.freightTotal !== '') ? parseFloat(b.freightTotal) : null,
     (b.duty != null && b.duty !== '') ? parseFloat(b.duty) : null]);
  await audit(req, 'incoming_create', 'incoming', rows[0].id, { qty, container: b.containerRef });
  if (b.supplier) { try { await require('./suppliers').ensureSupplierByName(b.supplier, { currency }); } catch (_) {} }
  if (b.containerRef) await reapportionContainer(b.containerRef).catch(() => {});

  // If staff linked this line to an existing product AND typed a part number that
  // isn't already the product's master SKU/part number, capture it as a searchable
  // sub part-number — so the factory/country code from this container can later be
  // found in inventory, stock-check, quote builder and sales.
  try {
    const typed = String(b.partNumber || '').trim();
    if (productId && typed) {
      const pr = await query(`SELECT sku, part_number FROM products WHERE id = $1`, [productId]);
      const m = pr.rows[0] || {};
      const norm = s => String(s || '').trim().toLowerCase();
      if (norm(typed) !== norm(m.sku) && norm(typed) !== norm(m.part_number)) {
        await query(`CREATE TABLE IF NOT EXISTS product_part_numbers (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          code TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS ppn_product_code_uq ON product_part_numbers (product_id, upper(code))`);
        await query(
          `INSERT INTO product_part_numbers (product_id, code, note) VALUES ($1, $2, $3)
           ON CONFLICT (product_id, upper(code)) DO NOTHING`,
          [productId, typed, b.containerRef ? ('Container ' + b.containerRef) : 'From incoming stock']);
      }
    }
  } catch (e) { /* non-critical — alias capture is best-effort */ }

  res.status(201).json({ item: rows[0], fxFailed: !!fxFailed });
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
    // Per-line cost capture (foreign → GBP). Container-level freight/duty are
    // captured on each line (not apportioned in v1).
    const lineCurrency = String(l.currency || b.currency || 'CNY').toUpperCase();
    const { gbp: lineGbp, rate: lineRate } = await costToGbp(l.unitCostForeign, lineCurrency, b.expectedDate, l.fxRate);
    const ins = await query(
      `INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date, status, notes, created_by,
                                   unit_cost_foreign, currency, fx_rate, unit_cost_gbp, freight_total, duty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [prod.id, prod.sku, prod.title, prod.part_number, qty, b.containerRef || null, b.supplier || null,
       b.expectedDate || null, b.status || 'on_order', b.notes || null, req.user.id,
       (l.unitCostForeign != null && l.unitCostForeign !== '') ? parseFloat(l.unitCostForeign) : null,
       lineCurrency, lineRate, lineGbp,
       (b.freightTotal != null && b.freightTotal !== '') ? parseFloat(b.freightTotal) : null,
       (b.duty != null && b.duty !== '') ? parseFloat(b.duty) : null]);
    created.push({ id: ins.rows[0].id, productId: prod.id, sku: prod.sku, qty });
  }
  await audit(req, 'incoming_bulk_add', 'incoming', null, { created: created.length, unmatched: unmatched.length, container: b.containerRef });
  if (b.supplier) { try { await require('./suppliers').ensureSupplierByName(b.supplier); } catch (_) {} }
  if (b.containerRef) await reapportionContainer(b.containerRef).catch(() => {});
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
  const receivedItems = [];
  const { pushProductStockToChannels } = require('./products');
  for (const row of rows) {
    const remaining = Math.max(0, row.qty_ordered - row.qty_received);
    if (remaining <= 0) continue;
    await query(`UPDATE incoming_stock SET qty_received = qty_ordered, status = 'received', received_at = COALESCE(received_at, now()), updated_at = now() WHERE id = $1`, [row.id]);
    receivedLines++; receivedUnits += remaining;
    // Capture what was received so the UI can save it for label printing.
    receivedItems.push({
      sku: row.sku || '', title: row.title || '',
      partNumber: row.part_number || row.sku || '', barcode: row.sku || '', qty: remaining,
    });
    if (row.product_id) {
      await query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [remaining, row.product_id]);
      await query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'incoming_received',$3,$4)`, [row.product_id, remaining, row.id, req.user.id]).catch(() => {});
      await recordReceivedCost(row, remaining, req.user.id);
      if (push) { try { await pushProductStockToChannels(row.product_id); pushed++; } catch (e) {} }
      // Stock arrived → flip any pre-listing/pre-orders for this product.
      setImmediate(() => require('../services/sync').handlePreorderStockArrival(row.product_id).catch(() => {}));
    }
  }
  await audit(req, 'incoming_receive_container', 'incoming', null, { container: ref, receivedLines, receivedUnits });
  res.json({ ok: true, receivedLines, receivedUnits, pushed, receivedItems });
});

// PATCH /api/incoming/:id — edit fields (qty, container, supplier, expected, status, notes, product link).
router.patch('/:id', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  const b = req.body || {};
  const map = {
    qtyOrdered: 'qty_ordered', containerRef: 'container_ref', supplier: 'supplier',
    expectedDate: 'expected_date', status: 'status', notes: 'notes',
    sku: 'sku', title: 'title', partNumber: 'part_number', productId: 'product_id',
    unitCostForeign: 'unit_cost_foreign', currency: 'currency', fxRate: 'fx_rate',
    unitCostGbp: 'unit_cost_gbp', freightTotal: 'freight_total', duty: 'duty',
  };
  // If the foreign cost or rate is edited (and no explicit GBP given), recompute GBP.
  if ((b.unitCostForeign !== undefined || b.fxRate !== undefined) && b.unitCostGbp === undefined) {
    const cur = (await query(`SELECT unit_cost_foreign, currency, fx_rate, expected_date FROM incoming_stock WHERE id = $1`, [req.params.id])).rows[0] || {};
    const foreign = b.unitCostForeign !== undefined ? b.unitCostForeign : cur.unit_cost_foreign;
    const currency = b.currency !== undefined ? b.currency : (cur.currency || 'CNY');
    const conv = await costToGbp(foreign, currency, b.expectedDate || cur.expected_date, b.fxRate);
    if (conv.gbp != null) { b.unitCostGbp = conv.gbp; if (b.fxRate === undefined && conv.rate != null) b.fxRate = conv.rate; }
  }
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    let v = b[k];
    if (col === 'qty_ordered') v = parseInt(v) || 0;
    if (col === 'expected_date' && !v) v = null;
    if (['unit_cost_foreign', 'fx_rate', 'unit_cost_gbp', 'freight_total', 'duty'].includes(col)) v = (v === '' || v == null) ? null : parseFloat(v);
    params.push(v); sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  params.push(req.params.id);
  const { rows } = await query(`UPDATE incoming_stock SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  // Qty or unit cost changed → the container's value split shifts; recompute landed costs.
  if (rows[0].container_ref) await reapportionContainer(rows[0].container_ref).catch(() => {});
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
  let channelPush = null, stockUpdated = false, costUpdated = false;
  if (row.product_id) {
    await query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [qty, row.product_id]);
    await query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'incoming_received',$3,$4)`,
      [row.product_id, qty, row.id, req.user.id]).catch(() => {});
    // Reload the row so received_at (just set) is available for the cost record.
    const fresh = (await query(`SELECT * FROM incoming_stock WHERE id = $1`, [row.id])).rows[0] || row;
    costUpdated = await recordReceivedCost(fresh, qty, req.user.id);
    stockUpdated = true;
    if (b.push !== false) {
      try {
        const { pushProductStockToChannels } = require('./products');
        channelPush = await pushProductStockToChannels(row.product_id);
      } catch (e) { channelPush = { error: e.message }; }
    }
    // Stock arrived → flip any pre-listing/pre-orders for this product.
    setImmediate(() => require('../services/sync').handlePreorderStockArrival(row.product_id).catch(() => {}));
  }
  await audit(req, 'incoming_receive', 'incoming', row.id, { qty, fully });
  res.json({ ok: true, received: qty, fully, stockUpdated, costUpdated, notLinked: !row.product_id, channelPush });
});

// DELETE /api/incoming/:id
router.delete('/:id', requirePermission('inventory'), async (req, res) => {
  await ensureTable();
  await query(`DELETE FROM incoming_stock WHERE id = $1`, [req.params.id]);
  await audit(req, 'incoming_delete', 'incoming', req.params.id, null);
  res.json({ ok: true });
});

// Expose helpers so other routes (e.g. the pre-listing create flow) can add a
// linked incoming line with the same FX conversion + table guarantee.
router.costToGbp = costToGbp;
router.ensureIncomingTable = ensureTable;

module.exports = router;
