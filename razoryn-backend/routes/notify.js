// routes/notify.js — back-in-stock capture + notify sweep.
//
// PUBLIC capture: the storefront "Email me when back in stock" form POSTs here
// (CORS open, no auth). We store the signup against a warehouse product.
// A periodic sweep (server.js cron) emails everyone waiting on a product once
// its qty_on_hand goes above zero — reusing the warehouse as the master stock
// source rather than relying on Shopify webhooks.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendEmail } = require('../services/email');
const brand = require('../lib/brand');

const router = express.Router();

let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  await query(`CREATE TABLE IF NOT EXISTS back_in_stock_requests (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER REFERENCES products(id) ON DELETE CASCADE,
    sku         TEXT,
    email       TEXT NOT NULL,
    variant_id  TEXT,
    shop        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at TIMESTAMPTZ
  )`);
  // One live request per email+product (re-arm on re-signup).
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS bis_email_product_idx ON back_in_stock_requests (email, product_id)`);
  await query(`CREATE INDEX IF NOT EXISTS bis_pending_idx ON back_in_stock_requests (product_id) WHERE notified_at IS NULL`);
  _tableReady = true;
}
ensureTable().catch(e => console.warn('[notify] ensureTable:', e.message));

// Resolve a warehouse product from whatever the storefront sends us: a SKU
// (preferred) or a Shopify product id / GID.
async function resolveProduct({ sku, productId }) {
  if (sku) {
    const r = await query(`SELECT id, sku, title, qty_on_hand, shopify_handle FROM products WHERE sku = $1`, [String(sku)]);
    if (r.rows[0]) return r.rows[0];
  }
  if (productId) {
    const numeric = String(productId).split('/').pop(); // gid://shopify/Product/123 -> 123
    const r = await query(`SELECT id, sku, title, qty_on_hand, shopify_handle FROM products WHERE shopify_product_id = $1`, [numeric]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// ── PUBLIC capture (CORS open) ──────────────────────────────────────────────
router.use('/', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const { email, sku, productId, variantId, shop } = req.body || {};
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail) || (!sku && !productId)) {
      return res.status(400).json({ ok: false, error: 'email_and_product_required' });
    }
    const product = await resolveProduct({ sku, productId });
    if (!product) return res.status(404).json({ ok: false, error: 'product_not_found' });

    await query(`
      INSERT INTO back_in_stock_requests (product_id, sku, email, variant_id, shop)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email, product_id) DO UPDATE SET notified_at = NULL, variant_id = EXCLUDED.variant_id
    `, [product.id, product.sku, cleanEmail, variantId || null, shop || null]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[notify] capture failed:', e.message);
    res.status(500).json({ ok: false, error: 'capture_failed' });
  }
});

// ── ADMIN list (waiting signups) ────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  await ensureTable();
  const r = await query(`
    SELECT b.id, b.email, b.sku, b.created_at, b.notified_at,
           p.title, p.qty_on_hand
      FROM back_in_stock_requests b
      LEFT JOIN products p ON p.id = b.product_id
     ORDER BY b.notified_at NULLS FIRST, b.created_at DESC
     LIMIT 500`);
  const pending = r.rows.filter(x => !x.notified_at).length;
  res.json({ requests: r.rows, pending });
});

// ── Sweep: email everyone waiting on a now-in-stock product ─────────────────
// Returns { sent, checked }. Safe to run on a timer (server.js cron).
async function runBackInStockSweep() {
  await ensureTable();
  const pending = await query(`
    SELECT b.id, b.email, b.variant_id, p.title, p.qty_on_hand, p.shopify_handle
      FROM back_in_stock_requests b
      JOIN products p ON p.id = b.product_id
     WHERE b.notified_at IS NULL AND p.qty_on_hand > 0
     LIMIT 500`);
  if (!pending.rows.length) return { sent: 0, checked: 0 };

  const base = `https://${(brand.domain || 'razoryn.co.uk').replace(/^https?:\/\//, '')}`;
  let sent = 0;
  for (const req of pending.rows) {
    const url = req.shopify_handle ? `${base}/products/${req.shopify_handle}` : base;
    const r = await sendEmail({
      to: req.email,
      subject: `Back in stock: ${req.title}`,
      html: `<p>Good news — <strong>${req.title}</strong> is back in stock at ${brand.name || 'Razoryn e-Parts'}.</p>
             <p><a href="${url}">Order it here</a> before it sells out again. Order by 12pm Mon–Fri for same-day dispatch.</p>`,
    });
    if (r.ok) {
      await query(`UPDATE back_in_stock_requests SET notified_at = now() WHERE id = $1`, [req.id]);
      sent++;
    }
  }
  if (sent) console.log(`[back-in-stock] emailed ${sent} waiting customer(s)`);
  return { sent, checked: pending.rows.length };
}

module.exports = router;
module.exports.runBackInStockSweep = runBackInStockSweep;
