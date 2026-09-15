// routes/rundown.js — the BANK TRANSFER run-down: a period statement of every
// completed (paid) bank-transfer sale, with a per-order VAT / subtotal / total
// breakdown. Two audiences, two layouts:
//   • format=accountant — a formal A4 statement: company + VAT header, a VAT
//     summary (standard-rated vs zero-rated exports), a line-per-order table
//     with net / VAT / gross columns, and a CSV attached when emailed.
//   • format=company    — a light, shareable summary: the period total up
//     front, then simple order cards. Same numbers, friendlier shape.
// Preview and download render the same HTML (print-ready for "Save as PDF");
// email sends it inline with the CSV attached (accountant format).
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const brand = require('../lib/brand');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => '£' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
const dstr = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

async function loadBankRows(from, to) {
  const params = [];
  const where = [
    `s.is_estimate = false`, `s.is_paid = true`,
    `s.status NOT IN ('refunded','cancelled')`,
    `(s.payment_method = 'bank' OR s.channel = 'direct_bank')`,
  ];
  if (from) { params.push(from); where.push(`COALESCE(s.paid_at, s.occurred_at) >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`COALESCE(s.paid_at, s.occurred_at) <= $${params.length}::date + interval '1 day'`); }
  const { rows } = await query(`
    SELECT s.id, s.invoice_number, s.payment_reference, s.customer_name, s.occurred_at, s.paid_at,
           s.subtotal, s.vat, s.total, s.is_export, s.export_country, s.customer_vat_number,
           (SELECT STRING_AGG(si.title, ' · ' ORDER BY si.id) FROM sale_items si WHERE si.sale_id = s.id) AS items,
           (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS item_count
      FROM sales s
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(s.paid_at, s.occurred_at) ASC, s.id ASC`, params);
  return rows.map(r => ({
    ...r,
    ref: r.invoice_number || r.payment_reference || ('#' + r.id),
    date: r.paid_at || r.occurred_at,
    subtotal: parseFloat(r.subtotal || 0), vat: parseFloat(r.vat || 0), total: parseFloat(r.total || 0),
  }));
}

function totalsOf(rows) {
  const t = { net: 0, vat: 0, gross: 0, exportNet: 0, stdNet: 0, stdVat: 0, count: rows.length };
  for (const r of rows) {
    t.net += r.subtotal; t.vat += r.vat; t.gross += r.total;
    if (r.is_export) t.exportNet += r.subtotal; else { t.stdNet += r.subtotal; t.stdVat += r.vat; }
  }
  return t;
}

function periodLabel(from, to) {
  if (from && to) return `${dstr(from)} — ${dstr(to)}`;
  if (from) return `from ${dstr(from)}`;
  if (to) return `up to ${dstr(to)}`;
  return 'all time';
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
         color: #111827; background: #f3f4f6; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 820px; margin: 24px auto; background: #fff; padding: 40px 44px;
           box-shadow: 0 1px 8px rgba(0,0,0,.08); border-radius: 4px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { color: #6b7280; }
  .actions { text-align: center; padding: 14px; }
  .actions button { padding: 9px 22px; border: none; border-radius: 6px; background: #111827; color: #fff;
                    font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
  @page { size: A4; margin: 14mm; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; padding: 0; max-width: none; border-radius: 0; }
                 .actions { display: none; } }
`;

function renderAccountant({ rows, company, from, to }) {
  const t = totalsOf(rows);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bank transfer run-down — ${esc(periodLabel(from, to))}</title>
<style>${BASE_CSS}
  h1 { font-size: 19px; margin: 0; letter-spacing: .02em; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
          border-bottom: 3px solid #111827; padding-bottom: 16px; margin-bottom: 18px; }
  .co { font-size: 12px; line-height: 1.6; text-align: right; }
  .co .nm { font-size: 15px; font-weight: 700; }
  .meta { display: flex; gap: 36px; font-size: 12.5px; margin-bottom: 18px; }
  .meta b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; margin-bottom: 2px; }
  .vatbox { display: flex; gap: 0; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; margin-bottom: 20px; }
  .vatbox > div { flex: 1; padding: 10px 14px; font-size: 12.5px; border-right: 1px solid #e5e7eb; }
  .vatbox > div:last-child { border-right: none; background: #111827; color: #fff; }
  .vatbox b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; opacity: .75; margin-bottom: 3px; }
  .vatbox .v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280;
       border-bottom: 2px solid #111827; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 7px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  tr:nth-child(even) td { background: #fafbfc; }
  tfoot td { border-top: 2px solid #111827; border-bottom: none; font-weight: 700; font-size: 13px; padding-top: 10px; background: none; }
  .tag { display: inline-block; font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 8px;
         background: #eef2ff; color: #3730a3; }
  .foot { margin-top: 22px; font-size: 10.5px; color: #6b7280; display: flex; justify-content: space-between; }
</style></head><body>
<div class="actions"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
<div class="sheet">
  <div class="head">
    <div>
      <h1>BANK TRANSFER RUN-DOWN</h1>
      <div class="muted" style="font-size:12.5px;margin-top:4px">Completed bank-transfer sales · statement for accounting</div>
    </div>
    <div class="co">
      <div class="nm">${esc(company.company_name || brand.name || '')}</div>
      ${company.company_address ? esc(company.company_address).replace(/\n/g, '<br>') + '<br>' : ''}
      ${company.company_reg_no ? 'Co. No. ' + esc(company.company_reg_no) + '<br>' : ''}
      ${company.vat_number ? 'VAT No. ' + esc(company.vat_number) : ''}
    </div>
  </div>
  <div class="meta">
    <div><b>Period</b>${esc(periodLabel(from, to))}</div>
    <div><b>Transactions</b>${t.count}</div>
    <div><b>Generated</b>${dstr(new Date())}</div>
    <div><b>Payment method</b>Bank transfer (paid)</div>
  </div>
  <div class="vatbox">
    <div><b>Standard-rated net</b><span class="v">${money(t.stdNet)}</span></div>
    <div><b>VAT charged</b><span class="v">${money(t.stdVat)}</span></div>
    <div><b>Zero-rated exports</b><span class="v">${money(t.exportNet)}</span></div>
    <div><b>Gross received</b><span class="v">${money(t.gross)}</span></div>
  </div>
  <table>
    <thead><tr>
      <th style="width:26px">#</th><th style="width:78px">Date paid</th><th style="width:92px">Invoice</th>
      <th>Customer / goods</th><th class="num" style="width:80px">Net</th><th class="num" style="width:70px">VAT</th><th class="num" style="width:84px">Gross</th>
    </tr></thead>
    <tbody>
      ${rows.map((r, i) => `<tr>
        <td class="muted">${i + 1}</td>
        <td>${dstr(r.date)}</td>
        <td style="font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(r.ref)}</td>
        <td><strong>${esc(r.customer_name || 'Walk-in customer')}</strong>
          <div class="muted" style="font-size:11px">${esc((r.items || '').slice(0, 140))}${(r.items || '').length > 140 ? '…' : ''}</div>
          ${r.is_export ? `<span class="tag">EXPORT — zero-rated${r.export_country ? ' · ' + esc(r.export_country) : ''}</span>` : ''}
        </td>
        <td class="num">${money(r.subtotal)}</td>
        <td class="num">${money(r.vat)}</td>
        <td class="num"><strong>${money(r.total)}</strong></td>
      </tr>`).join('')}
      ${!rows.length ? '<tr><td colspan="7" style="text-align:center;padding:24px" class="muted">No completed bank-transfer sales in this period.</td></tr>' : ''}
    </tbody>
    <tfoot><tr>
      <td colspan="4">Period totals</td>
      <td class="num">${money(t.net)}</td>
      <td class="num">${money(t.vat)}</td>
      <td class="num">${money(t.gross)}</td>
    </tr></tfoot>
  </table>
  <div class="foot">
    <span>Zero-rated export sales are UK VAT-free under VAT Act 1994 s.30(6); proof of export retained.</span>
    <span>Generated from Warehouse Hub</span>
  </div>
</div>
</body></html>`;
}

function renderCompany({ rows, company, from, to }) {
  const t = totalsOf(rows);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bank transfers — ${esc(periodLabel(from, to))}</title>
<style>${BASE_CSS}
  .sheet { max-width: 640px; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .hero { text-align: center; background: #111827; color: #fff; border-radius: 10px; padding: 20px 16px; margin: 16px 0 20px; }
  .hero .amt { font-size: 32px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .hero .sub { font-size: 12px; opacity: .8; margin-top: 4px; }
  .row { display: flex; gap: 12px; align-items: baseline; padding: 11px 4px; border-bottom: 1px solid #eceef1; font-size: 13px; }
  .row .d { width: 64px; color: #6b7280; font-size: 11.5px; flex: none; }
  .row .m { flex: 1; min-width: 0; }
  .row .m .c { font-weight: 600; }
  .row .m .i { color: #6b7280; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .m .r { color: #9ca3af; font-size: 10.5px; font-family: ui-monospace, Menlo, monospace; }
  .row .t { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .row .t small { display: block; font-weight: 400; color: #9ca3af; font-size: 10px; text-align: right; }
  .foot { margin-top: 18px; font-size: 11px; color: #9ca3af; text-align: center; }
</style></head><body>
<div class="actions"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
<div class="sheet">
  <h1>Bank transfers received</h1>
  <div class="muted" style="font-size:12.5px">${esc(company.company_name || brand.name || '')} · ${esc(periodLabel(from, to))}</div>
  <div class="hero">
    <div class="amt">${money(t.gross)}</div>
    <div class="sub">${t.count} completed payment${t.count === 1 ? '' : 's'} · includes ${money(t.vat)} VAT</div>
  </div>
  ${rows.map(r => `<div class="row">
    <div class="d">${dstr(r.date)}</div>
    <div class="m">
      <div class="c">${esc(r.customer_name || 'Walk-in customer')}</div>
      <div class="i">${esc((r.items || '').slice(0, 90))}${(r.items || '').length > 90 ? '…' : ''}</div>
      <div class="r">${esc(r.ref)}${r.is_export ? ' · export (0% VAT)' : ''}</div>
    </div>
    <div class="t">${money(r.total)}<small>${money(r.subtotal)} + ${money(r.vat)} VAT</small></div>
  </div>`).join('')}
  ${!rows.length ? '<div style="text-align:center;padding:30px" class="muted">No completed bank transfers in this period.</div>' : ''}
  <div class="foot">Generated ${dstr(new Date())} · Warehouse Hub</div>
</div>
</body></html>`;
}

function buildCsv(rows) {
  const escCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = [['Date paid', 'Invoice', 'Customer', 'Items', 'Net (ex VAT)', 'VAT', 'Gross', 'VAT treatment'].join(',')];
  for (const r of rows) {
    out.push([
      new Date(r.date).toISOString().slice(0, 10), r.ref, r.customer_name || '',
      (r.items || '').slice(0, 300), r.subtotal.toFixed(2), r.vat.toFixed(2), r.total.toFixed(2),
      r.is_export ? `Zero-rated export${r.export_country ? ' (' + r.export_country + ')' : ''}` : 'Standard-rated',
    ].map(escCsv).join(','));
  }
  const t = totalsOf(rows);
  out.push(['', '', '', 'TOTALS', t.net.toFixed(2), t.vat.toFixed(2), t.gross.toFixed(2), ''].map(escCsv).join(','));
  return out.join('\r\n');
}

async function companyRow() {
  return (await query('SELECT * FROM app_settings WHERE id = 1')).rows[0] || {};
}

// GET /api/rundown/bank?from=&to=&format=accountant|company&download=1
router.get('/bank', async (req, res) => {
  try {
    const { from, to } = req.query;
    const format = req.query.format === 'company' ? 'company' : 'accountant';
    const rows = await loadBankRows(from, to);
    const company = await companyRow();
    const html = (format === 'company' ? renderCompany : renderAccountant)({ rows, company, from, to });
    await audit(req, 'rundown_view', null, null, { format, from, to, rows: rows.length });
    res.set('Content-Type', 'text/html');
    if (req.query.download === '1') {
      res.set('Content-Disposition', `attachment; filename="bank-rundown-${format}-${(from || 'start')}-${(to || 'now')}.html"`);
    }
    res.send(html);
  } catch (e) { res.status(500).json({ error: 'rundown_failed', message: e.message }); }
});

// GET /api/rundown/bank.csv?from=&to=
router.get('/bank.csv', async (req, res) => {
  try {
    const { from, to } = req.query;
    const rows = await loadBankRows(from, to);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="bank-rundown-${(from || 'start')}-${(to || 'now')}.csv"`);
    res.send(buildCsv(rows));
  } catch (e) { res.status(500).json({ error: 'csv_failed', message: e.message }); }
});

// POST /api/rundown/bank/email { from, to, format, recipients: [..] | "a, b", message? }
router.post('/bank/email', async (req, res) => {
  try {
    const email = require('../services/email');
    if (!email.isConfigured()) return res.status(400).json({ error: 'email_not_configured', message: 'Email (Resend) isn\'t configured on the server.' });
    const b = req.body || {};
    const recipients = (Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[,;\s]+/))
      .map(e => String(e).trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (!recipients.length) return res.status(400).json({ error: 'recipients_required', message: 'Enter at least one valid email address.' });
    const format = b.format === 'company' ? 'company' : 'accountant';
    const rows = await loadBankRows(b.from, b.to);
    const company = await companyRow();
    const html = (format === 'company' ? renderCompany : renderAccountant)({ rows, company, from: b.from, to: b.to });
    const message = String(b.message || '').trim();
    const body = (message ? `<p style="font-family:sans-serif;font-size:14px">${esc(message)}</p><hr style="border:none;border-top:1px solid #ddd;margin:16px 0">` : '') + html;
    // The accountant gets the CSV alongside — import-ready for their software.
    const attachments = format === 'accountant'
      ? [{ filename: `bank-rundown-${(b.from || 'start')}-${(b.to || 'now')}.csv`, content: Buffer.from(buildCsv(rows)).toString('base64') }]
      : [];
    const r = await email.sendEmail({
      to: recipients,
      subject: `Bank transfer run-down — ${periodLabel(b.from, b.to)} (${rows.length} payment${rows.length === 1 ? '' : 's'})`,
      html: body,
      attachments,
    });
    if (!r.ok) return res.status(502).json({ error: 'send_failed', message: r.error });
    await audit(req, 'rundown_email', null, null, { format, from: b.from, to: b.to, recipients: recipients.length, rows: rows.length });
    res.json({ ok: true, sent: recipients.length, rows: rows.length, attachedCsv: attachments.length > 0 });
  } catch (e) { res.status(500).json({ error: 'email_failed', message: e.message }); }
});

module.exports = router;
