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
const { pool } = require('../db');
const hub = require('../lib/pushToInvoiceHub');
const invoiceHub = require('../services/invoiceHub');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const month = arg('month', '2026-06');           // YYYY-MM
const dryRun = process.argv.includes('--dry-run');
const withRefunds = process.argv.includes('--with-refunds');

async function run() {
  console.log(`Backfill → Invoice Hub`);
  console.log(`  Company:  ${hub.companyName()}`);
  console.log(`  Month:    ${month}`);
  console.log(`  Mode:     ${dryRun ? 'DRY RUN (nothing sent)' : 'LIVE'}${withRefunds ? ' + refunds' : ''}`);

  // Single source of truth: the same routine the Settings "Backfill" button uses.
  const r = await invoiceHub.backfillMonth({ month, dryRun, withRefunds });
  if (!r.ok) {
    console.error(`\n✗ ${r.message || r.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nFound ${r.found} sale(s): ${r.bank} bank transfer, ${r.cash} cash.`);

  if (dryRun) {
    for (const p of r.preview || []) {
      console.log(`  [dry] #${p.id} ${p.channel} £${p.total} ${p.date} ${p.customer || ''}` +
                  (p.refunded ? ' (refunded)' : ''));
    }
    console.log(`\nDry run complete — re-run without --dry-run to push.`);
    return;
  }

  for (const err of r.errors || []) console.warn(`  ✗ ${err.type} #${err.id}: ${err.error}`);
  console.log(`\nDone. Sales pushed: ${r.saleOk} ok, ${r.saleErr} failed.` +
              (withRefunds ? `  Refunds: ${r.refundOk} ok, ${r.refundErr} failed.` : ''));
  if (r.saleErr || r.refundErr) {
    console.log('Failed rows keep their error in invoice_hub_push_error / invoice_hub_refund_error and can be retried.');
    process.exitCode = 1;
  }
}

run()
  .catch(e => { console.error('Backfill failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
