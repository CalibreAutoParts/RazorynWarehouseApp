// routes/sales.js — sales, invoices, estimates, CSV exports, emails
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
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
router.get('/', requirePermission('sales'), async (req, res) => {
  const { channel, from, to, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 50);
  const where = [], params = [];
  if (channel) { params.push(channel); where.push(`channel = $${params.length}`); }
  if (from)    { params.push(from); where.push(`occurred_at >= $${params.length}`); }
  if (to)      { params.push(to); where.push(`occurred_at <= $${params.length}`); }
  if (status)  { params.push(status); where.push(`status = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM sales ${w} ORDER BY occurred_at DESC LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`,
    params
  );
  const tot = await query(`SELECT COUNT(*)::int AS n FROM sales ${w}`, params);
  const summary = await query(`
    SELECT channel, COUNT(*)::int AS count, COALESCE(SUM(total),0) AS revenue
    FROM sales ${w} GROUP BY channel`, params);
  res.json({ sales: rows, total: tot.rows[0].n, summary: summary.rows });
});

// GET /api/sales/export.csv?channel=&from=&to=
router.get('/export.csv', requirePermission('sales'), async (req, res) => {
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

// GET /api/sales/:id
router.get('/:id', requirePermission('sales'), async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const items = await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id]);
  res.json({ sale: s.rows[0], items: items.rows });
});

// POST /api/sales — record a manual sale or estimate.
// Body: { channel, paymentMethod, isEstimate, customerName, customerPhone, customerEmail,
//         shippingAddress, vehicleReg, orderNumber, items, shipping, notes }
router.post('/', requirePermission('sales'), async (req, res) => {
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
      const p = await c.query(
        'SELECT id, sku, title, qty_on_hand FROM products WHERE id = $1 FOR UPDATE',
        [it.productId]
      );
      if (!p.rows[0]) return { error: 'product_not_found', productId: it.productId };
      // For non-estimates, validate stock
      if (!isEstimate && p.rows[0].qty_on_hand < it.qty) {
        return { error: 'insufficient_stock', productId: it.productId, available: p.rows[0].qty_on_hand };
      }
      const lineTotal = parseFloat(it.unitPrice) * parseInt(it.qty);
      subtotal += lineTotal;
      itemsResolved.push({
        productId: p.rows[0].id, sku: p.rows[0].sku, title: p.rows[0].title,
        qty: parseInt(it.qty), unitPrice: parseFloat(it.unitPrice), lineTotal,
      });
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
                          is_estimate, order_number, vehicle_reg, shipping_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [b.channel, b.customerName || null, b.customerPhone || null, b.customerEmail || null,
       subtotal, vat, shipping, total,
       isEstimate ? 'pending' : 'paid',
       invoiceNumber, b.notes || null, req.user.id,
       paymentMethod, paymentReference,
       isEstimate, b.orderNumber || null, b.vehicleReg || null, b.shippingAddress || null]
    );

    for (const it of itemsResolved) {
      await c.query(
        `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.rows[0].id, it.productId, it.sku, it.title, it.qty, it.unitPrice, it.lineTotal]
      );
      // Only decrement stock for confirmed sales, not estimates
      if (!isEstimate) {
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
router.post('/:id/convert-to-invoice', requirePermission('sales'), async (req, res) => {
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

function renderInvoiceHtml({ sale, items, company, mode }) {
  // mode: 'invoice' | 'estimate' | 'receipt' (receipt = cash, simplified)
  const fmt = (n) => '£' + parseFloat(n || 0).toFixed(2);
  const date = sale.occurred_at ? new Date(sale.occurred_at) : new Date();
  const datePretty = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const timePretty = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const isVatRegistered = !!company.vat_registered;
  const isCashReceipt = mode === 'receipt' || (sale.payment_method === 'cash' && !isVatRegistered);

  // Document title
  const docTitle = mode === 'estimate' ? 'ESTIMATE'
                 : isCashReceipt ? 'RECEIPT'
                 : 'INVOICE';

  // For cash sales when not VAT-registered, render minimal receipt
  if (isCashReceipt) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${docTitle} ${sale.payment_reference || ''}</title>
<style>
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;max-width:480px;margin:30px auto;padding:0 24px;line-height:1.5}
  .head{text-align:center;border-bottom:2px solid #c8202d;padding-bottom:14px;margin-bottom:18px}
  .brand{font-size:22px;font-weight:800;letter-spacing:-.02em}
  .brand span{color:#c8202d}
  .doctitle{font-size:13px;color:#666;letter-spacing:.15em;margin-top:8px}
  .meta{font-size:12px;color:#444;margin-bottom:14px;display:flex;justify-content:space-between}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
  th,td{padding:8px 4px;text-align:left;border-bottom:1px dashed #ddd}
  th{font-size:10px;text-transform:uppercase;color:#888;letter-spacing:.06em}
  .num{text-align:right}
  .total{font-size:18px;font-weight:700;border-top:1px solid #111;padding-top:8px;display:flex;justify-content:space-between;margin-top:10px}
  .foot{margin-top:24px;font-size:11px;color:#888;text-align:center}
  .ref{font-family:ui-monospace,monospace;background:#f5f5f5;padding:4px 8px;border-radius:4px;font-size:11px}
  @media print { body { margin: 0; } }
</style></head><body>
<div class="head">
  <div class="brand">Razoryn <span>e-Parts</span></div>
  <div class="doctitle">${docTitle}</div>
</div>
<div class="meta">
  <div>
    <div>${escapeHtml(datePretty)} · ${escapeHtml(timePretty)}</div>
    ${sale.customer_name ? `<div>${escapeHtml(sale.customer_name)}</div>` : ''}
  </div>
  <div style="text-align:right">
    <div class="ref">${escapeHtml(sale.payment_reference || sale.invoice_number || '')}</div>
  </div>
</div>
<table>
  <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
  <tbody>
    ${items.map(i => `<tr>
      <td>${escapeHtml(i.title)}<div style="font-size:10px;color:#888">${escapeHtml(i.sku)}</div></td>
      <td class="num">${i.qty}</td>
      <td class="num">${fmt(i.line_total)}</td>
    </tr>`).join('')}
  </tbody>
</table>
<div class="total"><span>Total paid</span><span>${fmt(sale.total)}</span></div>
<div class="foot">
  Thank you. No returns on cash sales without proof of purchase.<br>
  Keep this receipt for your records.
</div>
<script>window.print && setTimeout(() => window.print(), 200);</script>
</body></html>`;
  }

  // Full invoice / estimate — Calibre + Hyundai inspired
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${docTitle} ${sale.invoice_number || sale.payment_reference || ''}</title>
<style>
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#0f1115;max-width:820px;margin:30px auto;padding:0 24px;line-height:1.45;font-size:13px}
  .row{display:flex;justify-content:space-between;gap:24px}
  .head-wrap{padding-bottom:18px;border-bottom:3px solid #c8202d;margin-bottom:22px}
  .brand-area .logo{font-size:28px;font-weight:800;letter-spacing:-.025em;line-height:1}
  .brand-area .logo span{color:#c8202d}
  .brand-area .sub{font-size:10px;color:#666;letter-spacing:.1em;text-transform:uppercase;margin-top:6px}
  .head-meta{text-align:right}
  .head-meta .doctype{font-size:22px;font-weight:800;letter-spacing:.04em;color:#0f1115}
  .head-meta .docno{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#444;margin-top:4px}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #e8eaee}
  .info-block .label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#777;font-weight:600;margin-bottom:6px}
  .info-block .val{font-size:13px;line-height:1.5}
  .info-block .val strong{display:block;font-size:14px;margin-bottom:2px}
  .order-fields{display:flex;flex-wrap:wrap;gap:14px 24px;margin-bottom:18px;font-size:12px;color:#555}
  .order-fields div span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#999;font-weight:600;margin-bottom:2px}
  .order-fields div strong{color:#0f1115}
  table.items{width:100%;border-collapse:collapse;margin:8px 0 20px}
  table.items th{background:#f5f6f7;text-align:left;padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#555;border-top:1px solid #e0e2e6;border-bottom:1px solid #e0e2e6}
  table.items td{padding:12px;border-bottom:1px solid #eef0f3;vertical-align:top}
  table.items .num{text-align:right}
  table.items .sku{font-family:ui-monospace,monospace;font-size:11px;color:#888;margin-top:2px}
  .totals{margin-left:auto;width:300px;font-size:13px}
  .totals .line{display:flex;justify-content:space-between;padding:5px 0}
  .totals .grand{font-size:18px;font-weight:700;margin-top:6px;padding-top:10px;border-top:2px solid #0f1115}
  .pay-block{margin-top:22px;padding:14px 16px;background:#fafbfc;border-left:3px solid #c8202d;font-size:12px;border-radius:0 6px 6px 0}
  .pay-block strong{display:inline-block;min-width:130px}
  .foot{margin-top:30px;padding-top:18px;border-top:1px solid #e0e2e6;font-size:10.5px;color:#777;line-height:1.6}
  .foot .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:12px}
  .foot .col strong{display:block;color:#444;text-transform:uppercase;font-size:9px;letter-spacing:.08em;margin-bottom:4px}
  .terms{font-size:10px;color:#888;margin-top:14px;text-align:center}
  .stamp-estimate{position:fixed;top:120px;right:60px;border:3px solid #b76b00;color:#b76b00;padding:6px 18px;font-weight:800;letter-spacing:.15em;transform:rotate(-8deg);opacity:.6;font-size:18px}
  @media print { body { margin: 0; } @page { margin: 12mm; } }
</style></head><body>

${mode === 'estimate' ? '<div class="stamp-estimate">ESTIMATE</div>' : ''}

<div class="head-wrap row">
  <div class="brand-area">
    <div class="logo">Razoryn <span>e-Parts</span></div>
    <div class="sub">Quality aftermarket vehicle parts</div>
  </div>
  <div class="head-meta">
    <div class="doctype">${docTitle}</div>
    <div class="docno">${escapeHtml(sale.invoice_number || sale.payment_reference || '—')}</div>
  </div>
</div>

<div class="info-grid">
  <div class="info-block">
    <div class="label">From</div>
    <div class="val">
      <strong>Razoryn e-Parts</strong>
      ${escapeHtml(company.company_address || '')}<br>
      ${company.company_phone ? `Tel: ${escapeHtml(company.company_phone)}<br>` : ''}
      ${company.company_email ? `${escapeHtml(company.company_email)}<br>` : ''}
      ${company.company_website ? `${escapeHtml(company.company_website)}<br>` : ''}
      ${company.company_reg_no ? `Company No. ${escapeHtml(company.company_reg_no)}<br>` : ''}
      ${isVatRegistered && company.vat_number ? `VAT No. ${escapeHtml(company.vat_number)}` : ''}
    </div>
  </div>
  <div class="info-block">
    <div class="label">Billed to</div>
    <div class="val">
      <strong>${escapeHtml(sale.customer_name || 'Cash customer')}</strong>
      ${sale.shipping_address ? escapeHtml(sale.shipping_address).replace(/\n/g, '<br>') + '<br>' : ''}
      ${sale.customer_phone ? `Tel: ${escapeHtml(sale.customer_phone)}<br>` : ''}
      ${sale.customer_email ? escapeHtml(sale.customer_email) : ''}
    </div>
  </div>
</div>

<div class="order-fields">
  <div><span>Date</span><strong>${escapeHtml(datePretty)}</strong></div>
  <div><span>Time</span><strong>${escapeHtml(timePretty)}</strong></div>
  ${sale.order_number ? `<div><span>Order No.</span><strong>${escapeHtml(sale.order_number)}</strong></div>` : ''}
  ${sale.external_order_id ? `<div><span>Channel Order</span><strong>${escapeHtml(sale.external_order_id)}</strong></div>` : ''}
  ${sale.vehicle_reg ? `<div><span>Reg No.</span><strong>${escapeHtml(sale.vehicle_reg)}</strong></div>` : ''}
  <div><span>Channel</span><strong>${escapeHtml((sale.channel || '').replace('_', ' '))}</strong></div>
  <div><span>Payment Ref.</span><strong>${escapeHtml(sale.payment_reference || '—')}</strong></div>
</div>

<table class="items">
  <thead><tr>
    <th>Description</th>
    <th class="num" style="width:60px">Qty</th>
    <th class="num" style="width:110px">Unit ${isVatRegistered ? '(excl. VAT)' : ''}</th>
    <th class="num" style="width:110px">Total ${isVatRegistered ? '(excl. VAT)' : ''}</th>
  </tr></thead>
  <tbody>
    ${items.map(i => {
      const unitExcl = isVatRegistered ? (parseFloat(i.unit_price) / 1.2) : parseFloat(i.unit_price);
      const lineExcl = isVatRegistered ? (parseFloat(i.line_total) / 1.2) : parseFloat(i.line_total);
      return `<tr>
        <td>
          <div>${escapeHtml(i.title)}</div>
          <div class="sku">${escapeHtml(i.sku)}</div>
        </td>
        <td class="num">${i.qty}</td>
        <td class="num">${fmt(unitExcl)}</td>
        <td class="num">${fmt(lineExcl)}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>

<div class="totals">
  ${isVatRegistered ? `
    <div class="line"><span>Net total</span><span>${fmt(sale.subtotal)}</span></div>
    <div class="line"><span>VAT (${company.vat_rate || 20}%)</span><span>${fmt(sale.vat)}</span></div>
  ` : `
    <div class="line"><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
  `}
  ${parseFloat(sale.shipping || 0) > 0 ? `<div class="line"><span>Shipping</span><span>${fmt(sale.shipping)}</span></div>` : ''}
  <div class="line grand"><span>Total ${isVatRegistered ? '(incl. VAT)' : ''}</span><span>${fmt(sale.total)}</span></div>
</div>

<div class="pay-block">
  <div><strong>Payment method:</strong> ${escapeHtml((sale.payment_method || '').toUpperCase()) || '—'}</div>
  ${mode === 'estimate' ? `<div style="margin-top:6px;color:#b76b00"><strong>Note:</strong> This is an estimate. Prices valid for 14 days. Goods reserved on receipt of payment.</div>` : ''}
  ${sale.payment_method === 'bank' && company.bank_account_name ? `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid #eee">
      <strong>Bank details:</strong><br>
      <div style="margin-left:130px;margin-top:-18px">
        ${escapeHtml(company.bank_account_name)}<br>
        Sort code: ${escapeHtml(company.bank_sort_code || '—')} · Account: ${escapeHtml(company.bank_account_number || '—')}<br>
        Reference: <strong>${escapeHtml(sale.payment_reference)}</strong>
      </div>
    </div>
  ` : ''}
</div>

<div class="foot">
  <div class="cols">
    <div class="col">
      <strong>Returns</strong>
      Within 30 days of purchase, in original packaging. 5% restocking fee applies. Return shipping at buyer's cost unless item faulty.
    </div>
    <div class="col">
      <strong>Fitment guarantee</strong>
      All parts checked for correct fitment before despatch. Refunded if part doesn't fit as advertised. Confirm OEM number before ordering.
    </div>
    <div class="col">
      <strong>Contact</strong>
      ${company.company_email ? escapeHtml(company.company_email) + '<br>' : ''}
      ${company.company_phone ? escapeHtml(company.company_phone) + '<br>' : ''}
      ${company.company_website ? escapeHtml(company.company_website) : ''}
    </div>
  </div>
  <div class="terms">
    ${company.company_reg_no ? `Razoryn e-Parts is a trading name of Razoryn Ltd, Company No. ${escapeHtml(company.company_reg_no)}, registered in England & Wales. ` : ''}
    ${isVatRegistered && company.vat_number ? `VAT No. ${escapeHtml(company.vat_number)}.` : ''}
    Full terms and conditions: ${company.company_website ? escapeHtml(company.company_website) + '/policies' : 'razoryn.co.uk/policies'}
  </div>
</div>
<script>window.print && setTimeout(() => window.print(), 200);</script>
</body></html>`;
}

// GET /api/sales/:id/invoice.html  — print-ready invoice (or estimate, or receipt)
router.get('/:id/invoice.html', requirePermission('sales'), async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).send('Not found');
  const sale = s.rows[0];
  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id])).rows;
  const company = await getCompanySettings();
  const mode = sale.is_estimate ? 'estimate'
             : (sale.payment_method === 'cash' && !company.vat_registered) ? 'receipt'
             : 'invoice';
  res.set('Content-Type', 'text/html').send(renderInvoiceHtml({ sale, items, company, mode }));
});

// POST /api/sales/:id/email — email the invoice to the customer
router.post('/:id/email', requirePermission('sales'), async (req, res) => {
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
  const html = renderInvoiceHtml({ sale, items, company, mode });
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

module.exports = router;
