// lib/invoice-links.js — customer-facing invoice download links.
//
// Each sale gets a stable, unguessable URL: /invoice/<saleId>/<signature>.pdf
// The signature is an HMAC of the sale id, so the link can't be guessed or
// walked (changing the id breaks it) and needs no DB row. The PDF is rendered
// fresh on every download, so it always reflects refunds/edits.
//
// Links are written onto the matching Shopify order (metafield razoryn.invoice_url)
// so the storefront account page can offer "Download invoice".
//
// Secret: INVOICE_LINK_SECRET if set, else JWT_SECRET. Changing it invalidates
// every link already handed out (they're re-pushed on the next sync only for
// sales not yet stamped — see services/sync.js pushInvoiceLinksToShopify).
const crypto = require('crypto');
const brand = require('./brand');

function secret() {
  return process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me';
}

function signSale(saleId) {
  return crypto.createHmac('sha256', secret()).update(`invoice:${saleId}`).digest('base64url').slice(0, 32);
}

function verifySale(saleId, sig) {
  const expected = signSale(saleId);
  const given = String(sig || '');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Public origin of this backend (the Warehouse Hub), e.g. https://warehouse.razoryn.co.uk
function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || `https://warehouse.${brand.domain}`).replace(/\/$/, '');
}

function invoiceUrlForSale(saleId) {
  return `${publicBaseUrl()}/invoice/${saleId}/${signSale(saleId)}.pdf`;
}

module.exports = { signSale, verifySale, invoiceUrlForSale, publicBaseUrl };
