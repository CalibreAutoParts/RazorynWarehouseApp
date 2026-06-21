// services/invoiceHub.js — pushes the warehouse's OWN direct sales/refunds into
// the Razoryn Invoice Hub.
//
// SCOPE (deliberately narrow — agreed with the business):
//   • We push only the warehouse's own direct orders:
//       - direct_bank  → paymentMethod BANK_TRANSFER  (normal VAT treatment)
//       - direct_cash  → paymentMethod CASH           (Hub keeps these internal:
//                        out of the VAT return / accountant view, owner-only —
//                        which is exactly how cash is treated here too)
//   • We do NOT push eBay or Shopify orders, nor direct_card (Stripe). Those
//     platforms take fees and are reconciled by uploading their own
//     weekly/monthly statements straight into the Hub — auto-posting here as
//     well would double-count them.
//
// Reliability mirrors the dispatch → channel push: every send is best-effort and
// fire-and-forget (setImmediate from the route), but the outcome is recorded on
// the sale row (invoice_hub_push_state / _error) so a failed push is visible and
// retryable rather than silently lost. The Hub's (company + externalId)
// idempotency makes retries safe — re-sending updates the existing record.

const { query } = require('../db');
const hub = require('../lib/pushToInvoiceHub');

// Direct-sale channels we forward. Everything else is out of scope.
const IN_SCOPE_CHANNELS = ['direct_bank', 'direct_cash'];

function isInScope(channel) {
  return IN_SCOPE_CHANNELS.includes(channel);
}

// Warehouse channel → Invoice Hub paymentMethod enum.
function paymentMethodFor(channel) {
  if (channel === 'direct_cash') return 'CASH';
  if (channel === 'direct_bank') return 'BANK_TRANSFER';
  return 'OTHER';
}

// YYYY-MM-DD (Hub's `date` field) from a timestamp, defaulting to today.
function toDateStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Stable external id for a sale — prefer the unified payment/invoice reference,
// fall back to a synthetic warehouse id. Used as the Hub's idempotency key.
function saleExternalId(sale) {
  return sale.payment_reference || sale.invoice_number || `WH-SALE-${sale.id}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration — outcome columns on `sales`. Mirrors the dispatch
// channel_push_state pattern. Idempotent; runs on cold boot.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureInvoiceHubColumns() {
  if (_migrationDone) return;
  try {
    // SALE push outcome.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_push_state TEXT`);   // 'pending' | 'ok' | 'error'
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_push_error TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_pushed_at  TIMESTAMPTZ`);
    // REFUND push outcome (tracked separately — a sale can sell fine but a later
    // refund push fail, or vice-versa).
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_refund_state TEXT`);  // 'pending' | 'ok' | 'error'
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_refund_error TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_hub_refunded_at  TIMESTAMPTZ`);
    _migrationDone = true;
  } catch (e) {
    console.warn('[invoiceHub] migration warning:', e.message);
  }
}
ensureInvoiceHubColumns();

// The standing VAT rate for this deployment (percent). Sales already store the
// VAT *portion* in `sale.vat`; we only send a rate when that portion is non-zero
// so cash / non-VAT-registered rows post at 0% and match the warehouse books.
async function configuredVatRate() {
  try {
    const r = await query('SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1');
    const row = r.rows[0] || {};
    if (!row.vat_registered) return 0;
    return parseFloat(row.vat_rate || 20) || 0;
  } catch {
    return 20;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Push a SALE. Best-effort: records the outcome on the sale row, never throws.
// Out-of-scope sales are a silent no-op (state left untouched).
// ──────────────────────────────────────────────────────────────────────────
async function pushSale(saleId) {
  if (!hub.isConfigured()) return;
  await ensureInvoiceHubColumns();
  try {
    const r = await query('SELECT * FROM sales WHERE id = $1', [saleId]);
    const sale = r.rows[0];
    if (!sale) return;
    // Only paid, non-estimate, in-scope direct sales are real "money in" events.
    if (sale.is_estimate) return;
    if (!isInScope(sale.channel)) return;
    if (sale.status === 'pending') return; // not paid yet — pushed on mark-paid

    await query(`UPDATE sales SET invoice_hub_push_state = 'pending' WHERE id = $1`, [saleId]);

    const vatRate = (parseFloat(sale.vat) > 0) ? await configuredVatRate() : 0;
    const cash = sale.channel === 'direct_cash';
    const event = {
      company: hub.companyName(),
      kind: 'SALE',
      externalId: saleExternalId(sale),
      description: `Direct ${cash ? 'cash' : 'bank transfer'} sale ${sale.order_number || sale.payment_reference || sale.id}`,
      amount: Number(sale.total),
      amountType: 'GROSS',
      vatRate,
      paymentMethod: paymentMethodFor(sale.channel),
      counterparty: sale.customer_name || undefined,
      date: toDateStr(sale.paid_at || sale.occurred_at),
    };

    await hub.pushEvents(event);
    await query(
      `UPDATE sales SET invoice_hub_push_state = 'ok', invoice_hub_push_error = NULL, invoice_hub_pushed_at = now() WHERE id = $1`,
      [saleId]);
  } catch (e) {
    console.warn(`[invoiceHub.pushSale] sale=${saleId} failed:`, e.message);
    await query(
      `UPDATE sales SET invoice_hub_push_state = 'error', invoice_hub_push_error = $2 WHERE id = $1`,
      [saleId, String(e.message).slice(0, 500)]).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Push a REFUND for a sale. One REFUND record per sale, keyed on the sale's
// reference + "-REFUND"; re-sending updates it to the cumulative refunded total
// (so partial refunds over time converge correctly). Amount is sent POSITIVE —
// the Hub makes it negative.
// ──────────────────────────────────────────────────────────────────────────
async function pushRefund(saleId) {
  if (!hub.isConfigured()) return;
  await ensureInvoiceHubColumns();
  try {
    const r = await query('SELECT * FROM sales WHERE id = $1', [saleId]);
    const sale = r.rows[0];
    if (!sale) return;
    if (!isInScope(sale.channel)) return;

    // Cumulative refunded amount across this sale's returns. If nothing was
    // itemised but the sale is flagged refunded, treat it as a full refund.
    const sums = await query(
      `SELECT COALESCE(SUM(refund_amount), 0) AS refunded FROM returns WHERE sale_id = $1`, [saleId]);
    let amount = Number(sums.rows[0]?.refunded || 0);
    if (!amount && sale.status === 'refunded') amount = Number(sale.total);
    if (!amount || amount <= 0) return; // nothing to refund yet

    await query(`UPDATE sales SET invoice_hub_refund_state = 'pending' WHERE id = $1`, [saleId]);

    const vatRate = (parseFloat(sale.vat) > 0) ? await configuredVatRate() : 0;
    const cash = sale.channel === 'direct_cash';
    const event = {
      company: hub.companyName(),
      kind: 'REFUND',
      externalId: `${saleExternalId(sale)}-REFUND`,
      description: `Refund for ${cash ? 'cash' : 'bank transfer'} sale ${sale.order_number || sale.payment_reference || sale.id}`,
      amount: +amount.toFixed(2),
      amountType: 'GROSS',
      vatRate,
      paymentMethod: paymentMethodFor(sale.channel),
      counterparty: sale.customer_name || undefined,
      date: toDateStr(),
    };

    await hub.pushEvents(event);
    await query(
      `UPDATE sales SET invoice_hub_refund_state = 'ok', invoice_hub_refund_error = NULL, invoice_hub_refunded_at = now() WHERE id = $1`,
      [saleId]);
  } catch (e) {
    console.warn(`[invoiceHub.pushRefund] sale=${saleId} failed:`, e.message);
    await query(
      `UPDATE sales SET invoice_hub_refund_state = 'error', invoice_hub_refund_error = $2 WHERE id = $1`,
      [saleId, String(e.message).slice(0, 500)]).catch(() => {});
  }
}

// Config/status for the UI: is the integration wired, and which company does
// this deployment post as.
function status() {
  return { configured: hub.isConfigured(), company: hub.companyName() };
}

// ──────────────────────────────────────────────────────────────────────────
// Backfill a month of historical direct cash/bank sales. Shared by the CLI
// script and the admin "Backfill to Invoice Hub" button. Returns a plain
// summary object (no throwing) so the route can hand it straight to the client.
//   month: "YYYY-MM"; dryRun: list only; withRefunds: also push REFUND events.
// ──────────────────────────────────────────────────────────────────────────
async function backfillMonth({ month, dryRun = false, withRefunds = false } = {}) {
  if (!hub.isConfigured()) {
    return { ok: false, error: 'not_configured',
             message: 'Invoice Hub not configured (INVOICE_HUB_URL / INVOICE_HUB_SECRET unset on this service).' };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  if (!m) return { ok: false, error: 'bad_month', message: 'Month must be in YYYY-MM format (e.g. 2026-06).' };
  const year = +m[1], mon = +m[2];
  if (mon < 1 || mon > 12) return { ok: false, error: 'bad_month', message: 'Month must be 01–12.' };

  await ensureInvoiceHubColumns();
  // paid_at is added by the sales route at runtime; ensure it exists for the filter.
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`).catch(() => {});

  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1)); // exclusive

  const { rows } = await query(
    `SELECT id, channel, status, total, customer_name,
            COALESCE(paid_at, occurred_at) AS pay_date
       FROM sales
      WHERE channel = ANY($1)
        AND is_estimate = false
        AND status NOT IN ('pending','cancelled')
        AND COALESCE(paid_at, occurred_at) >= $2
        AND COALESCE(paid_at, occurred_at) <  $3
      ORDER BY COALESCE(paid_at, occurred_at)`,
    [IN_SCOPE_CHANNELS, start, end]
  );

  const summary = {
    ok: true, month, company: hub.companyName(), dryRun, withRefunds,
    found: rows.length,
    bank: rows.filter(r => r.channel === 'direct_bank').length,
    cash: rows.filter(r => r.channel === 'direct_cash').length,
    saleOk: 0, saleErr: 0, refundOk: 0, refundErr: 0, errors: [],
  };

  if (dryRun || !rows.length) {
    summary.preview = rows.map(r => ({
      id: r.id, channel: r.channel, total: Number(r.total),
      date: r.pay_date.toISOString().slice(0, 10),
      customer: r.customer_name || null, refunded: r.status === 'refunded',
    }));
    return summary;
  }

  for (const r of rows) {
    await pushSale(r.id);
    const st = await query(
      `SELECT invoice_hub_push_state AS s, invoice_hub_push_error AS e FROM sales WHERE id = $1`, [r.id]);
    if (st.rows[0]?.s === 'ok') summary.saleOk++;
    else { summary.saleErr++; summary.errors.push({ id: r.id, type: 'sale', error: st.rows[0]?.e || st.rows[0]?.s || 'unknown' }); }

    if (withRefunds && r.status === 'refunded') {
      await pushRefund(r.id);
      const rst = await query(
        `SELECT invoice_hub_refund_state AS s, invoice_hub_refund_error AS e FROM sales WHERE id = $1`, [r.id]);
      if (rst.rows[0]?.s === 'ok') summary.refundOk++;
      else { summary.refundErr++; summary.errors.push({ id: r.id, type: 'refund', error: rst.rows[0]?.e || rst.rows[0]?.s || 'unknown' }); }
    }
  }
  return summary;
}

module.exports = {
  IN_SCOPE_CHANNELS,
  isInScope,
  paymentMethodFor,
  ensureInvoiceHubColumns,
  pushSale,
  pushRefund,
  status,
  backfillMonth,
};
