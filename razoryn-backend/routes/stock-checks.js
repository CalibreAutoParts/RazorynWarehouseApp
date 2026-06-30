// routes/stock-checks.js — feature 2: employee stock-check workflow
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requirePermission, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// Self-healing: the stock-check CADENCE lives on app_settings.
//   stock_check_interval_months — run a full check every N months (1/2/3/6/12)
//   stock_check_period_start     — when the CURRENT check cycle began; "counted"
//                                  means counted since this time. Reset bumps it.
let _scReady = false;
async function ensureCadenceColumns() {
  if (_scReady) return;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS stock_check_interval_months INTEGER DEFAULT 1`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS stock_check_period_start TIMESTAMPTZ`);
    _scReady = true;
  } catch (e) { console.warn('[stock-checks] cadence migration:', e.message); }
}
ensureCadenceColumns();

// Resolve the current check cycle. periodStart defaults to the start of this
// calendar month (preserving the old "this month" behaviour) until a reset sets it.
async function getCheckPeriod() {
  await ensureCadenceColumns();
  const r = await query(`SELECT stock_check_interval_months, stock_check_period_start, stock_check_enabled FROM app_settings WHERE id = 1`);
  const row = r.rows[0] || {};
  const intervalMonths = Math.max(1, parseInt(row.stock_check_interval_months) || 1);
  const ps = await query(
    `SELECT COALESCE(stock_check_period_start, date_trunc('month', now())) AS period_start,
            COALESCE(stock_check_period_start, date_trunc('month', now())) + ($1 || ' months')::interval AS next_due,
            now() >= COALESCE(stock_check_period_start, date_trunc('month', now())) + ($1 || ' months')::interval AS due_now
       FROM app_settings WHERE id = 1`, [String(intervalMonths)]);
  const p = ps.rows[0] || {};
  return {
    intervalMonths,
    enabled: !!row.stock_check_enabled,
    periodStart: p.period_start,
    nextDue: p.next_due,
    dueNow: !!p.due_now,
  };
}

// POST /api/stock-checks  { productId, actualQty, reason, notes, photoPath }
// Records a stock check. If actualQty != expected, applies the variance and
// logs a stock movement so the audit trail stays complete.
router.post('/', requirePermission('scan'), async (req, res) => {
  const { productId, actualQty, reason, notes, photoPath, forcePush } = req.body || {};
  if (!productId || actualQty == null) {
    return res.status(400).json({ error: 'productId_and_actualQty_required' });
  }

  const result = await withTx(async (c) => {
    const p = await c.query(
      `SELECT id, qty_on_hand FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );
    if (!p.rows[0]) return { error: 'product_not_found' };
    const expected = p.rows[0].qty_on_hand;
    const variance = actualQty - expected;

    const sc = await c.query(
      `INSERT INTO stock_checks (product_id, expected_qty, actual_qty, reason, notes, photo_path, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId, expected, actualQty, reason || null, notes || null, photoPath || null, req.user.id]
    );

    if (variance !== 0) {
      await c.query(
        `UPDATE products SET qty_on_hand = $1 WHERE id = $2`,
        [actualQty, productId]
      );
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, notes, performed_by)
         VALUES ($1,$2,'stock_check',$3,$4,$5)`,
        [productId, variance, sc.rows[0].id, reason || null, req.user.id]
      );
    }
    return { check: sc.rows[0], variance };
  });

  if (result.error) return res.status(404).json({ error: result.error });
  await audit(req, 'stock_check', 'product', productId, { variance: result.variance });

  // Push the counted quantity to Shopify + every linked eBay store immediately.
  // We push whenever the count CHANGED the system qty, and also when the caller
  // asks (forcePush) — the latter reconciles the channels even when the system
  // already matched, catching channel drift so a sold-out item can't be oversold
  // during a stock-take. Best-effort — never fail the stock check.
  let channelPush = null;
  if (result.variance !== 0 || forcePush) {
    try {
      const { pushProductStockToChannels } = require('./products');
      channelPush = await pushProductStockToChannels(productId);
    } catch (e) { channelPush = { error: e.message }; }
  }
  res.status(201).json({ ...result, channelPush });
});

// GET /api/stock-checks?productId=&days=30
router.get('/', requirePermission('inventory'), async (req, res) => {
  const { productId, days = 30 } = req.query;
  const where = ['sc.created_at > now() - $1::interval'];
  const params = [`${parseInt(days)} days`];
  if (productId) { params.push(productId); where.push(`sc.product_id = $${params.length}`); }
  const { rows } = await query(`
    SELECT sc.*, p.sku, p.title, u.name AS performed_by_name
    FROM stock_checks sc
    JOIN products p ON p.id = sc.product_id
    LEFT JOIN users u ON u.id = sc.performed_by
    WHERE ${where.join(' AND ')}
    ORDER BY sc.created_at DESC
    LIMIT 200
  `, params);
  res.json({ checks: rows });
});

// GET /api/stock-checks/progress — product IDs counted SINCE the current check
// cycle started, plus the cycle/cadence info (period start, interval, next due).
// Drives the stock-take checklist progress + the "check due" reminder.
router.get('/progress', requirePermission('scan'), async (req, res) => {
  const period = await getCheckPeriod();
  const { rows } = await query(
    `SELECT DISTINCT product_id FROM stock_checks WHERE created_at >= $1`, [period.periodStart]);
  res.json({ productIds: rows.map(r => r.product_id), ...period });
});

// Back-compat alias for older clients.
router.get('/this-month', requirePermission('scan'), async (req, res) => {
  const period = await getCheckPeriod();
  const { rows } = await query(
    `SELECT DISTINCT product_id FROM stock_checks WHERE created_at >= $1`, [period.periodStart]);
  res.json({ productIds: rows.map(r => r.product_id) });
});

// POST /api/stock-checks/reset — start a NEW check cycle: everything counted
// before now() drops back to "left to check". History rows are kept (audit); only
// the cycle's start moves. Admin-only.
router.post('/reset', requireAdmin, async (req, res) => {
  await ensureCadenceColumns();
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(`UPDATE app_settings SET stock_check_period_start = now() WHERE id = 1`);
  await audit(req, 'stock_check_reset', null, null, {});
  const period = await getCheckPeriod();
  res.json({ ok: true, ...period });
});

module.exports = router;
