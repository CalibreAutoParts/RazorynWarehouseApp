// scripts/backfill-invoice-hub.js — one-off catch-up: push historical direct
// cash + bank-transfer sales into the Invoice Hub.
//
// The live integration only fires on NEW events, so existing orders never sync
// on their own. This script enumerates the qualifying sales for a given month
// and pushes each through the SAME client/path the app uses (services/invoiceHub
// .pushSale), so backfilled rows are identical to live ones.
//
// Scope (same as the live integration):
//   • channel direct_bank  → BANK_TRANSFER
//   • channel direct_cash  → CASH (kept internal / owner-only on the Hub)
//   • paid, non-estimate, not cancelled
//   eBay / Shopify / card(Stripe) are NOT touched.
//
// Idempotent: each sale is keyed by its payment reference, so the Hub UPDATES
// rather than duplicating. Safe to re-run.
//
//   railway run node scripts/backfill-invoice-hub.js                 # June 2026 (default), sales only
//   railway run node scripts/backfill-invoice-hub.js --month 2026-06
//   railway run node scripts/backfill-invoice-hub.js --dry-run       # list, push nothing
//   railway run node scripts/backfill-invoice-hub.js --with-refunds  # also push refunds for refunded sales

require('dotenv').config();
const { pool, query } = require('../db');
const hub = require('../lib/pushToInvoiceHub');
const invoiceHub = require('../services/invoiceHub');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const month = arg('month', '2026-06');           // YYYY-MM
const dryRun = process.argv.includes('--dry-run');
const withRefunds = process.argv.includes('--with-refunds');

function monthBounds(m) {
  const match = /^(\d{4})-(\d{2})$/.exec(m);
  if (!match) throw new Error(`--month must be YYYY-MM (got "${m}")`);
  const year = +match[1], mon = +match[2];
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));   // first day of next month (exclusive)
  return { start, end };
}

async function run() {
  if (!hub.isConfigured()) {
    console.error('✗ Invoice Hub not configured (INVOICE_HUB_URL / INVOICE_HUB_SECRET unset).');
    process.exit(1);
  }
  const { start, end } = monthBounds(month);
  console.log(`Backfill → Invoice Hub`);
  console.log(`  Company:  ${hub.companyName()}`);
  console.log(`  Month:    ${month}  (payment date ${start.toISOString().slice(0,10)} .. ${end.toISOString().slice(0,10)} exclusive)`);
  console.log(`  Mode:     ${dryRun ? 'DRY RUN (nothing sent)' : 'LIVE'}${withRefunds ? ' + refunds' : ''}`);

  // Defensive: ensure the payment-date columns exist (added at runtime by the
  // sales route in normal operation; harmless if already present).
  await invoiceHub.ensureInvoiceHubColumns();
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_paid BOOLEAN`).catch(() => {});

  // Qualifying sales: in-scope channel, real (not estimate/cancelled), paid, and
  // whose payment date (paid_at, else occurred_at) falls in the month.
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
    [invoiceHub.IN_SCOPE_CHANNELS, start, end]
  );

  if (!rows.length) {
    console.log('\nNo qualifying direct cash/bank sales found for that month. Nothing to do.');
    return;
  }

  const cash = rows.filter(r => r.channel === 'direct_cash');
  const bank = rows.filter(r => r.channel === 'direct_bank');
  const refundedRows = rows.filter(r => r.status === 'refunded');
  console.log(`\nFound ${rows.length} sale(s): ${bank.length} bank transfer, ${cash.length} cash` +
              (refundedRows.length ? `  (${refundedRows.length} refunded)` : ''));

  if (dryRun) {
    for (const r of rows) {
      console.log(`  [dry] #${r.id} ${r.channel} £${r.total} ${r.pay_date.toISOString().slice(0,10)} ${r.customer_name || ''}` +
                  (r.status === 'refunded' ? ' (refunded)' : ''));
    }
    console.log(`\nDry run complete — re-run without --dry-run to push.`);
    return;
  }

  let saleOk = 0, saleErr = 0, refundOk = 0, refundErr = 0;
  for (const r of rows) {
    await invoiceHub.pushSale(r.id);
    const st = await query(`SELECT invoice_hub_push_state AS s, invoice_hub_push_error AS e FROM sales WHERE id = $1`, [r.id]);
    const s = st.rows[0] || {};
    if (s.s === 'ok') { saleOk++; }
    else { saleErr++; console.warn(`  ✗ sale #${r.id}: ${s.e || s.s || 'unknown error'}`); }

    if (withRefunds && r.status === 'refunded') {
      await invoiceHub.pushRefund(r.id);
      const rst = await query(`SELECT invoice_hub_refund_state AS s, invoice_hub_refund_error AS e FROM sales WHERE id = $1`, [r.id]);
      const rs = rst.rows[0] || {};
      if (rs.s === 'ok') { refundOk++; }
      else { refundErr++; console.warn(`  ✗ refund #${r.id}: ${rs.e || rs.s || 'unknown error'}`); }
    }
  }

  console.log(`\nDone. Sales pushed: ${saleOk} ok, ${saleErr} failed.` +
              (withRefunds ? `  Refunds: ${refundOk} ok, ${refundErr} failed.` : ''));
  if (saleErr || refundErr) {
    console.log('Failed rows keep their error in invoice_hub_push_error / invoice_hub_refund_error and can be retried.');
    process.exitCode = 1;
  }
}

run()
  .catch(e => { console.error('Backfill failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
