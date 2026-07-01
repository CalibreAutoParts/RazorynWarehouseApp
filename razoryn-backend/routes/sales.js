// routes/sales.js — sales, invoices, estimates, CSV exports, emails
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const brand = require('../lib/brand');

const router = express.Router();
router.use(requireAuth);

// #13 — track whether a direct invoice has actually been PAID. is_paid=false on
// a non-estimate sale = "parts given, awaiting payment" (follow-up list).
// is_paid defaults to TRUE so every existing invoice stays paid (restart-safe —
// no backfill that could re-flip intentionally-unpaid rows). paid_at records
// when payment was taken.
let _paidColReady = false;
async function ensurePaidColumn() {
  if (_paidColReady) return;
  try {
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT true`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
    // Explicit ship-vs-collect choice per order. NULL = legacy rows; the worklist
    // falls back to "cash = collect, everything else = ship" for those.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS fulfillment_method TEXT`);
    // Fitment workflow: needs_fitment = no vehicle reg captured (auto-parts must
    // be confirmed against the customer's car); large_panel = order contains an
    // LP item needing the special courier.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS needs_fitment BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS large_panel BOOLEAN NOT NULL DEFAULT false`);
    // Fitment is a storefront-only concern — clear it on staff-quoted direct
    // sales (fitment was confirmed before quoting). Idempotent: only rewrites
    // rows still flagged, so it's a no-op after the first boot.
    await query(`UPDATE sales SET needs_fitment = false
                  WHERE needs_fitment = true AND channel IN ('direct_cash','direct_bank','direct_card')`);
    // Allow card/Stripe as a manual-entry channel alongside cash + bank. The
    // channel CHECK is inline (auto-named sales_channel_check); widen it so
    // 'direct_card' is accepted without losing the guard on bad values.
    try {
      await query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_channel_check`);
      await query(`ALTER TABLE sales ADD CONSTRAINT sales_channel_check CHECK (channel IN ('shopify','ebay_em','ebay_cl','direct_cash','direct_bank','direct_card'))`);
    } catch (e) { console.warn('[sales] channel constraint widen:', e.message); }
    // When a CHANNEL order is deleted, remember its external order id so the
    // eBay/Shopify sync doesn't silently re-import it (the "deleted but it came
    // back in Dispatch" bug). Tombstone table; the pulls skip anything listed here.
    await query(`CREATE TABLE IF NOT EXISTS deleted_external_orders (
      channel           TEXT,
      external_order_id TEXT NOT NULL,
      deleted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_by        INTEGER,
      PRIMARY KEY (external_order_id)
    )`);
    _paidColReady = true;
  } catch (e) { console.warn('[sales] ensurePaidColumn:', e.message); }
}
ensurePaidColumn();
// GDPR: sales/invoices carry customer PII — never let a browser or proxy cache
// these responses.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const CHANNELS = ['shopify', 'ebay_em', 'ebay_cl', 'direct_cash', 'direct_bank', 'direct_card'];

// ----- helpers -----
// Build the single customer-facing reference for a sale. One unified value used
// for BOTH invoice_number and payment_reference (replacing the old separate
// RZN-<date>-<seq> and REP-<rand>-<suffix> pair). PREFIX is the brand's
// invoicePrefix — CAP for Calibre, REP for Razoryn.
//   eBay sale    → <PREFIX>-E-<eBay order #>
//   Shopify sale → <PREFIX>-S-<Shopify order #>
//   Direct sale  → <PREFIX>-#### (brand-shared sequence from 0700)
async function buildSaleReference(client, { channel, orderNumber }) {
  const prefix = brand.invoicePrefix || 'REP';
  const isEbay = channel === 'ebay_em' || channel === 'ebay_cl';
  const isShopify = channel === 'shopify';
  if (isEbay && orderNumber) return `${prefix}-E-${orderNumber}`;
  if (isShopify && orderNumber) return `${prefix}-S-${orderNumber}`;
  const next = await nextDirectNumber(client, prefix);
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// Next number in the brand's direct-sale sequence. Floors at 700 so the first
// direct sale is <PREFIX>-0700. Matches references of the form PREFIX-#### only
// (4+ digits), so channel refs like CAP-E-123 never collide with it.
async function nextDirectNumber(client, prefix) {
  const runQuery = client ? client.query.bind(client) : query;
  const r = await runQuery(
    `SELECT COALESCE(MAX(SUBSTRING(payment_reference FROM ('^' || $1 || '-([0-9]{4,})$'))::int), 699) + 1 AS next
       FROM sales
      WHERE payment_reference ~ ('^' || $1 || '-[0-9]{4,}$')`,
    [prefix]
  );
  return r.rows[0].next;
}

// One-time backfill: assign the new <PREFIX>-#### scheme to existing DIRECT
// (cash/bank) sales, oldest first, continuing the shared sequence. eBay/Shopify
// sales are intentionally NOT backfilled. Idempotent — rows already on the new
// scheme are skipped, so it's safe to run on every boot.
let _backfilledDirect = false;
async function backfillDirectReferences() {
  if (_backfilledDirect) return;
  try {
    const prefix = brand.invoicePrefix || 'REP';
    const { rows } = await query(
      `SELECT id FROM sales
        WHERE channel IN ('direct_cash','direct_bank')
          AND (payment_reference IS NULL OR payment_reference !~ ('^' || $1 || '-[0-9]{4,}$'))
        ORDER BY occurred_at ASC, id ASC`,
      [prefix]
    );
    if (!rows.length) { _backfilledDirect = true; return; }
    let n = await nextDirectNumber(null, prefix);
    for (const row of rows) {
      const ref = `${prefix}-${String(n).padStart(4, '0')}`;
      await query(`UPDATE sales SET payment_reference = $1, invoice_number = $2 WHERE id = $3`, [ref, ref, row.id]);
      n++;
    }
    console.log(`[sales] backfilled ${rows.length} direct (cash/bank) references to ${prefix}-#### scheme`);
    _backfilledDirect = true;
  } catch (e) {
    console.warn('[sales] direct-reference backfill warning:', e.message);
  }
}
backfillDirectReferences();

// GET /api/sales?channel=&from=&to=&page=
router.get('/', requireAdmin, async (req, res) => {
  const { channel, from, to, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(2000, parseInt(req.query.pageSize) || 50);
  const where = [], params = [];
  if (channel) { params.push(channel); where.push(`s.channel = $${params.length}`); }
  if (from)    { params.push(from); where.push(`s.occurred_at >= $${params.length}`); }
  if (to)      { params.push(to); where.push(`s.occurred_at <= $${params.length}`); }
  if (status)  { params.push(status); where.push(`s.status = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Join with sale_items so we can show a meaningful item label (first item title)
  // and an item count, instead of generic "(multi-item sale)".
  const { rows } = await query(
    `SELECT s.*,
       (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title,
       (SELECT sku FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_sku,
       (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count
     FROM sales s ${w} ORDER BY s.occurred_at DESC LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`,
    params
  );
  const tot = await query(`SELECT COUNT(*)::int AS n FROM sales s ${w}`, params);
  const summary = await query(`
    SELECT channel, COUNT(*)::int AS count, COALESCE(SUM(total),0) AS revenue
    FROM sales s ${w} GROUP BY channel`, params);

  // Refunds in the same window (so revenue can be shown net of returns, #1).
  // Returns carry refund_amount once a return is processed/closed; grouped by
  // the originating sale's channel (fall back to the return's own channel).
  let refundsByChannel = {}, refundsTotal = 0;
  try {
    const rWhere = [`r.status IN ('processed','closed')`, `r.refund_amount IS NOT NULL`];
    const rParams = [];
    if (from) { rParams.push(from); rWhere.push(`r.created_at >= $${rParams.length}`); }
    if (to)   { rParams.push(to);   rWhere.push(`r.created_at <= $${rParams.length}`); }
    const rRows = (await query(`
      SELECT COALESCE(s.channel, r.channel) AS channel, COALESCE(SUM(r.refund_amount),0)::numeric AS refunds
      FROM returns r LEFT JOIN sales s ON s.id = r.sale_id
      WHERE ${rWhere.join(' AND ')} GROUP BY COALESCE(s.channel, r.channel)`, rParams)).rows;
    for (const row of rRows) {
      const amt = parseFloat(row.refunds) || 0;
      refundsByChannel[row.channel] = amt;
      refundsTotal += amt;
    }
  } catch (e) { /* returns table not ready — ignore */ }

  res.json({ sales: rows, total: tot.rows[0].n, summary: summary.rows, refundsByChannel, refundsTotal });
});

// GET /api/sales/export.csv?channel=&from=&to=
router.get('/export.csv', requireAdmin, async (req, res) => {
  const { channel, from, to } = req.query;
  const where = [], params = [];
  if (channel) { params.push(channel); where.push(`s.channel = $${params.length}`); }
  if (from)    { params.push(from); where.push(`s.occurred_at >= $${params.length}`); }
  if (to)      { params.push(to); where.push(`s.occurred_at <= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT s.occurred_at, s.channel, s.invoice_number, s.payment_reference, s.external_order_id,
           s.customer_name, s.customer_email, s.total, s.payment_method,
           si.title AS item_title, si.sku AS item_sku, si.qty, si.unit_price, si.line_total,
           p.part_number AS part_number
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
    ${w}
    ORDER BY s.occurred_at DESC, si.id`, params);

  const headers = [
    'Date', 'Channel', 'Invoice / Reference', 'Order ID', 'Customer',
    'Customer Email', 'Item', 'SKU', 'Part Number', 'Qty', 'Unit Price', 'Line Total',
    'Order Total', 'Payment Method',
  ];
  const csvEscape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.occurred_at ? new Date(r.occurred_at).toISOString() : '',
      r.channel,
      r.invoice_number || r.payment_reference || '',
      r.external_order_id || '',
      r.customer_name || '',
      r.customer_email || '',
      r.item_title || '',
      r.item_sku || '',
      r.part_number || '',
      r.qty || '',
      r.unit_price || '',
      r.line_total || '',
      r.total || '',
      r.payment_method || '',
    ].map(csvEscape).join(','));
  }
  const filename = `sales-${channel || 'all'}-${new Date().toISOString().slice(0,10)}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\r\n'));
});

// GET /api/sales/export.xlsx?from=&to=&channel=
// Multi-sheet Excel workbook. Layout:
//   - One "Summary" sheet (revenue per channel × month)
//   - One sheet per channel showing line items
//   - Within each channel sheet, rows are grouped & sub-totaled per month
// `channel` query param filters to a single channel (shopify | ebay | cash | bank | all)
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  let XLSX;
  try { XLSX = require('xlsx'); }
  catch (e) {
    return res.status(503).json({ error: 'xlsx_not_installed', message: 'Run `npm install` after pulling — adds xlsx dependency.' });
  }
  const { from, to, channel: filterChannel } = req.query;
  const baseWhere = [], baseParams = [];
  if (from) { baseParams.push(from); baseWhere.push(`s.occurred_at >= $${baseParams.length}`); }
  if (to)   { baseParams.push(to);   baseWhere.push(`s.occurred_at <= $${baseParams.length}`); }

  const allChannels = [
    { key: 'shopify', label: 'Store (Shopify)', sheetName: 'Store',  match: ['shopify'] },
    { key: 'ebay',    label: 'eBay',            sheetName: 'eBay',     match: ['ebay_em', 'ebay_cl'] },
    { key: 'cash',    label: 'Cash',            sheetName: 'Cash',     match: ['direct_cash'] },
    { key: 'bank',    label: 'Bank transfer',   sheetName: 'Bank',     match: ['direct_bank'] },
  ];
  const channels = filterChannel && filterChannel !== 'all'
    ? allChannels.filter(c => c.key === filterChannel)
    : allChannels;
  if (!channels.length) return res.status(400).json({ error: 'invalid_channel' });

  const wb = XLSX.utils.book_new();
  const headers = [
    'Date', 'Month', 'Invoice / Ref', 'Channel Order ID', 'Customer', 'Customer Email',
    'Item', 'SKU', 'Part Number', 'Qty', 'Unit Price (£)', 'Line Total (£)', 'Order Total (£)', 'Payment',
  ];

  // Collect data for the Summary sheet
  const summary = {}; // { 'YYYY-MM': { shopify: 0, ebay: 0, cash: 0, bank: 0 } }

  for (const ch of channels) {
    const params = baseParams.slice();
    const chPlaceholders = ch.match.map((_, i) => `$${params.length + i + 1}`).join(',');
    params.push(...ch.match);
    const where = baseWhere.concat(`s.channel IN (${chPlaceholders})`);
    const w = `WHERE ${where.join(' AND ')}`;

    const { rows } = await query(`
      SELECT s.id AS sale_id, s.occurred_at, s.invoice_number, s.payment_reference, s.external_order_id,
             s.customer_name, s.customer_email, s.total, s.payment_method, s.is_estimate,
             si.title AS item_title, si.sku AS item_sku, si.qty, si.unit_price, si.line_total,
             p.part_number AS part_number
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      ${w}
      ORDER BY s.occurred_at ASC, si.id`, params);

    // Group rows by month
    const byMonth = {}; // 'YYYY-MM' → array of rows
    const seenSales = new Set(); // to avoid double-counting totals across multi-line orders
    for (const r of rows) {
      if (r.is_estimate) continue; // exclude estimates from accounting export
      const month = r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 7) : 'unknown';
      (byMonth[month] = byMonth[month] || []).push(r);
      if (!seenSales.has(r.sale_id)) {
        seenSales.add(r.sale_id);
        if (!summary[month]) summary[month] = { shopify: 0, ebay: 0, cash: 0, bank: 0 };
        summary[month][ch.key] = (summary[month][ch.key] || 0) + Number(r.total || 0);
      }
    }

    // Build sheet rows: month section header + items + monthly subtotal
    const data = [];
    const sortedMonths = Object.keys(byMonth).sort();
    for (const month of sortedMonths) {
      const monthRows = byMonth[month];
      // Pretty month label, e.g. "August 2025"
      const [yr, mo] = month.split('-');
      const monthLabel = mo ? new Date(yr, parseInt(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Unknown';
      data.push([`── ${monthLabel} ──`]);
      data.push(headers);
      const uniqueOrderTotals = new Map(); // sale_id → total
      for (const r of monthRows) {
        if (!uniqueOrderTotals.has(r.sale_id)) uniqueOrderTotals.set(r.sale_id, Number(r.total || 0));
        data.push([
          r.occurred_at ? new Date(r.occurred_at) : '',
          monthLabel,
          r.invoice_number || r.payment_reference || '',
          r.external_order_id || '',
          r.customer_name || '',
          r.customer_email || '',
          r.item_title || '',
          r.item_sku || '',
          r.part_number || '',
          r.qty || 0,
          Number(r.unit_price || 0),
          Number(r.line_total || 0),
          Number(r.total || 0),
          r.payment_method || '',
        ]);
      }
      // Subtotal row
      const monthTotal = [...uniqueOrderTotals.values()].reduce((a, b) => a + b, 0);
      data.push(['', '', '', '', '', '', `${monthLabel} subtotal`, '', '', uniqueOrderTotals.size + ' orders', '', '', monthTotal, '']);
      data.push([]); // blank separator
    }
    if (!data.length) data.push(['(no sales in date range for ' + ch.label + ')']);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 22 }, { wch: 26 },
      { wch: 42 }, { wch: 22 }, { wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, ch.sheetName);
  }

  // Summary sheet — built first so it appears as the first tab
  const summarySheet = [['Month', 'Store (£)', 'eBay (£)', 'Cash (£)', 'Bank (£)', 'TOTAL (£)']];
  const months = Object.keys(summary).sort();
  let grandStore = 0, grandEbay = 0, grandCash = 0, grandBank = 0;
  for (const m of months) {
    const [yr, mo] = m.split('-');
    const monthLabel = mo ? new Date(yr, parseInt(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Unknown';
    const row = summary[m];
    const total = (row.shopify||0) + (row.ebay||0) + (row.cash||0) + (row.bank||0);
    grandStore += row.shopify||0; grandEbay += row.ebay||0; grandCash += row.cash||0; grandBank += row.bank||0;
    summarySheet.push([monthLabel, row.shopify||0, row.ebay||0, row.cash||0, row.bank||0, total]);
  }
  summarySheet.push([]);
  summarySheet.push(['TOTAL', grandStore, grandEbay, grandCash, grandBank, grandStore+grandEbay+grandCash+grandBank]);
  const summaryWs = XLSX.utils.aoa_to_sheet(summarySheet);
  summaryWs['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
  // Prepend Summary sheet
  wb.SheetNames.unshift('Summary');
  wb.Sheets['Summary'] = summaryWs;

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = filterChannel && filterChannel !== 'all'
    ? `sales-${filterChannel}-${new Date().toISOString().slice(0,10)}.xlsx`
    : `sales-all-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

// ──────────────────────────────────────────────────────────────────────────
// Invoice Hub — admin tools (registered before /:id so the literal paths win).
// GET  /api/sales/invoice-hub/status   — is it configured + which company.
// POST /api/sales/invoice-hub/backfill — { month:"YYYY-MM", dryRun?, withRefunds? }
//   Backfills past direct cash/bank sales. Powers the Settings button so a
//   one-off catch-up needs no terminal. Idempotent on the Hub side.
// ──────────────────────────────────────────────────────────────────────────
router.get('/invoice-hub/status', requireAdmin, async (req, res) => {
  res.json(require('../services/invoiceHub').status());
});

router.post('/invoice-hub/backfill', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const result = await require('../services/invoiceHub').backfillMonth({
    month: b.month,
    dryRun: !!b.dryRun,
    withRefunds: !!b.withRefunds,
  });
  if (!result.dryRun && result.ok) {
    await audit(req, 'invoice_hub_backfill', 'sale', null,
      { month: result.month, found: result.found, saleOk: result.saleOk, saleErr: result.saleErr });
  }
  res.status(result.ok ? 200 : 400).json(result);
});

// GET /api/sales/:id
router.get('/:id', requireAdmin, async (req, res, next) => {
  // Sale ids are numeric. Let non-numeric paths (e.g. /vat-report, /vat-report.csv)
  // fall through to their dedicated handlers instead of being treated as an id.
  if (!/^\d+$/.test(req.params.id)) return next();
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const items = await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id]);
  await audit(req, 'view_sale', 'sale', req.params.id);  // GDPR: log customer-data read
  res.json({ sale: s.rows[0], items: items.rows });
});

// POST /api/sales — record a manual sale or estimate.
// Body: { channel, paymentMethod, isEstimate, customerName, customerPhone, customerEmail,
//         shippingAddress, vehicleReg, orderNumber, items, shipping, notes }
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'invalid_channel' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'items_required' });
  if (!['direct_cash', 'direct_bank', 'direct_card'].includes(b.channel)) {
    return res.status(400).json({ error: 'channel_not_manual_entry' });
  }
  // Map UI payment method → channel where possible (cash / bank / card[=Stripe])
  const paymentMethod = b.paymentMethod ||
    (b.channel === 'direct_cash' ? 'cash' : b.channel === 'direct_card' ? 'card' : 'bank');
  // Ship vs collect. Honour an explicit choice; otherwise cash defaults to
  // collection, card/bank default to shipping (matches the old behaviour).
  const fulfillmentMethod = (b.fulfillmentMethod === 'ship' || b.fulfillmentMethod === 'collect')
    ? b.fulfillmentMethod
    : (paymentMethod === 'cash' ? 'collect' : 'ship');

  const settings = await query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
  const setRow = settings.rows[0] || {};
  const vatRegistered = !!setRow.vat_registered;
  const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;

  const isEstimate = !!b.isEstimate;
  // Pre-order: the item isn't in stock yet (a pre-listed product or simply out of
  // stock with a container on the way). A pre-order does NOT validate or deduct
  // stock, is allowed at 0 qty, and is kept out of revenue/dispatch until the
  // stock arrives and it's flipped to a normal order (see the stock-in hook in
  // routes/products.js / routes/incoming.js). docType 'preorder' or preorder=true.
  const isPreorder = !isEstimate && (b.docType === 'preorder' || !!b.preorder);
  // Whether this sale is paid now (vs an issued-but-unpaid invoice). Needed both
  // inside the transaction (sale status/stock) AND after it (Invoice Hub push),
  // so it lives in the outer scope.
  const isPaid = isEstimate ? true : (b.paid !== false);

  const result = await withTx(async (c) => {
    let subtotal = 0;
    const itemsResolved = [];
    // Collect ALL stock shortfalls in one pass so the UI can list every offending
    // line at once, instead of the user fixing one and re-submitting to find the next.
    const shortages = [];
    for (const it of b.items) {
      if (it.productId) {
        // Inventory-backed item
        const p = await c.query(
          'SELECT id, sku, title, qty_on_hand FROM products WHERE id = $1 FOR UPDATE',
          [it.productId]
        );
        if (!p.rows[0]) return { error: 'product_not_found', productId: it.productId };
        // For non-estimate paid sales, validate stock. Estimates and pre-orders
        // don't touch stock at all (a pre-order is expressly for items not yet in).
        if (!isEstimate && !isPreorder && p.rows[0].qty_on_hand < it.qty) {
          shortages.push({ productId: p.rows[0].id, sku: p.rows[0].sku, title: p.rows[0].title,
                           requested: parseInt(it.qty), available: p.rows[0].qty_on_hand });
          continue;
        }
        const lineTotal = +(parseFloat(it.unitPrice) * parseInt(it.qty)).toFixed(2);
        subtotal += lineTotal;
        itemsResolved.push({
          productId: p.rows[0].id, sku: p.rows[0].sku, title: p.rows[0].title,
          qty: parseInt(it.qty), unitPrice: parseFloat(it.unitPrice), lineTotal,
        });
      } else {
        // Custom item — no inventory link, no stock change
        const lineTotal = +(parseFloat(it.unitPrice) * parseInt(it.qty)).toFixed(2);
        subtotal += lineTotal;
        itemsResolved.push({
          productId: null, sku: 'CUSTOM', title: it.customTitle || 'Custom item',
          qty: parseInt(it.qty), unitPrice: parseFloat(it.unitPrice), lineTotal,
        });
      }
    }

    // Any inventory-backed line short on stock → abort with the full list. Keep
    // sku/available at the top level for older clients that read just the first.
    if (shortages.length) {
      return { error: 'insufficient_stock', shortages,
               productId: shortages[0].productId, sku: shortages[0].sku, available: shortages[0].available };
    }

    // VAT model: prices in the system match Shopify/eBay listing prices, which
    // are gross (VAT-INCLUSIVE). subtotal therefore already contains VAT — we
    // must NOT add it on top. The `vat` column stores the VAT *portion* of the
    // gross subtotal (for accounting/reporting). Total = subtotal + shipping.
    //
    // Policy:
    //  • Cash on collection → no VAT recorded (£0). Receipt, not an invoice.
    //  • Bank / Card / Online → if vat_registered, record VAT portion of gross.
    // Delivery is taxable income too, so VAT is taken on the gross subtotal PLUS
    // shipping (both are VAT-inclusive). Total is unchanged.
    const isCashSale = paymentMethod === 'cash';
    const vatChargeable = !isCashSale && vatRegistered;
    const shipping = parseFloat(b.shipping || 0);
    const grossForVat = subtotal + shipping;
    const vat = vatChargeable
      ? +(grossForVat - grossForVat / (1 + vatRate)).toFixed(2)  // VAT portion of gross (goods + delivery)
      : 0;
    const total = +(subtotal + shipping).toFixed(2);  // subtotal IS gross — no VAT added

    // Generate identifiers — one unified reference for both columns. Estimates
    // reserve a reference but keep invoice_number null until converted.
    const reference = await buildSaleReference(c, { channel: b.channel, orderNumber: b.orderNumber });
    const invoiceNumber = isEstimate ? null : reference;
    const paymentReference = reference;

    // Resolve customer link — either an existing customer_id (picked from
    // autocomplete) or a freshly-created record via b.createCustomer payload.
    // The sale's denormalised customer_name/email/phone columns are still set
    // for historical accuracy, but customer_id lets us roll up lifetime spend.
    let customerId = b.customerId || null;
    if (!customerId && b.createCustomer && b.customerName) {
      try {
        // Self-healing in case the customers table doesn't exist yet
        await c.query(`CREATE TABLE IF NOT EXISTS customers (
          id SERIAL PRIMARY KEY, name TEXT NOT NULL, business_name TEXT,
          email TEXT, phone TEXT, address TEXT, whatsapp TEXT, notes TEXT,
          is_trade BOOLEAN NOT NULL DEFAULT false, tags TEXT,
          created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const cu = await c.query(
          `INSERT INTO customers (name, business_name, email, phone, address, whatsapp, notes, is_trade, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [b.customerName, b.customerBusinessName || null, b.customerEmail || null,
           b.customerPhone || null, b.shippingAddress || null, b.customerWhatsapp || null,
           b.customerNotes || null, !!b.customerIsTrade, req.user.id]
        );
        customerId = cu.rows[0].id;
      } catch (e) {
        console.warn('[sales] customer auto-create failed:', e.message);
      }
    }

    // #13: an issued-but-unpaid invoice (b.paid === false) still gives the parts
    // (stock decrements like any invoice) but is flagged for payment follow-up.
    // isPaid is computed in the outer scope (used again for the Invoice Hub push).
    await ensurePaidColumn();
    // Fitment only applies to self-service Shopify storefront orders. Direct
    // sales (cash/bank/card) are quoted by staff who confirm fitment first, so
    // they're never flagged. large_panel still applies (courier routing).
    const needsFitment = false;
    let largePanel = false;
    const pids = itemsResolved.map(i => i.productId).filter(Boolean);
    if (pids.length) {
      const lp = await c.query(`SELECT bool_or(COALESCE(large_panel,false)) AS lp FROM products WHERE id = ANY($1)`, [pids]);
      largePanel = !!lp.rows[0]?.lp;
    }
    const sale = await c.query(
      `INSERT INTO sales (channel, customer_name, customer_phone, customer_email,
                          subtotal, vat, shipping, total, status, invoice_number,
                          notes, recorded_by, payment_method, payment_reference,
                          is_estimate, order_number, vehicle_reg, vin_number, shipping_address,
                          customer_id, is_paid, paid_at, fulfillment_method, needs_fitment, large_panel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [b.channel, b.customerName || null, b.customerPhone || null, b.customerEmail || null,
       subtotal, vat, shipping, total,
       isEstimate ? 'pending' : (isPreorder ? 'preorder' : (isPaid ? 'paid' : 'pending')),
       invoiceNumber, b.notes || null, req.user.id,
       paymentMethod, paymentReference,
       isEstimate, b.orderNumber || null, b.vehicleReg || null, b.vinNumber || null, b.shippingAddress || null,
       customerId, isPaid, (!isEstimate && isPaid) ? new Date() : null, fulfillmentMethod, needsFitment, largePanel]
    );

    for (const it of itemsResolved) {
      await c.query(
        `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.rows[0].id, it.productId, it.sku, it.title, it.qty, it.unitPrice, it.lineTotal]
      );
      // Estimates and pre-orders NEVER touch stock. Paid sales decrement only
      // inventory-backed items.
      if (!isEstimate && !isPreorder && it.productId) {
        await c.query(
          `UPDATE products SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`,
          [it.qty, it.productId]
        );
        await c.query(
          `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [it.productId, -it.qty, `sale_${b.channel}`, sale.rows[0].id, req.user.id]
        );
      }
    }

    return { sale: sale.rows[0], items: itemsResolved };
  });

  if (result.error) return res.status(409).json(result);
  await audit(req, isEstimate ? 'create_estimate' : (isPreorder ? 'create_preorder' : 'create_sale'), 'sale', result.sale.id, {
    channel: b.channel, total: result.sale.total
  });

  // Push stock for non-estimate, non-preorder sales (pre-orders don't change stock).
  if (!isEstimate && !isPreorder) {
    setImmediate(() => {
      const sync = require('../services/sync');
      sync.pushStockForSaleItems(result.items).catch(e => console.warn('[sync] push failed:', e.message));
      // Any line that sold down to 0 but has stock on the way → list as a pre-order.
      for (const it of result.items) {
        if (it.productId) sync.handleStockOutIfIncoming(it.productId).catch(() => {});
      }
    });
  } else if (isPreorder) {
    // A pre-order was placed → the available-to-promise drops; re-push the capped
    // count to the channels so the listing shows fewer units remaining.
    setImmediate(() => {
      const { pushProductStockToChannels } = require('./products');
      for (const it of result.items) {
        if (it.productId) pushProductStockToChannels(it.productId).catch(() => {});
      }
    });
  }
  // Forward our own direct bank/cash sales to the Invoice Hub (best-effort).
  // Only paid, non-estimate, in-scope sales — eBay/Shopify/card are excluded
  // (reconciled via platform statement uploads). A pending invoice is pushed
  // later when it's marked paid.
  if (!isEstimate && !isPreorder && isPaid) {
    const invoiceHub = require('../services/invoiceHub');
    if (invoiceHub.isInScope(result.sale.channel)) {
      setImmediate(() => invoiceHub.pushSale(result.sale.id).catch(e => console.warn('[invoiceHub] push failed:', e.message)));
    }
  }
  // Auto-email the document (proforma / estimate / paid invoice / receipt) to the
  // customer — best-effort, only when Resend is configured, auto-send is on, and a
  // customer email is present.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  setImmediate(() => maybeAutoEmailSale(result.sale.id, baseUrl));
  res.status(201).json(result);
});

// POST /api/sales/:id/mark-paid — record payment for an already-issued invoice
// (#13). Stock was already decremented when the invoice was issued, so this only
// flips the payment state — no inventory change.
router.post('/:id/mark-paid', requireAdmin, async (req, res) => {
  await ensurePaidColumn();
  const s = await query(`SELECT id, is_estimate, status, channel FROM sales WHERE id = $1`, [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (s.rows[0].is_estimate) return res.status(400).json({ error: 'is_estimate', message: 'Use “Mark paid” on the estimate to convert it to an invoice.' });
  const newStatus = (s.rows[0].status === 'pending') ? 'paid' : s.rows[0].status;
  // Optional explicit payment date so the figure lines up with the VAT period /
  // bank statement it was actually received in (defaults to now()).
  let paidAt = null;
  if (req.body && req.body.paidAt) { const d = new Date(req.body.paidAt); if (!isNaN(d)) paidAt = d; }
  const upd = await query(
    `UPDATE sales SET is_paid = true, paid_at = COALESCE($3, now()), status = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, newStatus, paidAt]);
  await audit(req, 'sale_mark_paid', 'sale', req.params.id, { paidAt: paidAt || 'now' });
  // A pending direct bank/cash invoice has now been paid → forward it to the
  // Invoice Hub (best-effort; idempotent on the Hub side).
  {
    const invoiceHub = require('../services/invoiceHub');
    if (invoiceHub.isInScope(s.rows[0].channel)) {
      setImmediate(() => invoiceHub.pushSale(req.params.id).catch(e => console.warn('[invoiceHub] push failed:', e.message)));
    }
  }
  // Was an unpaid (pending) invoice → now paid: email the paid invoice/receipt.
  if (s.rows[0].status === 'pending') {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    setImmediate(() => maybeAutoEmailSale(req.params.id, baseUrl));
  }
  res.json({ ok: true, sale: upd.rows[0] });
});

// Flip an invoice back to unpaid (correct a mistake / chase again). Estimates excluded.
router.post('/:id/mark-unpaid', requireAdmin, async (req, res) => {
  await ensurePaidColumn();
  const s = await query(`SELECT id, is_estimate FROM sales WHERE id = $1`, [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (s.rows[0].is_estimate) return res.status(400).json({ error: 'is_estimate' });
  const upd = await query(`UPDATE sales SET is_paid = false, paid_at = NULL WHERE id = $1 RETURNING *`, [req.params.id]);
  await audit(req, 'sale_mark_unpaid', 'sale', req.params.id, null);
  res.json({ ok: true, sale: upd.rows[0] });
});

// POST /api/sales/:id/retry-invoice-push — manually re-send a direct bank/cash
// sale (and any refund against it) to the Invoice Hub after a failed push.
// Mirrors the dispatch "retry-push" button. Idempotent on the Hub side.
router.post('/:id/retry-invoice-push', requireAdmin, async (req, res) => {
  const invoiceHub = require('../services/invoiceHub');
  const s = await query(`SELECT id, channel, status FROM sales WHERE id = $1`, [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (!invoiceHub.isInScope(s.rows[0].channel)) {
    return res.status(409).json({ error: 'out_of_scope', message: 'Only direct bank/cash sales are pushed to the Invoice Hub.' });
  }
  setImmediate(() => invoiceHub.pushSale(req.params.id).catch(e => console.warn('[invoiceHub.retry]', e.message)));
  if (s.rows[0].status === 'refunded') {
    setImmediate(() => invoiceHub.pushRefund(req.params.id).catch(e => console.warn('[invoiceHub.retry]', e.message)));
  }
  await audit(req, 'sale_retry_invoice_push', 'sale', req.params.id, null);
  res.json({ ok: true, message: 'Retry queued — check back in a few seconds.' });
});

// ──────────────────────────────────────────────────────────────────────────
// VAT RETURNS
// VAT quarters use HMRC stagger group 3 (quarters end Feb / May / Aug / Nov):
//   Q1  Dec 1 – Feb (end)    Q2  Mar 1 – May 31
//   Q3  Jun 1 – Aug 31       Q4  Sep 1 – Nov 30
// Cash sales are NOT VATable (no VAT recorded). Bank + Card(=Stripe) ARE VATable
// and their prices are gross/VAT-inclusive, so VAT = the stored `vat` column.
// ──────────────────────────────────────────────────────────────────────────
const VAT_QUARTERS = [
  { q: 1, label: 'Q1 (Dec–Feb)', startMonth: 12, endMonth: 2 },
  { q: 2, label: 'Q2 (Mar–May)', startMonth: 3,  endMonth: 5 },
  { q: 3, label: 'Q3 (Jun–Aug)', startMonth: 6,  endMonth: 8 },
  { q: 4, label: 'Q4 (Sep–Nov)', startMonth: 9,  endMonth: 11 },
];
// For a given "VAT year" (the calendar year the quarter ENDS in) + quarter number,
// return the [from, toExclusive] date range. Q1 starts in the PRIOR December.
function vatQuarterRange(year, q) {
  const def = VAT_QUARTERS.find(x => x.q === q) || VAT_QUARTERS[0];
  const startYear = def.q === 1 ? year - 1 : year;
  const from = new Date(Date.UTC(startYear, def.startMonth - 1, 1, 0, 0, 0));
  const toExclusive = new Date(Date.UTC(year, def.endMonth, 1, 0, 0, 0)); // first day after the end month
  return { from, toExclusive, label: def.label };
}
function currentVatPeriod(d = new Date()) {
  const m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  // The quarter ends in this calendar year except December, which belongs to
  // next year's Q1 (Dec–Feb).
  if (m === 12) return { year: y + 1, q: 1 };
  if (m <= 2) return { year: y, q: 1 };
  if (m <= 5) return { year: y, q: 2 };
  if (m <= 8) return { year: y, q: 3 };
  return { year: y, q: 4 };
}

// Resolve the report window from query params: either ?year=&quarter= or
// ?month=YYYY-MM. Defaults to the current VAT quarter.
function resolveVatWindow(q) {
  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
    const [y, m] = q.month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const toExclusive = new Date(Date.UTC(y, m, 1));
    return { from, toExclusive, label: from.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), kind: 'month' };
  }
  const cur = currentVatPeriod();
  const year = parseInt(q.year, 10) || cur.year;
  const quarter = parseInt(q.quarter, 10) || cur.q;
  const r = vatQuarterRange(year, quarter);
  return { ...r, label: `${r.label} ${year}`, kind: 'quarter', year, quarter };
}

// Core query: VATable (bank+card) sales in the window, plus the non-VAT cash
// total for context. `basis=paid` counts only invoices marked paid (cash
// accounting) using paid_at; otherwise uses occurred_at (accrual).
async function vatReportData(win, basis) {
  await ensurePaidColumn();
  const dateCol = basis === 'paid' ? 'paid_at' : 'occurred_at';
  const paidClause = basis === 'paid' ? 'AND s.is_paid = true' : '';
  const rows = await query(`
    SELECT s.id, s.${dateCol} AS date, s.invoice_number, s.payment_reference, s.payment_method,
           s.customer_name, s.subtotal, s.vat, s.shipping, s.total, s.is_paid, s.paid_at, s.occurred_at
      FROM sales s
     WHERE s.is_estimate = false
       AND s.status NOT IN ('refunded','cancelled')
       AND s.payment_method IN ('bank','card')
       AND s.${dateCol} >= $1 AND s.${dateCol} < $2
       ${paidClause}
     ORDER BY s.${dateCol} ASC
  `, [win.from, win.toExclusive]);
  const cash = await query(`
    SELECT COALESCE(SUM(total),0)::numeric AS total, COUNT(*)::int AS n
      FROM sales s
     WHERE s.is_estimate = false AND s.status NOT IN ('refunded','cancelled')
       AND s.payment_method = 'cash'
       AND s.${dateCol} >= $1 AND s.${dateCol} < $2 ${paidClause}
  `, [win.from, win.toExclusive]);
  const sum = rows.rows.reduce((a, r) => {
    a.gross += parseFloat(r.total || 0);
    a.vat += parseFloat(r.vat || 0);
    a.net += parseFloat(r.total || 0) - parseFloat(r.vat || 0);
    a[r.payment_method] = (a[r.payment_method] || 0) + parseFloat(r.total || 0);
    return a;
  }, { gross: 0, vat: 0, net: 0 });
  return {
    window: { label: win.label, from: win.from, to: win.toExclusive, kind: win.kind, basis: basis === 'paid' ? 'paid' : 'accrual' },
    vatable: { count: rows.rows.length, gross: +sum.gross.toFixed(2), net: +sum.net.toFixed(2), vat: +sum.vat.toFixed(2),
               byMethod: { bank: +(sum.bank || 0).toFixed(2), card: +(sum.card || 0).toFixed(2) } },
    cash: { count: cash.rows[0].n, total: +parseFloat(cash.rows[0].total).toFixed(2) },
    rows: rows.rows,
  };
}

// GET /api/sales/vat-report — JSON summary for the on-screen VAT panel.
router.get('/vat-report', requireAdmin, async (req, res) => {
  try {
    const win = resolveVatWindow(req.query);
    const data = await vatReportData(win, req.query.basis);
    res.json({ ...data, quarters: VAT_QUARTERS });
  } catch (e) {
    console.error('[sales.vat-report]', e);
    res.status(500).json({ error: 'report_failed', message: e.message });
  }
});

// GET /api/sales/vat-report.csv — the downloadable file for the VAT return.
router.get('/vat-report.csv', requireAdmin, async (req, res) => {
  try {
    const win = resolveVatWindow(req.query);
    const data = await vatReportData(win, req.query.basis);
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [];
    lines.push(`VAT report — ${data.window.label} (${data.window.basis} basis)`);
    lines.push('');
    lines.push(['Date', 'Invoice/Ref', 'Customer', 'Payment', 'Gross (incl VAT)', 'Net', 'VAT', 'Paid', 'Paid date'].join(','));
    for (const r of data.rows) {
      const gross = parseFloat(r.total || 0), vat = parseFloat(r.vat || 0);
      lines.push([
        esc(new Date(r.date).toLocaleDateString('en-GB')),
        esc(r.invoice_number || r.payment_reference || ''),
        esc(r.customer_name || ''),
        esc((r.payment_method || '').toUpperCase()),
        gross.toFixed(2), (gross - vat).toFixed(2), vat.toFixed(2),
        r.is_paid ? 'Yes' : 'No',
        esc(r.paid_at ? new Date(r.paid_at).toLocaleDateString('en-GB') : ''),
      ].join(','));
    }
    lines.push('');
    lines.push(['TOTALS (VATable: bank + card)', '', '', '', data.vatable.gross.toFixed(2), data.vatable.net.toFixed(2), data.vatable.vat.toFixed(2), '', ''].join(','));
    lines.push([`Cash (non-VAT) ${data.cash.count} sale(s)`, '', '', '', data.cash.total.toFixed(2), '', '0.00', '', ''].join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="vat-${(data.window.label).replace(/[^\w-]+/g, '_')}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    console.error('[sales.vat-report.csv]', e);
    res.status(500).json({ error: 'report_failed', message: e.message });
  }
});

// POST /api/sales/:id/convert-to-invoice — turn an estimate into a paid invoice
router.post('/:id/convert-to-invoice', requireAdmin, async (req, res) => {
  const paymentMethod = req.body.paymentMethod || 'cash';
  const result = await withTx(async (c) => {
    const s = await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!s.rows[0]) return { error: 'not_found' };
    if (!s.rows[0].is_estimate) return { error: 'not_an_estimate' };

    // Promote the estimate's existing reserved reference to its invoice number —
    // keep the number it was quoted under rather than issuing a new one.
    const reference = s.rows[0].payment_reference
      || await buildSaleReference(c, { channel: s.rows[0].channel, orderNumber: s.rows[0].order_number });
    const invoiceNumber = reference;
    const paymentReference = reference;

    // Decrement stock now that it's paid
    const items = await c.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [req.params.id]);
    for (const it of items.rows) {
      if (!it.product_id) continue;
      const p = await c.query(`SELECT qty_on_hand FROM products WHERE id = $1 FOR UPDATE`, [it.product_id]);
      if (!p.rows[0] || p.rows[0].qty_on_hand < it.qty) {
        return { error: 'insufficient_stock', sku: it.sku };
      }
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`, [it.qty, it.product_id]);
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [it.product_id, -it.qty, `sale_${s.rows[0].channel}`, s.rows[0].id, req.user.id]
      );
    }

    // Recompute VAT/total in case payment method changed (legacy estimates without one).
    // Subtotal is always gross-inclusive — total = subtotal + shipping; vat is portion.
    const settings = await c.query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
    const setRow = settings.rows[0] || {};
    const vatRegistered = !!setRow.vat_registered;
    const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;
    const isCashSale = paymentMethod === 'cash';
    const vatChargeable = !isCashSale && vatRegistered;
    const subtotal = parseFloat(s.rows[0].subtotal);
    const shipping = parseFloat(s.rows[0].shipping || 0);
    const grossForVat = subtotal + shipping;   // delivery is taxable income too
    const vat = vatChargeable ? +(grossForVat - grossForVat / (1 + vatRate)).toFixed(2) : 0;
    const total = +(subtotal + shipping).toFixed(2);

    const updated = await c.query(`
      UPDATE sales SET
        is_estimate = false, status = 'paid', invoice_number = $1,
        payment_reference = $2, payment_method = $3, occurred_at = now(),
        vat = $4, total = $5
      WHERE id = $6 RETURNING *`,
      [invoiceNumber, paymentReference, paymentMethod, vat, total, req.params.id]);

    return { sale: updated.rows[0], items: items.rows };
  });

  if (result.error) return res.status(409).json(result);
  await audit(req, 'convert_estimate_to_invoice', 'sale', result.sale.id, { paymentMethod });
  // Push stock to channels
  setImmediate(() => {
    const sync = require('../services/sync');
    sync.pushStockForSaleItems(result.items.map(i => ({ productId: i.product_id })))
      .catch(e => console.warn('[sync] push failed:', e.message));
    // Any line that sold down to 0 but has stock on the way → list as a pre-order.
    for (const it of result.items) {
      if (it.product_id) sync.handleStockOutIfIncoming(it.product_id).catch(() => {});
    }
  });
  // Estimate → invoice: email the finalised invoice to the customer.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  setImmediate(() => maybeAutoEmailSale(result.sale.id, baseUrl));
  res.json(result);
});

// Helpers shared by invoice + email
async function getCompanySettings() {
  const r = await query('SELECT * FROM app_settings WHERE id = 1');
  return r.rows[0] || {};
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInvoiceHtml({ sale, items, company, mode, baseUrl }) {
  // mode: 'invoice' | 'estimate' | 'receipt'
  const brand = require('../lib/brand');
  const fmt = (n) => '\u00A3' + parseFloat(n || 0).toFixed(2);
  const date = sale.occurred_at ? new Date(sale.occurred_at) : new Date();
  const datePretty = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Channel + payment labels
  const isVatRegistered = !!company.vat_registered;
  const isEbay = (sale.channel || '').startsWith('ebay');
  const isShopify = sale.channel === 'shopify';
  const isDirect = sale.channel === 'direct_cash' || sale.channel === 'direct_bank';

  const paymentLabel = (() => {
    const pm = sale.payment_method;
    if (pm === 'shopify') return 'Shopify Payment';
    if (pm === 'ebay')    return 'eBay Payment';
    if (pm === 'cash')    return 'Cash';
    if (pm === 'bank')    return 'Bank Transfer';
    if (pm === 'card')    return 'Card (Stripe)';
    if (isShopify) return 'Shopify Payment';
    if (isEbay) return 'eBay Payment';
    if (sale.channel === 'direct_cash') return 'Cash';
    if (sale.channel === 'direct_bank') return 'Bank Transfer';
    return '\u2014';
  })();
  const channelLabel = (() => {
    if (isShopify) return 'Store';
    if (isEbay) return 'eBay';
    if (sale.channel === 'direct_cash') return 'Cash sale';
    if (sale.channel === 'direct_bank') return 'Bank transfer';
    return (sale.channel || '').replace(/_/g, ' ');
  })();

  // Customer name on invoice: prefer the shipping-address first line (real name).
  // Never use the eBay username on the customer-facing invoice — it's not their name.
  // If we have no shipping address yet, show a friendly placeholder; staff still see
  // the username in the Sales tab and order detail modal.
  // Also clean any stale "ebayXXX" anonymized email proxies or "GB" country lines stored
  // before the sanitiser was added to the sync code.
  const cleanedAddressLines = (sale.shipping_address || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^ebay[a-z0-9]{4,}$/i.test(l) && !/^(GB|UK|GBR|United Kingdom)$/i.test(l));
  const cleanedAddress = cleanedAddressLines.join('\n');

  let billedToName = sale.customer_name || 'Walk-in customer';
  if (cleanedAddress) {
    const firstLine = cleanedAddressLines[0];
    if (firstLine) billedToName = firstLine;
  } else if (isEbay) {
    billedToName = 'eBay customer';
  } else if (isShopify) {
    billedToName = 'Online customer';
  }

  const isCashReceipt = mode === 'receipt' || sale.payment_method === 'cash';
  // Pro-forma uses the FULL invoice template (1:1 with a real invoice) — just a different
  // document title and a "not yet paid" notice. Customer needs to recognise it as a
  // normal invoice they can pay against, not a casual estimate.
  const isProforma = mode === 'proforma';
  const docTitle = mode === 'estimate' ? 'ESTIMATE'
                 : isProforma ? 'PRO FORMA INVOICE'
                 : isCashReceipt ? 'RECEIPT'
                 : 'INVOICE';

  // Print suppression: empty <title> + @page CSS removes URL/timestamp headers in most browsers.
  // (Browsers still show some headers if user hasn't disabled them in print settings; the user
  // must uncheck "Headers and footers" once in their printer settings.)
  const printCSS = `
    @page { margin: 12mm; size: A4; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
  `;

  // Returns / fitment policy varies per channel
  const policyDomain = (company.company_website || brand.domain || '').replace(/^https?:\/\//, '') || 'our website';
  const returnsPolicy = isEbay
    ? "Returns handled via eBay within 30 days. Open a return request through your eBay account; we'll respond within 48 hours."
    : isShopify
    ? `30-day returns from delivery, in original packaging. Open a return request via your account at ${policyDomain}. 5% restocking fee applies.`
    : "Within 30 days of purchase, in original packaging. 5% restocking fee applies. Return shipping at buyer's cost unless faulty.";

  const fitmentPolicy = (isEbay || isShopify)
    ? "Customer confirmed fitment before ordering by matching the part number, OEM reference and listing photos. We supply the exact item shown in the listing."
    : "All parts checked for fitment before despatch. Refunded if part doesn't fit as advertised. Confirm OEM number before ordering.";

  // ----- ESTIMATE: minimal layout, no logo, no business details -----
  if (mode === 'estimate') {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  ${printCSS}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#111;background:#fafafa;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
  .actions{display:flex;gap:10px;justify-content:center;margin:20px 0;flex-wrap:wrap}
  .btn{display:inline-block;padding:9px 20px;background:#111;color:white;border-radius:4px;text-decoration:none;font-weight:500;font-size:12px;cursor:pointer;border:none;font-family:inherit}
  .btn.ghost{background:white;color:#111;border:1px solid #ccc}
  .page{max-width:680px;margin:24px auto;background:white;padding:48px 56px;box-shadow:0 1px 4px rgba(0,0,0,.05)}
  .head{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:18px;border-bottom:1px solid #ddd;margin-bottom:28px}
  .head h1{font-size:24px;font-weight:600;letter-spacing:.04em;color:#111}
  .head .ref{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#888;margin-top:4px}
  .head .right{text-align:right;font-size:11px;color:#888}
  .head .right strong{display:block;color:#111;font-size:13px;font-weight:500;margin-top:2px}
  .customer-block{margin-bottom:24px}
  .customer-block .label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#888;font-weight:500;margin-bottom:4px}
  .customer-block .name{font-size:14px;font-weight:500}
  .customer-block .addr{font-size:12px;color:#555;margin-top:2px;white-space:pre-line}
  table{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:13px}
  table thead th{text-align:left;padding:10px 0;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#888;font-weight:500;border-bottom:1px solid #ddd}
  table thead th.num{text-align:right}
  table tbody td{padding:12px 0;border-bottom:1px solid #f0f0f0;vertical-align:top}
  table tbody td.num{text-align:right;font-variant-numeric:tabular-nums}
  table .sku{font-family:ui-monospace,monospace;font-size:10.5px;color:#999;margin-top:2px}
  .totals{margin-left:auto;width:280px;font-size:13px;margin-top:8px}
  .totals .row{display:flex;justify-content:space-between;padding:5px 0}
  .totals .grand{font-weight:600;font-size:16px;padding-top:10px;margin-top:6px;border-top:1px solid #111}
  .estimate-notice{margin-top:32px;padding:14px 0;border-top:1px solid #ddd;text-align:center;font-size:11px;color:#888;line-height:1.7}
  .estimate-notice strong{color:#111;font-weight:500}
</style></head><body>
<div class="actions no-print">
  <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  <a class="btn ghost" href="#" onclick="window.close();return false">Close</a>
</div>
<div class="page">
  <div class="head">
    <div>
      <h1>ESTIMATE</h1>
      <div class="ref">${escapeHtml(sale.payment_reference || '\u2014')}</div>
    </div>
    <div class="right">
      Issued<strong>${escapeHtml(datePretty)}</strong>
    </div>
  </div>

  <div class="customer-block">
    <div class="label">For</div>
    <div class="name">${escapeHtml(billedToName)}</div>
    ${cleanedAddress ? `<div class="addr">${escapeHtml(cleanedAddressLines.slice(1).join('\n'))}</div>` : ''}
    ${sale.customer_phone ? `<div class="addr">${escapeHtml(sale.customer_phone)}</div>` : ''}
    ${sale.customer_email ? `<div class="addr">${escapeHtml(sale.customer_email)}</div>` : ''}
  </div>

  ${(sale.vehicle_reg || sale.vin_number) ? `
  <div class="customer-block">
    <div class="label">Vehicle</div>
    ${sale.vehicle_reg ? `<div class="name">${escapeHtml(sale.vehicle_reg)}</div>` : ''}
    ${sale.vin_number ? `<div class="addr" style="font-family:ui-monospace,monospace">VIN: ${escapeHtml(sale.vin_number)}</div>` : ''}
  </div>` : ''}

  ${sale.payment_method ? `
  <div class="customer-block">
    <div class="label">Payment method</div>
    <div class="name">${sale.payment_method === 'cash' ? '💰 Cash on collection'
                       : sale.payment_method === 'bank' ? '🏦 Bank transfer'
                       : sale.payment_method === 'card' ? '💳 Card'
                       : escapeHtml(sale.payment_method)}</div>
  </div>` : ''}

  <table>
    <thead><tr>
      <th>Item</th>
      <th class="num" style="width:60px">Qty</th>
      <th class="num" style="width:90px">Unit</th>
      <th class="num" style="width:100px">Total</th>
    </tr></thead>
    <tbody>
      ${items.map(i => `<tr>
        <td>${escapeHtml(i.title)}<div class="sku">${escapeHtml(i.sku || '')}</div></td>
        <td class="num">${i.qty}</td>
        <td class="num">${fmt(i.unit_price)}</td>
        <td class="num">${fmt(i.line_total)}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span style="color:#888">Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
    ${parseFloat(sale.shipping || 0) > 0 ? `<div class="row"><span style="color:#888">Shipping</span><span>${fmt(sale.shipping)}</span></div>` : ''}
    <div class="row grand"><span>Total</span><span>${fmt(sale.total)}</span></div>
  </div>

  <div class="estimate-notice">
    This is an <strong>estimate</strong>, not a tax invoice. Prices valid for 14 days from the date above.<br>
    To confirm, quote reference <strong>${escapeHtml(sale.payment_reference || '')}</strong>.
  </div>
</div>
</body></html>`;
  }

  // ----- CASH RECEIPT: very compact, no company details / no VAT info (per brief) -----
  if (isCashReceipt) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  ${printCSS}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#111;max-width:420px;margin:24px auto;padding:0 24px;line-height:1.5;font-size:13px;-webkit-font-smoothing:antialiased}
  .head{text-align:center;padding-bottom:14px;border-bottom:1px solid #ddd;margin-bottom:18px}
  .doctype{font-size:14px;letter-spacing:.18em;color:#888;font-weight:500}
  .ref{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#111;margin-top:6px}
  .meta{margin-bottom:14px;color:#555;font-size:12px;text-align:center}
  table{width:100%;border-collapse:collapse;margin:10px 0}
  th,td{padding:8px 0;text-align:left;font-size:12px}
  th{font-size:10px;text-transform:uppercase;color:#888;letter-spacing:.08em;font-weight:500;border-bottom:1px solid #ddd}
  td{border-bottom:1px solid #f0f0f0}
  .num{text-align:right}
  .total{display:flex;justify-content:space-between;font-size:16px;font-weight:600;margin-top:12px;padding-top:12px;border-top:1px solid #111}
  .foot{margin-top:24px;font-size:11px;color:#888;text-align:center;line-height:1.7}
  .actions{margin:20px auto 0;text-align:center}
  .btn{display:inline-block;padding:8px 18px;background:#111;color:white;border-radius:4px;font-weight:500;font-size:12px;cursor:pointer;border:none;font-family:inherit}
  @media print {.actions{display:none}}
</style></head><body>
<div class="head">
  <div class="doctype">RECEIPT</div>
  <div class="ref">${escapeHtml(sale.payment_reference || '')}</div>
</div>
<div class="meta">
  ${escapeHtml(datePretty)} \u00B7 ${escapeHtml(date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}
  ${sale.customer_name ? `<br>${escapeHtml(sale.customer_name)}` : ''}
</div>
<table>
  <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
  <tbody>
    ${items.map(i => `<tr>
      <td>${escapeHtml(i.title)}<div style="font-size:10px;color:#999;margin-top:2px">${escapeHtml(i.sku)}</div></td>
      <td class="num">${i.qty}</td>
      <td class="num">${fmt(i.line_total)}</td>
    </tr>`).join('')}
  </tbody>
</table>
<div class="total"><span>Total paid</span><span>${fmt(sale.total)}</span></div>
<div class="foot">Cash sale. No returns without this receipt.</div>
<div class="actions"><button class="btn" onclick="window.print()">Print</button></div>
</body></html>`;
  }

  // ----- FULL INVOICE -----
  // Logo selection — prefer the uploaded logo (from app_settings.logo_data_url)
  // if one is set, else fall back to the brand-default file in public/. The
  // uploaded version is inlined as a data URL so it always renders in print +
  // email preview without needing a follow-up request.
  const logoUrl = company.logo_data_url
    ? company.logo_data_url
    : (baseUrl || '') + brand.logoUrl;
  // VAT display rules (everywhere prices are gross-inclusive):
  //  • Cash sale: NEVER break out VAT. Just show "Subtotal" + "Total" — no VAT line at all.
  //    User policy is cash is VAT-free. (Even if business is vat_registered, cash is excluded.)
  //  • Bank / Card / Online (vat_registered): break out the VAT *portion* of the gross subtotal.
  //  • Bank / Card / Online (not vat_registered): just show "Subtotal" + "Total" — no VAT.
  const isCashSale = sale.payment_method === 'cash';
  // Break out VAT only when the order ACTUALLY carried VAT (sale.vat > 0). An
  // international export (eBay/Shopify) is zero-rated — sale.vat is 0 — so we must
  // NOT fabricate a 20% split; show plain Subtotal/Shipping/Total instead.
  const vatAmount = parseFloat(sale.vat || 0);
  const shippingGross = parseFloat(sale.shipping || 0);
  const showVatBreakdown = isVatRegistered && !isCashSale && vatAmount > 0;
  // Derive net from the real VAT amount so net + VAT = total exactly (any rate).
  const grossTotal = parseFloat(sale.subtotal || 0) + shippingGross;
  const netFactor = (showVatBreakdown && grossTotal > 0) ? (grossTotal - vatAmount) / grossTotal : 1;
  const subtotalNet = parseFloat(sale.subtotal || 0) * netFactor;
  const shippingNet = shippingGross * netFactor;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  ${printCSS}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#111;background:#fafafa;font-size:12.5px;line-height:1.55;-webkit-font-smoothing:antialiased;letter-spacing:-.005em}
  .actions{display:flex;gap:10px;justify-content:center;margin:20px 0;flex-wrap:wrap}
  .btn{display:inline-block;padding:9px 20px;background:#111;color:white;border-radius:4px;text-decoration:none;font-weight:500;font-size:12px;cursor:pointer;border:none;font-family:inherit}
  .btn.ghost{background:white;color:#111;border:1px solid #ccc}
  .page{max-width:780px;margin:24px auto;background:white;padding:48px 56px;box-shadow:0 1px 4px rgba(0,0,0,.05)}

  /* Header — Hyundai-inspired: logo top-left, doctype top-right */
  .top{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:24px;border-bottom:1.5px solid #111;margin-bottom:28px}
  .top .left img.logo{height:48px;display:block;max-width:200px;object-fit:contain;object-position:left center}
  .top .right{text-align:right}
  .top .right .doctype{font-size:24px;font-weight:600;letter-spacing:.04em;color:#111;line-height:1.1}
  .top .right .ref{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#888;margin-top:8px}
  .top .right .order{font-size:11px;color:#666;margin-top:3px}

  /* Address grid — From + Billed to */
  .addr-grid{display:grid;grid-template-columns:1fr 1fr;gap:36px;padding-bottom:24px;border-bottom:1px solid #eee;margin-bottom:20px}
  .addr-block .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#999;font-weight:500;margin-bottom:8px}
  .addr-block .name{font-size:14px;font-weight:600;margin-bottom:4px;color:#111}
  .addr-block .lines{font-size:11.5px;color:#555;line-height:1.65}
  /* Contact pills — phone / email / website on one line, dot-separated */
  .addr-block .contact-row{margin-top:6px;font-size:11.5px;color:#555;line-height:1.6}
  .addr-block .contact-row span:not(:last-child)::after{content:' · ';color:#bbb;margin:0 2px}
  /* Registration / VAT — small muted line */
  .addr-block .meta-row{margin-top:6px;font-size:10.5px;color:#999;letter-spacing:.02em}
  .addr-block .meta-row span:not(:last-child)::after{content:' · ';margin:0 2px}
  /* Socials — bottom-of-invoice section just above the .foot.
     Monochrome single-colour for clean print + email delivery. SVG icons inline
     so no external requests, no font dependencies, no broken images. */
  .socials{margin-top:24px;padding:14px 0;border-top:1px solid #eee;display:flex;align-items:center;justify-content:center;gap:18px;flex-wrap:wrap;font-size:11.5px;color:#555}
  .socials .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#999;font-weight:500}
  .socials a{display:inline-flex;align-items:center;gap:6px;color:#555;text-decoration:none;font-weight:500;transition:color .15s ease}
  .socials a:hover{color:#111}
  .socials svg{display:block;flex-shrink:0}

  /* Pro-forma notice — colour-coded by payment method.
     The method gets surfaced in a coloured banner above the From/To so the
     customer (and Ali's staff during eyeball checks) instantly know how to pay. */
  .proforma-notice{border-radius:6px;padding:14px 18px;margin-bottom:24px;line-height:1.55}
  .proforma-notice-head{display:flex;align-items:center;gap:12px;margin-bottom:6px;flex-wrap:wrap}
  .proforma-notice-tag{font-size:9.5px;font-weight:700;letter-spacing:.12em;background:#111;color:#fff;padding:3px 8px;border-radius:3px}
  .proforma-notice-method{font-size:14px;font-weight:600}
  .proforma-notice-body{font-size:12px;line-height:1.6}
  /* Bank — blue */
  .proforma-bank{background:#eaf2ff;border:1px solid #b3ccef;color:#1a3c6e}
  .proforma-bank .proforma-notice-tag{background:#1a3c6e}
  .proforma-bank .proforma-notice-method{color:#1a3c6e}
  /* Cash — amber */
  .proforma-cash{background:#fff8e6;border:1px solid #f0d171;color:#5a4400}
  .proforma-cash .proforma-notice-tag{background:#5a4400}
  .proforma-cash .proforma-notice-method{color:#5a4400}
  /* Card — green */
  .proforma-card{background:#e8f5e8;border:1px solid #99cc99;color:#1f6b2e}
  .proforma-card .proforma-notice-tag{background:#1f6b2e}
  .proforma-card .proforma-notice-method{color:#1f6b2e}
  /* Unknown / legacy */
  .proforma-unknown{background:#f5f5f5;border:1px solid #ddd;color:#444}

  /* Detail strip */
  .detail-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:14px 18px;background:#fafafa;border:1px solid #eee;border-radius:4px;margin-bottom:24px}
  .detail-strip .item .l{font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:#999;font-weight:500;margin-bottom:4px}
  .detail-strip .item .v{font-size:12.5px;color:#111;font-weight:500}

  /* Items */
  table.items{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12.5px}
  table.items thead th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#888;font-weight:500;padding:10px 12px;border-top:1px solid #111;border-bottom:1px solid #ddd}
  table.items thead th.num{text-align:right}
  table.items tbody td{padding:14px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top}
  table.items tbody td.num{text-align:right;font-variant-numeric:tabular-nums}
  table.items .sku{font-family:ui-monospace,monospace;font-size:10.5px;color:#999;margin-top:3px}

  /* Totals */
  .totals-wrap{display:flex;justify-content:flex-end;margin-bottom:24px}
  .totals{width:300px;font-size:12.5px}
  .totals .row{display:flex;justify-content:space-between;padding:5px 14px;color:#555}
  .totals .grand{background:#111;color:white;padding:13px 16px;font-size:15px;font-weight:600;margin-top:6px;display:flex;justify-content:space-between;border-radius:3px;letter-spacing:.01em}

  /* Bank details box (only on bank-transfer invoices) */
  .pay{padding:14px 18px;background:#fafafa;border-left:2px solid #111;font-size:12px;border-radius:0 4px 4px 0;margin-bottom:20px}
  .pay .row{display:flex;gap:14px;margin-bottom:6px}
  .pay .row .l{min-width:110px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#888;font-weight:500;padding-top:1px}
  .pay .row .v{font-weight:500;color:#111}

  /* Footer */
  .foot{margin-top:30px;padding-top:18px;border-top:1px solid #eee;font-size:10.5px;color:#666;line-height:1.7}
  .foot .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-bottom:14px}
  .foot .col .h{display:block;color:#111;text-transform:uppercase;font-size:9.5px;letter-spacing:.1em;margin-bottom:5px;font-weight:500}

  /* Review CTA — subtle but noticeable strip just above the foot when a review
     URL is configured. Star + link layout, brand-coloured accent. */
  .review-cta{margin-top:18px;padding:12px 16px;background:#fff8e6;border:1px solid #f0d171;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:11.5px;color:#5a4400}
  .review-cta .rc-text{font-weight:500}
  .review-cta .rc-links{display:flex;gap:10px;flex-wrap:wrap}
  .review-cta a{display:inline-block;padding:6px 12px;background:#5a4400;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;font-size:11px;letter-spacing:.02em}
  .review-cta a:hover{background:#3d2e00}
  .terms{font-size:10px;color:#999;text-align:center;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:12px}
</style></head><body>

<div class="actions no-print">
  <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  <a class="btn ghost" href="#" onclick="window.close();return false">Close</a>
</div>

<div class="page">
  <div class="top">
    <div class="left">
      <img class="logo" src="${logoUrl}" alt="${escapeHtml(brand.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
      <div style="display:none;font-size:22px;font-weight:700;letter-spacing:-.02em">${escapeHtml(brand.name)}</div>
    </div>
    <div class="right">
      <div class="doctype">${docTitle}</div>
      <div class="ref">${escapeHtml(sale.invoice_number || sale.payment_reference || '\u2014')}</div>
    </div>
  </div>

  ${isProforma ? `
  <div class="proforma-notice proforma-${sale.payment_method || 'unknown'}">
    <div class="proforma-notice-head">
      <span class="proforma-notice-tag">PRO FORMA</span>
      <span class="proforma-notice-method">
        ${sale.payment_method === 'cash' ? '💰 Payment by Cash on Collection'
        : sale.payment_method === 'bank' ? '🏦 Payment by Bank Transfer'
        : sale.payment_method === 'card' ? '💳 Payment by Card'
        : 'Payment method not specified'}
      </span>
    </div>
    <div class="proforma-notice-body">
      ${sale.payment_method === 'cash'
        ? `This is a pro-forma invoice for cash payment on collection. Bring this reference when you collect: <strong>${escapeHtml(sale.payment_reference || '')}</strong>. We'll issue a receipt once payment is received.`
        : sale.payment_method === 'bank'
        ? `This is a pro-forma invoice — not a tax invoice. Pay by bank transfer using the details below, quoting reference <strong>${escapeHtml(sale.payment_reference || '')}</strong>. Once payment clears we'll issue the final VAT invoice and dispatch your order.`
        : `This is a pro-forma invoice — not a tax invoice. Quote reference <strong>${escapeHtml(sale.payment_reference || '')}</strong> when paying. We'll issue a final invoice once payment is received.`}
    </div>
  </div>
  ` : ''}

  <div class="addr-grid">
    <div class="addr-block">
      <div class="lbl">From</div>
      <div class="name">${escapeHtml(company.company_name || brand.fullName || brand.name)}</div>
      ${company.company_address ? `<div class="lines">${escapeHtml(company.company_address).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="contact-row">
        ${company.company_phone ? `<span>${escapeHtml(company.company_phone)}</span>` : ''}
        ${company.company_email ? `<span>${escapeHtml(company.company_email)}</span>` : ''}
        ${company.company_website ? `<span>${escapeHtml(company.company_website)}</span>` : ''}
      </div>
      ${(company.company_reg_no || (isVatRegistered && company.vat_number)) ? `
        <div class="meta-row">
          ${company.company_reg_no ? `<span>Co. No. ${escapeHtml(company.company_reg_no)}</span>` : ''}
          ${isVatRegistered && company.vat_number ? `<span>VAT ${escapeHtml(company.vat_number)}</span>` : ''}
        </div>
      ` : ''}
    </div>
    <div class="addr-block">
      <div class="lbl">${isProforma ? 'Billed to' : 'Billed / Delivered to'}</div>
      <div class="name">${escapeHtml(billedToName)}</div>
      <div class="lines">
        ${cleanedAddress
          ? escapeHtml(cleanedAddressLines.slice(1).join('\n')).replace(/\n/g, '<br>') + '<br>'
          : '<em style="color:#bbb">No address on file</em><br>'}
        ${sale.customer_phone ? escapeHtml(sale.customer_phone) + '<br>' : ''}
        ${sale.customer_email ? escapeHtml(sale.customer_email) : ''}
      </div>
    </div>
  </div>

  <div class="detail-strip">
    <div class="item"><div class="l">Date</div><div class="v">${escapeHtml(datePretty)}</div></div>
    <div class="item"><div class="l">Channel</div><div class="v">${escapeHtml(channelLabel)}</div></div>
    ${sale.order_number ? `<div class="item"><div class="l">Order No.</div><div class="v" style="font-family:ui-monospace,monospace;font-size:11px">${escapeHtml(sale.order_number)}</div></div>` : sale.vehicle_reg ? `<div class="item"><div class="l">Vehicle Reg.</div><div class="v">${escapeHtml(sale.vehicle_reg)}</div></div>` : sale.vin_number ? `<div class="item"><div class="l">VIN</div><div class="v" style="font-family:ui-monospace,monospace;font-size:10px">${escapeHtml(sale.vin_number)}</div></div>` : `<div class="item"><div class="l">Status</div><div class="v" style="text-transform:capitalize">${escapeHtml(sale.status || 'paid')}</div></div>`}
    ${
      // Payment label policy: show ONLY for cash / bank / card (direct sales + pro-formas).
      // Shopify/eBay channels: the channel name already implies the payment route, and the
      // redundant "Shopify Payment" / "eBay Payment" label looks like noise — hide entirely.
      (sale.payment_method === 'cash' || sale.payment_method === 'bank' || sale.payment_method === 'card')
        ? `<div class="item"><div class="l">Payment</div><div class="v">${escapeHtml(paymentLabel)}</div></div>`
        : `<div class="item"></div>` /* placeholder keeps the 4-column grid balanced */
    }
  </div>

  ${(sale.vehicle_reg || sale.vin_number) && sale.order_number ? `
  <div class="detail-strip" style="grid-template-columns:1fr 1fr;margin-top:-16px">
    ${sale.vehicle_reg ? `<div class="item"><div class="l">Vehicle Reg.</div><div class="v">${escapeHtml(sale.vehicle_reg)}</div></div>` : ''}
    ${sale.vin_number ? `<div class="item"><div class="l">VIN</div><div class="v" style="font-family:ui-monospace,monospace;font-size:10px">${escapeHtml(sale.vin_number)}</div></div>` : ''}
  </div>
  ` : ''}

  <table class="items">
    <thead><tr>
      <th>Description</th>
      <th class="num" style="width:60px">Qty</th>
      <th class="num" style="width:110px">Unit ${showVatBreakdown ? 'Net' : ''}</th>
      <th class="num" style="width:110px">Total ${showVatBreakdown ? 'Net' : ''}</th>
    </tr></thead>
    <tbody>
      ${items.map(i => {
        // Unit prices in the DB are gross. Show net using the same factor as the
        // totals (derived from the real VAT) so columns reconcile with the VAT line.
        const unitNet = parseFloat(i.unit_price) * netFactor;
        const lineNet = parseFloat(i.line_total) * netFactor;
        return `<tr>
          <td>${escapeHtml(i.title)}<div class="sku">${escapeHtml(i.sku || '')}</div></td>
          <td class="num">${i.qty}</td>
          <td class="num">${fmt(unitNet)}</td>
          <td class="num">${fmt(lineNet)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <div class="totals-wrap">
    <div class="totals">
      ${showVatBreakdown ? `
        <div class="row"><span>Subtotal (Net)</span><span>${fmt(subtotalNet)}</span></div>
        ${shippingGross > 0 ? `<div class="row"><span>Delivery (Net)</span><span>${fmt(shippingNet)}</span></div>` : ''}
        <div class="row"><span>VAT (${company.vat_rate || 20}%)</span><span>${fmt(vatAmount)}</span></div>
      ` : `
        <div class="row"><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
        ${shippingGross > 0 ? `<div class="row"><span>Shipping</span><span>${fmt(sale.shipping)}</span></div>` : ''}
      `}
      <div class="grand"><span>TOTAL${showVatBreakdown ? ' (incl. VAT)' : ''}</span><span>${fmt(sale.total)}</span></div>
    </div>
  </div>

  ${(sale.payment_method === 'bank' && company.bank_account_name) ? `
  <div class="pay">
    <div class="row"><div class="l">Bank</div><div class="v" style="font-weight:400">
      ${escapeHtml(company.bank_account_name)}<br>
      Sort code: ${escapeHtml(company.bank_sort_code || '\u2014')} \u00B7 Account: ${escapeHtml(company.bank_account_number || '\u2014')}<br>
      Use reference: <strong>${escapeHtml(sale.payment_reference)}</strong>
    </div></div>
  </div>
  ` : ''}

  ${(company.social_instagram || company.social_facebook || company.social_tiktok || company.social_linkedin) ? `
  <div class="socials">
    <span class="lbl">Follow us</span>
    ${company.social_instagram ? `<a href="https://instagram.com/${escapeHtml(company.social_instagram.replace(/^@/,''))}" target="_blank" rel="noopener" aria-label="Instagram">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.4a4 4 0 1 1-7.9 1.2 4 4 0 0 1 7.9-1.2Z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
      <span>@${escapeHtml(company.social_instagram.replace(/^@/,''))}</span>
    </a>` : ''}
    ${company.social_tiktok ? `<a href="https://tiktok.com/@${escapeHtml(company.social_tiktok.replace(/^@/,''))}" target="_blank" rel="noopener" aria-label="TikTok">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.71a8.16 8.16 0 0 0 4.77 1.52V6.79c-.55 0-1-.09-1.84-.1Z"/></svg>
      <span>@${escapeHtml(company.social_tiktok.replace(/^@/,''))}</span>
    </a>` : ''}
    ${company.social_facebook ? `<a href="${escapeHtml(company.social_facebook)}" target="_blank" rel="noopener" aria-label="Facebook">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"/></svg>
      <span>Facebook</span>
    </a>` : ''}
    ${company.social_linkedin ? `<a href="${escapeHtml(company.social_linkedin)}" target="_blank" rel="noopener" aria-label="LinkedIn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 2h-17A1.5 1.5 0 0 0 2 3.5v17A1.5 1.5 0 0 0 3.5 22h17a1.5 1.5 0 0 0 1.5-1.5v-17A1.5 1.5 0 0 0 20.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 1 1 8.3 6.5a1.78 1.78 0 0 1-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0 0 13 14.19a.66.66 0 0 0 0 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 0 1 2.7-1.4c1.55 0 3.36.86 3.36 3.66z"/></svg>
      <span>LinkedIn</span>
    </a>` : ''}
  </div>
  ` : ''}

  ${(() => {
    // Review CTA — only renders if at least one review URL is configured.
    // Picks the platform per the configured preference (Trustpilot/Google/both).
    const tp = company.trustpilot_url || '';
    const gg = company.google_review_url || '';
    const platform = company.review_platform || 'trustpilot';
    const items = [];
    if ((platform === 'trustpilot' || platform === 'both') && tp) {
      items.push({ label: 'Trustpilot', url: tp });
    }
    if ((platform === 'google' || platform === 'both') && gg) {
      items.push({ label: 'Google', url: gg });
    }
    // If picked platform was empty, fall back to whichever URL is set
    if (items.length === 0 && tp) items.push({ label: 'Trustpilot', url: tp });
    if (items.length === 0 && gg) items.push({ label: 'Google', url: gg });
    if (items.length === 0) return '';
    return `
  <div class="review-cta">
    <span class="rc-text">Enjoyed your order? A quick review really helps — thank you!</span>
    <span class="rc-links">
      ${items.map(it => `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">★ Review us on ${escapeHtml(it.label)}</a>`).join('')}
    </span>
  </div>`;
  })()}

  <div class="foot">
    <div class="cols">
      <div class="col">
        <span class="h">Returns</span>
        ${returnsPolicy}
      </div>
      <div class="col">
        <span class="h">Fitment</span>
        ${fitmentPolicy}
      </div>
      <div class="col">
        <span class="h">Contact</span>
        ${company.company_email ? escapeHtml(company.company_email) + '<br>' : ''}
        ${company.company_phone ? escapeHtml(company.company_phone) + '<br>' : ''}
        ${company.company_website ? escapeHtml(company.company_website) : ''}
      </div>
    </div>
    <div class="terms">
      ${company.company_reg_no ? `${escapeHtml(brand.name)} is a trading name of ${escapeHtml(company.company_name || brand.fullName)}, Company Reg Number ${escapeHtml(company.company_reg_no)}, registered in England & Wales.` : ''}
      ${isVatRegistered && company.vat_number ? ` VAT Number: ${escapeHtml(company.vat_number)}.` : ''}
      Full terms: ${company.company_website ? escapeHtml(company.company_website) + '/policies' : escapeHtml((brand.domain || '').replace(/^https?:\/\//, '')) + '/policies'}
    </div>
  </div>
</div>

</body></html>`;
}

// GET /api/sales/:id/invoice.html  — print-ready invoice (or estimate, proforma, or receipt)
// Query: ?proforma=1 forces proforma layout even for paid invoices.
// Pro-formas use the FULL invoice template (1:1 with a real invoice) but with
// "PRO FORMA INVOICE" as the document title. The minimal "estimate" layout is
// kept for legacy estimates that have no payment_method set (pre-Quote-Builder).
router.get('/:id/invoice.html', requireAdmin, async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).send('Not found');
  const sale = s.rows[0];
  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id])).rows;
  const company = await getCompanySettings();
  const forceProforma = req.query.proforma === '1' || req.query.proforma === 'true';
  // Pro-forma = estimate created via Quote Builder (has a payment_method) OR explicit override.
  const isProforma = forceProforma || (sale.is_estimate && !!sale.payment_method);
  const mode = isProforma ? 'proforma'
             : sale.is_estimate ? 'estimate'
             : (sale.payment_method === 'cash') ? 'receipt'
             : 'invoice';
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  await audit(req, 'view_invoice', 'sale', req.params.id, { mode });  // GDPR: log customer-data read
  res.set('Content-Type', 'text/html').send(renderInvoiceHtml({ sale, items, company, mode, baseUrl }));
});

// GET /api/sales/email-templates — list the covering-message templates for the
// send dialog's picker.
router.get('/email-templates', requireAdmin, async (req, res) => {
  const { getEmailTemplates } = require('../lib/email-templates');
  res.json({ templates: await getEmailTemplates(query) });
});

// PUT /api/sales/email-templates { templates:[{key,name,body}] } — save edits.
router.put('/email-templates', requireAdmin, async (req, res) => {
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS invoice_email_templates TEXT`);
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const arr = (Array.isArray(req.body?.templates) ? req.body.templates : [])
      .filter(t => t && (t.name || t.body))
      .map(t => ({
        key: String(t.key || t.name || 'tpl').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32) || 'tpl',
        name: String(t.name || 'Untitled').slice(0, 80),
        body: String(t.body || ''),
      }))
      .slice(0, 30);
    await query(`UPDATE app_settings SET invoice_email_templates = $1, updated_at = now() WHERE id = 1`, [JSON.stringify(arr)]);
    await audit(req, 'update_email_templates', null, null, { count: arr.length });
    res.json({ ok: true, templates: arr });
  } catch (e) {
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

// Build the invoice/proforma/estimate/receipt email for a sale and send it via
// Resend. Reusable by the manual "✉ Email" button AND the auto-send hooks
// (after a proforma or paid invoice is recorded). Returns {ok,id,...} — never
// throws, so callers (incl. fire-and-forget setImmediate) stay safe.
async function sendSaleDocumentEmail(saleId, { to, templateKey, includeMessage, baseUrl } = {}) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'email_not_configured' };
  const sr = await query('SELECT * FROM sales WHERE id = $1', [saleId]);
  const sale = sr.rows[0];
  if (!sale) return { ok: false, error: 'sale_not_found' };
  const recipient = String(to || sale.customer_email || '').trim();
  if (!recipient) return { ok: false, error: 'no_email_address' };

  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [saleId])).rows;
  const company = await getCompanySettings();
  const brand = require('../lib/brand');
  return composeAndSendInvoiceEmail({ sale, items, company, brand, to: recipient, templateKey, includeMessage, baseUrl });
}

// The actual compose + Resend send, taking the sale/items directly (so the test
// endpoint can use synthetic data without touching the DB).
async function composeAndSendInvoiceEmail({ sale, items = [], company = {}, brand, to, templateKey, includeMessage, baseUrl }) {
  brand = brand || require('../lib/brand');
  const recipient = String(to || sale.customer_email || '').trim();
  if (!recipient) return { ok: false, error: 'no_email_address' };
  // Same document-mode detection as the invoice.html route.
  const isProforma = sale.is_estimate && !!sale.payment_method;
  const mode = isProforma ? 'proforma'
             : sale.is_estimate ? 'estimate'
             : (sale.payment_method === 'cash') ? 'receipt'
             : 'invoice';
  const html = renderInvoiceHtml({ sale, items, company, mode, baseUrl: baseUrl || (brand.domain ? `https://${brand.domain}` : '') });
  const docLabel = mode === 'estimate' ? 'Estimate'
                 : mode === 'proforma' ? 'Pro-forma invoice'
                 : mode === 'receipt' ? 'Receipt'
                 : 'Invoice';
  const subject = `${docLabel} ${sale.invoice_number || sale.payment_reference || ''} — ${brand.name}`;

  // Covering message + brand signature, from the chosen (or default) template.
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const siteLabel = (company.company_website || brand.domain || '').replace(/^https?:\/\//, '');
  const sigBits = [company.company_phone, company.company_email, siteLabel].filter(Boolean).join(' · ');
  const { getEmailTemplates, defaultKeyForSale } = require('../lib/email-templates');
  const templates = await getEmailTemplates(query);
  const chosenKey = includeMessage === false ? 'none' : (templateKey || defaultKeyForSale(sale));
  const tpl = templates.find(t => t.key === chosenKey) || templates.find(t => t.key === 'standard');
  const rawBody = tpl ? (tpl.body || '') : '';
  const subst = rawBody
    .replace(/\{customer\}/g, sale.customer_name || 'there')
    .replace(/\{brand\}/g, brand.name || '')
    .replace(/\{doc\}/g, docLabel.toLowerCase())
    .replace(/\{ref\}/g, sale.invoice_number ? ` (ref ${sale.invoice_number})` : '')
    .replace(/\{website\}/g, siteLabel || (brand.name || 'our website'));
  const bodyHtml = esc(subst).trim()
    .split(/\n{2,}/).map(p => `<p style="margin:0 0 10px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const cover = !bodyHtml ? '' : `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:660px;margin:0 auto 16px;padding:18px 20px;background:#f6f7f8;border-radius:10px;color:#222;line-height:1.5">
      ${bodyHtml}
      <p style="margin:14px 0 0;font-weight:700">${esc(brand.name)}</p>
      ${sigBits ? `<p style="margin:3px 0 0;font-size:12px;color:#666">${esc(sigBits)}</p>` : ''}
    </div>`;
  // Attach the document as a PDF. The email body is then just the covering
  // message (clean), with the invoice in the attachment. If PDF generation fails
  // for any reason, fall back to the full invoice rendered inline so the customer
  // still gets it.
  let attachments;
  let emailHtml;
  try {
    const { buildInvoicePdf } = require('../lib/invoice-pdf');
    const pdf = await buildInvoicePdf({ sale, items, company, brand, mode });
    attachments = [{ filename: `${docLabel.replace(/[^a-z0-9]+/gi, '-')}-${(sale.invoice_number || sale.payment_reference || sale.id)}.pdf`, content: pdf.toString('base64') }];
    const fallbackMsg = `<p style="margin:0">Please find your ${esc(docLabel.toLowerCase())} attached.</p>`;
    emailHtml = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;padding:8px">${cover || fallbackMsg}</div>`;
  } catch (e) {
    console.warn('[sendSaleDocumentEmail] PDF failed, sending inline:', e.message);
    const htmlWithCover = cover ? html.replace(/(<body[^>]*>)/i, `$1${cover}`) : html;
    emailHtml = (cover && htmlWithCover === html) ? cover + html : htmlWithCover;
  }

  // Avoid "no-reply" senders (hurts deliverability + Resend flags it). Use the
  // company email when it's on the verified brand domain, else invoices@domain.
  // Override per-deployment with WAREHOUSE_FROM_EMAIL.
  const dom = (brand.domain || '').toLowerCase();
  const onBrandDomain = company.company_email && company.company_email.toLowerCase().endsWith('@' + dom);
  const fromEmail = process.env.WAREHOUSE_FROM_EMAIL || (onBrandDomain ? company.company_email : `invoices@${brand.domain}`);
  try {
    const axios = require('axios');
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${brand.name} <${fromEmail}>`,
      to: [recipient],
      subject,
      html: emailHtml,
      // Replies go to the business inbox, not the no-reply send address.
      ...(company.company_email ? { reply_to: company.company_email } : {}),
      ...(attachments ? { attachments } : {}),
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return { ok: true, id: r.data?.id, to: recipient, mode, docLabel };
  } catch (e) {
    console.error('[sendSaleDocumentEmail]', e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// Is auto-emailing of documents (proforma / invoice) enabled? Stored in the
// app_settings.data JSONB; defaults ON (only ever fires when Resend is
// configured AND the sale has a customer email, so it's a safe default).
async function autoEmailEnabled() {
  try {
    const r = await query(`SELECT data FROM app_settings WHERE id = 1`);
    return r.rows[0]?.data?.autoEmailDocuments !== false;
  } catch (_) { return false; }
}

// Fire-and-forget auto-send for a freshly-finalised sale (creation / mark-paid /
// convert). No-ops unless Resend is configured, auto-send is on, and there's a
// customer email. Logged for the audit trail.
async function maybeAutoEmailSale(saleId, baseUrl) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    if (!(await autoEmailEnabled())) return;
    const sr = await query('SELECT customer_email, invoice_number, payment_reference FROM sales WHERE id = $1', [saleId]);
    if (!sr.rows[0]?.customer_email) return;
    const out = await sendSaleDocumentEmail(saleId, { baseUrl });
    if (out.ok) {
      await query(
        `INSERT INTO audit_log (user_id, action, target_type, target_id, metadata) VALUES (NULL,'auto_email_document','sale',$1,$2)`,
        [saleId, JSON.stringify({ to: out.to, mode: out.mode, resend_id: out.id })]
      ).catch(() => {});
    } else if (out.error !== 'no_email_address' && out.error !== 'email_not_configured') {
      console.warn(`[auto-email] sale ${saleId}:`, out.error);
    }
  } catch (e) { console.warn('[auto-email] failed:', e.message); }
}

// POST /api/sales/:id/email — email the invoice to the customer (manual button)
router.post('/:id/email', requireAdmin, async (req, res) => {
  const s = await query('SELECT id, customer_email FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const to = req.body.to || s.rows[0].customer_email;
  if (!to) return res.status(400).json({ error: 'no_email_address' });
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'email_not_configured',
      message: 'Set RESEND_API_KEY env var in Railway. Sign up at resend.com (free tier: 3000 emails/month).'
    });
  }
  const out = await sendSaleDocumentEmail(req.params.id, {
    to,
    templateKey: req.body?.templateKey,
    includeMessage: req.body?.includeMessage,
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  if (!out.ok) return res.status(out.error === 'no_email_address' ? 400 : 500).json({ error: 'email_failed', message: out.error });
  await audit(req, 'email_invoice', 'sale', Number(req.params.id), { to: out.to, resend_id: out.id });
  res.json({ ok: true, id: out.id });
});

// POST /api/sales/test-email { to } — send a SAMPLE invoice email (with the PDF
// attached) to verify the whole pipeline end-to-end: Resend connection, from-
// address, template and the PDF attachment. Uses synthetic data — no DB sale.
router.post('/test-email', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || req.user?.email || '').trim();
  if (!to) return res.status(400).json({ error: 'no_email_address', message: 'Enter an email address to send the test to.' });
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'email_not_configured', message: 'Connect Resend first: set RESEND_API_KEY in Railway and verify your domain at resend.com/domains.' });
  }
  const company = await getCompanySettings();
  const brand = require('../lib/brand');
  const vatReg = !!company.vat_registered;
  const rate = parseFloat(company.vat_rate || 20) / 100;
  const subtotal = 120, shipping = 10, gross = subtotal + shipping;
  const sale = {
    id: 0, invoice_number: `${brand.invoicePrefix || 'INV'}-TEST-1001`,
    payment_reference: `${brand.invoicePrefix || 'INV'}-TEST-1001`,
    occurred_at: new Date().toISOString(),
    customer_name: 'Test Customer', customer_email: to,
    payment_method: 'bank', channel: 'direct_bank',
    is_estimate: false, is_paid: true, status: 'paid',
    subtotal, shipping, vat: vatReg ? +(gross - gross / (1 + rate)).toFixed(2) : 0, total: gross,
    shipping_address: '123 Test Street\nLondon\nSW1A 1AA',
  };
  const items = [{ title: 'Sample part — front bumper (TEST)', sku: 'TEST-001', qty: 1, unit_price: 120, line_total: 120 }];
  const out = await composeAndSendInvoiceEmail({
    sale, items, company, brand, to, templateKey: 'paid_thanks',
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  if (!out.ok) return res.status(500).json({ error: 'email_failed', message: out.error });
  await audit(req, 'test_email', null, null, { to });
  res.json({ ok: true, id: out.id, to });
});

// POST /api/sales/:id/items/:itemId/link-product
// Manually attach a product to a sale_item line that didn't auto-match by SKU.
// If decrementStock=true and the sale is paid, also decrements stock by that line's qty.
router.post('/:id/items/:itemId/link-product', requireAdmin, async (req, res) => {
  const { productId, decrementStock } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId_required' });

  const result = await withTx(async (c) => {
    const li = await c.query(
      `SELECT si.*, s.status FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE si.id = $1 AND si.sale_id = $2 FOR UPDATE`,
      [req.params.itemId, req.params.id]
    );
    if (!li.rows[0]) return { error: 'item_not_found' };
    const alreadyLinked = li.rows[0].product_id != null;
    await c.query(`UPDATE sale_items SET product_id = $1 WHERE id = $2`, [productId, req.params.itemId]);

    // Optionally decrement stock now (only if it wasn't already linked + this is a paid sale)
    if (decrementStock && !alreadyLinked && li.rows[0].status === 'paid') {
      const p = await c.query(`SELECT qty_on_hand FROM products WHERE id = $1 FOR UPDATE`, [productId]);
      if (!p.rows[0]) return { error: 'product_not_found' };
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`,
        [li.rows[0].qty, productId]);
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,$2,'retroactive_link',$3,$4)`,
        [productId, -li.rows[0].qty, req.params.id, req.user.id]
      );
    }
    return { ok: true, linked: { itemId: req.params.itemId, productId, decremented: !!decrementStock && !alreadyLinked }};
  });

  if (result.error) return res.status(409).json(result);
  await audit(req, 'link_sale_item_product', 'sale_item', req.params.itemId, { productId });
  res.json(result);
});

// POST /api/sales/relink-unmatched  (admin)
// Re-runs SKU resolution against all sale_items where product_id IS NULL,
// using the same fuzzy matching as the live sync. Useful after fixing SKUs.
router.post('/relink-unmatched', requireAdmin, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  // Reuse the resolver from sync.js
  const sync = require('../services/sync');
  const unmatched = await query(
    `SELECT id, sale_id, sku, qty FROM sale_items WHERE product_id IS NULL ORDER BY id DESC LIMIT 500`
  );
  let linked = 0;
  for (const li of unmatched.rows) {
    const m = await sync.resolveProductBySku(null, li.sku);
    if (m) {
      await query(`UPDATE sale_items SET product_id = $1 WHERE id = $2`, [m.id, li.id]);
      linked++;
    }
  }
  await audit(req, 'relink_unmatched_sales', null, null, { scanned: unmatched.rows.length, linked });
  res.json({ ok: true, scanned: unmatched.rows.length, linked });
});

// PATCH /api/sales/:id — edit customer/notes/reg/VIN/order# on an existing sale.
// Does NOT edit financials (subtotal/vat/total/items) — use line-item PATCH for that.
router.patch('/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const fields = {
    customer_name: b.customerName,
    customer_phone: b.customerPhone,
    customer_email: b.customerEmail,
    shipping_address: b.shippingAddress,
    order_number: b.orderNumber,
    vehicle_reg: b.vehicleReg,
    vin_number: b.vinNumber,
    notes: b.notes,
  };
  const updates = [], params = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    params.push(val === '' ? null : val);
    updates.push(`${col} = $${params.length}`);
  }
  if (!updates.length) return res.json({ ok: true, message: 'no_changes' });
  params.push(req.params.id);
  const r = await query(`UPDATE sales SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'edit_sale', 'sale', req.params.id, fields);
  res.json({ ok: true, sale: r.rows[0] });
});

// Recompute a sale's subtotal/vat/total from its current line items. Same VAT
// model as creation: subtotal is gross (VAT-inclusive); total = subtotal + shipping;
// vat stores the portion (0 for cash / when not VAT-registered).
async function recomputeSaleTotals(c, saleId) {
  const tot = await c.query(`SELECT COALESCE(SUM(line_total),0) AS subtotal FROM sale_items WHERE sale_id = $1`, [saleId]);
  const subtotal = parseFloat(tot.rows[0].subtotal);
  const saleRow = await c.query(`SELECT payment_method, shipping FROM sales WHERE id = $1`, [saleId]);
  const settings = await c.query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
  const setRow = settings.rows[0] || {};
  const vatRegistered = !!setRow.vat_registered;
  const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;
  const isCashSale = saleRow.rows[0]?.payment_method === 'cash';
  const shipping = parseFloat(saleRow.rows[0]?.shipping || 0);
  // Delivery is taxable income too — VAT is on (subtotal + shipping) gross.
  const grossForVat = subtotal + shipping;
  const vat = (!isCashSale && vatRegistered) ? +(grossForVat - grossForVat / (1 + vatRate)).toFixed(2) : 0;
  const total = +(subtotal + shipping).toFixed(2);
  await c.query(`UPDATE sales SET subtotal = $1, vat = $2, total = $3 WHERE id = $4`, [subtotal, vat, total, saleId]);
  return { subtotal, vat, total };
}

// Only DIRECT (cash/bank/card) paid sales own their warehouse stock locally —
// eBay/Shopify stock is reconciled by the channel sync, so we never restock those
// from a manual line edit (it would double-count).
function saleStockManaged(row) {
  return ['direct_cash', 'direct_bank', 'direct_card'].includes(row.sale_channel)
    && !row.sale_is_estimate && row.sale_status === 'paid';
}

// PATCH /api/sales/:id/items/:itemId — edit a line item (title, qty, unit_price)
// Recalculates sale totals afterwards. For direct cash/bank/card paid sales,
// changing the quantity also adjusts warehouse stock (reduce qty → stock back).
// Logs an audit entry capturing the old + new values.
router.patch('/:id/items/:itemId', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const result = await withTx(async (c) => {
    const existing = await c.query(
      `SELECT si.*, s.shipping AS sale_shipping, s.status AS sale_status,
              s.is_estimate AS sale_is_estimate, s.channel AS sale_channel
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE si.id = $1 AND si.sale_id = $2 FOR UPDATE`,
      [req.params.itemId, req.params.id]
    );
    if (!existing.rows[0]) return { error: 'item_not_found' };
    const old = existing.rows[0];

    const newTitle = b.title !== undefined ? (b.title || null) : old.title;
    const newQty = b.qty !== undefined ? parseInt(b.qty) : old.qty;
    const newUnitPrice = b.unitPrice !== undefined ? parseFloat(b.unitPrice) : parseFloat(old.unit_price);
    const newLineTotal = +(newQty * newUnitPrice).toFixed(2);

    // Stock follows the quantity change for direct paid sales.
    let affectedProductId = null;
    if (saleStockManaged(old) && old.product_id && newQty !== old.qty) {
      const delta = old.qty - newQty;   // >0 → return units to stock; <0 → consume more
      if (delta < 0) {
        const pr = await c.query(`SELECT qty_on_hand FROM products WHERE id = $1 FOR UPDATE`, [old.product_id]);
        const have = pr.rows[0]?.qty_on_hand || 0;
        if (have < -delta) return { error: 'insufficient_stock', available: have, sku: old.sku, title: old.title, productId: old.product_id };
      }
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`, [delta, old.product_id]);
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'sale_item_edit',$3,$4)`,
        [old.product_id, delta, req.params.id, req.user.id]);
      affectedProductId = old.product_id;
    }

    await c.query(
      `UPDATE sale_items SET title = $1, qty = $2, unit_price = $3, line_total = $4 WHERE id = $5`,
      [newTitle, newQty, newUnitPrice, newLineTotal, req.params.itemId]
    );
    const totals = await recomputeSaleTotals(c, req.params.id);
    return { ok: true, oldItem: old, totals, affectedProductId,
             newItem: { title: newTitle, qty: newQty, unit_price: newUnitPrice, line_total: newLineTotal } };
  });
  if (result.error) return res.status(result.error === 'item_not_found' ? 404 : 409).json(result);
  await audit(req, 'edit_sale_item', 'sale_item', req.params.itemId, { saleId: req.params.id, ...result.newItem });
  if (result.affectedProductId) {
    setImmediate(() => { try { require('./products').pushProductStockToChannels(result.affectedProductId); } catch (_) {} });
  }
  res.json(result);
});

// DELETE /api/sales/:id/items/:itemId — remove a single line from an invoice
// (e.g. it was added by mistake, or the whole line is being returned). For direct
// cash/bank/card paid sales the line's stock is restored (?restock=false to skip).
// Recomputes the sale totals. Won't touch eBay/Shopify-channel stock.
router.delete('/:id/items/:itemId', requireAdmin, async (req, res) => {
  const restock = req.query.restock !== 'false';
  const result = await withTx(async (c) => {
    const ex = await c.query(
      `SELECT si.*, s.status AS sale_status, s.is_estimate AS sale_is_estimate, s.channel AS sale_channel
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE si.id = $1 AND si.sale_id = $2 FOR UPDATE`,
      [req.params.itemId, req.params.id]
    );
    if (!ex.rows[0]) return { error: 'item_not_found' };
    const it = ex.rows[0];
    const doRestock = restock && saleStockManaged(it) && !!it.product_id;
    if (doRestock) {
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`, [it.qty, it.product_id]);
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'sale_item_removed',$3,$4)`,
        [it.product_id, it.qty, req.params.id, req.user.id]);
    }
    await c.query(`DELETE FROM sale_items WHERE id = $1`, [req.params.itemId]);
    const totals = await recomputeSaleTotals(c, req.params.id);
    const remaining = await c.query(`SELECT COUNT(*)::int AS n FROM sale_items WHERE sale_id = $1`, [req.params.id]);
    return { ok: true, restocked: doRestock ? it.qty : 0, totals, remaining: remaining.rows[0].n, affectedProductId: doRestock ? it.product_id : null };
  });
  if (result.error) return res.status(404).json(result);
  await audit(req, 'remove_sale_item', 'sale_item', req.params.itemId, { saleId: req.params.id, restocked: result.restocked });
  if (result.affectedProductId) {
    setImmediate(() => { try { require('./products').pushProductStockToChannels(result.affectedProductId); } catch (_) {} });
  }
  res.json(result);
});

// DELETE /api/sales/:id — delete a sale/estimate/invoice (admin only).
// If the sale was paid AND had product_id linked items, stock is RESTORED.
// Use query param ?restoreStock=false to skip stock restore.
router.delete('/:id', requireAdmin, async (req, res) => {
  const restoreStock = req.query.restoreStock !== 'false';
  const result = await withTx(async (c) => {
    const s = await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!s.rows[0]) return { error: 'not_found' };
    const sale = s.rows[0];

    if (restoreStock && !sale.is_estimate && sale.status === 'paid') {
      const items = await c.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [req.params.id]);
      for (const it of items.rows) {
        if (it.product_id) {
          await c.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`, [it.qty, it.product_id]);
          await c.query(
            `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
             VALUES ($1,$2,'sale_deleted_restore',$3,$4)`,
            [it.product_id, it.qty, sale.id, req.user.id]
          );
        }
      }
    }
    // For a channel order, tombstone its external id so the sync won't re-import it.
    if (sale.external_order_id && /^(shopify|ebay_)/.test(sale.channel || '')) {
      await c.query(
        `INSERT INTO deleted_external_orders (channel, external_order_id, deleted_by)
         VALUES ($1,$2,$3) ON CONFLICT (external_order_id) DO NOTHING`,
        [sale.channel, sale.external_order_id, req.user.id]);
    }
    // Remove any notifications that pointed at this sale (dispatch/shipment/etc.)
    // so nothing lingers in the bell after a full wipe.
    await c.query(`DELETE FROM notifications WHERE related_type = 'sale' AND related_id = $1`, [sale.id]).catch(() => {});
    // sale_items cascades on sale delete
    await c.query(`DELETE FROM sales WHERE id = $1`, [req.params.id]);
    return { ok: true, deleted: sale.id, stockRestored: restoreStock && !sale.is_estimate && sale.status === 'paid' };
  });
  if (result.error) return res.status(404).json(result);
  await audit(req, 'delete_sale', 'sale', req.params.id, result);
  res.json(result);
});

// POST /api/sales/backfill-ebay-addresses
// For all eBay orders missing shipping_address, re-fetch detail from eBay GetOrders
// (single-order detail) and populate the address + customer name. Also extracts
// buyer email/phone if present in the new detail response.
router.post('/backfill-ebay-addresses', requireAdmin, async (req, res) => {
  const ebay = require('../services/ebay');
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });

  const { rows } = await query(
    `SELECT id, external_order_id, customer_name FROM sales
     WHERE channel LIKE 'ebay%' AND external_order_id IS NOT NULL
       AND (shipping_address IS NULL OR shipping_address = '')
     ORDER BY occurred_at DESC LIMIT 100`
  );

  let updated = 0, noAddress = 0, failed = 0;
  const errors = [];

  for (const sale of rows) {
    try {
      const xml = await ebay.getOrderDetail(sale.external_order_id);
      // Parse shipping address out of the per-order detail XML
      const orderBlock = (xml.match(/<Order>[\s\S]*?<\/Order>/) || [])[0] || '';
      const shipBlock = (orderBlock.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/) || [])[1] || '';

      const extract = (tag) => {
        const m = shipBlock.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>'));
        if (!m) return '';
        return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
      };
      const name = extract('Name');
      const street1 = extract('Street1');
      let street2 = extract('Street2');
      const city = extract('CityName');
      const state = extract('StateOrProvince');
      const postal = extract('PostalCode');
      const country = extract('Country');
      const phone = extract('Phone');

      // eBay sometimes injects an anonymized buyer-email proxy in Street2 (e.g. "ebayerm7qr9")
      // — strip these. Also strip plain country codes like "GB" / "UK" from the visible address.
      if (/^ebay[a-z0-9]{4,}$/i.test(street2 || '')) street2 = '';
      const countryClean = (country === 'GB' || country === 'UK' || country === 'United Kingdom' || country === 'GBR') ? '' : country;

      // Also try to extract buyer email (often in TransactionArray > Transaction > Buyer)
      const emailM = orderBlock.match(/<Buyer>[\s\S]*?<Email>([^<]+)<\/Email>/);
      const buyerEmail = emailM ? emailM[1].trim() : null;

      const parts = [name, street1, street2, city, state, postal, countryClean].filter(Boolean);
      if (!parts.length) { noAddress++; continue; }

      const address = parts.join('\n');
      await query(
        `UPDATE sales SET shipping_address = $1,
                          customer_name = CASE WHEN $2 != '' THEN $2 ELSE customer_name END,
                          customer_phone = COALESCE($3, customer_phone),
                          customer_email = COALESCE($4, customer_email)
         WHERE id = $5`,
        [address, name || '', phone || null, buyerEmail && buyerEmail !== 'Invalid Request' ? buyerEmail : null, sale.id]
      );
      updated++;
    } catch (e) {
      failed++;
      errors.push({ id: sale.id, orderId: sale.external_order_id, message: e.message });
    }
  }
  await audit(req, 'backfill_ebay_addresses', null, null, { scanned: rows.length, updated, noAddress, failed });
  res.json({ scanned: rows.length, updated, noAddress, failed, errors: errors.slice(0, 5) });
});

// POST /api/sales/backfill-vat — one-time corrective sweep for sales where VAT
// was incorrectly added on top of an already-gross subtotal. Resets every sale
// to the new model: total = subtotal + shipping; cash sales have zero VAT;
// other VAT-registered sales have the VAT *portion* of the gross subtotal.
// Safe to run multiple times — idempotent.
router.post('/backfill-vat', requireAdmin, async (req, res) => {
  const settings = await query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
  const setRow = settings.rows[0] || {};
  const vatRegistered = !!setRow.vat_registered;
  const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;

  const ukVat = require('../lib/uk-vat');
  const all = await query(`SELECT id, subtotal, shipping, vat, total, payment_method, shipping_address FROM sales`);
  let fixed = 0, alreadyOk = 0, exports = 0;
  for (const s of all.rows) {
    const subtotal = parseFloat(s.subtotal || 0);
    const shipping = parseFloat(s.shipping || 0);
    const isCashSale = s.payment_method === 'cash';
    // Exports routed via eBay's Global/International Shipping hub are zero-rated.
    const isExport = ukVat.isGspExport(s.shipping_address);
    if (isExport) exports++;
    const vatChargeable = !isCashSale && vatRegistered && !isExport;
    const grossForVat = subtotal + shipping;   // delivery is taxable income too
    const correctVat = vatChargeable ? +(grossForVat - grossForVat / (1 + vatRate)).toFixed(2) : 0;
    const correctTotal = +(subtotal + shipping).toFixed(2);
    if (Math.abs(parseFloat(s.vat || 0) - correctVat) < 0.005
        && Math.abs(parseFloat(s.total || 0) - correctTotal) < 0.005) {
      alreadyOk++;
      continue;
    }
    await query(
      `UPDATE sales SET vat = $1, total = $2 WHERE id = $3`,
      [correctVat, correctTotal, s.id]
    );
    fixed++;
  }
  await audit(req, 'backfill_vat', null, null, { fixed, alreadyOk, exports });
  res.json({ ok: true, fixed, alreadyOk, exports, total: all.rows.length });
});

// ──────────────────────────────────────────────────────────────────────────
// Daily follow-up for UNPAID direct invoices (cash / bank / card). eBay &
// Shopify orders settle on-platform; direct cash/card/bank sales are the ones
// that get forgotten. Once a day we raise ONE digest notification + push so
// staff chase payment. Idempotent within the day: skips if a 'payment_followup'
// notification was already created in the last 20 hours.
// ──────────────────────────────────────────────────────────────────────────
async function runPaymentFollowups() {
  await ensurePaidColumn();
  // Don't double-fire if today's digest already went out.
  const recent = await query(
    `SELECT 1 FROM notifications WHERE type = 'payment_followup' AND created_at > now() - INTERVAL '20 hours' LIMIT 1`
  );
  if (recent.rows.length) return { skipped: 'already_sent_today' };

  const r = await query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(total),0)::numeric AS total,
           MIN(occurred_at) AS oldest
      FROM sales
     WHERE is_estimate = false AND is_paid = false
       AND status NOT IN ('refunded','cancelled')
       AND payment_method IN ('cash','bank','card')
       AND occurred_at >= now() - INTERVAL '120 days'
  `);
  const n = r.rows[0].n;
  if (!n) return { count: 0 };

  const total = parseFloat(r.rows[0].total || 0);
  const oldestDays = r.rows[0].oldest
    ? Math.floor((Date.now() - new Date(r.rows[0].oldest).getTime()) / 86400000) : 0;
  const title = `${n} unpaid order${n === 1 ? '' : 's'} to chase`;
  const body = `£${total.toFixed(2)} outstanding across ${n} cash/bank/card sale${n === 1 ? '' : 's'}`
    + (oldestDays ? ` — oldest is ${oldestDays} day${oldestDays === 1 ? '' : 's'} old.` : '.');
  try {
    await query(
      `INSERT INTO notifications (type, title, body, severity) VALUES ('payment_followup', $1, $2, 'warn')`,
      [title, body]
    );
  } catch (e) { console.warn('[followups] notification insert:', e.message); }
  try { require('../services/push').sendToAll({ title, body, url: '/', tag: 'payment-followup', category: 'payment_followup' }); } catch (_) {}
  return { count: n, total };
}

module.exports = router;
module.exports.runPaymentFollowups = runPaymentFollowups;
