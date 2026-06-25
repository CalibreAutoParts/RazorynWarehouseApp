// lib/invoice-pdf.js — render the invoice/receipt/pro-forma as a PDF that mirrors
// the on-screen HTML invoice (logo, From / Billed-to, detail strip, line-items
// table, black TOTAL bar, bank box, footer policies). Built with pdfkit (pure JS,
// no headless browser — safe on Railway). Paginates cleanly: one page normally,
// flowing to a second when there are many lines, with the table header repeated.
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const money = (n) => '£' + (Number(n) || 0).toFixed(2);

function docTitle(mode) {
  return mode === 'estimate' ? 'ESTIMATE'
       : mode === 'proforma' ? 'PRO FORMA INVOICE'
       : mode === 'receipt'  ? 'RECEIPT'
       : 'INVOICE';
}
function channelLabel(sale) {
  const ch = sale.channel || '';
  if (ch === 'direct_cash') return 'Cash sale';
  if (ch === 'direct_bank') return 'Bank transfer';
  if (ch === 'direct_card') return 'Card';
  if (ch.startsWith('ebay')) return 'eBay';
  if (ch === 'shopify') return 'Shopify';
  return ch.replace(/_/g, ' ');
}
function paymentLabel(pm) {
  return pm === 'cash' ? 'Cash' : pm === 'bank' ? 'Bank transfer' : pm === 'card' ? 'Card' : (pm || '');
}

// Resolve a logo image source (Buffer) — prefer an uploaded logo, else the
// brand's bundled PNG. Returns null if none can be read.
function logoBuffer(company, brand) {
  try {
    const data = company.logo_data_url || '';
    const m = /^data:image\/[^;]+;base64,(.*)$/s.exec(data);
    if (m) return Buffer.from(m[1], 'base64');
  } catch (_) {}
  try {
    const rel = (brand.logoUrl || '/logo.png').replace(/^\//, '');
    const p = path.join(__dirname, '..', 'public', rel);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch (_) {}
  return null;
}

// Draw a 24x24-viewBox social icon (same artwork as the on-screen invoice),
// scaled to `size` px at (x, y). Filled icons fill; Instagram is an outline.
function drawSocialIcon(doc, kind, x, y, size, color) {
  const s = size / 24;
  doc.save();
  doc.translate(x, y).scale(s);
  if (kind === 'instagram') {
    doc.lineWidth(2).strokeColor(color);
    doc.roundedRect(2, 2, 20, 20, 5).stroke();
    doc.path('M16 11.4a4 4 0 1 1-7.9 1.2 4 4 0 0 1 7.9-1.2Z').stroke();
    doc.circle(17.6, 6.5, 1).fillColor(color).fill();
  } else if (kind === 'tiktok') {
    doc.fillColor(color).path('M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.71a8.16 8.16 0 0 0 4.77 1.52V6.79c-.55 0-1-.09-1.84-.1Z').fill();
  } else if (kind === 'facebook') {
    doc.fillColor(color).path('M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z').fill('even-odd');
  } else if (kind === 'linkedin') {
    doc.fillColor(color).path('M20.5 2h-17A1.5 1.5 0 0 0 2 3.5v17A1.5 1.5 0 0 0 3.5 22h17a1.5 1.5 0 0 0 1.5-1.5v-17A1.5 1.5 0 0 0 20.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 1 1 8.3 6.5a1.78 1.78 0 0 1-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0 0 13 14.19a.66.66 0 0 0 0 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 0 1 2.7-1.4c1.55 0 3.36.86 3.36 3.66z').fill('even-odd');
  }
  doc.restore();
}

/** @returns {Promise<Buffer>} */
function buildInvoicePdf({ sale, items = [], company = {}, brand, mode = 'invoice' }) {
  brand = brand || {};
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 40;
      const right = doc.page.width - 40;
      const contentW = right - left;
      const pageBottom = doc.page.height - 45;
      const ink = '#111';
      const muted = '#888';
      const isCash = sale.payment_method === 'cash';
      const vatReg = !!company.vat_registered;
      const showVat = vatReg && !isCash && mode !== 'estimate';
      const rate = parseFloat(company.vat_rate || 20) / 100;
      const net = (g) => showVat ? (Number(g) / (1 + rate)) : Number(g);
      const companyName = company.company_name || brand.fullName || brand.name || 'Invoice';
      const ref = sale.invoice_number || sale.payment_reference || ('#' + sale.id);

      // ---------- Header: logo (left) + document title + ref (right) ----------
      let y = 40;
      const logo = logoBuffer(company, brand);
      if (logo) {
        try { doc.image(logo, left, y, { fit: [150, 46] }); } catch (_) { doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(companyName, left, y + 6); }
      } else {
        doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(companyName, left, y + 6, { width: 280 });
      }
      doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(docTitle(mode), right - 240, y, { width: 240, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor(muted).text(ref, right - 240, y + 26, { width: 240, align: 'right' });
      y += 64;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e5e5').lineWidth(1).stroke();
      y += 16;

      // ---------- From / Billed to (two columns) ----------
      const colW = (contentW - 24) / 2;
      const colL = left, colR = left + colW + 24;
      const labelText = (x, yy, txt) => { doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(txt.toUpperCase(), x, yy, { width: colW, characterSpacing: 0.5 }); };
      const fromTop = y;
      labelText(colL, y, 'From');
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(companyName, colL, y + 12, { width: colW });
      let fy = y + 12 + 14;
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      const fromLines = [
        company.company_address,
        [company.company_phone, company.company_email].filter(Boolean).join('  ·  '),
        company.company_website || (brand.domain || ''),
        [company.company_reg_no ? `Co. No. ${company.company_reg_no}` : '', (vatReg && company.vat_number) ? `VAT ${company.vat_number}` : ''].filter(Boolean).join('   '),
      ].filter(Boolean).join('\n');
      doc.text(fromLines, colL, fy, { width: colW });
      const fromBottom = doc.y;

      // Billed-to
      const addrLines = (sale.shipping_address || '').split('\n').map((l) => l.trim())
        .filter((l) => l && !/^ebay[a-z0-9]{4,}$/i.test(l) && !/^(GB|UK|GBR|United Kingdom)$/i.test(l));
      const billedToName = (addrLines[0]) || sale.customer_name || 'Customer';
      labelText(colR, fromTop, mode === 'proforma' ? 'Billed to' : 'Billed / Delivered to');
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(billedToName, colR, fromTop + 12, { width: colW });
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      const toLines = [
        ...addrLines.slice(1),
        sale.customer_phone, sale.customer_email,
      ].filter(Boolean).join('\n') || 'No address on file';
      doc.text(toLines, colR, fromTop + 12 + 14, { width: colW });
      const toBottom = doc.y;

      y = Math.max(fromBottom, toBottom) + 18;

      // ---------- Detail strip (Date / Channel / Status-or-Order / Payment) ----------
      const stripH = 40;
      doc.rect(left, y, contentW, stripH).fillColor('#fafafa').fill();
      doc.rect(left, y, contentW, stripH).strokeColor('#eee').lineWidth(1).stroke();
      const cells = [
        ['Date', sale.occurred_at ? new Date(sale.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''],
        ['Channel', channelLabel(sale)],
        [sale.order_number ? 'Order No.' : (sale.vehicle_reg ? 'Vehicle Reg.' : 'Status'),
         sale.order_number || sale.vehicle_reg || (sale.status || 'paid')],
        ['Payment', paymentLabel(sale.payment_method)],
      ];
      const cellW = contentW / 4;
      cells.forEach(([l, v], i) => {
        const cx = left + i * cellW + 12;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#999').text(String(l).toUpperCase(), cx, y + 8, { width: cellW - 16 });
        doc.font('Helvetica').fontSize(10).fillColor(ink).text(String(v || ''), cx, y + 20, { width: cellW - 16 });
      });
      y += stripH + 18;

      // ---------- Items table ----------
      const cols = { desc: left + 8, qty: right - 220, unit: right - 150, total: right - 70 };
      const drawTableHeader = () => {
        doc.moveTo(left, y).lineTo(right, y).strokeColor(ink).lineWidth(1).stroke();
        y += 6;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(muted);
        doc.text('DESCRIPTION', cols.desc, y, { width: cols.qty - cols.desc - 8 });
        doc.text('QTY', cols.qty, y, { width: 50, align: 'right' });
        doc.text(showVat ? 'UNIT NET' : 'UNIT', cols.unit, y, { width: 70, align: 'right' });
        doc.text(showVat ? 'TOTAL NET' : 'TOTAL', cols.total, y, { width: right - cols.total, align: 'right' });
        y += 16;
        doc.moveTo(left, y).lineTo(right, y).strokeColor('#ddd').lineWidth(1).stroke();
        y += 8;
      };
      drawTableHeader();

      doc.font('Helvetica').fontSize(9.5);
      for (const it of items) {
        const descW = cols.qty - cols.desc - 8;
        const titleH = doc.heightOfString(it.title || '', { width: descW });
        const hasSku = it.sku && it.sku !== 'CUSTOM';
        const rowH = titleH + (hasSku ? 12 : 0) + 12;
        if (y + rowH > pageBottom) { doc.addPage(); y = 40; drawTableHeader(); doc.font('Helvetica').fontSize(9.5); }
        doc.fillColor('#222').text(it.title || '', cols.desc, y, { width: descW });
        if (hasSku) doc.fillColor('#999').fontSize(8).text(it.sku, cols.desc, y + titleH + 1, { width: descW });
        doc.fillColor('#222').fontSize(9.5);
        doc.text(String(it.qty), cols.qty, y, { width: 50, align: 'right' });
        doc.text(money(net(it.unit_price)), cols.unit, y, { width: 70, align: 'right' });
        doc.text(money(net(it.line_total)), cols.total, y, { width: right - cols.total, align: 'right' });
        y += rowH;
        doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#f0f0f0').lineWidth(1).stroke();
      }
      y += 10;

      // ---------- Keep totals + bank + footer together; new page if they won't fit ----------
      const subtotalGross = parseFloat(sale.subtotal || 0);
      const shippingGross = parseFloat(sale.shipping || 0);
      const vat = parseFloat(sale.vat || 0);
      const total = parseFloat(sale.total || 0);
      const isBank = sale.payment_method === 'bank' && company.bank_account_name;
      const totalsRows = (showVat ? (shippingGross > 0 ? 3 : 2) : (shippingGross > 0 ? 2 : 1));

      // Social handles + review CTA — same rules as the on-screen invoice.
      const handle = (h) => String(h || '').replace(/^@/, '');
      const socials = [];
      if (company.social_instagram) socials.push({ kind: 'instagram', text: `@${handle(company.social_instagram)}`, url: `https://instagram.com/${handle(company.social_instagram)}` });
      if (company.social_tiktok) socials.push({ kind: 'tiktok', text: `@${handle(company.social_tiktok)}`, url: `https://tiktok.com/@${handle(company.social_tiktok)}` });
      if (company.social_facebook) socials.push({ kind: 'facebook', text: 'Facebook', url: company.social_facebook });
      if (company.social_linkedin) socials.push({ kind: 'linkedin', text: 'LinkedIn', url: company.social_linkedin });
      const tp = company.trustpilot_url || '', gg = company.google_review_url || '', platform = company.review_platform || 'trustpilot';
      const reviews = [];
      if ((platform === 'trustpilot' || platform === 'both') && tp) reviews.push({ label: 'Trustpilot', url: tp });
      if ((platform === 'google' || platform === 'both') && gg) reviews.push({ label: 'Google', url: gg });
      if (!reviews.length && tp) reviews.push({ label: 'Trustpilot', url: tp });
      if (!reviews.length && gg) reviews.push({ label: 'Google', url: gg });

      const blockNeed = totalsRows * 16 + 34 + (isBank ? 80 : 20)
        + (socials.length ? 28 : 0) + (reviews.length ? 46 : 0) + 110;
      if (y + blockNeed > pageBottom) { doc.addPage(); y = 40; }

      // Totals (right aligned) + black TOTAL bar
      const tLabelX = right - 250, tValX = right - 120;
      const totalRow = (label, val) => {
        doc.font('Helvetica').fontSize(10).fillColor('#555');
        doc.text(label, tLabelX, y, { width: 120, align: 'right' });
        doc.text(val, tValX, y, { width: 120 - 6, align: 'right' });
        y += 16;
      };
      if (showVat) {
        totalRow('Subtotal (net)', money(subtotalGross / (1 + rate)));
        if (shippingGross > 0) totalRow('Delivery (net)', money(shippingGross / (1 + rate)));
        totalRow(`VAT (${(rate * 100).toFixed(0)}%)`, money(vat));
      } else {
        totalRow('Subtotal', money(subtotalGross));
        if (shippingGross > 0) totalRow('Shipping', money(shippingGross));
      }
      y += 4;
      const barX = right - 250, barW = 250, barH = 26;
      doc.rect(barX, y, barW, barH).fillColor(ink).fill();
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12);
      doc.text(mode === 'estimate' ? 'ESTIMATE TOTAL' : (showVat ? 'TOTAL (incl. VAT)' : 'TOTAL'), barX + 12, y + 7);
      doc.text(money(total), barX + barW - 110, y + 7, { width: 98, align: 'right' });
      y += barH + 18;

      // Bank details box (bank-transfer invoices)
      if (isBank) {
        const boxH = 70;
        doc.rect(left, y, contentW, boxH).fillColor('#fafafa').fill();
        doc.rect(left, y, 3, boxH).fillColor(ink).fill();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('BANK DETAILS', left + 14, y + 10);
        doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
          [`Account name: ${company.bank_account_name}`,
           company.bank_sort_code ? `Sort code: ${company.bank_sort_code}` : '',
           company.bank_account_number ? `Account no: ${company.bank_account_number}` : '',
           `Use reference: ${ref}`].filter(Boolean).join('\n'),
          left + 14, y + 24, { width: contentW - 28 });
        y += boxH + 16;
      }

      // ---------- Follow us ----------
      if (socials.length) {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#999').text('FOLLOW US', left, y);
        y += 12;
        const iconSize = 12, sCol = '#1a3c6e';
        let cx = left;
        socials.forEach((s) => {
          drawSocialIcon(doc, s.kind, cx, y, iconSize, sCol);
          const tx = cx + iconSize + 4;
          doc.font('Helvetica').fontSize(9).fillColor(sCol);
          const tw = doc.widthOfString(s.text);
          doc.text(s.text, tx, y + 2, { link: s.url, underline: false, width: tw + 2 });
          cx = tx + tw + 18;
        });
        y += 20;
      }

      // ---------- Review CTA (amber banner) ----------
      if (reviews.length) {
        const rh = 32;
        doc.rect(left, y, contentW, rh).fillColor('#fff8e6').fill();
        doc.rect(left, y, contentW, rh).strokeColor('#f0d171').lineWidth(1).stroke();
        // Right-aligned review link(s) first, so we know how much room the text has.
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#5a4400');
        let rrx = right - 12;
        for (const rv of reviews.slice().reverse()) {
          const label = `Review us on ${rv.label}`;
          const w = doc.widthOfString(label);
          rrx -= w;
          doc.text(label, rrx, y + 11, { link: rv.url, underline: false, width: w + 2 });
          rrx -= 16;
        }
        doc.font('Helvetica').fontSize(9.5).fillColor('#5a4400')
          .text('Enjoyed your order? A quick review really helps — thank you!', left + 12, y + 11, { width: rrx - left - 18, lineBreak: false, ellipsis: true });
        y += rh + 16;
      }

      // ---------- Footer: returns / fitment / contact ----------
      const isDirect = (sale.channel || '').startsWith('direct');
      const returnsPolicy = isDirect
        ? "Within 30 days of purchase, in original packaging. 5% restocking fee applies. Return shipping at buyer's cost unless faulty."
        : "Returns within 30 days, in original packaging. Open a return request through your account.";
      const fitmentPolicy = isDirect
        ? "All parts checked for fitment before despatch. Refunded if part doesn't fit as advertised. Confirm OEM number before ordering."
        : "Customer confirmed fitment before ordering by matching the part number, OEM reference and listing photos.";
      const contact = [company.company_email, company.company_phone, (company.company_website || brand.domain || '')].filter(Boolean).join('\n');
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#eee').lineWidth(1).stroke();
      y += 12;
      const fcolW = (contentW - 40) / 3;
      const footCol = (x, h, body) => {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ink).text(h.toUpperCase(), x, y, { width: fcolW });
        doc.font('Helvetica').fontSize(8).fillColor('#666').text(body, x, y + 12, { width: fcolW, lineBreak: true });
        return y + 12 + doc.heightOfString(body, { width: fcolW });
      };
      const b1 = footCol(left, 'Returns', returnsPolicy);
      const b2 = footCol(left + fcolW + 20, 'Fitment', fitmentPolicy);
      const b3 = footCol(left + 2 * (fcolW + 20), 'Contact', contact);
      y = Math.max(b1, b2, b3) + 12;

      // Thank-you / legal line — flows after the footer (never pinned below the
      // bottom margin, which would force an extra blank page).
      const legal = company.company_reg_no
        ? `${companyName}, Company Reg ${company.company_reg_no}${vatReg && company.vat_number ? `, VAT ${company.vat_number}` : ''}.`
        : '';
      doc.font('Helvetica').fontSize(8).fillColor('#999')
        .text(`Thank you for your business — ${brand.name || companyName}.${legal ? '  ' + legal : ''}`,
          left, y, { width: contentW, align: 'center', lineBreak: true });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildInvoicePdf };
