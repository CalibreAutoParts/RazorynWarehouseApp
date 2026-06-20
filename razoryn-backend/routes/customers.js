// routes/customers.js — repeat-customer directory + autocomplete + lifetime stats.
//
// Schema goal: a lightweight customers table that stores contact info + business
// details for repeat callers. NOT the source of truth for invoice customer_name
// — that still lives on the sales row (so historical invoices stay correct even
// if a customer record is edited later). The customer record is the canonical
// place to look up "what's this customer's address" before generating a new
// invoice.
//
// Lifetime value calculation is on-the-fly via a JOIN — no denormalised count
// columns to maintain. Sales.customer_name is fuzzy-matched on lookup.

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);
// GDPR: customer records are PII — never let a browser or proxy cache them.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration. Idempotent.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureCustomerTable() {
  if (_migrationDone) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        business_name   TEXT,
        email           TEXT,
        phone           TEXT,
        address         TEXT,
        whatsapp        TEXT,         -- separate field — sometimes different from phone
        notes           TEXT,         -- free-form notes ("trade customer", "calls every Friday")
        is_trade        BOOLEAN NOT NULL DEFAULT false,
        tags            TEXT,         -- comma-separated for now; could be JSONB later
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Indexes for the autocomplete search. ILIKE with leading-wildcard can't use
    // an index, but for ~thousands of customers that's still fast enough; if it
    // grows large we'd add a pg_trgm GIN index.
    await query(`CREATE INDEX IF NOT EXISTS customers_name_idx     ON customers (LOWER(name))`);
    await query(`CREATE INDEX IF NOT EXISTS customers_phone_idx    ON customers (phone)`);
    await query(`CREATE INDEX IF NOT EXISTS customers_email_idx    ON customers (LOWER(email))`);
    await query(`CREATE INDEX IF NOT EXISTS customers_business_idx ON customers (LOWER(business_name))`);
    // Link sales back to a customer when known (nullable — most past sales
    // won't be matched). Lets us compute lifetime value precisely.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`);
    await query(`CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales (customer_id) WHERE customer_id IS NOT NULL`);
    _migrationDone = true;
  } catch (e) {
    console.warn('[customers.js] migration warning:', e.message);
  }
}
ensureCustomerTable();

// ──────────────────────────────────────────────────────────────────────────
// GET /api/customers?q=… — autocomplete search across name, business, phone, email.
// Returns up to 10 matches with lifetime stats already joined in. Used by the
// Quote Builder modal's customer-name field so staff can pick a repeat
// customer in one click and have all fields auto-fill.
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  await ensureCustomerTable();
  const q = (req.query.q || '').trim();
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  let where = '1=1';
  let params = [];
  if (q) {
    // Match against name, business_name, phone (digit-only fuzzy), email.
    // Phone match strips non-digits from both sides so '07' matches '+447…' etc.
    const digitsOnly = q.replace(/[^\d]/g, '');
    if (digitsOnly.length >= 4) {
      params.push(`%${q.toLowerCase()}%`, `%${digitsOnly}%`);
      where = `(LOWER(name) LIKE $1 OR LOWER(business_name) LIKE $1 OR LOWER(email) LIKE $1 OR REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $2)`;
    } else {
      params.push(`%${q.toLowerCase()}%`);
      where = `(LOWER(name) LIKE $1 OR LOWER(business_name) LIKE $1 OR LOWER(email) LIKE $1)`;
    }
  }
  params.push(limit);
  // The lifetime stats are joined in via a correlated subquery — cheaper than
  // a GROUP BY when most customers have only a handful of sales each. Excludes
  // estimates / pro-formas from the spend total since those aren't realised yet.
  const r = await query(`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM sales s WHERE s.customer_id = c.id AND s.status != 'cancelled')               AS order_count,
      (SELECT COALESCE(SUM(s.total), 0) FROM sales s WHERE s.customer_id = c.id AND s.status NOT IN ('cancelled') AND s.invoice_number IS NOT NULL) AS lifetime_value,
      (SELECT MAX(s.occurred_at) FROM sales s WHERE s.customer_id = c.id)                                       AS last_order_at
    FROM customers c
    WHERE ${where}
    ORDER BY (
      SELECT COALESCE(SUM(s2.total), 0) FROM sales s2 WHERE s2.customer_id = c.id
    ) DESC, c.name ASC
    LIMIT $${params.length}
  `, params);
  res.json({ customers: r.rows });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/customers — create a new customer record.
// PATCH /api/customers/:id — update existing.
// Both used by the in-modal "save customer" flow when staff completes a
// quote for a name they want to remember.
// ──────────────────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  await ensureCustomerTable();
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  // Soft dedupe: if a phone or email exactly matches an existing record, return
  // that one rather than creating a duplicate. Reduces accidental duplicates
  // when staff hits "Save customer" twice in a row.
  if (b.phone || b.email) {
    const dedupe = await query(
      `SELECT * FROM customers WHERE ($1 != '' AND phone = $1) OR ($2 != '' AND LOWER(email) = LOWER($2)) LIMIT 1`,
      [b.phone || '', b.email || '']
    );
    if (dedupe.rows[0]) {
      return res.json({ ok: true, customer: dedupe.rows[0], deduped: true });
    }
  }
  const r = await query(`
    INSERT INTO customers (name, business_name, email, phone, address, whatsapp, notes, is_trade, tags, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [
    name,
    (b.businessName || b.business_name || '').trim() || null,
    (b.email || '').trim() || null,
    (b.phone || '').trim() || null,
    (b.address || '').trim() || null,
    (b.whatsapp || '').trim() || null,
    (b.notes || '').trim() || null,
    !!b.isTrade || !!b.is_trade,
    (b.tags || '').trim() || null,
    req.user?.id || null,
  ]);
  await audit(req, 'create_customer', 'customer', r.rows[0].id, { name });
  res.json({ ok: true, customer: r.rows[0] });
});

router.patch('/:id', requireAdmin, async (req, res) => {
  await ensureCustomerTable();
  const b = req.body || {};
  const fieldMap = {
    name: 'name', businessName: 'business_name', business_name: 'business_name',
    email: 'email', phone: 'phone', address: 'address', whatsapp: 'whatsapp',
    notes: 'notes', isTrade: 'is_trade', is_trade: 'is_trade', tags: 'tags',
  };
  const updates = [], params = [];
  for (const [k, col] of Object.entries(fieldMap)) {
    if (b[k] === undefined) continue;
    params.push(b[k]);
    updates.push(`${col} = $${params.length}`);
  }
  if (!updates.length) return res.json({ ok: true, message: 'no_changes' });
  params.push(req.params.id);
  const r = await query(
    `UPDATE customers SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_customer', 'customer', req.params.id, {});
  res.json({ ok: true, customer: r.rows[0] });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  await ensureCustomerTable();
  // Don't delete — just mark inactive (preserve historical sale → customer joins)
  // Hmm, no active flag yet. For now actually delete; sales.customer_id ON DELETE SET NULL preserves data.
  await query('DELETE FROM customers WHERE id = $1', [req.params.id]);
  await audit(req, 'delete_customer', 'customer', req.params.id, {});
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/customers/:id/sales — full sales history for a customer.
// Powers the "Customer profile" view (lifetime spend, recent orders).
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id/sales', async (req, res) => {
  await ensureCustomerTable();
  const r = await query(`
    SELECT s.*, (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count
    FROM sales s
    WHERE s.customer_id = $1
    ORDER BY s.occurred_at DESC
    LIMIT 100
  `, [req.params.id]);
  await audit(req, 'view_customer_sales', 'customer', req.params.id);  // GDPR: log customer-data read
  res.json({ sales: r.rows });
});

module.exports = router;
