// lib/invoice-pdf.js — render a clean, self-contained invoice/receipt/pro-forma
// PDF with pdfkit (pure JS, no headless browser — safe on Railway). Used to
// ATTACH the document to invoice emails. Mirrors the VAT model used everywhere
// else: line prices are gross (VAT-inclusive); VAT is the portion within
// (subtotal + shipping); total = subtotal + shipping.
const PDFDocument = require('pdfkit');

const money = (n) => '£' + (Number(n) || 0).toFixed(2);

function docTitle(mode) {
  return mode === 'estimate' ? 'ESTIMATE'
       : mode === 'proforma' ? 'PRO-FORMA INVOICE'
       : mode === 'receipt'  ? 'RECEIPT'
       : 'INVOICE';
}

/**
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf({ sale, items = [], company = {}, brand = {}, mode = 'invoice' }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const accent = brand.primaryColor || '#c8202d';
      const pageW = doc.page.width;
      const left = 50;
      const right = pageW - 50;
      const companyName = company.company_name || brand.fullName || brand.name || 'Invoice';

      // ---- Header: company (left) + document title (right) ----
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(18).text(companyName, left, 50);
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      const compLines = [
        company.company_address,
        company.company_phone, company.company_email,
        (company.company_website || (brand.domain ? brand.domain : '')),
        company.company_reg_no ? `Company reg: ${company.company_reg_no}` : '',
        (company.vat_registered && company.vat_number) ? `VAT no: ${company.vat_number}` : '',
      ].filter(Boolean);
      doc.text(compLines.join('\n'), left, 74, { width: 280 });

      doc.font('Helvetica-Bold').fontSize(22).fillColor(accent)
        .text(docTitle(mode), right - 220, 50, { width: 220, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      const ref = sale.invoice_number || sale.payment_reference || ('#' + sale.id);
      const dateStr = sale.occurred_at ? new Date(sale.occurred_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
      const metaLines = [
        `Reference: ${ref}`,
        dateStr ? `Date: ${dateStr}` : '',
        sale.order_number && sale.order_number !== ref ? `Order no: ${sale.order_number}` : '',
        sale.vehicle_reg ? `Vehicle reg: ${sale.vehicle_reg}` : '',
      ].filter(Boolean);
      doc.text(metaLines.join('\n'), right - 220, 80, { width: 220, align: 'right' });

      // ---- Bill to ----
      let y = 150;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('Bill to', left, y);
      doc.font('Helvetica').fontSize(10).fillColor('#333');
      const billLines = [
        sale.customer_name || 'Customer',
        ...(sale.shipping_address || '').split('\n').map((l) => l.trim())
          .filter((l) => l && !/^ebay[a-z0-9]{4,}$/i.test(l)),
        sale.customer_phone, sale.customer_email,
      ].filter(Boolean);
      doc.text(billLines.join('\n'), left, y + 15, { width: 280 });

      // ---- Items table ----
      y = 250;
      const isCash = sale.payment_method === 'cash';
      const vatRegistered = !!company.vat_registered;
      const showVat = vatRegistered && !isCash && mode !== 'estimate';
      const rate = parseFloat(company.vat_rate || 20) / 100;
      const net = (gross) => showVat ? (Number(gross) / (1 + rate)) : Number(gross);

      const cols = { desc: left, qty: 330, unit: 390, total: 470 };
      doc.rect(left, y, right - left, 20).fill(accent);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
      doc.text('Description', cols.desc + 6, y + 6);
      doc.text('Qty', cols.qty, y + 6, { width: 40, align: 'right' });
      doc.text(showVat ? 'Unit (net)' : 'Unit', cols.unit, y + 6, { width: 60, align: 'right' });
      doc.text(showVat ? 'Total (net)' : 'Total', cols.total, y + 6, { width: right - cols.total - 6, align: 'right' });
      y += 24;

      doc.font('Helvetica').fontSize(9).fillColor('#222');
      for (const it of items) {
        const titleH = doc.heightOfString(it.title || '', { width: cols.qty - cols.desc - 12 });
        const rowH = Math.max(18, titleH + 8);
        if (y + rowH > doc.page.height - 120) { doc.addPage(); y = 50; }
        doc.fillColor('#222').text(it.title || '', cols.desc + 6, y, { width: cols.qty - cols.desc - 12 });
        if (it.sku && it.sku !== 'CUSTOM') doc.fillColor('#888').fontSize(8).text(it.sku, cols.desc + 6, y + titleH, { width: cols.qty - cols.desc - 12 });
        doc.fillColor('#222').fontSize(9);
        doc.text(String(it.qty), cols.qty, y, { width: 40, align: 'right' });
        doc.text(money(net(it.unit_price)), cols.unit, y, { width: 60, align: 'right' });
        doc.text(money(net(it.line_total)), cols.total, y, { width: right - cols.total - 6, align: 'right' });
        y += rowH;
        doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#eee').lineWidth(1).stroke();
      }

      // ---- Totals ----
      y += 10;
      const subtotalGross = parseFloat(sale.subtotal || 0);
      const shippingGross = parseFloat(sale.shipping || 0);
      const vat = parseFloat(sale.vat || 0);
      const total = parseFloat(sale.total || 0);
      const labelX = right - 230, valX = right - 120;
      const totalRow = (label, val, bold) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? '#111' : '#444');
        doc.text(label, labelX, y, { width: 110, align: 'right' });
        doc.text(val, valX, y, { width: 110, align: 'right' });
        y += bold ? 20 : 16;
      };
      if (showVat) {
        totalRow('Subtotal (net)', money(subtotalGross / (1 + rate)));
        if (shippingGross > 0) totalRow('Delivery (net)', money(shippingGross / (1 + rate)));
        totalRow(`VAT (${(rate * 100).toFixed(0)}%)`, money(vat));
      } else {
        totalRow('Subtotal', money(subtotalGross));
        if (shippingGross > 0) totalRow('Shipping', money(shippingGross));
      }
      doc.moveTo(labelX, y).lineTo(right, y).strokeColor('#ccc').lineWidth(1).stroke();
      y += 6;
      totalRow(mode === 'estimate' ? 'Estimate total' : 'Total', money(total), true);

      // ---- Payment / bank details ----
      y += 10;
      const payLabel = isCash ? 'Cash' : sale.payment_method === 'bank' ? 'Bank transfer' : sale.payment_method === 'card' ? 'Card' : (sale.payment_method || '');
      if (payLabel) { doc.font('Helvetica').fontSize(9).fillColor('#555').text(`Payment method: ${payLabel}`, left, y); y += 14; }
      if (sale.payment_method === 'bank' && company.bank_account_name) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text('Bank details', left, y); y += 13;
        doc.font('Helvetica').fontSize(9).fillColor('#444').text(
          [`Account name: ${company.bank_account_name}`,
           company.bank_sort_code ? `Sort code: ${company.bank_sort_code}` : '',
           company.bank_account_number ? `Account no: ${company.bank_account_number}` : '',
           `Reference: ${ref}`].filter(Boolean).join('\n'), left, y);
        y += 52;
      }

      // ---- Footer ----
      const footY = doc.page.height - 70;
      doc.font('Helvetica').fontSize(9).fillColor('#777')
        .text(`Thank you for your business — ${brand.name || companyName}.`, left, footY, { width: right - left, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildInvoicePdf };
