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

router.ensureSupplierByName = ensureSupplierByName;
module.exports = router;
