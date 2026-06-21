// scripts/test-invoice-hub.js — one-shot connectivity check for the Invoice Hub.
//
// Posts a single, clearly-marked TEST sale through the same client the app uses,
// so it exercises INVOICE_HUB_URL / _SECRET / _COMPANY exactly as production
// does. Safe to run repeatedly: it uses a fixed externalId, so the Hub UPDATES
// the same record instead of creating duplicates (this is also how you confirm
// idempotency — run it twice, you should still see only one "SELF-TEST" row).
//
//   railway run node scripts/test-invoice-hub.js          # default £1.20 BANK_TRANSFER sale
//   node scripts/test-invoice-hub.js --amount 5 --cash    # £5 CASH sale
//
// After it succeeds, open the Hub's Invoices & Receipts tab, find the
// "SELF-TEST — safe to delete" row for this company, and delete it.

require('dotenv').config();
const hub = require('../lib/pushToInvoiceHub');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const isCash = process.argv.includes('--cash');
const amount = parseFloat(arg('amount', '1.20')) || 1.20;

async function run() {
  console.log('Invoice Hub self-test');
  console.log('  URL configured:    ', !!process.env.INVOICE_HUB_URL);
  console.log('  SECRET configured: ', !!process.env.INVOICE_HUB_SECRET);
  console.log('  Company:           ', hub.companyName() || '(unset!)');

  if (!hub.isConfigured()) {
    console.error('\n✗ Not configured — set INVOICE_HUB_URL and INVOICE_HUB_SECRET on this service.');
    process.exit(1);
  }

  const event = {
    company: hub.companyName(),
    kind: 'SALE',
    externalId: 'WAREHOUSE-SELFTEST',
    description: 'SELF-TEST — safe to delete (warehouse → Invoice Hub connectivity check)',
    amount,
    amountType: 'GROSS',
    vatRate: isCash ? 0 : 20,
    paymentMethod: isCash ? 'CASH' : 'BANK_TRANSFER',
    counterparty: 'Connectivity Test',
    date: new Date().toISOString().slice(0, 10),
  };

  console.log('\nPosting:', JSON.stringify(event, null, 2));
  try {
    const res = await hub.pushEvents(event);
    console.log('\n✓ Accepted. Hub response:', JSON.stringify(res));
    const r = Array.isArray(res?.results) ? res.results[0] : null;
    if (r && r.status === 'error') {
      console.error(`\n✗ The Hub recorded an error for this event: ${r.error}`);
      console.error('  (Most common cause: INVOICE_HUB_COMPANY does not match a company in the Hub.)');
      process.exit(1);
    }
    console.log('\nNow open the Hub → Invoices & Receipts and delete the "SELF-TEST" row.');
  } catch (e) {
    console.error('\n✗ Push failed:', e.message);
    if (/401/.test(e.message)) console.error('  → INVOICE_HUB_SECRET does not match the Hub\'s INTEGRATION_WEBHOOK_SECRET.');
    if (/Company not found/.test(e.message)) console.error('  → INVOICE_HUB_COMPANY does not match a company name in the Hub.');
    process.exit(1);
  }
}

run().then(() => process.exit(0));
