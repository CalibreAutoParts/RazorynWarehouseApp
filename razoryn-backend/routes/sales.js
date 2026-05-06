// routes/sales.js — feature 7: sales by channel + invoice generation
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const CHANNELS = ['shopify', 'ebay_em', 'ebay_cl', 'direct_cash', 'direct_bank'];

// GET /api/sales?channel=&from=&to=&page=
router.get('/', requirePermission('sales'), async (req, res) => {
  const { channel, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 50);

  const where = [], params = [];
  if (channel) { params.push(channel); where.push(`channel = $${params.length}`); }
  if (from)    { params.push(from); where.push(`occurred_at >= $${params.length}`); }
  if (to)      { params.push(to); where.push(`occurred_at <= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT * FROM sales ${w} ORDER BY occurred_at DESC LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`,
    params
  );
  const tot = await query(`SELECT COUNT(*)::int AS n FROM sales ${w}`, params);

  // Summary row counts
  const summary = await query(`
    SELECT channel,
           COUNT(*)::int AS count,
           COALESCE(SUM(total),0) AS revenue
    FROM sales
    ${w}
    GROUP BY channel
  `, params);

  res.json({ sales: rows, total: tot.rows[0].n, summary: summary.rows });
});

// GET /api/sales/:id  (with line items)
router.get('/:id', requirePermission('sales'), async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const items = await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id]);
  res.json({ sale: s.rows[0], items: items.rows });
});

// POST /api/sales  — record a sale (typically a direct cash/bank sale entered manually)
// Shopify/eBay sales come in via the sync workers, not this endpoint.
//
// Body:
//   { channel, customerName, customerPhone, customerEmail,
//     items: [{ productId, qty, unitPrice }],
//     shipping, notes }
router.post('/', requirePermission('sales'), async (req, res) => {
  const b = req.body || {};
  if (!CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'invalid_channel' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'items_required' });

  // Direct sales only (Shopify/eBay sales are inserted by sync workers with different fields)
  if (!['direct_cash', 'direct_bank'].includes(b.channel)) {
    return res.status(400).json({ error: 'channel_not_manual_entry' });
  }

  const settings = await query('SELECT vat_rate FROM app_settings WHERE id = 1');
  const vatRate = parseFloat(settings.rows[0].vat_rate) / 100;

  const result = await withTx(async (c) => {
    let subtotal = 0;
    const itemsResolved = [];

    for (const it of b.items) {
      const p = await c.query(
        'SELECT id, sku, title, qty_on_hand FROM products WHERE id = $1 FOR UPDATE',
        [it.productId]
      );
      if (!p.rows[0]) return { error: 'product_not_found', productId: it.productId };
      if (p.rows[0].qty_on_hand < it.qty) {
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

    // Generate invoice number — RZN-YYYYMMDD-NNNN
    const today = new Date();
    const datePart = today.toISOString().slice(0, 10).replace(/-/g, '');
    const seqRow = await c.query(
      `SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM '\\d+$')::int), 0) + 1 AS next
       FROM sales WHERE invoice_number LIKE $1`,
      [`RZN-${datePart}-%`]
    );
    const invoiceNumber = `RZN-${datePart}-${String(seqRow.rows[0].next).padStart(4, '0')}`;

    const sale = await c.query(
      `INSERT INTO sales (channel, customer_name, customer_phone, customer_email,
                          subtotal, vat, shipping, total, status, invoice_number,
                          notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11) RETURNING *`,
      [b.channel, b.customerName || null, b.customerPhone || null, b.customerEmail || null,
       subtotal, vat, shipping, total, invoiceNumber, b.notes || null, req.user.id]
    );

    for (const it of itemsResolved) {
      await c.query(
        `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.rows[0].id, it.productId, it.sku, it.title, it.qty, it.unitPrice, it.lineTotal]
      );
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

    return { sale: sale.rows[0], items: itemsResolved };
  });

  if (result.error) return res.status(409).json(result);

  await audit(req, 'create_sale', 'sale', result.sale.id, {
    channel: b.channel, total: result.sale.total
  });

  // Trigger out-of-band sync to push the new stock levels to Shopify/eBay
  setImmediate(() => {
    const sync = require('../services/sync');
    sync.pushStockForSaleItems(result.items).catch(e => console.warn('[sync] push failed:', e.message));
  });

  res.status(201).json(result);
});

// GET /api/sales/:id/invoice.html  — print-ready invoice
router.get('/:id/invoice.html', requirePermission('sales'), async (req, res) => {
  const s = await query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).send('Not found');
  const sale = s.rows[0];
  const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [req.params.id])).rows;

  const fmt = (n) => '£' + parseFloat(n).toFixed(2);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice ${sale.invoice_number}</title>
<style>
  body{font-family:Inter,sans-serif;color:#0f1115;max-width:780px;margin:40px auto;padding:0 24px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #c8202d;padding-bottom:16px;margin-bottom:24px}
  .brand{font-size:24px;font-weight:800}.brand span{color:#c8202d}
  .meta{text-align:right;font-size:13px;color:#4a5260}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th,td{padding:10px;text-align:left;border-bottom:1px solid #e6e8ec}
  th{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .num{text-align:right}
  .totals{margin-left:auto;width:280px;font-size:14px}
  .totals .row{display:flex;justify-content:space-between;padding:6px 0}
  .totals .grand{font-size:20px;font-weight:700;border-top:2px solid #0f1115;margin-top:8px;padding-top:10px}
  .foot{margin-top:40px;font-size:12px;color:#4a5260;border-top:1px solid #e6e8ec;padding-top:16px}
</style></head><body>
<div class="head">
  <div>
    <div class="brand">Razoryn <span>e-Parts</span></div>
    <div style="font-size:12px;color:#4a5260;margin-top:4px">
      Unit 4 Shakespeare Industrial Estate, Watford<br>
      eparts@razoryn.co.uk · +44 7494589542<br>
      Company No. 16466013
    </div>
  </div>
  <div class="meta">
    <div style="font-size:18px;font-weight:700;color:#0f1115">INVOICE</div>
    <div>${sale.invoice_number || '—'}</div>
    <div>${new Date(sale.occurred_at).toLocaleDateString('en-GB')}</div>
    <div>Channel: ${sale.channel.replace('_', ' ')}</div>
  </div>
</div>
${sale.customer_name ? `<div style="margin-bottom:16px"><strong>Bill to:</strong> ${sale.customer_name}${sale.customer_phone ? ' · ' + sale.customer_phone : ''}</div>` : ''}
<table>
  <thead><tr><th>Item</th><th>SKU</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
  <tbody>
    ${items.map(i => `<tr>
      <td>${i.title}</td><td>${i.sku}</td>
      <td class="num">${i.qty}</td>
      <td class="num">${fmt(i.unit_price)}</td>
      <td class="num">${fmt(i.line_total)}</td>
    </tr>`).join('')}
  </tbody>
</table>
<div class="totals">
  <div class="row"><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
  <div class="row"><span>VAT (20%)</span><span>${fmt(sale.vat)}</span></div>
  <div class="row"><span>Shipping</span><span>${fmt(sale.shipping)}</span></div>
  <div class="row grand"><span>Total</span><span>${fmt(sale.total)}</span></div>
</div>
<div class="foot">Thank you for your business. Returns accepted within 30 days. 5% restocking fee applies.</div>
<script>window.print && setTimeout(() => window.print(), 200);</script>
</body></html>`;
  res.set('Content-Type', 'text/html').send(html);
});

module.exports = router;
