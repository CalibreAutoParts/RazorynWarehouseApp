// lib/pushToInvoiceHub.js — low-level client for the Razoryn Invoice Hub.
//
// The Invoice Hub exposes one secure endpoint that ingests sales / refunds and
// works out VAT automatically. This module is the thin transport layer: it
// knows the URL, the shared secret and which company this deployment posts as.
// The decision of *what* to send (and the per-sale state tracking / retry) lives
// in services/invoiceHub.js — keeping this file a dumb, well-tested POSTer.
//
// Per-deployment config (Railway Variables — one warehouse service per company):
//   INVOICE_HUB_URL     = https://razoryninvoice-production.up.railway.app
//   INVOICE_HUB_SECRET  = same value as the Hub's INTEGRATION_WEBHOOK_SECRET
//   INVOICE_HUB_COMPANY = "Razoryn EParts"  (or "Calibre Auto Parts" on Calibre)
//
// INVOICE_HUB_COMPANY falls back to the active brand's name so an un-set var
// still posts to a sensible company, but it should be set explicitly because the
// Hub matches on the trading/legal name and the brand name ("Razoryn e-Parts")
// is not guaranteed to resolve.

const axios = require('axios');
const brand = require('./brand');

const HUB_URL = (process.env.INVOICE_HUB_URL || '').replace(/\/+$/, '');
const HUB_SECRET = process.env.INVOICE_HUB_SECRET || '';
const HUB_COMPANY = process.env.INVOICE_HUB_COMPANY || brand.name;

// True only when both the endpoint and the secret are present. Callers should
// skip silently when this is false (dev / un-configured deployments).
function isConfigured() {
  return !!(HUB_URL && HUB_SECRET);
}

// The company string posted on every event for this deployment.
function companyName() {
  return HUB_COMPANY;
}

// POST one event or an array of events (a batch) to the Hub. Retries transient
// failures (network errors / 5xx) with exponential backoff. 4xx responses are
// caller mistakes — surfaced immediately without retry. The Hub treats
// (company + externalId) as unique, so retries never create duplicates.
async function pushEvents(events, { retries = 4 } = {}) {
  if (!isConfigured()) {
    throw new Error('Invoice Hub not configured (INVOICE_HUB_URL / INVOICE_HUB_SECRET unset)');
  }
  const url = `${HUB_URL}/api/integrations/transactions`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, events, {
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': HUB_SECRET,
        },
        timeout: 15000,
        // We handle status codes ourselves so 4xx doesn't throw before we can
        // tell retryable (5xx) from non-retryable (4xx).
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      // Client errors won't get better on retry — fail fast.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Invoice Hub rejected push (${res.status}): ${body}`);
      }
      lastErr = new Error(`Invoice Hub error (${res.status}): ${body}`);
    } catch (e) {
      // Non-retryable rejection thrown above — re-throw immediately.
      if (/rejected push/.test(e.message)) throw e;
      lastErr = e;
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt))); // 2s, 4s, 8s, 16s
    }
  }
  throw lastErr || new Error('Invoice Hub push failed');
}

module.exports = { isConfigured, companyName, pushEvents };
