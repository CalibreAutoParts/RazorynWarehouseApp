// routes/sales.js — sales, invoices, estimates, CSV exports, emails
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const CHANNELS = ['shopify', 'ebay_em', 'ebay_cl', 'direct_cash', 'direct_bank'];

// ----- helpers -----
function genReference(paymentMethod) {
  // REP-{8 alnum chars}-{suffix}
  const suffix = ({ cash: 'C', bank: 'B', card: 'S', shopify: 'O', ebay: 'E' })[paymentMethod] || 'X';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
            + Math.random().toString(36).slice(2, 6).toUpperCase();
  return `REP-${rand.slice(0, 8)}-${suffix}`;
}

async function nextInvoiceNumber(client) {
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10).replace(/-/g, '');
  const runQuery = client ? client.query.bind(client) : query;
  const seq = await runQuery(
    `SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM '\\d+$')::int), 0) + 1 AS next
     FROM sales WHERE invoice_number LIKE $1`,
    [`RZN-${datePart}-%`]
  );
  const next = seq.rows[0].next;
  return `RZN-${datePart}-${String(next).padStart(4, '0')}`;
}

// GET /api/sales?channel=&from=&to=&page=
router.get('/', requireAdmin, async (req, res) => {
  const { channel, from, to, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 50);
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
  res.json({ sales: rows, total: tot.rows[0].n, summary: summary.rows });
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

// GET /api/sales/:id
router.get('/:id', requireAdmin, async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const items = await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id]);
  res.json({ sale: s.rows[0], items: items.rows });
});

// POST /api/sales — record a manual sale or estimate.
// Body: { channel, paymentMethod, isEstimate, customerName, customerPhone, customerEmail,
//         shippingAddress, vehicleReg, orderNumber, items, shipping, notes }
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'invalid_channel' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'items_required' });
  if (!['direct_cash', 'direct_bank'].includes(b.channel)) {
    return res.status(400).json({ error: 'channel_not_manual_entry' });
  }
  // Map UI payment method → channel where possible
  const paymentMethod = b.paymentMethod || (b.channel === 'direct_cash' ? 'cash' : 'bank');

  const settings = await query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
  const setRow = settings.rows[0] || {};
  const vatRegistered = !!setRow.vat_registered;
  const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;

  const isEstimate = !!b.isEstimate;

  const result = await withTx(async (c) => {
    let subtotal = 0;
    const itemsResolved = [];
    for (const it of b.items) {
      if (it.productId) {
        // Inventory-backed item
        const p = await c.query(
          'SELECT id, sku, title, qty_on_hand FROM products WHERE id = $1 FOR UPDATE',
          [it.productId]
        );
        if (!p.rows[0]) return { error: 'product_not_found', productId: it.productId };
        // For non-estimate paid sales, validate stock. Estimates don't touch stock at all.
        if (!isEstimate && p.rows[0].qty_on_hand < it.qty) {
          return { error: 'insufficient_stock', productId: it.productId, sku: p.rows[0].sku, available: p.rows[0].qty_on_hand };
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

    // VAT model: prices in the system match Shopify/eBay listing prices, which
    // are gross (VAT-INCLUSIVE). subtotal therefore already contains VAT — we
    // must NOT add it on top. The `vat` column stores the VAT *portion* of the
    // gross subtotal (for accounting/reporting). Total = subtotal + shipping.
    //
    // Policy:
    //  • Cash on collection → no VAT recorded (£0). Receipt, not an invoice.
    //  • Bank / Card / Online → if vat_registered, record VAT portion of gross.
    const isCashSale = paymentMethod === 'cash';
    const vatChargeable = !isCashSale && vatRegistered;
    const vat = vatChargeable
      ? +(subtotal - subtotal / (1 + vatRate)).toFixed(2)  // VAT portion of gross
      : 0;
    const shipping = parseFloat(b.shipping || 0);
    const total = +(subtotal + shipping).toFixed(2);  // subtotal IS gross — no VAT added

    // Generate identifiers
    const invoiceNumber = isEstimate ? null : await nextInvoiceNumber(c);
    const paymentReference = genReference(paymentMethod);

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

    const sale = await c.query(
      `INSERT INTO sales (channel, customer_name, customer_phone, customer_email,
                          subtotal, vat, shipping, total, status, invoice_number,
                          notes, recorded_by, payment_method, payment_reference,
                          is_estimate, order_number, vehicle_reg, vin_number, shipping_address,
                          customer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [b.channel, b.customerName || null, b.customerPhone || null, b.customerEmail || null,
       subtotal, vat, shipping, total,
       isEstimate ? 'pending' : 'paid',
       invoiceNumber, b.notes || null, req.user.id,
       paymentMethod, paymentReference,
       isEstimate, b.orderNumber || null, b.vehicleReg || null, b.vinNumber || null, b.shippingAddress || null,
       customerId]
    );

    for (const it of itemsResolved) {
      await c.query(
        `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.rows[0].id, it.productId, it.sku, it.title, it.qty, it.unitPrice, it.lineTotal]
      );
      // Estimates NEVER touch stock. Paid sales decrement only inventory-backed items.
      if (!isEstimate && it.productId) {
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
  await audit(req, isEstimate ? 'create_estimate' : 'create_sale', 'sale', result.sale.id, {
    channel: b.channel, total: result.sale.total
  });

  // Push stock for non-estimate sales
  if (!isEstimate) {
    setImmediate(() => {
      const sync = require('../services/sync');
      sync.pushStockForSaleItems(result.items).catch(e => console.warn('[sync] push failed:', e.message));
    });
  }
  res.status(201).json(result);
});

// POST /api/sales/:id/convert-to-invoice — turn an estimate into a paid invoice
router.post('/:id/convert-to-invoice', requireAdmin, async (req, res) => {
  const paymentMethod = req.body.paymentMethod || 'cash';
  const result = await withTx(async (c) => {
    const s = await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!s.rows[0]) return { error: 'not_found' };
    if (!s.rows[0].is_estimate) return { error: 'not_an_estimate' };

    const invoiceNumber = await nextInvoiceNumber(c);
    const paymentReference = genReference(paymentMethod);

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
    const vat = vatChargeable ? +(subtotal - subtotal / (1 + vatRate)).toFixed(2) : 0;
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
  });
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

  const isCashReceipt = mode === 'receipt' || (sale.payment_method === 'cash' && !isVatRegistered);
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
  const returnsPolicy = isEbay
    ? "Returns handled via eBay within 30 days. Open a return request through your eBay account; we'll respond within 48 hours."
    : isShopify
    ? "30-day returns from delivery, in original packaging. Open a return request via your account at razoryn.co.uk. 5% restocking fee applies."
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
  const showVatBreakdown = isVatRegistered && !isCashSale;
  const subtotalNet = showVatBreakdown ? (parseFloat(sale.subtotal) / (1 + 0.2)) : parseFloat(sale.subtotal);
  const vatAmount = showVatBreakdown ? (parseFloat(sale.subtotal) - subtotalNet) : 0;

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
        // Unit prices in the DB are gross. If we're breaking out VAT, divide for the net display.
        const unitNet = showVatBreakdown ? (parseFloat(i.unit_price) / (1 + 0.2)) : parseFloat(i.unit_price);
        const lineNet = showVatBreakdown ? (parseFloat(i.line_total) / (1 + 0.2)) : parseFloat(i.line_total);
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
        <div class="row"><span>VAT (${company.vat_rate || 20}%)</span><span>${fmt(vatAmount)}</span></div>
      ` : `
        <div class="row"><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
      `}
      ${parseFloat(sale.shipping || 0) > 0 ? `<div class="row"><span>Shipping</span><span>${fmt(sale.shipping)}</span></div>` : ''}
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
    <span class="rc-text">Enjoyed your order? A quick review really helps a small business.</span>
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
      Full terms: ${company.company_website ? escapeHtml(company.company_website) + '/policies' : 'razoryn.co.uk/policies'}
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
             : (sale.payment_method === 'cash' && !company.vat_registered) ? 'receipt'
             : 'invoice';
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.set('Content-Type', 'text/html').send(renderInvoiceHtml({ sale, items, company, mode, baseUrl }));
});

// POST /api/sales/:id/email — email the invoice to the customer
router.post('/:id/email', requireAdmin, async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const sale = s.rows[0];
  const to = req.body.to || sale.customer_email;
  if (!to) return res.status(400).json({ error: 'no_email_address' });

  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id])).rows;
  const company = await getCompanySettings();
  const brand = require('../lib/brand');
  // Same proforma detection as the invoice.html route.
  const isProforma = sale.is_estimate && !!sale.payment_method;
  const mode = isProforma ? 'proforma'
             : sale.is_estimate ? 'estimate'
             : (sale.payment_method === 'cash' && !company.vat_registered) ? 'receipt'
             : 'invoice';
  const html = renderInvoiceHtml({ sale, items, company, mode, baseUrl: `${req.protocol}://${req.get('host')}` });
  const docLabel = mode === 'estimate' ? 'Estimate'
                 : mode === 'proforma' ? 'Pro-forma invoice'
                 : mode === 'receipt' ? 'Receipt'
                 : 'Invoice';
  const subject = `${docLabel} ${sale.invoice_number || sale.payment_reference || ''} — ${brand.name}`;

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'email_not_configured',
      message: 'Set RESEND_API_KEY env var in Railway. Sign up at resend.com (free tier: 3000 emails/month).'
    });
  }
  const fromEmail = process.env.WAREHOUSE_FROM_EMAIL || `noreply@${brand.domain}`;
  try {
    const axios = require('axios');
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${brand.name} <${fromEmail}>`,
      to: [to],
      subject,
      html,
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    await audit(req, 'email_invoice', 'sale', sale.id, { to, resend_id: r.data?.id });
    res.json({ ok: true, id: r.data?.id });
  } catch (e) {
    console.error('[email_invoice]', e.response?.data || e.message);
    res.status(500).json({ error: 'email_failed', message: e.response?.data?.message || e.message });
  }
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

// PATCH /api/sales/:id/items/:itemId — edit a line item (title, qty, unit_price)
// Recalculates sale totals afterwards. Logs an audit entry capturing the old + new values.
router.patch('/:id/items/:itemId', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const result = await withTx(async (c) => {
    const existing = await c.query(
      `SELECT si.*, s.vat AS sale_vat, s.subtotal AS sale_subtotal, s.shipping AS sale_shipping
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

    await c.query(
      `UPDATE sale_items SET title = $1, qty = $2, unit_price = $3, line_total = $4 WHERE id = $5`,
      [newTitle, newQty, newUnitPrice, newLineTotal, req.params.itemId]
    );

    // Recompute sale totals from all line items.
    // Same VAT model as sale creation: subtotal is gross (VAT-inclusive),
    // total = subtotal + shipping. VAT column stores the portion, not an addition.
    const tot = await c.query(`SELECT COALESCE(SUM(line_total),0) AS subtotal FROM sale_items WHERE sale_id = $1`, [req.params.id]);
    const newSubtotal = parseFloat(tot.rows[0].subtotal);
    const saleRow = await c.query(`SELECT payment_method FROM sales WHERE id = $1`, [req.params.id]);
    const settings = await c.query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
    const setRow = settings.rows[0] || {};
    const vatRegistered = !!setRow.vat_registered;
    const vatRate = vatRegistered ? (parseFloat(setRow.vat_rate || 20) / 100) : 0;
    const isCashSale = saleRow.rows[0]?.payment_method === 'cash';
    const vatChargeable = !isCashSale && vatRegistered;
    const newVat = vatChargeable
      ? +(newSubtotal - newSubtotal / (1 + vatRate)).toFixed(2)
      : 0;
    const newTotal = +(newSubtotal + parseFloat(old.sale_shipping || 0)).toFixed(2);
    await c.query(
      `UPDATE sales SET subtotal = $1, vat = $2, total = $3 WHERE id = $4`,
      [newSubtotal, newVat, newTotal, req.params.id]
    );
    return { ok: true, oldItem: old, newItem: { title: newTitle, qty: newQty, unit_price: newUnitPrice, line_total: newLineTotal } };
  });
  if (result.error) return res.status(404).json(result);
  await audit(req, 'edit_sale_item', 'sale_item', req.params.itemId, { saleId: req.params.id, ...result.newItem });
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

  const all = await query(`SELECT id, subtotal, shipping, vat, total, payment_method FROM sales`);
  let fixed = 0, alreadyOk = 0;
  for (const s of all.rows) {
    const subtotal = parseFloat(s.subtotal || 0);
    const shipping = parseFloat(s.shipping || 0);
    const isCashSale = s.payment_method === 'cash';
    const vatChargeable = !isCashSale && vatRegistered;
    const correctVat = vatChargeable ? +(subtotal - subtotal / (1 + vatRate)).toFixed(2) : 0;
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
  await audit(req, 'backfill_vat', null, null, { fixed, alreadyOk });
  res.json({ ok: true, fixed, alreadyOk, total: all.rows.length });
});

module.exports = router;
