// routes/books.js — the Books / VAT workspace (admin-only, desktop view).
//
// The whole VAT-return story in one place:
//   • Bank ACCOUNTS registry — each business can hold several accounts, same
//     or different banks (Monzo, Wise, Mettle, Barclays…).
//   • Upload a month's bank STATEMENT PDF → Claude reads it (detects the
//     bank, extracts every transaction, first-pass categorises) → the
//     reconciliation screen starts mostly done. Auto-matching then links
//     money-in lines to warehouse invoices (invoice number / payment
//     reference / amount+date) and tags eBay/Shopify payouts.
//   • Each TRANSACTION can be linked to a warehouse invoice, a marketplace
//     payout (payout id), or captured as expenditure with its VAT amount and
//     an uploaded VAT receipt — with a follow-up flag for businesses that
//     haven't provided one yet.
//   • EXPORTS for the accountant: full invoice pack (every paid/issued
//     invoice for the period as one print-ready document), transactions CSV,
//     and a tokened SHARE LINK — a read-only page the accountant opens with
//     the statements, every transaction, and the attached invoices/receipts,
//     downloadable individually or as a pack. Periods: month / VAT quarter /
//     year / custom.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();          // authed: mounted at /api/books
const publicRouter = express.Router();    // tokened: mounted at /api/books-shared

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const BOOKS_DIR = path.join(UPLOAD_DIR, 'books');
const RECEIPTS_DIR = path.join(BOOKS_DIR, 'receipts');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'receipt' ? RECEIPTS_DIR : BOOKS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname || '.pdf').toLowerCase()),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS bank_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      bank TEXT,
      business TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Accounts with statements behind them archive instead of deleting, so
    // the uploaded history keeps its account label.
    await query(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);
    await query(`CREATE TABLE IF NOT EXISTS bank_statements (
      id SERIAL PRIMARY KEY,
      account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
      label TEXT,
      file_path TEXT NOT NULL,
      bank_detected TEXT,
      account_detected TEXT,
      period_start DATE, period_end DATE,
      tx_count INTEGER NOT NULL DEFAULT 0,
      ai_confidence NUMERIC(4,3),
      ai_notes TEXT,
      uploaded_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS bank_transactions (
      id SERIAL PRIMARY KEY,
      statement_id INTEGER REFERENCES bank_statements(id) ON DELETE CASCADE,
      account_id INTEGER,
      tx_date DATE NOT NULL,
      description TEXT,
      counterparty TEXT,
      money_in NUMERIC(12,2) NOT NULL DEFAULT 0,
      money_out NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance NUMERIC(12,2),
      category TEXT,
      match_type TEXT,
      sale_id INTEGER,
      payout_ref TEXT,
      payout_platform TEXT,
      vat_amount NUMERIC(10,2),
      vat_likely BOOLEAN NOT NULL DEFAULT false,
      needs_vat_receipt BOOLEAN NOT NULL DEFAULT false,
      receipt_path TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS bank_tx_date_idx ON bank_transactions (tx_date)`);
    await query(`CREATE INDEX IF NOT EXISTS bank_tx_stmt_idx ON bank_transactions (statement_id)`);
    await query(`CREATE TABLE IF NOT EXISTS books_shares (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      account_id INTEGER,
      label TEXT,
      created_by INTEGER,
      revoked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    _ready = true;
  } catch (e) { console.warn('[books] migration:', e.message); }
}

const gbp = (n) => '£' + (parseFloat(n) || 0).toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Accounts ───────────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  await ensureTables();
  const { rows } = await query(`SELECT a.*, (SELECT COUNT(*)::int FROM bank_statements s WHERE s.account_id = a.id) AS statements FROM bank_accounts a ORDER BY a.business NULLS LAST, a.name`);
  res.json({ accounts: rows });
});
router.post('/accounts', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name_required' });
  const { rows } = await query(`INSERT INTO bank_accounts (name, bank, business) VALUES ($1,$2,$3) RETURNING *`,
    [String(b.name).slice(0, 120), b.bank ? String(b.bank).slice(0, 60) : null, b.business ? String(b.business).slice(0, 120) : null]);
  await audit(req, 'books_account_add', 'bank_account', rows[0].id, { name: b.name });
  res.status(201).json({ account: rows[0] });
});
router.delete('/accounts/:id', async (req, res) => {
  await ensureTables();
  // An account with statements uploaded keeps its history — archive it
  // (hidden from pickers, restorable). Only empty accounts hard-delete.
  const st = await query(`SELECT COUNT(*)::int AS n FROM bank_statements WHERE account_id = $1`, [req.params.id]);
  if (st.rows[0].n > 0) {
    await query(`UPDATE bank_accounts SET archived = true WHERE id = $1`, [req.params.id]);
    await audit(req, 'books_account_archive', 'bank_account', req.params.id, { statements: st.rows[0].n });
    return res.json({ ok: true, mode: 'archived', statements: st.rows[0].n });
  }
  await query(`DELETE FROM bank_accounts WHERE id = $1`, [req.params.id]);
  await audit(req, 'books_account_delete', 'bank_account', req.params.id);
  res.json({ ok: true, mode: 'deleted' });
});
// PATCH /accounts/:id — rename, change bank, or restore an archived account.
router.patch('/accounts/:id', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  const sets = [], params = [];
  if (b.name !== undefined) { params.push(String(b.name).slice(0, 120)); sets.push(`name = $${params.length}`); }
  if (b.bank !== undefined) { params.push(b.bank ? String(b.bank).slice(0, 60) : null); sets.push(`bank = $${params.length}`); }
  if (b.archived !== undefined) { params.push(!!b.archived); sets.push(`archived = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  params.push(req.params.id);
  const r = await query(`UPDATE bank_accounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'books_account_update', 'bank_account', req.params.id, b);
  res.json({ account: r.rows[0] });
});

// ── Statement upload + AI parse + auto-match ──────────────────────────────
// Money-in lines are matched to warehouse invoices by invoice number /
// payment reference in the description, else by exact amount within ±4 days
// of an unmatched paid bank sale (only when the candidate is unique).
async function autoMatchTransaction(t) {
  if (t.money_in > 0) {
    if (t.payout_platform || /payout|managed payments|\bebay\b|shopify|shopi\b/i.test(t.description || '')) {
      return { match_type: 'payout', payout_platform: t.payout_platform || (/shopi/i.test(t.description) ? 'shopify' : (/ebay|managed/i.test(t.description) ? 'ebay' : null)), category: 'payout' };
    }
    const descNorm = String(t.description || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cands = await query(`
      SELECT id, invoice_number, payment_reference, total FROM sales
       WHERE is_estimate = false AND (payment_method = 'bank' OR channel = 'direct_bank')
         AND ABS(total - $1) < 0.01
         AND COALESCE(paid_at, occurred_at) BETWEEN $2::date - interval '6 days' AND $2::date + interval '6 days'`,
      [t.money_in, t.date]);
    // Reference match beats amount match; a unique amount match is accepted.
    const byRef = cands.rows.find(s =>
      (s.invoice_number && descNorm.includes(String(s.invoice_number).toUpperCase().replace(/[^A-Z0-9]/g, '')))
      || (s.payment_reference && descNorm.includes(String(s.payment_reference).toUpperCase().replace(/[^A-Z0-9]/g, ''))));
    if (byRef) return { match_type: 'sale', sale_id: byRef.id, category: 'sale_receipt' };
    if (cands.rows.length === 1) return { match_type: 'sale', sale_id: cands.rows[0].id, category: 'sale_receipt' };
    return { match_type: null, category: t.type || 'other' };
  }
  // Money out: trust the AI's first-pass category; flag likely-VAT lines for a receipt.
  return {
    match_type: t.type === 'transfer' ? 'transfer' : 'expense',
    category: t.type || 'other',
    needs_vat_receipt: !!t.vatLikely,
  };
}

router.post('/statements', upload.single('statement'), async (req, res) => {
  await ensureTables();
  if (!req.file) return res.status(400).json({ error: 'statement_pdf_required' });
  const ai = require('../services/ai');
  if (!ai.isConfigured()) return res.status(400).json({ error: 'ai_not_configured', message: 'Set ANTHROPIC_API_KEY first — the statement reader runs on Claude.' });
  const accountId = req.body.accountId ? parseInt(req.body.accountId) : null;
  let parsed;
  try {
    const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');
    parsed = await ai.parseBankStatement(pdfBase64, { hint: req.body.hint || null });
  } catch (e) {
    return res.status(502).json({ error: e.code || 'parse_failed', message: e.message });
  }
  if (!parsed || !parsed.transactions.length) {
    return res.status(422).json({ error: 'no_transactions', message: 'Claude couldn’t read any transactions from that PDF' + (parsed && parsed.notes ? ' — ' + parsed.notes : '') + '. Is it a text PDF (not a photo scan)?' });
  }
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  const st = await query(
    `INSERT INTO bank_statements (account_id, label, file_path, bank_detected, account_detected, period_start, period_end, tx_count, ai_confidence, ai_notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [accountId, req.body.label || null, relPath, parsed.bank, parsed.accountName,
     parsed.periodStart, parsed.periodEnd, parsed.transactions.length, parsed.confidence, parsed.notes, req.user.id]);
  let autoLinked = 0, payouts = 0, receiptsNeeded = 0;
  for (const t of parsed.transactions) {
    let m = { match_type: null, category: t.type || 'other' };
    try { m = await autoMatchTransaction(t); } catch (_) {}
    if (m.match_type === 'sale') autoLinked++;
    if (m.match_type === 'payout') payouts++;
    if (m.needs_vat_receipt) receiptsNeeded++;
    await query(
      `INSERT INTO bank_transactions (statement_id, account_id, tx_date, description, counterparty, money_in, money_out, balance,
                                      category, match_type, sale_id, payout_platform, vat_likely, needs_vat_receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [st.rows[0].id, accountId, t.date, t.description, t.counterparty, t.moneyIn, t.moneyOut, t.balance,
       m.category || null, m.match_type || null, m.sale_id || null, m.payout_platform || t.payoutPlatform || null,
       !!t.vatLikely, !!m.needs_vat_receipt]);
  }
  await audit(req, 'books_statement_upload', 'bank_statement', st.rows[0].id, { bank: parsed.bank, tx: parsed.transactions.length, autoLinked, payouts });
  res.status(201).json({
    ok: true, statement: st.rows[0],
    parsed: { bank: parsed.bank, accountName: parsed.accountName, period: [parsed.periodStart, parsed.periodEnd], confidence: parsed.confidence, notes: parsed.notes },
    summary: { transactions: parsed.transactions.length, autoLinkedInvoices: autoLinked, payouts, receiptsNeeded },
  });
});

router.get('/statements', async (req, res) => {
  await ensureTables();
  const params = []; let where = '1=1';
  if (req.query.accountId) { params.push(parseInt(req.query.accountId)); where = `s.account_id = $${params.length}`; }
  const { rows } = await query(`
    SELECT s.*, a.name AS account_name, a.bank AS account_bank, a.business
      FROM bank_statements s LEFT JOIN bank_accounts a ON a.id = s.account_id
     WHERE ${where} ORDER BY s.period_start DESC NULLS LAST, s.created_at DESC LIMIT 200`, params);
  res.json({ statements: rows });
});
router.delete('/statements/:id', async (req, res) => {
  await ensureTables();
  const r = await query(`DELETE FROM bank_statements WHERE id = $1 RETURNING file_path`, [req.params.id]);
  if (r.rows[0]?.file_path) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.rows[0].file_path)); } catch (_) {} }
  await audit(req, 'books_statement_delete', 'bank_statement', req.params.id);
  res.json({ ok: true });
});
router.get('/statements/:id/file', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT file_path FROM bank_statements WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
});

// ── Transactions ───────────────────────────────────────────────────────────
async function loadTransactions({ from, to, accountId }) {
  const params = [from, to];
  let where = `t.tx_date BETWEEN $1 AND $2`;
  if (accountId) { params.push(parseInt(accountId)); where += ` AND t.account_id = $${params.length}`; }
  const { rows } = await query(`
    SELECT t.*, s.bank_detected, s.label AS statement_label, a.name AS account_name, a.bank AS account_bank, a.business,
           sl.invoice_number, sl.total AS sale_total, sl.customer_name
      FROM bank_transactions t
      LEFT JOIN bank_statements s ON s.id = t.statement_id
      LEFT JOIN bank_accounts a ON a.id = t.account_id
      LEFT JOIN sales sl ON sl.id = t.sale_id
     WHERE ${where}
     ORDER BY t.tx_date, t.id`, params);
  return rows;
}
router.get('/transactions', async (req, res) => {
  await ensureTables();
  const from = req.query.from, to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from_to_required' });
  res.json({ transactions: await loadTransactions({ from, to, accountId: req.query.accountId }) });
});
router.patch('/transactions/:id', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  const sets = [], params = [];
  const map = {
    category: b.category, match_type: b.matchType, sale_id: b.saleId === '' ? null : b.saleId,
    payout_ref: b.payoutRef, payout_platform: b.payoutPlatform,
    vat_amount: b.vatAmount === '' ? null : b.vatAmount,
    needs_vat_receipt: b.needsVatReceipt, counterparty: b.counterparty, notes: b.notes,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  params.push(req.params.id);
  const r = await query(`UPDATE bank_transactions SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'books_tx_update', 'bank_transaction', req.params.id, b);
  res.json({ transaction: r.rows[0] });
});
router.post('/transactions/:id/receipt', upload.single('receipt'), async (req, res) => {
  await ensureTables();
  if (!req.file) return res.status(400).json({ error: 'receipt_required' });
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  const r = await query(`UPDATE bank_transactions SET receipt_path = $1, needs_vat_receipt = false, updated_at = now() WHERE id = $2 RETURNING *`, [relPath, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'books_receipt_upload', 'bank_transaction', req.params.id);
  res.status(201).json({ transaction: r.rows[0] });
});
router.get('/transactions/:id/receipt', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT receipt_path FROM bank_transactions WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]?.receipt_path) return res.status(404).json({ error: 'no_receipt' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].receipt_path));
});

// ── Summary ───────────────────────────────────────────────────────────────
async function periodSummary({ from, to, accountId }) {
  const rows = await loadTransactions({ from, to, accountId });
  const sum = { moneyIn: 0, moneyOut: 0, vatCaptured: 0, byCategory: {}, unmatched: 0, receiptsMissing: 0, count: rows.length };
  for (const t of rows) {
    sum.moneyIn += parseFloat(t.money_in) || 0;
    sum.moneyOut += parseFloat(t.money_out) || 0;
    if (t.vat_amount) sum.vatCaptured += parseFloat(t.vat_amount) || 0;
    const cat = t.category || 'uncategorised';
    sum.byCategory[cat] = (sum.byCategory[cat] || { in: 0, out: 0, vat: 0, n: 0 });
    sum.byCategory[cat].in += parseFloat(t.money_in) || 0;
    sum.byCategory[cat].out += parseFloat(t.money_out) || 0;
    sum.byCategory[cat].vat += parseFloat(t.vat_amount) || 0;
    sum.byCategory[cat].n++;
    if (!t.match_type) sum.unmatched++;
    if (t.needs_vat_receipt && !t.receipt_path) sum.receiptsMissing++;
  }
  sum.moneyIn = +sum.moneyIn.toFixed(2); sum.moneyOut = +sum.moneyOut.toFixed(2); sum.vatCaptured = +sum.vatCaptured.toFixed(2);
  return sum;
}
router.get('/summary', async (req, res) => {
  await ensureTables();
  if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'from_to_required' });
  res.json(await periodSummary({ from: req.query.from, to: req.query.to, accountId: req.query.accountId }));
});

// ── Exports ────────────────────────────────────────────────────────────────
async function loadInvoiceSales({ from, to, basis }) {
  // basis 'paid' = money received in the period (VAT cash accounting);
  // 'issued' = invoice dated in the period (accrual).
  const dateCol = basis === 'issued' ? 's.occurred_at' : `COALESCE(s.paid_at, s.occurred_at)`;
  const paidClause = basis === 'issued' ? '' : 'AND s.is_paid = true';
  const { rows } = await query(`
    SELECT s.* FROM sales s
     WHERE s.is_estimate = false ${paidClause}
       AND ${dateCol} >= $1::date AND ${dateCol} < ($2::date + interval '1 day')
     ORDER BY ${dateCol}`, [from, to]);
  return rows;
}

// One print-ready document holding the FULL invoice for every order in the
// period — page break per invoice, "Save as PDF" gives the accountant pack.
async function buildInvoicePackHtml({ from, to, basis }) {
  const salesMod = require('./sales');
  const company = await salesMod.getCompanySettings();
  const brand = require('../lib/brand');
  const sales = await loadInvoiceSales({ from, to, basis });
  const pages = [];
  for (const sale of sales) {
    try {
      await salesMod.enrichSaleCustomer(sale);
      const items = (await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [sale.id])).rows;
      const mode = sale.payment_method === 'cash' ? 'receipt' : 'invoice';
      const html = salesMod.renderInvoiceHtml({ sale, items, company, mode, baseUrl: '' });
      // Lift each invoice's page out of its standalone document (its <style>
      // is identical every time, so one copy in the pack head is enough).
      const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || '';
      const styles = pages.length === 0 ? (html.match(/<style>([\s\S]*?)<\/style>/i) || [])[1] || '' : null;
      pages.push({ body: body.replace(/<div class="actions no-print">[\s\S]*?<\/div>/, ''), styles });
    } catch (e) { console.warn('[books] pack invoice', sale.id, e.message); }
  }
  const styles = pages.find(p => p.styles)?.styles || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Invoices ${esc(basis)} ${esc(from)} to ${esc(to)} - ${esc(brand.name || '')}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles}
  .pack-head{max-width:680px;margin:24px auto;font-family:'Inter',Arial,sans-serif}
  .pack-page{page-break-after:always}
  .pack-page:last-child{page-break-after:auto}
</style></head><body>
<div class="pack-head no-print" style="text-align:center">
  <h2 style="font-family:Inter,Arial">${pages.length} invoice${pages.length === 1 ? '' : 's'} — ${esc(basis === 'issued' ? 'issued' : 'paid')} ${esc(from)} → ${esc(to)}</h2>
  <p style="color:#777;font-size:13px">Print → Save as PDF for one pack with every invoice on its own page.</p>
  <button onclick="window.print()" style="padding:9px 20px;background:#111;color:#fff;border:none;border-radius:4px;cursor:pointer">Print / Save as PDF</button>
</div>
${pages.map(p => `<div class="pack-page">${p.body}</div>`).join('\n')}
</body></html>`;
}

router.get('/export/invoice-pack', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from_to_required' });
  const basis = req.query.basis === 'issued' ? 'issued' : 'paid';
  await audit(req, 'books_invoice_pack', null, null, { from, to, basis });
  res.set('Content-Type', 'text/html').send(await buildInvoicePackHtml({ from, to, basis }));
});

function buildCsv(rows) {
  const cols = ['date', 'account', 'bank', 'business', 'description', 'counterparty', 'money_in', 'money_out', 'category', 'match', 'invoice_no', 'payout_ref', 'vat_amount', 'receipt', 'notes'];
  const cell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [cols.join(',')];
  for (const t of rows) {
    lines.push([
      String(t.tx_date).slice(0, 10), t.account_name || '', t.account_bank || t.bank_detected || '', t.business || '',
      t.description || '', t.counterparty || '',
      t.money_in > 0 ? (+t.money_in).toFixed(2) : '', t.money_out > 0 ? (+t.money_out).toFixed(2) : '',
      t.category || '', t.match_type || '',
      t.invoice_number || '', t.payout_ref || (t.payout_platform || ''),
      t.vat_amount != null ? (+t.vat_amount).toFixed(2) : '',
      t.receipt_path ? 'yes' : (t.needs_vat_receipt ? 'MISSING' : ''),
      t.notes || '',
    ].map(cell).join(','));
  }
  return lines.join('\n');
}
router.get('/export/csv', async (req, res) => {
  await ensureTables();
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from_to_required' });
  const rows = await loadTransactions({ from, to, accountId: req.query.accountId });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="transactions-${from}-to-${to}.csv"`);
  res.send(buildCsv(rows));
});

// ── Accountant share links ─────────────────────────────────────────────────
router.post('/share', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  if (!b.from || !b.to) return res.status(400).json({ error: 'from_to_required' });
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await query(
    `INSERT INTO books_shares (token, from_date, to_date, account_id, label, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [token, b.from, b.to, b.accountId || null, b.label || null, req.user.id]);
  await audit(req, 'books_share_create', 'books_share', rows[0].id, { from: b.from, to: b.to });
  res.status(201).json({ share: rows[0], url: `/api/books-shared/${token}` });
});
router.get('/shares', async (req, res) => {
  await ensureTables();
  const { rows } = await query(`SELECT * FROM books_shares WHERE revoked = false ORDER BY created_at DESC LIMIT 50`);
  res.json({ shares: rows });
});
router.delete('/shares/:id', async (req, res) => {
  await ensureTables();
  await query(`UPDATE books_shares SET revoked = true WHERE id = $1`, [req.params.id]);
  await audit(req, 'books_share_revoke', 'books_share', req.params.id);
  res.json({ ok: true });
});

// ── The accountant's read-only view (token in the URL, no login) ──────────
async function shareFor(token) {
  await ensureTables();
  const { rows } = await query(`SELECT * FROM books_shares WHERE token = $1 AND revoked = false`, [String(token)]);
  return rows[0] || null;
}
publicRouter.get('/:token', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('This link has been revoked or does not exist.');
  const brand = require('../lib/brand');
  const from = String(share.from_date).slice(0, 10), to = String(share.to_date).slice(0, 10);
  const txs = await loadTransactions({ from, to, accountId: share.account_id });
  const sum = await periodSummary({ from, to, accountId: share.account_id });
  const stmtIds = [...new Set(txs.map(t => t.statement_id).filter(Boolean))];
  const stmts = stmtIds.length
    ? (await query(`SELECT s.*, a.name AS account_name, a.bank AS account_bank, a.business FROM bank_statements s LEFT JOIN bank_accounts a ON a.id = s.account_id WHERE s.id = ANY($1)`, [stmtIds])).rows
    : [];
  const base = `/api/books-shared/${share.token}`;
  const catRows = Object.entries(sum.byCategory).sort((a, b2) => (b2[1].out + b2[1].in) - (a[1].out + a[1].in));
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(brand.name || 'Accounts')} — ${esc(from)} to ${esc(to)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box} body{font-family:Inter,Arial,sans-serif;margin:0;background:#f5f5f6;color:#111;font-size:14px}
  .wrap{max-width:1150px;margin:0 auto;padding:24px 16px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:#777;font-size:13px;margin-bottom:18px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:18px}
  .card{background:#fff;border:1px solid #e3e3e6;border-radius:8px;padding:12px 14px}
  .card .l{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#888} .card .v{font-size:19px;font-weight:700;margin-top:3px}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
  .btn{display:inline-block;padding:8px 14px;background:#111;color:#fff;border-radius:5px;text-decoration:none;font-size:12.5px;font-weight:500}
  .btn.ghost{background:#fff;color:#111;border:1px solid #ccc}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e3e6;border-radius:8px;overflow:hidden;font-size:12.5px}
  th{background:#fafafa;text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#888;border-bottom:1px solid #e3e3e6}
  td{padding:8px 10px;border-bottom:1px solid #f0f0f1;vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pill{display:inline-block;padding:1px 8px;border-radius:9px;font-size:10.5px;background:#eee}
  .pill.g{background:#e2f3e6;color:#176b2c}.pill.r{background:#fde6e8;color:#a1232e}.pill.b{background:#e5edfb;color:#1d4fa1}
  a{color:#1d4fa1} h2{font-size:15px;margin:22px 0 8px}
</style></head><body><div class="wrap">
  <h1>${esc(brand.name || 'Accounts')} — transactions &amp; VAT records</h1>
  <div class="sub">Period ${esc(from)} → ${esc(to)}${share.label ? ' · ' + esc(share.label) : ''} · prepared ${new Date().toLocaleDateString('en-GB')} · read-only link</div>
  <div class="cards">
    <div class="card"><div class="l">Money in</div><div class="v">${gbp(sum.moneyIn)}</div></div>
    <div class="card"><div class="l">Money out</div><div class="v">${gbp(sum.moneyOut)}</div></div>
    <div class="card"><div class="l">VAT captured on costs</div><div class="v">${gbp(sum.vatCaptured)}</div></div>
    <div class="card"><div class="l">Transactions</div><div class="v">${sum.count}</div></div>
    <div class="card"><div class="l">VAT receipts missing</div><div class="v">${sum.receiptsMissing}</div></div>
  </div>
  <div class="bar">
    <a class="btn" href="${base}/pack?basis=paid" target="_blank">📄 Invoice pack — all PAID in period</a>
    <a class="btn" href="${base}/pack?basis=issued" target="_blank">📄 Invoice pack — all ISSUED in period</a>
    <a class="btn ghost" href="${base}/csv">⬇ Transactions CSV</a>
    ${stmts.map(s => `<a class="btn ghost" href="${base}/statement/${s.id}" target="_blank">🏦 ${esc(s.account_bank || s.bank_detected || 'Statement')}${s.period_start ? ' ' + String(s.period_start).slice(0, 10) : ''} (PDF)</a>`).join('')}
  </div>
  <h2>Spend by category</h2>
  <table><thead><tr><th>Category</th><th class="num">In</th><th class="num">Out</th><th class="num">VAT captured</th><th class="num">Lines</th></tr></thead><tbody>
  ${catRows.map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${v.in ? gbp(v.in) : ''}</td><td class="num">${v.out ? gbp(v.out) : ''}</td><td class="num">${v.vat ? gbp(v.vat) : ''}</td><td class="num">${v.n}</td></tr>`).join('')}
  </tbody></table>
  <h2>Every transaction</h2>
  <table><thead><tr><th>Date</th><th>Account</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th>Category</th><th>Linked to</th><th class="num">VAT</th><th>Receipt</th></tr></thead><tbody>
  ${txs.map(t => `<tr>
    <td>${esc(String(t.tx_date).slice(0, 10))}</td>
    <td>${esc(t.account_name || t.bank_detected || '')}</td>
    <td>${esc(t.description || '')}${t.notes ? `<div style="color:#888;font-size:11px">${esc(t.notes)}</div>` : ''}</td>
    <td class="num">${t.money_in > 0 ? gbp(t.money_in) : ''}</td>
    <td class="num">${t.money_out > 0 ? gbp(t.money_out) : ''}</td>
    <td><span class="pill">${esc(t.category || '—')}</span></td>
    <td>${t.sale_id ? `<a href="${base}/invoice/${t.sale_id}" target="_blank">Invoice ${esc(t.invoice_number || ('#' + t.sale_id))}</a>` : (t.payout_ref || t.payout_platform ? `<span class="pill b">${esc((t.payout_platform || 'payout').toUpperCase())}${t.payout_ref ? ' ' + esc(t.payout_ref) : ''}</span>` : '<span style="color:#aaa">—</span>')}</td>
    <td class="num">${t.vat_amount != null ? gbp(t.vat_amount) : ''}</td>
    <td>${t.receipt_path ? `<a href="${base}/receipt/${t.id}" target="_blank">view</a>` : (t.needs_vat_receipt ? '<span class="pill r">missing</span>' : '')}</td>
  </tr>`).join('')}
  </tbody></table>
  <div style="color:#999;font-size:11px;margin:16px 0">Generated by the ${esc(brand.name || '')} warehouse system. Figures are working records, not filed returns.</div>
</div></body></html>`);
});
publicRouter.get('/:token/csv', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  const rows = await loadTransactions({ from: String(share.from_date).slice(0, 10), to: String(share.to_date).slice(0, 10), accountId: share.account_id });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="transactions.csv"`);
  res.send(buildCsv(rows));
});
publicRouter.get('/:token/pack', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  res.set('Content-Type', 'text/html').send(await buildInvoicePackHtml({
    from: String(share.from_date).slice(0, 10), to: String(share.to_date).slice(0, 10),
    basis: req.query.basis === 'issued' ? 'issued' : 'paid',
  }));
});
publicRouter.get('/:token/invoice/:saleId', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  const salesMod = require('./sales');
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).send('Not found');
  const sale = s.rows[0];
  await salesMod.enrichSaleCustomer(sale);
  const items = (await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [req.params.saleId])).rows;
  const company = await salesMod.getCompanySettings();
  const mode = sale.payment_method === 'cash' ? 'receipt' : 'invoice';
  res.set('Content-Type', 'text/html').send(salesMod.renderInvoiceHtml({ sale, items, company, mode, baseUrl: '' }));
});
publicRouter.get('/:token/receipt/:txId', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  const r = await query(`SELECT receipt_path FROM bank_transactions WHERE id = $1`, [req.params.txId]);
  if (!r.rows[0]?.receipt_path) return res.status(404).send('No receipt');
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].receipt_path));
});
publicRouter.get('/:token/statement/:id', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  const r = await query(`SELECT file_path FROM bank_statements WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).send('Not found');
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
});

const authedRouter = express.Router();
authedRouter.use(requireAuth, requireAdmin);
authedRouter.use(router);

module.exports = authedRouter;
module.exports.publicRouter = publicRouter;
