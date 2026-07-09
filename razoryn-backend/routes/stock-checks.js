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
  if (!productId) return res.status(400).json({ error: 'productId_required' });

  // CONFIRM vs ADJUST — the critical safety distinction:
  //  • Confirm (`confirm:true` or no actualQty): staff verified the item; DO NOT
  //    change stock. It only records that it was checked. This stops a stale
  //    on-screen quantity from overwriting the server's live figure (e.g. an item
  //    that sold on eBay/Shopify since the page loaded) and re-inflating stock.
  //  • Adjust (an explicit numeric actualQty): staff physically counted N → set it.
  const isConfirm = req.body.confirm === true || actualQty == null || actualQty === '';
  const counted = isConfirm ? null : parseInt(actualQty, 10);
  if (!isConfirm && (!Number.isFinite(counted) || counted < 0)) {
    return res.status(400).json({ error: 'invalid_actualQty' });
  }

  const result = await withTx(async (c) => {
    const p = await c.query(
      `SELECT id, qty_on_hand FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );
    if (!p.rows[0]) return { error: 'product_not_found' };
    const expected = p.rows[0].qty_on_hand;
    // On a confirm we record the check at the CURRENT server qty (variance 0).
    const recordedActual = isConfirm ? expected : counted;
    const variance = recordedActual - expected;

    const sc = await c.query(
      `INSERT INTO stock_checks (product_id, expected_qty, actual_qty, reason, notes, photo_path, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId, expected, recordedActual, reason || null, notes || null, photoPath || null, req.user.id]
    );

    if (variance !== 0) {
      await c.query(
        `UPDATE products SET qty_on_hand = $1 WHERE id = $2`,
        [recordedActual, productId]
      );
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, notes, performed_by)
         VALUES ($1,$2,'stock_check',$3,$4,$5)`,
        [productId, variance, sc.rows[0].id, reason || null, req.user.id]
      );
    }
    return { check: sc.rows[0], variance, confirmed: isConfirm };
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

// Products "counted" since a time — an item counts if it got a stock-take check
// OR a HUMAN quantity adjustment (from the Stock Check / scan page or Inventory
// adjust) in the window. This means it doesn't matter which screen staff use to
// count on: adjusting an item's quantity marks it done in the monthly stock-take.
// Sales, returns, incoming receipts and the revert tool are NOT counts.
async function countedProductIdsSince(since) {
  const { rows } = await query(`
    SELECT DISTINCT product_id FROM (
      SELECT product_id FROM stock_checks WHERE created_at >= $1
      UNION
      SELECT product_id FROM stock_movements
        WHERE created_at >= $1 AND product_id IS NOT NULL AND performed_by IS NOT NULL
          AND reason IS NOT NULL
          AND reason NOT ILIKE 'sale%'
          AND reason NOT IN ('return_restock','incoming_received','stock_check_revert','sale_deleted_restore')
    ) t`, [since]);
  return rows.map(r => r.product_id);
}

// GET /api/stock-checks/progress — product IDs counted SINCE the current check
// cycle started, plus the cycle/cadence info (period start, interval, next due).
// Drives the stock-take checklist progress + the "check due" reminder.
router.get('/progress', requirePermission('scan'), async (req, res) => {
  const period = await getCheckPeriod();
  const productIds = await countedProductIdsSince(period.periodStart);
  res.json({ productIds, ...period });
});

// Back-compat alias for older clients.
router.get('/this-month', requirePermission('scan'), async (req, res) => {
  const period = await getCheckPeriod();
  const productIds = await countedProductIdsSince(period.periodStart);
  res.json({ productIds });
});

// GET /api/stock-checks/restore-preview?since=ISO
// Recovery for the "confirm re-inflated sold-out items" bug: for each product that
// had an INFLATING stock check since `since` (defaults to the current cycle start),
// the correct figure is its quantity at the START of the take — the expected_qty of
// the first stock-check in the window (before any bad confirm touched it). Lists the
// items whose current qty is now HIGHER than that, i.e. wrongly inflated.
router.get('/restore-preview', requireAdmin, async (req, res) => {
  const period = await getCheckPeriod();
  const since = req.query.since ? new Date(req.query.since) : period.periodStart;
  const { rows } = await query(`
    SELECT p.id AS product_id, p.title, p.sku, p.qty_on_hand AS current_qty,
           first.expected_qty AS suggested_qty
    FROM products p
    JOIN LATERAL (
      SELECT expected_qty FROM stock_checks sc
       WHERE sc.product_id = p.id AND sc.created_at >= $1
       ORDER BY sc.created_at ASC, sc.id ASC LIMIT 1
    ) first ON true
    WHERE EXISTS (SELECT 1 FROM stock_checks sc2
                    WHERE sc2.product_id = p.id AND sc2.created_at >= $1
                      AND sc2.actual_qty > sc2.expected_qty)
      AND p.qty_on_hand > first.expected_qty
    ORDER BY (p.qty_on_hand - first.expected_qty) DESC`, [since]);
  res.json({ since, items: rows.map(r => ({ ...r, inflatedBy: r.current_qty - r.suggested_qty })) });
});

// POST /api/stock-checks/restore-apply  { since?, productIds? }
// Set each affected product back to its start-of-take quantity, log a compensating
// movement, and re-push to the channels. Admin-only.
router.post('/restore-apply', requireAdmin, async (req, res) => {
  const period = await getCheckPeriod();
  const since = req.body?.since ? new Date(req.body.since) : period.periodStart;
  const only = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : null;
  const { rows } = await query(`
    SELECT p.id AS product_id, p.qty_on_hand AS current_qty, first.expected_qty AS suggested_qty
    FROM products p
    JOIN LATERAL (
      SELECT expected_qty FROM stock_checks sc
       WHERE sc.product_id = p.id AND sc.created_at >= $1
       ORDER BY sc.created_at ASC, sc.id ASC LIMIT 1
    ) first ON true
    WHERE EXISTS (SELECT 1 FROM stock_checks sc2 WHERE sc2.product_id = p.id AND sc2.created_at >= $1 AND sc2.actual_qty > sc2.expected_qty)
      AND p.qty_on_hand > first.expected_qty`, [since]);
  let fixed = 0; const done = [];
  for (const r of rows) {
    if (only && !only.includes(String(r.product_id))) continue;
    const delta = r.suggested_qty - r.current_qty;   // negative (lowering)
    try {
      await query(`UPDATE products SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [r.suggested_qty, r.product_id]);
      await query(
        `INSERT INTO stock_movements (product_id, delta, reason, notes, performed_by)
         VALUES ($1,$2,'stock_check_revert','Reverted inflated stock-take count',$3)`,
        [r.product_id, delta, req.user.id]);
      try { await require('./products').pushProductStockToChannels(r.product_id); } catch (_) {}
      done.push({ productId: r.product_id, from: r.current_qty, to: r.suggested_qty });
      fixed++;
    } catch (e) { /* skip on error */ }
  }
  await audit(req, 'stock_check_restore', null, null, { fixed, since });
  res.json({ ok: true, fixed, done });
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
