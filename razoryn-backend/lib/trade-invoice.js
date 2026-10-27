// lib/trade-invoice.js — the consolidated trade invoice (one document for every
// order a trade customer placed in a period) as HTML (view/print/portal) and
// PDF (email / accountant ZIP pack).
//
// VAT accounts get a VAT invoice (net, VAT, gross per line + VAT summary).
// Cash accounts get an ACCOUNT STATEMENT with no VAT — matching how counter
// cash sales are handled — so the two never mix in the books.

const PDFDocument = require('pdfkit');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => '£' + (Number(n) || 0).toFixed(2);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ukDate = d => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d);
  return isNaN(x) ? '' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
};

// Normalise a detail ({ invoice, account, orders }) into printable rows.
function model(detail) {
  const { invoice, account, orders } = detail;
  const isCash = invoice.account_type === 'cash';
  const rows = [];
  for (const { sale, items } of orders) {
    const gross = Number(sale.subtotal) + Number(sale.shipping);
    const f = gross > 0 ? (gross - Number(sale.vat)) / gross : 1;    // gross → net factor for this order
    for (const it of items) {
      rows.push({ order: sale.invoice_number, po: sale.order_number || '', date: sale.occurred_at,
        sku: it.sku, title: it.title, qty: it.qty, unit: r2(Number(it.unit_price) * f), net: r2(Number(it.line_total) * f) });
    }
    if (Number(sale.shipping) > 0) {
      rows.push({ order: sale.invoice_number, po: sale.order_number || '', date: sale.occurred_at,
        sku: '', title: 'Delivery', qty: 1, unit: r2(Number(sale.shipping) * f), net: r2(Number(sale.shipping) * f) });
    }
    if (sale.status === 'refunded' || Number(sale.refunded_amount) > 0) {
      rows.push({ order: sale.invoice_number, po: '', date: sale.occurred_at, sku: '', title: 'Refund / credit', qty: 1,
        unit: -r2(Number(sale.refunded_amount || 0) * f), net: -r2(Number(sale.refunded_amount || 0) * f) });
    }
  }
  const total = Number(invoice.total), vat = Number(invoice.vat), paid = Number(invoice.amount_paid);
  return { invoice, account, isCash, rows, net: r2(total - vat), vat: r2(vat), total: r2(total), paid: r2(paid), balance: r2(Math.max(0, total - paid)) };
}

function renderHtml(detail, { company = {}, brand = {} } = {}) {
  const m = model(detail);
  const { invoice: inv, account: a } = m;
  const title = m.isCash ? 'ACCOUNT STATEMENT' : 'INVOICE';
  const name = company.company_name || brand.fullName || brand.name || '';
  const bank = (company.bank_account_number && !m.isCash)
    ? `<div class="box"><b>Pay by bank transfer</b><br>${esc(company.bank_account_name || name)}<br>Sort code ${esc(company.bank_sort_code || '')} · Account ${esc(company.bank_account_number)}<br>Reference: <b>${esc(inv.number)}</b></div>` : '';
  const status = inv.status === 'paid' ? '<span class="tag paid">PAID</span>'
    : inv.status === 'void' ? '<span class="tag void">VOID</span>'
    : (new Date(inv.due_date) < new Date() ? '<span class="tag over">OVERDUE</span>' : '');
  let lastOrder = null;
  const body = m.rows.map(r => {
    const head = r.order !== lastOrder
      ? `<tr class="oh"><td colspan="5">Order <b>${esc(r.order)}</b> · ${esc(ukDate(r.date))}${r.po ? ' · your PO ' + esc(r.po) : ''}</td></tr>` : '';
    lastOrder = r.order;
    return head + `<tr><td class="mono">${esc(r.sku)}</td><td>${esc(r.title)}</td><td class="n">${r.qty}</td><td class="n">${money(r.unit)}</td><td class="n">${money(r.net)}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title === 'INVOICE' ? 'Invoice' : 'Statement')} - ${esc(a.name)} - ${esc(inv.number)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;background:#f4f5f7;margin:0;padding:20px}
.page{max-width:820px;margin:0 auto;background:#fff;padding:32px;border-radius:8px}
.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}
.logo{max-height:60px;max-width:220px}
h1{font-size:22px;margin:0;text-align:right}.ref{text-align:right;color:#555;font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:22px 0;font-size:13px;line-height:1.5}
.box{background:#f6f7f9;border:1px solid #e3e6eb;border-radius:6px;padding:10px 12px;font-size:13px;margin-top:14px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;border-bottom:2px solid #111;padding:6px 4px}
td{padding:5px 4px;border-bottom:1px solid #eee}.n{text-align:right;white-space:nowrap}.mono{font-family:ui-monospace,monospace;font-size:11px}
tr.oh td{background:#fafafa;font-size:12px;color:#333;padding-top:9px}
.tot{margin-left:auto;width:280px;margin-top:14px;font-size:13.5px}.tot div{display:flex;justify-content:space-between;padding:3px 0}
.tot .g{font-weight:700;border-top:2px solid #111;margin-top:4px;padding-top:6px;font-size:15px}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:700;font-size:12px;margin-left:6px}
.paid{background:#e3f5ea;color:#1a7f3e}.over{background:#fde8e8;color:#c8202d}.void{background:#eee;color:#666}
.foot{margin-top:24px;font-size:11px;color:#777;line-height:1.5}
@media print{body{background:#fff;padding:0}.page{border-radius:0;padding:10mm}}
@media(max-width:600px){.grid{grid-template-columns:1fr}.page{padding:16px}}
</style></head><body><div class="page">
<div class="top"><div><img class="logo" src="/public-logo" alt="${esc(brand.name || '')}" onerror="this.outerHTML='<b style=&quot;font-size:20px&quot;>${esc(brand.name || name)}</b>'"></div>
<div><h1>${title}${status}</h1><div class="ref">${esc(inv.number)}</div></div></div>
<div class="grid">
<div><b>From</b><br>${esc(name)}<br>${esc(company.company_address || '').replace(/\n/g, '<br>')}
${company.company_phone ? '<br>' + esc(company.company_phone) : ''}${company.company_email ? '<br>' + esc(company.company_email) : ''}
${!m.isCash && company.vat_registered && company.vat_number ? '<br>VAT ' + esc(company.vat_number) : ''}${company.company_reg_no ? '<br>Co. No. ' + esc(company.company_reg_no) : ''}</div>
<div><b>Bill to</b><br>${esc(a.name)}${a.contact_name ? '<br>' + esc(a.contact_name) : ''}<br>${esc(a.address || '').replace(/\n/g, '<br>')}
${a.vat_number && !m.isCash ? '<br>VAT ' + esc(a.vat_number) : ''}
<br><br><b>Issued</b> ${esc(ukDate(inv.issued_at))} · <b>Due</b> ${esc(ukDate(inv.due_date))}
<br><b>Period</b> ${esc(ukDate(inv.period_from))} – ${esc(ukDate(inv.period_to))} · ${inv.order_count} order${inv.order_count === 1 ? '' : 's'}</div>
</div>
<table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th class="n">Unit${m.isCash ? '' : ' (ex VAT)'}</th><th class="n">Net</th></tr></thead><tbody>${body}</tbody></table>
<div class="tot">
${m.isCash ? '' : `<div><span>Net</span><span>${money(m.net)}</span></div><div><span>VAT</span><span>${money(m.vat)}</span></div>`}
<div class="g"><span>Total</span><span>${money(m.total)}</span></div>
${m.paid > 0 ? `<div><span>Paid</span><span>−${money(m.paid)}</span></div>` : ''}
<div class="g"><span>Balance due</span><span>${money(m.balance)}</span></div>
</div>
${bank}
<div class="foot">${m.isCash ? 'Account statement for goods supplied on account. ' : 'This consolidated invoice covers every order listed above; individual order documents are delivery notes. '}Payment due by ${esc(ukDate(inv.due_date))}. Please quote ${esc(inv.number)} with your payment.</div>
</div></body></html>`;
}

function buildPdf(detail, { company = {}, brand = {} } = {}) {
  const m = model(detail);
  const { invoice: inv, account: a } = m;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const L = 40, R = doc.page.width - 40, W = R - L, bottom = doc.page.height - 50;
      const name = company.company_name || brand.fullName || brand.name || '';
      let y = 40;
      if (company.logo_data_url && /^data:image\/(png|jpe?g);base64,/.test(company.logo_data_url)) {
        try { doc.image(Buffer.from(company.logo_data_url.split(',')[1], 'base64'), L, y, { fit: [180, 50] }); } catch (_) { doc.font('Helvetica-Bold').fontSize(16).text(name, L, y); }
      } else doc.font('Helvetica-Bold').fontSize(16).text(name, L, y, { width: 260 });
      doc.font('Helvetica-Bold').fontSize(18).text(m.isCash ? 'ACCOUNT STATEMENT' : 'INVOICE', R - 260, y, { width: 260, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#555').text(inv.number + (inv.status === 'paid' ? '  ·  PAID' : ''), R - 260, y + 24, { width: 260, align: 'right' }).fillColor('#111');
      y += 70;
      const fromLines = [name, company.company_address || '', company.company_phone || '', company.company_email || '',
        (!m.isCash && company.vat_registered && company.vat_number) ? 'VAT ' + company.vat_number : '',
        company.company_reg_no ? 'Co. No. ' + company.company_reg_no : ''].filter(Boolean).join('\n');
      const toLines = [a.name, a.contact_name || '', a.address || '', (!m.isCash && a.vat_number) ? 'VAT ' + a.vat_number : ''].filter(Boolean).join('\n');
      doc.font('Helvetica-Bold').fontSize(9).text('FROM', L, y).text('BILL TO', L + W / 2, y);
      doc.font('Helvetica').fontSize(9).text(fromLines, L, y + 12, { width: W / 2 - 10 });
      doc.text(toLines, L + W / 2, y + 12, { width: W / 2 });
      y += 12 + Math.max(doc.heightOfString(fromLines, { width: W / 2 - 10 }), doc.heightOfString(toLines, { width: W / 2 })) + 8;
      doc.font('Helvetica').fontSize(9).text(`Issued ${ukDate(inv.issued_at)}   ·   Due ${ukDate(inv.due_date)}   ·   Period ${ukDate(inv.period_from)} – ${ukDate(inv.period_to)}   ·   ${inv.order_count} order(s)`, L, y);
      y += 20;
      const cols = [L, L + 90, R - 170, R - 110, R - 50];
      const head = () => {
        doc.font('Helvetica-Bold').fontSize(8.5);
        doc.text('SKU', cols[0], y); doc.text('ITEM', cols[1], y); doc.text('QTY', cols[2], y, { width: 40, align: 'right' });
        doc.text(m.isCash ? 'UNIT' : 'UNIT EX VAT', cols[3] - 20, y, { width: 70, align: 'right' }); doc.text('NET', cols[4], y, { width: 50, align: 'right' });
        y += 12; doc.moveTo(L, y).lineTo(R, y).lineWidth(1).stroke(); y += 4;
      };
      head();
      let last = null;
      for (const r of m.rows) {
        if (y > bottom - 30) { doc.addPage(); y = 40; head(); }
        if (r.order !== last) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333')
            .text(`Order ${r.order} · ${ukDate(r.date)}${r.po ? ' · PO ' + r.po : ''}`, L, y + 2).fillColor('#111');
          y += 14; last = r.order;
        }
        doc.font('Helvetica').fontSize(8.5);
        const h = Math.max(11, doc.heightOfString(r.title || '', { width: cols[2] - cols[1] - 6 }));
        doc.text(r.sku || '', cols[0], y, { width: 86 });
        doc.text(r.title || '', cols[1], y, { width: cols[2] - cols[1] - 6 });
        doc.text(String(r.qty), cols[2], y, { width: 40, align: 'right' });
        doc.text(money(r.unit), cols[3] - 20, y, { width: 70, align: 'right' });
        doc.text(money(r.net), cols[4], y, { width: 50, align: 'right' });
        y += h + 3;
      }
      if (y > bottom - 110) { doc.addPage(); y = 40; }
      y += 8; doc.moveTo(R - 220, y).lineTo(R, y).stroke(); y += 6;
      const line = (label, val, bold) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
        doc.text(label, R - 220, y, { width: 120 }); doc.text(val, R - 100, y, { width: 100, align: 'right' }); y += bold ? 16 : 13;
      };
      if (!m.isCash) { line('Net', money(m.net)); line('VAT', money(m.vat)); }
      line('Total', money(m.total), true);
      if (m.paid > 0) line('Paid', '-' + money(m.paid));
      line('Balance due', money(m.balance), true);
      y += 8;
      if (!m.isCash && company.bank_account_number) {
        doc.font('Helvetica').fontSize(9).text(`Pay by bank transfer: ${company.bank_account_name || name} · Sort code ${company.bank_sort_code || ''} · Account ${company.bank_account_number} · Reference ${inv.number}`, L, y, { width: W });
        y += 26;
      }
      doc.fontSize(8).fillColor('#777').text(m.isCash
        ? 'Account statement for goods supplied on account.'
        : 'This consolidated invoice covers every order listed above; individual order documents are delivery notes.', L, y, { width: W });
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { renderHtml, buildPdf };
