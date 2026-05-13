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
  const seq = await (client || query)(
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

// GET /api/sales/export.xlsx?from=&to=
// Multi-sheet Excel workbook with one sheet per channel: Shopify, eBay, Cash, Bank.
// Used for accounting — each channel reconciles separately.
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  let XLSX;
  try { XLSX = require('xlsx'); }
  catch (e) {
    return res.status(503).json({ error: 'xlsx_not_installed', message: 'Run `npm install` after pulling — adds xlsx dependency.' });
  }
  const { from, to } = req.query;
  const baseWhere = [], baseParams = [];
  if (from) { baseParams.push(from); baseWhere.push(`s.occurred_at >= $${baseParams.length}`); }
  if (to)   { baseParams.push(to);   baseWhere.push(`s.occurred_at <= $${baseParams.length}`); }

  const channels = [
    { label: 'Shopify',       sheetName: 'Shopify',  match: ['shopify'] },
    { label: 'eBay',          sheetName: 'eBay',     match: ['ebay_em', 'ebay_cl'] },
    { label: 'Cash',          sheetName: 'Cash',     match: ['direct_cash'] },
    { label: 'Bank transfer', sheetName: 'Bank',     match: ['direct_bank'] },
  ];

  const wb = XLSX.utils.book_new();
  const headers = [
    'Date', 'Invoice / Reference', 'Channel Order ID', 'Customer', 'Customer Email',
    'Item', 'SKU', 'Part Number', 'Qty', 'Unit Price', 'Line Total', 'Order Total', 'Payment Method',
  ];

  for (const ch of channels) {
    const params = baseParams.slice();
    const chPlaceholders = ch.match.map((_, i) => `$${params.length + i + 1}`).join(',');
    params.push(...ch.match);
    const where = baseWhere.concat(`s.channel IN (${chPlaceholders})`);
    const w = `WHERE ${where.join(' AND ')}`;

    const { rows } = await query(`
      SELECT s.occurred_at, s.invoice_number, s.payment_reference, s.external_order_id,
             s.customer_name, s.customer_email, s.total, s.payment_method,
             si.title AS item_title, si.sku AS item_sku, si.qty, si.unit_price, si.line_total,
             p.part_number AS part_number
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      ${w}
      ORDER BY s.occurred_at DESC, si.id`, params);

    const data = [headers];
    for (const r of rows) {
      data.push([
        r.occurred_at ? new Date(r.occurred_at) : '',
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
    if (data.length === 1) data.push(['(no sales in date range)']);

    const ws = XLSX.utils.aoa_to_sheet(data);
    // Column widths
    ws['!cols'] = [
      { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 22 }, { wch: 26 },
      { wch: 42 }, { wch: 22 }, { wch: 18 }, { wch: 6 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, ch.sheetName);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `sales-${new Date().toISOString().slice(0,10)}.xlsx`;
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

    const vat = +(subtotal * vatRate).toFixed(2);
    const shipping = parseFloat(b.shipping || 0);
    const total = +(subtotal + vat + shipping).toFixed(2);

    // Generate identifiers
    const invoiceNumber = isEstimate ? null : await nextInvoiceNumber(c);
    const paymentReference = genReference(paymentMethod);

    const sale = await c.query(
      `INSERT INTO sales (channel, customer_name, customer_phone, customer_email,
                          subtotal, vat, shipping, total, status, invoice_number,
                          notes, recorded_by, payment_method, payment_reference,
                          is_estimate, order_number, vehicle_reg, vin_number, shipping_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [b.channel, b.customerName || null, b.customerPhone || null, b.customerEmail || null,
       subtotal, vat, shipping, total,
       isEstimate ? 'pending' : 'paid',
       invoiceNumber, b.notes || null, req.user.id,
       paymentMethod, paymentReference,
       isEstimate, b.orderNumber || null, b.vehicleReg || null, b.vinNumber || null, b.shippingAddress || null]
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

    const updated = await c.query(`
      UPDATE sales SET
        is_estimate = false, status = 'paid', invoice_number = $1,
        payment_reference = $2, payment_method = $3, occurred_at = now()
      WHERE id = $4 RETURNING *`,
      [invoiceNumber, paymentReference, paymentMethod, req.params.id]);

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
  const fmt = (n) => '£' + parseFloat(n || 0).toFixed(2);
  const date = sale.occurred_at ? new Date(sale.occurred_at) : new Date();
  const datePretty = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Friendly payment label that falls back to channel when method is blank (legacy sales)
  const paymentLabel = (() => {
    const pm = sale.payment_method;
    if (pm === 'shopify') return 'Shopify Payment';
    if (pm === 'ebay')    return 'eBay Payment';
    if (pm === 'cash')    return 'Cash';
    if (pm === 'bank')    return 'Bank Transfer';
    if (pm === 'card')    return 'Card (Stripe)';
    if (sale.channel === 'shopify') return 'Shopify Payment';
    if ((sale.channel || '').startsWith('ebay')) return 'eBay Payment';
    if (sale.channel === 'direct_cash') return 'Cash';
    if (sale.channel === 'direct_bank') return 'Bank Transfer';
    return '—';
  })();
  // Friendly channel label: Store / eBay / Cash / Bank
  const channelLabel = (() => {
    if (sale.channel === 'shopify') return 'Store';
    if ((sale.channel || '').startsWith('ebay')) return 'eBay';
    if (sale.channel === 'direct_cash') return 'Cash sale';
    if (sale.channel === 'direct_bank') return 'Bank transfer';
    return (sale.channel || '').replace(/_/g, ' ');
  })();

  const isVatRegistered = !!company.vat_registered;
  const isCashReceipt = mode === 'receipt' || (sale.payment_method === 'cash' && !isVatRegistered);
  const docTitle = mode === 'estimate' ? 'ESTIMATE' : isCashReceipt ? 'RECEIPT' : 'INVOICE';
  const logoUrl = (baseUrl || '') + '/logo.png';

  // ----- #5 — Use the shipping name from the address rather than eBay username on invoices -----
  // The first line of shipping_address is the buyer's real name.
  // sale.customer_name on eBay sales is the eBay username — useful for staff but not for the
  // customer-facing invoice. Prefer the shipping-address name when available.
  let billedToName = sale.customer_name || 'Walk-in customer';
  if (sale.shipping_address) {
    const firstLine = String(sale.shipping_address).split('\n')[0].trim();
    if (firstLine) billedToName = firstLine;
  }

  // For VAT calc: when VAT registered, line totals are inclusive — derive net
  const subtotalNet = isVatRegistered ? (parseFloat(sale.subtotal) / 1.2) : parseFloat(sale.subtotal);
  const vatAmount = isVatRegistered ? (parseFloat(sale.subtotal) - subtotalNet) : 0;

  // ---------- Minimal cash receipt (for non-VAT cash sales) ----------
  if (isCashReceipt) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${docTitle} ${escapeHtml(sale.payment_reference || '')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;max-width:420px;margin:24px auto;padding:0 20px;line-height:1.5;font-size:13px}
  .head{text-align:center;padding-bottom:14px;border-bottom:1px dashed #999;margin-bottom:16px}
  .logo{height:38px;margin-bottom:6px}
  .doctype{font-size:12px;letter-spacing:.2em;color:#666;font-weight:600}
  .ref{font-family:ui-monospace,monospace;font-size:12px;background:#f5f5f5;display:inline-block;padding:4px 10px;border-radius:3px;margin-top:8px}
  .meta{margin-bottom:12px;color:#555}
  table{width:100%;border-collapse:collapse;margin:10px 0}
  th,td{padding:6px 0;text-align:left}
  th{font-size:10px;text-transform:uppercase;color:#999;letter-spacing:.06em;border-bottom:1px solid #ddd}
  td{border-bottom:1px dashed #eee}
  .num{text-align:right}
  .total{display:flex;justify-content:space-between;font-size:17px;font-weight:700;margin-top:10px;padding-top:10px;border-top:2px solid #111}
  .foot{margin-top:18px;font-size:11px;color:#888;text-align:center;line-height:1.6}
  .actions{margin:20px auto 0;text-align:center}
  .btn{display:inline-block;padding:8px 18px;background:#c8202d;color:white;border-radius:4px;text-decoration:none;font-weight:600;font-size:12px;cursor:pointer;border:none}
  @media print {.actions{display:none}}
</style></head><body>
<div class="head">
  <img src="${logoUrl}" alt="Razoryn" class="logo" onerror="this.style.display='none'">
  <div class="doctype">${docTitle}</div>
  <div class="ref">${escapeHtml(sale.payment_reference || '')}</div>
</div>
<div class="meta">
  ${escapeHtml(datePretty)} · ${escapeHtml(date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}
  ${sale.customer_name ? `<br>Customer: ${escapeHtml(sale.customer_name)}` : ''}
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
<div class="total"><span>TOTAL PAID</span><span>${fmt(sale.total)}</span></div>
<div class="foot">
  Thank you. Cash sales — no returns without this receipt.<br>
  Keep this slip for your records.
</div>
<div class="actions">
  <button class="btn" onclick="window.print()">Print receipt</button>
</div>
</body></html>`;
  }

  // ---------- Full invoice / estimate (Hyundai-inspired layout) ----------
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${docTitle} ${escapeHtml(sale.invoice_number || sale.payment_reference || '')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#0f1115;background:#fafafa;font-size:12px;line-height:1.45}
  .page{max-width:840px;margin:24px auto;background:white;padding:42px 48px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  /* Header */
  .topbar{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:3px solid #c8202d;margin-bottom:24px}
  .topbar .left img{height:48px;display:block}
  .topbar .left .sub{font-size:10px;color:#666;letter-spacing:.12em;text-transform:uppercase;margin-top:8px;font-weight:500}
  .topbar .right{text-align:right}
  .topbar .right .doctype{font-size:30px;font-weight:300;letter-spacing:.12em;color:#0f1115;line-height:1}
  .topbar .right .num{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#c8202d;font-weight:600;margin-top:8px}
  .topbar .right .order{font-size:10.5px;color:#777;margin-top:3px}
  /* Address blocks (Hyundai-style 2-col) */
  .addr-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:32px;padding:18px 0 20px;border-bottom:1px solid #e0e2e6;margin-bottom:18px}
  .addr-block .lbl{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:#888;font-weight:600;margin-bottom:6px}
  .addr-block .name{font-size:13px;font-weight:600;margin-bottom:2px;color:#0f1115}
  .addr-block .lines{font-size:11.5px;color:#444;line-height:1.6}
  /* Order details row (Hyundai's account no / order no / date strip) */
  .detail-strip{display:grid;grid-template-columns:repeat(4, 1fr);gap:18px;padding:12px 14px;background:#f7f7f8;border:1px solid #ebedf0;border-radius:4px;margin-bottom:22px}
  .detail-strip .item .l{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#888;font-weight:600;margin-bottom:3px}
  .detail-strip .item .v{font-size:12px;color:#0f1115;font-weight:600}
  /* Items table */
  table.items{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
  table.items thead th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#666;font-weight:600;padding:9px 10px;border-top:1.5px solid #0f1115;border-bottom:1px solid #ccc;background:#fafafa}
  table.items thead th.num{text-align:right}
  table.items tbody td{padding:10px;border-bottom:1px solid #eef0f3;vertical-align:top}
  table.items tbody td.num{text-align:right;font-variant-numeric:tabular-nums}
  table.items .sku{font-family:ui-monospace,monospace;font-size:10.5px;color:#888;margin-top:2px}
  /* Totals (Hyundai-style — boxed, right-aligned) */
  .totals-wrap{display:flex;justify-content:flex-end;margin-bottom:24px}
  .totals{width:340px;font-size:12px}
  .totals .row{display:flex;justify-content:space-between;padding:5px 12px}
  .totals .row.sep{border-top:1px solid #e0e2e6;margin-top:4px;padding-top:9px}
  .totals .grand{background:#0f1115;color:white;padding:11px 14px;font-size:15px;font-weight:600;margin-top:6px;display:flex;justify-content:space-between;border-radius:2px}
  /* Payment + bank */
  .pay{padding:14px 16px;background:#fff8f8;border-left:3px solid #c8202d;font-size:12px;border-radius:0 4px 4px 0;margin-bottom:18px}
  .pay .row{display:flex;gap:12px;margin-bottom:4px}
  .pay .row .l{min-width:130px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#777;font-weight:600;padding-top:1px}
  .pay .row .v{font-weight:600}
  /* Footer */
  .foot{margin-top:24px;padding-top:16px;border-top:1px solid #e0e2e6;font-size:10px;color:#666;line-height:1.6}
  .foot .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:12px}
  .foot .col .h{display:block;color:#222;text-transform:uppercase;font-size:9px;letter-spacing:.1em;margin-bottom:5px;font-weight:600}
  .terms{font-size:9.5px;color:#888;text-align:center;line-height:1.6;border-top:1px dashed #ddd;padding-top:10px}
  /* Estimate stamp */
  .stamp{position:absolute;top:160px;left:50%;transform:translateX(-50%) rotate(-12deg);border:4px solid #b76b00;color:#b76b00;padding:8px 32px;font-weight:800;letter-spacing:.2em;font-size:28px;opacity:.18;pointer-events:none}
  /* Print actions */
  .actions{display:flex;gap:10px;justify-content:center;margin:20px 0;flex-wrap:wrap}
  .btn{display:inline-block;padding:9px 20px;background:#c8202d;color:white;border-radius:4px;text-decoration:none;font-weight:600;font-size:12px;cursor:pointer;border:none;font-family:inherit}
  .btn.ghost{background:white;color:#0f1115;border:1px solid #ccc}
  @media print {
    body{background:white}
    .page{box-shadow:none;margin:0;padding:24px 28px;max-width:none}
    .actions{display:none}
    @page{margin:10mm}
  }
</style></head><body>

<div class="actions">
  <button class="btn" onclick="window.print()">🖨 Print / Save as PDF</button>
  <a class="btn ghost" href="#" onclick="window.close();return false">Close</a>
</div>

<div class="page" style="position:relative">
  ${mode === 'estimate' ? '<div class="stamp">ESTIMATE</div>' : ''}

  <div class="topbar">
    <div class="left">
      ${mode !== 'estimate' ? `
        <img src="${logoUrl}" alt="Razoryn e-Parts" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
        <div style="display:none;font-size:24px;font-weight:800;letter-spacing:-.02em">Razoryn <span style="color:#c8202d">e-Parts</span></div>
        <div class="sub">Quality aftermarket vehicle parts</div>
      ` : `
        <div style="font-size:24px;font-weight:700;letter-spacing:-.01em;color:#333">Estimate</div>
        <div class="sub" style="margin-top:6px">Quote · valid 14 days</div>
      `}
    </div>
    <div class="right">
      <div class="doctype">${docTitle}</div>
      <div class="num">${escapeHtml(sale.invoice_number || sale.payment_reference || '—')}</div>
      ${sale.order_number ? `<div class="order">Order: ${escapeHtml(sale.order_number)}</div>` : ''}
    </div>
  </div>

  <div class="addr-grid">
    ${mode !== 'estimate' ? `
    <div class="addr-block">
      <div class="lbl">From</div>
      <div class="name">Razoryn e-Parts</div>
      <div class="lines">
        ${escapeHtml(company.company_address || '')}<br>
        ${company.company_phone ? 'Tel: ' + escapeHtml(company.company_phone) + '<br>' : ''}
        ${company.company_email ? escapeHtml(company.company_email) + '<br>' : ''}
        ${company.company_website ? escapeHtml(company.company_website) + '<br>' : ''}
        ${company.company_reg_no ? 'Co. No. ' + escapeHtml(company.company_reg_no) : ''}
        ${isVatRegistered && company.vat_number ? ' · VAT ' + escapeHtml(company.vat_number) : ''}
      </div>
    </div>
    ` : `
    <div class="addr-block">
      <div class="lbl">Quote details</div>
      <div class="lines" style="color:#555;font-size:11.5px">
        This is an estimate only. Prices valid for 14 days from the date below.<br>
        Goods reserved on receipt of payment.
      </div>
    </div>
    `}
    <div class="addr-block">
      <div class="lbl">${mode === 'estimate' ? 'Estimate for' : 'Billed / Delivered to'}</div>
      <div class="name">${escapeHtml(billedToName)}</div>
      <div class="lines">
        ${sale.shipping_address
          ? escapeHtml(sale.shipping_address).split('\n').slice(1).map(escapeHtml).join('<br>') + '<br>'
          : '<em style="color:#aaa">No address on file</em><br>'}
        ${sale.customer_phone ? 'Tel: ' + escapeHtml(sale.customer_phone) + '<br>' : ''}
        ${sale.customer_email ? escapeHtml(sale.customer_email) : ''}
      </div>
    </div>
  </div>

  <div class="detail-strip">
    <div class="item"><div class="l">Date</div><div class="v">${escapeHtml(datePretty)}</div></div>
    <div class="item"><div class="l">Channel</div><div class="v">${escapeHtml(channelLabel)}</div></div>
    ${sale.vehicle_reg
      ? `<div class="item"><div class="l">Vehicle Reg.</div><div class="v">${escapeHtml(sale.vehicle_reg)}</div></div>`
      : sale.vin_number
      ? `<div class="item"><div class="l">VIN</div><div class="v" style="font-family:ui-monospace,monospace;font-size:10.5px">${escapeHtml(sale.vin_number)}</div></div>`
      : `<div class="item"><div class="l">Status</div><div class="v" style="text-transform:capitalize">${escapeHtml(sale.status || '—')}</div></div>`}
    <div class="item"><div class="l">Payment</div><div class="v">${escapeHtml(paymentLabel)}</div></div>
  </div>

  <table class="items">
    <thead><tr>
      <th>Description</th>
      <th class="num" style="width:60px">Qty</th>
      <th class="num" style="width:110px">Unit ${isVatRegistered ? 'Net' : ''}</th>
      <th class="num" style="width:110px">Total ${isVatRegistered ? 'Net' : ''}</th>
    </tr></thead>
    <tbody>
      ${items.map(i => {
        const unitNet = isVatRegistered ? (parseFloat(i.unit_price) / 1.2) : parseFloat(i.unit_price);
        const lineNet = isVatRegistered ? (parseFloat(i.line_total) / 1.2) : parseFloat(i.line_total);
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
      ${isVatRegistered ? `
        <div class="row"><span>Subtotal (Net)</span><span>${fmt(subtotalNet)}</span></div>
        <div class="row"><span>VAT (${company.vat_rate || 20}%)</span><span>${fmt(vatAmount)}</span></div>
      ` : `
        <div class="row"><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
      `}
      ${parseFloat(sale.shipping || 0) > 0 ? `<div class="row"><span>Shipping</span><span>${fmt(sale.shipping)}</span></div>` : ''}
      <div class="grand"><span>TOTAL${isVatRegistered ? ' (incl. VAT)' : ''}</span><span>${fmt(sale.total)}</span></div>
    </div>
  </div>

  ${(mode === 'estimate' || (sale.payment_method === 'bank' && company.bank_account_name)) ? `
  <div class="pay">
    ${mode === 'estimate' ? `<div class="row"><div class="l">Note</div><div class="v" style="color:#b76b00">Estimate valid 14 days. Goods reserved on receipt of payment.</div></div>` : ''}
    ${sale.payment_method === 'bank' && company.bank_account_name ? `
      <div class="row"${mode === 'estimate' ? ' style="margin-top:8px;padding-top:8px;border-top:1px solid #f0d4d8"' : ''}><div class="l">Bank</div><div class="v" style="font-weight:400">
        ${escapeHtml(company.bank_account_name)}<br>
        Sort: ${escapeHtml(company.bank_sort_code || '—')} · Acc: ${escapeHtml(company.bank_account_number || '—')}<br>
        Use reference: <strong>${escapeHtml(sale.payment_reference)}</strong>
      </div></div>
    ` : ''}
  </div>
  ` : ''}

  ${mode !== 'estimate' ? `
  <div class="foot">
    <div class="cols">
      <div class="col">
        <span class="h">Returns</span>
        Within 30 days of purchase, in original packaging. 5% restocking fee applies. Return shipping at buyer's cost unless faulty.
      </div>
      <div class="col">
        <span class="h">Fitment</span>
        All parts checked for fitment before despatch. Refunded if part doesn't fit as advertised. Confirm OEM number before ordering.
      </div>
      <div class="col">
        <span class="h">Contact</span>
        ${company.company_email ? escapeHtml(company.company_email) + '<br>' : ''}
        ${company.company_phone ? escapeHtml(company.company_phone) + '<br>' : ''}
        ${company.company_website ? escapeHtml(company.company_website) : ''}
      </div>
    </div>
    <div class="terms">
      ${company.company_reg_no ? `Razoryn e-Parts is a trading name of Razoryn Ltd, Co. No. ${escapeHtml(company.company_reg_no)}, England & Wales. ` : ''}
      ${isVatRegistered && company.vat_number ? `VAT No. ${escapeHtml(company.vat_number)}. ` : ''}
      Full terms: ${company.company_website ? escapeHtml(company.company_website) + '/policies' : 'razoryn.co.uk/policies'}
    </div>
  </div>
  ` : `
  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e0e2e6;font-size:11px;color:#666;text-align:center">
    To confirm this estimate, contact us with reference <strong>${escapeHtml(sale.payment_reference || '—')}</strong>.
  </div>
  `}
</div>

</body></html>`;
}

// GET /api/sales/:id/invoice.html  — print-ready invoice (or estimate, or receipt)
router.get('/:id/invoice.html', requireAdmin, async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).send('Not found');
  const sale = s.rows[0];
  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id])).rows;
  const company = await getCompanySettings();
  const mode = sale.is_estimate ? 'estimate'
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
  const mode = sale.is_estimate ? 'estimate'
             : (sale.payment_method === 'cash' && !company.vat_registered) ? 'receipt'
             : 'invoice';
  const html = renderInvoiceHtml({ sale, items, company, mode, baseUrl: `${req.protocol}://${req.get('host')}` });
  const docLabel = mode === 'estimate' ? 'Estimate' : mode === 'receipt' ? 'Receipt' : 'Invoice';
  const subject = `${docLabel} ${sale.invoice_number || sale.payment_reference || ''} — Razoryn e-Parts`;

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'email_not_configured',
      message: 'Set RESEND_API_KEY env var in Railway. Sign up at resend.com (free tier: 3000 emails/month).'
    });
  }
  const fromEmail = process.env.WAREHOUSE_FROM_EMAIL || 'noreply@razoryn.co.uk';
  try {
    const axios = require('axios');
    const r = await axios.post('https://api.resend.com/emails', {
      from: `Razoryn e-Parts <${fromEmail}>`,
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

    // Recompute sale totals from all line items
    const tot = await c.query(`SELECT COALESCE(SUM(line_total),0) AS subtotal FROM sale_items WHERE sale_id = $1`, [req.params.id]);
    const newSubtotal = parseFloat(tot.rows[0].subtotal);
    // Keep the existing VAT proportion (if VAT was 0, keep 0; if it was 20% of old subtotal, keep 20%)
    const oldSubtotal = parseFloat(old.sale_subtotal);
    const vatRate = oldSubtotal > 0 ? (parseFloat(old.sale_vat) / oldSubtotal) : 0;
    const newVat = +(newSubtotal * vatRate).toFixed(2);
    const newTotal = +(newSubtotal + newVat + parseFloat(old.sale_shipping || 0)).toFixed(2);
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

module.exports = router;
