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
    destination: (req, file, cb) => cb(null, String(file.fieldname || '').startsWith('receipt') ? RECEIPTS_DIR : BOOKS_DIR),
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
    // The INVOICES account — the bank whose details sit on our invoices
    // (Settings → bank details), i.e. where customer payments are EXPECTED.
    // Payments landing elsewhere still match, but get flagged as exceptions.
    await query(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false`);
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
    // Lump sums & part-payments: ONE bank line can be split across several
    // invoices, and one invoice can be paid across several bank lines. Each
    // row allocates a portion of a transaction to a sale.
    await query(`CREATE TABLE IF NOT EXISTS bank_tx_allocations (
      id SERIAL PRIMARY KEY,
      tx_id INTEGER NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
      sale_id INTEGER NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS bank_tx_alloc_tx_idx ON bank_tx_allocations (tx_id)`);
    await query(`CREATE INDEX IF NOT EXISTS bank_tx_alloc_sale_idx ON bank_tx_allocations (sale_id)`);
    // Receipt FILE NAME referenced by the bank's own export (Mettle's column
    // names the attached receipt per row) — bulk attach matches on it exactly.
    await query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS receipt_ref TEXT`);
    // VAT % for receipt-less but clearly VAT-inclusive charges (Royal Mail
    // tracked, FedEx domestic…) — the VAT amount back-calculates from gross.
    await query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2)`);
    // Several receipts/photos can back ONE payment (an invoice split over
    // pages, or a photo of each till receipt).
    await query(`CREATE TABLE IF NOT EXISTS bank_tx_receipts (
      id SERIAL PRIMARY KEY,
      tx_id INTEGER NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS bank_tx_receipts_tx_idx ON bank_tx_receipts (tx_id)`);
    // Repeat payers: "BA Cars MCR" on the bank line IS a known customer —
    // every confirmed link teaches the mapping, so their next payment
    // surfaces their invoices automatically.
    // Per-payee VAT treatment for recurring outgoings (standing orders,
    // direct debits, card regulars): set once — every future statement line
    // from that payee applies it automatically. vat_rate NULL = no VAT.
    await query(`CREATE TABLE IF NOT EXISTS books_vat_rules (
      id SERIAL PRIMARY KEY,
      payer_norm TEXT UNIQUE NOT NULL,
      payer_label TEXT,
      vat_rate NUMERIC(5,2),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS books_payer_map (
      id SERIAL PRIMARY KEY,
      payer_norm TEXT UNIQUE NOT NULL,
      payer_label TEXT,
      customer_name TEXT,
      last_sale_id INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
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
    await query(`CREATE TABLE IF NOT EXISTS platform_statements (
      id SERIAL PRIMARY KEY,
      platform TEXT,
      label TEXT,
      file_path TEXT NOT NULL,
      period_start DATE, period_end DATE,
      currency TEXT,
      summary JSONB,
      payouts JSONB,
      reconciliation JSONB,
      ai_confidence NUMERIC(4,3),
      ai_notes TEXT,
      uploaded_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    _ready = true;
  } catch (e) { console.warn('[books] migration:', e.message); }
}

const gbp = (n) => '£' + (parseFloat(n) || 0).toFixed(2);
const ukDate = (d) => String(d || '').slice(0, 10).split('-').reverse().join('/');
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
  if (b.isPrimary !== undefined) {
    if (b.isPrimary) await query(`UPDATE bank_accounts SET is_primary = false`);
    params.push(!!b.isPrimary); sets.push(`is_primary = $${params.length}`);
  }
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
    // PART-PAYMENTS recorded on the warehouse app: the sale_payments ledger
    // holds each recorded payment's amount + date. A bank line matching a
    // recorded (non-cash) payment's amount within ±4 days — with the invoice
    // reference in the description, or as the only candidate — becomes a
    // partial ALLOCATION to that invoice for exactly the recorded amount.
    try {
      const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const pays = await query(`
        SELECT sp.sale_id, sp.amount, s.invoice_number, s.payment_reference, s.total
          FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
         WHERE COALESCE(sp.method, 'bank') <> 'cash'
           AND ABS(sp.amount - $1) < 0.01
           AND sp.paid_at BETWEEN $2::date - interval '4 days' AND $2::date + interval '4 days'`,
        [t.money_in, t.date]);
      const payRef = pays.rows.find(p =>
        (p.invoice_number && descNorm.includes(norm(p.invoice_number)))
        || (p.payment_reference && descNorm.includes(norm(p.payment_reference))));
      const payHit = payRef || (pays.rows.length === 1 ? pays.rows[0] : null);
      if (payHit) {
        return {
          match_type: 'sale', sale_id: payHit.sale_id, category: 'sale_receipt',
          allocation: { saleId: payHit.sale_id, amount: +parseFloat(payHit.amount).toFixed(2) },
        };
      }
    } catch (_) { /* sale_payments table not migrated yet — skip quietly */ }
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
  if (!req.file) return res.status(400).json({ error: 'statement_file_required' });
  const ai = require('../services/ai');
  if (!ai.isConfigured()) return res.status(400).json({ error: 'ai_not_configured', message: 'Set ANTHROPIC_API_KEY first — the statement reader runs on Claude.' });
  const accountId = req.body.accountId ? parseInt(req.body.accountId) : null;
  // CSV / Excel exports are EXACT (no PDF reading) — preferred when the bank
  // offers them (Mettle, Wise, Capital on Tap all do). PDFs still work.
  const ext = path.extname(req.file.originalname || req.file.path).toLowerCase();
  let source;
  try {
    if (ext === '.csv' || ext === '.txt') {
      source = { csvText: fs.readFileSync(req.file.path, 'utf8'), filename: req.file.originalname };
    } else if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(req.file.path);
      source = { csvText: XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]), filename: req.file.originalname };
    } else {
      source = { pdfBase64: fs.readFileSync(req.file.path).toString('base64') };
    }
  } catch (e) { return res.status(422).json({ error: 'unreadable_file', message: e.message }); }
  let parsed;
  try {
    parsed = await ai.parseBankStatement(source, { hint: req.body.hint || null });
  } catch (e) {
    return res.status(502).json({ error: e.code || 'parse_failed', message: e.message });
  }
  if (!parsed || !parsed.transactions.length) {
    // A marketplace statement in the bank uploader would turn aggregated
    // category totals into fake bank transactions — bounce it to the right place.
    if (parsed && parsed.notABankStatement) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(422).json({
        error: 'marketplace_statement',
        message: 'That’s a marketplace statement (eBay/Shopify), not a bank statement — upload it under 📑 Marketplace statements instead, so the payouts get checked against the bank.' + (parsed.notes ? ' (' + parsed.notes + ')' : ''),
      });
    }
    return res.status(422).json({ error: 'no_transactions', message: 'Claude couldn’t read any transactions from that PDF' + (parsed && parsed.notes ? ' — ' + parsed.notes : '') + '. Is it a text PDF (not a photo scan)?' });
  }
  if (parsed.notABankStatement) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(422).json({
      error: 'marketplace_statement',
      message: 'That’s a marketplace statement (eBay/Shopify), not a bank statement — upload it under 📑 Marketplace statements instead, so the payouts get checked against the bank.',
    });
  }
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  const st = await query(
    `INSERT INTO bank_statements (account_id, label, file_path, bank_detected, account_detected, period_start, period_end, tx_count, ai_confidence, ai_notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [accountId, req.body.label || null, relPath, parsed.bank, parsed.accountName,
     parsed.periodStart, parsed.periodEnd, parsed.transactions.length, parsed.confidence, parsed.notes, req.user.id]);
  // Which account do invoices EXPECT to be paid into? The starred one — and
  // when none is starred yet, auto-detect it from the Settings bank details
  // (the account name / numbers printed on our invoices).
  let primary = (await query(`SELECT id, name FROM bank_accounts WHERE is_primary = true LIMIT 1`)).rows[0] || null;
  if (!primary && accountId) {
    try {
      const s = (await query(`SELECT bank_account_name, bank_sort_code, bank_account_number FROM app_settings WHERE id = 1`)).rows[0] || {};
      const normName = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const digits = (x) => String(x || '').replace(/[^0-9]/g, '');
      const setName = normName(s.bank_account_name);
      const detected = normName(parsed.accountName);
      const nameHit = setName.length >= 6 && detected && (detected.includes(setName) || setName.includes(detected));
      const acctDigits = digits(s.bank_account_number);
      const numHit = acctDigits.length >= 6 && digits(parsed.sortCodeOrIban).includes(acctDigits);
      if (nameHit || numHit) {
        await query(`UPDATE bank_accounts SET is_primary = true WHERE id = $1`, [accountId]);
        primary = (await query(`SELECT id, name FROM bank_accounts WHERE id = $1`, [accountId])).rows[0];
      }
    } catch (_) {}
  }
  let autoLinked = 0, payouts = 0, receiptsNeeded = 0;
  for (const t of parsed.transactions) {
    let m = { match_type: null, category: t.type || 'other' };
    try { m = await autoMatchTransaction(t); } catch (_) {}
    // Recurring payee with a saved VAT rule (standing orders, DDs, couriers)
    // → apply it: rate + back-calculated VAT, or no-VAT, no receipt chase.
    if (t.moneyOut > 0) {
      try {
        const rule = (await query(`SELECT vat_rate FROM books_vat_rules WHERE payer_norm = $1`, [payerKeyForTx(t)])).rows[0];
        if (rule) {
          if (rule.vat_rate != null && parseFloat(rule.vat_rate) > 0) {
            const rr = parseFloat(rule.vat_rate);
            m.vat_rate = rr;
            m.vat_amount = +(t.moneyOut * rr / (100 + rr)).toFixed(2);
            m.needs_vat_receipt = false;
          } else {
            m.vat_rate = null; m.vat_amount = 0; m.needs_vat_receipt = false;
          }
        }
      } catch (_) {}
    }
    // Invoice money landing OUTSIDE the invoices account is an exception worth
    // seeing (e.g. a customer who couldn't reach the usual bank paid into
    // Wise) — the match still happens, with a note explaining it.
    const offPrimaryNote = (m.match_type === 'sale' && primary && accountId && accountId !== primary.id)
      ? `⚠ Invoice payment received here — invoices are normally paid into the ${primary.name || 'invoices'} account (Settings bank details)`
      : null;
    if (m.match_type === 'sale') autoLinked++;
    if (m.match_type === 'payout') payouts++;
    if (m.needs_vat_receipt) receiptsNeeded++;
    const ins = await query(
      `INSERT INTO bank_transactions (statement_id, account_id, tx_date, description, counterparty, money_in, money_out, balance,
                                      category, match_type, sale_id, payout_platform, vat_likely, needs_vat_receipt, notes, receipt_ref, vat_rate, vat_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [st.rows[0].id, accountId, t.date, t.description, t.counterparty, t.moneyIn, t.moneyOut, t.balance,
       m.category || null, m.match_type || null, m.sale_id || null, m.payout_platform || t.payoutPlatform || null,
       !!t.vatLikely, !!m.needs_vat_receipt, offPrimaryNote, t.receiptRef || null,
       m.vat_rate != null ? m.vat_rate : null, m.vat_amount != null ? m.vat_amount : null]);
    // A warehouse-recorded part-payment match becomes a real allocation (the
    // exact recorded amount against that invoice).
    if (m.allocation && ins.rows[0]) {
      try {
        await query(`INSERT INTO bank_tx_allocations (tx_id, sale_id, amount) VALUES ($1,$2,$3)`,
          [ins.rows[0].id, m.allocation.saleId, m.allocation.amount]);
      } catch (_) {}
    }
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
           sl.invoice_number, sl.total AS sale_total, sl.customer_name,
           alloc.allocations, rcpt.receipts
      FROM bank_transactions t
      LEFT JOIN bank_statements s ON s.id = t.statement_id
      LEFT JOIN bank_accounts a ON a.id = t.account_id
      LEFT JOIN sales sl ON sl.id = t.sale_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg(json_build_object(
                 'id', ba.id, 'saleId', ba.sale_id, 'amount', ba.amount,
                 'invoiceNumber', s2.invoice_number, 'saleTotal', s2.total,
                 'customer', s2.customer_name) ORDER BY ba.id), '[]'::json) AS allocations
          FROM bank_tx_allocations ba LEFT JOIN sales s2 ON s2.id = ba.sale_id
         WHERE ba.tx_id = t.id
      ) alloc ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg(json_build_object('id', br.id, 'name', br.original_name) ORDER BY br.id), '[]'::json) AS receipts
          FROM bank_tx_receipts br WHERE br.tx_id = t.id
      ) rcpt ON true
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
    vat_rate: b.vatRate === '' ? null : b.vatRate,
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
  if (b.saleId) await rememberPayer(r.rows[0].id, parseInt(b.saleId));
  // Setting a VAT % (or clearing it to no-VAT) on a payee's line IS the
  // setup for that standing order / direct debit — remember it.
  if (b.vatRate !== undefined && b.teachRule) {
    await rememberVatRule(r.rows[0].counterparty, payerKeyForTx(r.rows[0]),
      (b.vatRate === '' || b.vatRate == null) ? null : parseFloat(b.vatRate));
  }
  await audit(req, 'books_tx_update', 'bank_transaction', req.params.id, b);
  res.json({ transaction: r.rows[0] });
});
// POST /transactions/dismiss-receipts { ids, reason? } — stop chasing VAT
// receipts for these payments (overseas suppliers carry no reclaimable UK
// VAT, so no receipt will ever exist). The reason lands in the notes so the
// accountant sees why there's no receipt.
router.post('/transactions/dismiss-receipts', async (req, res) => {
  await ensureTables();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids_required' });
  const reason = String(req.body?.reason || 'No UK VAT to reclaim').slice(0, 120);
  const r = await query(
    `UPDATE bank_transactions
        SET needs_vat_receipt = false,
            vat_amount = COALESCE(vat_amount, 0),
            notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || ' · ' || $2 END,
            updated_at = now()
      WHERE id = ANY($1) RETURNING id`, [ids, reason]);
  // Teach the no-VAT rule for these payees (overseas suppliers etc.).
  try {
    const payees = await query(`SELECT DISTINCT counterparty, description FROM bank_transactions WHERE id = ANY($1)`, [ids]);
    for (const p of payees.rows) await rememberVatRule(p.counterparty, payerKeyForTx(p), null);
  } catch (_) {}
  await audit(req, 'books_dismiss_receipts', null, null, { count: r.rows.length, reason });
  res.json({ ok: true, updated: r.rows.length });
});

// POST /transactions/mark-vat-inclusive { ids, rate } — for charges that ARE
// VAT-inclusive but never come with an invoice (Royal Mail tracked, FedEx
// domestic shipping…): stamps the rate, back-calculates the VAT portion from
// the gross (gross × r/(100+r)), and stops the receipt chase, noting why.
router.post('/transactions/mark-vat-inclusive', async (req, res) => {
  await ensureTables();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x)).filter(Boolean) : [];
  const rate = parseFloat(req.body?.rate);
  if (!ids.length || !(rate > 0) || rate > 100) return res.status(400).json({ error: 'ids_and_rate_required' });
  const note = `VAT @${rate}% included — domestic service, no separate invoice issued`;
  const r = await query(
    `UPDATE bank_transactions
        SET vat_rate = $2,
            vat_amount = ROUND(money_out * $2 / (100 + $2), 2),
            needs_vat_receipt = false,
            notes = CASE WHEN notes IS NULL OR notes = '' THEN $3 ELSE notes || ' · ' || $3 END,
            updated_at = now()
      WHERE id = ANY($1) AND money_out > 0 RETURNING id`, [ids, rate, note]);
  // Teach the per-payee rule so future statements apply it automatically.
  try {
    const payees = await query(`SELECT DISTINCT counterparty, description FROM bank_transactions WHERE id = ANY($1)`, [ids]);
    for (const p of payees.rows) await rememberVatRule(p.counterparty, payerKeyForTx(p), rate);
  } catch (_) {}
  await audit(req, 'books_vat_inclusive', null, null, { count: r.rows.length, rate });
  res.json({ ok: true, updated: r.rows.length });
});

// ── Allocations: lump sums & part-payments ────────────────────────────────
const normPayer = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
function payerKeyForTx(t) {
  return normPayer(t.counterparty || String(t.description || '').split('·')[0].split(':')[0]);
}
// Remember a payee's VAT treatment (rate, or NULL = no VAT) so recurring
// standing orders / direct debits handle themselves from then on.
async function rememberVatRule(payerLabel, payerNorm, rate) {
  if (!payerNorm || payerNorm.length < 3) return;
  try {
    await query(
      `INSERT INTO books_vat_rules (payer_norm, payer_label, vat_rate, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (payer_norm) DO UPDATE SET vat_rate = $3, payer_label = COALESCE($2, books_vat_rules.payer_label), updated_at = now()`,
      [payerNorm, payerLabel ? String(payerLabel).slice(0, 120) : null, rate]);
  } catch (_) {}
}

// A confirmed link teaches the payer → customer mapping for next time.
async function rememberPayer(txId, saleId) {
  try {
    const t = (await query(`SELECT counterparty, description FROM bank_transactions WHERE id = $1`, [txId])).rows[0];
    const s = (await query(`SELECT customer_name FROM sales WHERE id = $1`, [saleId])).rows[0];
    if (!t || !s || !s.customer_name) return;
    const key = payerKeyForTx(t);
    if (!key || key.length < 3) return;
    await query(
      `INSERT INTO books_payer_map (payer_norm, payer_label, customer_name, last_sale_id, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (payer_norm) DO UPDATE SET customer_name = $3, last_sale_id = $4, updated_at = now()`,
      [key, (t.counterparty || '').slice(0, 120) || null, s.customer_name, saleId]);
  } catch (_) {}
}

// GET /transactions/:id/suggest-invoices — ranked candidates for the 🧾 link:
// same amount (or the invoice's OUTSTANDING balance), paid-date proximity,
// and remembered repeat payers — so a "BA Cars MCR £229.99 on 01/06" line
// offers the right invoice instead of a blank search box.
router.get('/transactions/:id/suggest-invoices', async (req, res) => {
  await ensureTables();
  const t = (await query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.id])).rows[0];
  if (!t) return res.status(404).json({ error: 'not_found' });
  const amt = parseFloat(t.money_in) || parseFloat(t.money_out) || 0;
  const payerKey = payerKeyForTx(t);
  let mapped = null;
  try { mapped = (await query(`SELECT customer_name FROM books_payer_map WHERE payer_norm = $1`, [payerKey])).rows[0] || null; } catch (_) {}
  // Candidate pool: direct (non-marketplace) sales around the payment date,
  // plus everything by the remembered customer.
  const { rows: cands } = await query(`
    SELECT id, invoice_number, payment_reference, customer_name, total, amount_paid, occurred_at, is_paid, channel, payment_method
      FROM sales
     WHERE is_estimate = false
       AND channel NOT ILIKE 'ebay%' AND channel <> 'shopify'
       AND (occurred_at BETWEEN $1::date - interval '45 days' AND $1::date + interval '45 days'
            OR ($2::text IS NOT NULL AND customer_name ILIKE $2))
     ORDER BY occurred_at DESC LIMIT 400`,
    [t.tx_date, mapped ? mapped.customer_name : null]);
  const payerTokens = payerKey.split(' ').filter(w => w.length >= 3);
  const scored = [];
  for (const s of cands) {
    const total = parseFloat(s.total) || 0;
    const outstanding = +(total - (parseFloat(s.amount_paid) || 0)).toFixed(2);
    const custNorm = normPayer(s.customer_name);
    let score = 0; const reasons = [];
    if (amt > 0 && Math.abs(total - amt) < 0.01) { score += 50; reasons.push('same amount as the invoice total'); }
    else if (amt > 0 && outstanding > 0 && Math.abs(outstanding - amt) < 0.01) { score += 48; reasons.push(`matches the outstanding £${outstanding.toFixed(2)}`); }
    const days = Math.abs((new Date(s.occurred_at) - new Date(t.tx_date)) / 86400000);
    if (days <= 14) { score += Math.max(0, Math.round(20 - days)); if (days <= 4) reasons.push(days < 1 ? 'same day' : `${Math.round(days)} day(s) apart`); }
    if (mapped && custNorm === normPayer(mapped.customer_name)) { score += 60; reasons.push(`repeat payer — "${(t.counterparty || payerKey)}" previously paid this customer's invoices`); }
    else if (payerTokens.length && custNorm) {
      const hits = payerTokens.filter(w => custNorm.includes(w)).length;
      if (hits >= Math.max(1, Math.ceil(payerTokens.length / 2))) { score += 40; reasons.push(`name matches "${t.counterparty || payerKey}"`); }
      else if (hits >= 1) { score += 18; reasons.push('partial name match'); }
    }
    if (!s.is_paid) { score += 8; reasons.push('still awaiting payment'); }
    if (score >= 25) scored.push({ saleId: s.id, invoiceNumber: s.invoice_number, customer: s.customer_name, total, outstanding, occurredAt: s.occurred_at, isPaid: s.is_paid, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  res.json({ suggestions: scored.slice(0, 8), payer: t.counterparty || null, amount: amt, mappedCustomer: mapped ? mapped.customer_name : null });
});
// POST /transactions/:id/allocations { saleId, amount } — allocate a portion
// of this bank line to an invoice. A lump sum gets several allocations (one
// per invoice it covers); a part-payment allocates less than the invoice
// total, with the rest arriving on later bank lines.
router.post('/transactions/:id/allocations', async (req, res) => {
  await ensureTables();
  const saleId = parseInt(req.body?.saleId);
  const amount = parseFloat(req.body?.amount);
  if (!saleId || !(amount > 0)) return res.status(400).json({ error: 'saleId_and_amount_required' });
  const t = (await query(`SELECT * FROM bank_transactions WHERE id = $1`, [req.params.id])).rows[0];
  if (!t) return res.status(404).json({ error: 'not_found' });
  const allocated = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_tx_allocations WHERE tx_id = $1`, [t.id])).rows[0].s);
  const lineTotal = parseFloat(t.money_in) || parseFloat(t.money_out) || 0;
  if (allocated + amount > lineTotal + 0.005) {
    return res.status(400).json({ error: 'over_allocated', message: `Only £${(lineTotal - allocated).toFixed(2)} of this line is unallocated.` });
  }
  await query(`INSERT INTO bank_tx_allocations (tx_id, sale_id, amount) VALUES ($1,$2,$3)`, [t.id, saleId, +amount.toFixed(2)]);
  await rememberPayer(t.id, saleId);
  // Keep the legacy single-link fields sensible: first allocation drives them.
  await query(`UPDATE bank_transactions SET sale_id = COALESCE(sale_id, $2), match_type = 'sale', category = COALESCE(category, 'sale_receipt'), updated_at = now() WHERE id = $1`, [t.id, saleId]);
  await audit(req, 'books_tx_allocate', 'bank_transaction', t.id, { saleId, amount });
  const rows = await loadTransactions({ from: String(t.tx_date).slice(0, 10), to: String(t.tx_date).slice(0, 10) });
  res.status(201).json({ ok: true, transaction: rows.find(x => x.id === t.id) || null });
});
router.delete('/transactions/:id/allocations/:allocId', async (req, res) => {
  await ensureTables();
  const r = await query(`DELETE FROM bank_tx_allocations WHERE id = $1 AND tx_id = $2 RETURNING sale_id`, [req.params.allocId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  // If that was the last allocation for the sale the legacy field points at,
  // clear the legacy link too.
  const left = await query(`SELECT COUNT(*)::int AS n, MIN(sale_id) AS first_sale FROM bank_tx_allocations WHERE tx_id = $1`, [req.params.id]);
  if (!left.rows[0].n) {
    await query(`UPDATE bank_transactions SET sale_id = NULL, match_type = NULL, updated_at = now() WHERE id = $1 AND sale_id = $2`, [req.params.id, r.rows[0].sale_id]);
  } else {
    await query(`UPDATE bank_transactions SET sale_id = $2, updated_at = now() WHERE id = $1`, [req.params.id, left.rows[0].first_sale]);
  }
  await audit(req, 'books_tx_deallocate', 'bank_transaction', req.params.id, { allocId: req.params.allocId });
  res.json({ ok: true });
});

router.post('/transactions/:id/receipt', upload.single('receipt'), async (req, res) => {  await ensureTables();
  if (!req.file) return res.status(400).json({ error: 'receipt_required' });
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  // Multiple receipts/photos per payment: each upload APPENDS.
  const r = await query(`UPDATE bank_transactions SET receipt_path = COALESCE(receipt_path, $1), needs_vat_receipt = false, updated_at = now() WHERE id = $2 RETURNING *`, [relPath, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await query(`INSERT INTO bank_tx_receipts (tx_id, file_path, original_name) VALUES ($1,$2,$3)`,
    [req.params.id, relPath, (req.file.originalname || '').slice(0, 200) || null]);
  await audit(req, 'books_receipt_upload', 'bank_transaction', req.params.id);
  res.status(201).json({ transaction: r.rows[0] });
});
// Serve one receipt file by its receipt-row id (a payment can hold several).
router.get('/receipt-file/:rid', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT file_path FROM bank_tx_receipts WHERE id = $1`, [req.params.rid]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
});
router.get('/transactions/:id/receipt', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT receipt_path FROM bank_transactions WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]?.receipt_path) return res.status(404).json({ error: 'no_receipt' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].receipt_path));
});

// POST /api/books/receipts/bulk — attach a FOLDER of receipts in one go (the
// Mettle export ships a receipts/ folder with files like
// "Mettle-INV-133-2026-04-25.pdf"). Each file is matched by the DATE in its
// filename to a money-out transaction that still lacks a receipt — exact date
// first, then ±2 days — and attached only when the match is unambiguous.
// Unmatched files are listed back (attach those few via the 📎 on the row).
router.post('/receipts/bulk', upload.array('receipts', 200), async (req, res) => {
  await ensureTables();
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'no_files' });
  const out = { attached: [], unmatched: [] };
  // How many transactions even CARRY a receipt reference? Zero means the
  // bank statement was imported before reference capture existed — the fix
  // is re-uploading the CSV, and the response says so instead of failing
  // vaguely on dates.
  const refCount = parseInt((await query(`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE receipt_ref IS NOT NULL AND receipt_ref <> ''`)).rows[0].n) || 0;
  out.refCount = refCount;
  const normRef = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const attach = async (txId, relPath2, name2) => {
    await query(`UPDATE bank_transactions SET receipt_path = COALESCE(receipt_path, $1), needs_vat_receipt = false, updated_at = now() WHERE id = $2`, [relPath2, txId]);
    await query(`INSERT INTO bank_tx_receipts (tx_id, file_path, original_name) VALUES ($1,$2,$3)`, [txId, relPath2, String(name2).slice(0, 200)]);
  };
  for (const f of files) {
    const name = f.originalname || path.basename(f.path);
    // 1. EXACT: the bank's own export names the receipt file per row
    //    (Mettle's receipt column) — attach to EVERY row referencing it.
    //    Compared with punctuation stripped on BOTH sides, plus the long
    //    numeric id from the filename as a secondary key, so truncated or
    //    reformatted references still hit.
    const base = name.replace(/\.[a-z0-9]+$/i, '');
    const normBase = normRef(base);
    const digits = (base.match(/\d{6,}/g) || []).pop() || null;
    const refHits = (refCount && normBase.length >= 10) ? await query(
      `SELECT id, description FROM bank_transactions
        WHERE receipt_ref IS NOT NULL AND (
          regexp_replace(lower(receipt_ref), '[^a-z0-9]', '', 'g') LIKE '%' || $1 || '%'
          OR regexp_replace(lower(receipt_ref), '[^a-z0-9]', '', 'g') <> ''
             AND $1 LIKE '%' || regexp_replace(lower(receipt_ref), '[^a-z0-9]', '', 'g') || '%'
          OR ($2::text IS NOT NULL AND receipt_ref LIKE '%' || $2 || '%'))`, [normBase, digits]) : { rows: [] };
    if (refHits.rows.length) {
      const relPath2 = path.relative(UPLOAD_DIR, f.path);
      for (const tx2 of refHits.rows) {
        await attach(tx2.id, relPath2, name);
        out.attached.push({ file: name, txId: tx2.id, description: tx2.description, via: 'export reference' });
      }
      continue;
    }
    const dm = name.match(/(\d{4})-(\d{2})-(\d{2})/);
    let tx = null;
    if (dm) {
      const day = `${dm[1]}-${dm[2]}-${dm[3]}`;
      const exact = await query(
        `SELECT id, description, money_out FROM bank_transactions
          WHERE money_out > 0 AND receipt_path IS NULL AND tx_date = $1::date`, [day]);
      if (exact.rows.length === 1) tx = exact.rows[0];
      else if (!exact.rows.length) {
        const near = await query(
          `SELECT id, description, money_out FROM bank_transactions
            WHERE money_out > 0 AND receipt_path IS NULL
              AND tx_date BETWEEN $1::date - interval '2 days' AND $1::date + interval '2 days'`, [day]);
        if (near.rows.length === 1) tx = near.rows[0];
      }
    }
    if (tx) {
      await attach(tx.id, path.relative(UPLOAD_DIR, f.path), name);
      out.attached.push({ file: name, txId: tx.id, description: tx.description, via: 'date' });
    } else {
      try { fs.unlinkSync(f.path); } catch (_) {}
      out.unmatched.push(name);
    }
  }
  await audit(req, 'books_receipts_bulk', null, null, { attached: out.attached.length, unmatched: out.unmatched.length });
  res.json({ ok: true, ...out, summary: { attached: out.attached.length, unmatched: out.unmatched.length } });
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

// ── Platform statements (eBay / Shopify monthly) + payout reconciliation ──
// eBay pays out daily but reports monthly — and deducts fees, postage
// labels, advertising and refunds BEFORE paying, so the banked number is
// smaller than sales. Upload the monthly statement: Claude pulls the payout
// list + the deduction breakdown, then every payout is checked against the
// bank transactions — matched ones get the payout id stamped on the bank
// line (the physical link), and anything missing or extra is flagged with
// the total difference.
const normPayoutId = (x) => String(x || '').replace(/[^0-9]/g, '');

async function reconcilePlatformStatement(parsed) {
  const from = parsed.periodStart, to = parsed.periodEnd;
  const rec = { matched: [], missingFromBank: [], extraInBank: [], totals: {} };
  if (!parsed.payouts.length) return rec;
  // Bank candidates: money-in lines around the period that look like this platform.
  const pat = parsed.platform === 'ebay' ? '(ebay|managed payments)'
    : parsed.platform === 'shopify' ? '(shopify|shopi)'
    : parsed.platform;
  const { rows: bank } = await query(`
    SELECT id, tx_date, description, money_in, payout_ref FROM bank_transactions
     WHERE money_in > 0
       AND tx_date BETWEEN COALESCE($1::date, '1970-01-01') - interval '7 days' AND COALESCE($2::date, now()::date) + interval '7 days'
       AND (payout_platform = $3 OR description ~* $4)`,
    [from, to, parsed.platform, pat]);
  const used = new Set();
  for (const p of parsed.payouts) {
    const pid = normPayoutId(p.payoutId);
    // 1. payout id printed in the bank description; 2. unique amount ±4 days.
    let hit = pid ? bank.find(b => !used.has(b.id) && normPayoutId(b.description).includes(pid) && pid.length >= 6) : null;
    if (!hit) {
      const cands = bank.filter(b => !used.has(b.id) && Math.abs(parseFloat(b.money_in) - p.amount) < 0.01
        && Math.abs((new Date(b.tx_date) - new Date(p.date)) / 86400000) <= 4);
      if (cands.length === 1) hit = cands[0];
    }
    if (hit) {
      used.add(hit.id);
      rec.matched.push({ payoutId: p.payoutId, date: p.date, amount: p.amount, bankTxId: hit.id, bankDate: String(hit.tx_date).slice(0, 10) });
      // Stamp the physical link on the bank line.
      try {
        await query(`UPDATE bank_transactions SET payout_ref = COALESCE(payout_ref, $2), payout_platform = $3, match_type = 'payout', category = COALESCE(category, 'payout'), updated_at = now() WHERE id = $1`,
          [hit.id, p.payoutId || null, parsed.platform]);
      } catch (_) {}
    } else {
      rec.missingFromBank.push({ payoutId: p.payoutId, date: p.date, amount: p.amount });
    }
  }
  // Bank payouts in the period that the statement doesn't list.
  for (const b of bank) {
    if (!used.has(b.id) && from && to && String(b.tx_date).slice(0, 10) >= from && String(b.tx_date).slice(0, 10) <= to) {
      rec.extraInBank.push({ bankTxId: b.id, date: String(b.tx_date).slice(0, 10), amount: +parseFloat(b.money_in).toFixed(2), description: b.description });
    }
  }
  const sum = (a) => +a.reduce((x, y) => x + (y.amount || 0), 0).toFixed(2);
  const S = parsed.summary || {};
  const n = (x) => +(parseFloat(x) || 0);
  // Carry-over sanity check: opening balance (last month's unpaid funds) plus
  // this month's activity, minus what was paid out, should equal the closing
  // balance carried into next month. A gap means a misread (or an odd line on
  // the statement) worth a human look.
  const deductions = +(n(S.refunds) + n(S.fees) + n(S.postageLabels) + n(S.advertising) + n(S.otherDeductions)).toFixed(2);
  const expectedClosing = +(n(S.openingBalance) + n(S.grossSales) - deductions - (n(S.netPayouts) || sum(parsed.payouts))).toFixed(2);
  rec.totals = {
    statementPayouts: sum(parsed.payouts),
    statementNet: n(S.netPayouts) || sum(parsed.payouts),
    matchedInBank: sum(rec.matched),
    missingFromBank: sum(rec.missingFromBank),
    extraInBank: sum(rec.extraInBank),
    difference: +(sum(parsed.payouts) - sum(rec.matched)).toFixed(2),
    openingBalance: n(S.openingBalance),
    closingBalance: n(S.closingBalance),
    deductions,
    carryCheckDiff: S.closingBalance !== undefined ? +(expectedClosing - n(S.closingBalance)).toFixed(2) : null,
  };
  return rec;
}

router.post('/platform-statements', upload.single('statement'), async (req, res) => {
  await ensureTables();
  if (!req.file) return res.status(400).json({ error: 'statement_pdf_required' });
  const ai = require('../services/ai');
  if (!ai.isConfigured()) return res.status(400).json({ error: 'ai_not_configured' });
  let parsed;
  try {
    const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');
    parsed = await ai.parsePlatformStatement(pdfBase64, { hint: req.body.hint || (req.body.platform ? 'This is a ' + req.body.platform + ' statement.' : null) });
  } catch (e) { return res.status(502).json({ error: e.code || 'parse_failed', message: e.message }); }
  if (!parsed) return res.status(422).json({ error: 'unreadable', message: 'Claude couldn’t read that PDF — is it a text PDF (not a scan)?' });
  const reconciliation = await reconcilePlatformStatement(parsed);
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  const st = await query(
    `INSERT INTO platform_statements (platform, label, file_path, period_start, period_end, currency, summary, payouts, reconciliation, ai_confidence, ai_notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12) RETURNING *`,
    [parsed.platform, req.body.label || null, relPath, parsed.periodStart, parsed.periodEnd, parsed.currency,
     JSON.stringify(parsed.summary), JSON.stringify(parsed.payouts), JSON.stringify(reconciliation),
     parsed.confidence, parsed.notes, req.user.id]);
  await audit(req, 'books_platform_statement', 'platform_statement', st.rows[0].id, {
    platform: parsed.platform, payouts: parsed.payouts.length, matched: reconciliation.matched.length, missing: reconciliation.missingFromBank.length,
  });
  res.status(201).json({ ok: true, statement: st.rows[0], parsed: { platform: parsed.platform, period: [parsed.periodStart, parsed.periodEnd], confidence: parsed.confidence, notes: parsed.notes }, reconciliation });
});
router.get('/platform-statements', async (req, res) => {
  await ensureTables();
  const { rows } = await query(`SELECT * FROM platform_statements ORDER BY period_start DESC NULLS LAST, created_at DESC LIMIT 100`);
  res.json({ statements: rows });
});
router.delete('/platform-statements/:id', async (req, res) => {
  await ensureTables();
  const r = await query(`DELETE FROM platform_statements WHERE id = $1 RETURNING file_path`, [req.params.id]);
  if (r.rows[0]?.file_path) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.rows[0].file_path)); } catch (_) {} }
  await audit(req, 'books_platform_statement_delete', 'platform_statement', req.params.id);
  res.json({ ok: true });
});
router.get('/platform-statements/:id/file', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT file_path FROM platform_statements WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
});
// Re-run the bank match (e.g. after uploading the bank statement that holds
// the missing payouts).
router.post('/platform-statements/:id/rematch', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT * FROM platform_statements WHERE id = $1`, [req.params.id]);
  const st = r.rows[0];
  if (!st) return res.status(404).json({ error: 'not_found' });
  const parsed = {
    platform: st.platform, periodStart: st.period_start ? String(st.period_start).slice(0, 10) : null,
    periodEnd: st.period_end ? String(st.period_end).slice(0, 10) : null,
    summary: st.summary || {}, payouts: st.payouts || [],
  };
  const reconciliation = await reconcilePlatformStatement(parsed);
  await query(`UPDATE platform_statements SET reconciliation = $1::jsonb WHERE id = $2`, [JSON.stringify(reconciliation), st.id]);
  res.json({ ok: true, reconciliation });
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
    const allocs = Array.isArray(t.allocations) ? t.allocations : [];
    const invoiceCol = allocs.length
      ? allocs.map(a => (a.invoiceNumber || ('#' + a.saleId)) + ' £' + (+a.amount).toFixed(2)).join(' | ')
      : (t.invoice_number || '');
    lines.push([
      ukDate(t.tx_date), t.account_name || '', t.account_bank || t.bank_detected || '', t.business || '',
      t.description || '', t.counterparty || '',
      t.money_in > 0 ? (+t.money_in).toFixed(2) : '', t.money_out > 0 ? (+t.money_out).toFixed(2) : '',
      t.category || '', t.match_type || '',
      invoiceCol, t.payout_ref || (t.payout_platform || ''),
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
  const fromUk = ukDate(from), toUk = ukDate(to);
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
  <div class="sub">Period ${esc(fromUk)} → ${esc(toUk)}${share.label ? ' · ' + esc(share.label) : ''} · prepared ${new Date().toLocaleDateString('en-GB')} · read-only link</div>
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
    <td>${esc(ukDate(t.tx_date))}</td>
    <td>${esc(t.account_name || t.bank_detected || '')}</td>
    <td>${esc(t.description || '')}${t.notes ? `<div style="color:#888;font-size:11px">${esc(t.notes)}</div>` : ''}</td>
    <td class="num">${t.money_in > 0 ? gbp(t.money_in) : ''}</td>
    <td class="num">${t.money_out > 0 ? gbp(t.money_out) : ''}</td>
    <td><span class="pill">${esc(t.category || '—')}</span></td>
    <td>${(Array.isArray(t.allocations) && t.allocations.length)
      ? t.allocations.map(a => `<a href="${base}/invoice/${a.saleId}" target="_blank">Invoice ${esc(a.invoiceNumber || ('#' + a.saleId))}</a> ${gbp(a.amount)}${a.saleTotal != null && (parseFloat(a.amount) + 0.005) < parseFloat(a.saleTotal) ? ' <span style="color:#888">(part of ' + gbp(a.saleTotal) + ')</span>' : ''}`).join('<br>')
      : (t.sale_id ? `<a href="${base}/invoice/${t.sale_id}" target="_blank">Invoice ${esc(t.invoice_number || ('#' + t.sale_id))}</a>` : (t.payout_ref || t.payout_platform ? `<span class="pill b">${esc((t.payout_platform || 'payout').toUpperCase())}${t.payout_ref ? ' ' + esc(t.payout_ref) : ''}</span>` : '<span style="color:#aaa">—</span>'))}</td>
    <td class="num">${t.vat_amount != null ? gbp(t.vat_amount) : ''}</td>
    <td>${(Array.isArray(t.receipts) && t.receipts.length)
      ? t.receipts.map((r2, i2) => `<a href="${base}/receipt-file/${r2.id}" target="_blank">file${t.receipts.length > 1 ? ' ' + (i2 + 1) : ''}</a>`).join(' · ')
      : (t.receipt_path ? `<a href="${base}/receipt/${t.id}" target="_blank">view</a>` : (t.needs_vat_receipt ? '<span class="pill r">missing</span>' : ''))}</td>
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
publicRouter.get('/:token/receipt-file/:rid', async (req, res) => {
  const share = await shareFor(req.params.token);
  if (!share) return res.status(404).send('Link revoked.');
  const r = await query(`SELECT file_path FROM bank_tx_receipts WHERE id = $1`, [req.params.rid]);
  if (!r.rows[0]) return res.status(404).send('No receipt');
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
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
