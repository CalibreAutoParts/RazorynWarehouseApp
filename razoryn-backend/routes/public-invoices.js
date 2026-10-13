// routes/public-invoices.js — PUBLIC customer invoice download (no login).
// GET /invoice/:saleId/:sig.pdf — the HMAC signature in the URL is the credential
// (lib/invoice-links.js). Linked from the customer's Shopify order (metafield
// razoryn.invoice_url) and the storefront "My account" page.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { verifySale } = require('../lib/invoice-links');

const router = express.Router();

// Generous for real customers, hostile to anyone trying signatures.
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests — please try again shortly.',
}));

const fileSafe = (s) => String(s == null ? '' : s).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();

router.get('/:saleId/:sig', async (req, res, next) => {
  try {
    const saleId = parseInt(req.params.saleId, 10);
    const sig = String(req.params.sig || '').replace(/\.pdf$/i, '');
    // Same response for "no such sale" and "bad signature" — don't leak which ids exist.
    const notFound = () => res.status(404).type('text/plain').send('Invoice not found. Please contact us if you need a copy.');
    if (!Number.isFinite(saleId) || !verifySale(saleId, sig)) return notFound();

    const s = await query('SELECT * FROM sales WHERE id = $1', [saleId]);
    const sale = s.rows[0];
    if (!sale || sale.is_estimate) return notFound();

    const salesMod = require('./sales');
    const brand = require('../lib/brand');
    const { buildInvoicePdf } = require('../lib/invoice-pdf');
    await salesMod.enrichSaleCustomer(sale);
    const items = (await query('SELECT * FROM sale_items WHERE sale_id = $1', [saleId])).rows;
    const company = await salesMod.getCompanySettings();
    const mode = sale.payment_method === 'cash' ? 'receipt' : 'invoice';
    const pdf = await buildInvoicePdf({ sale, items, company, brand, mode });

    const ref = sale.invoice_number || sale.payment_reference || `invoice-${sale.id}`;
    const name = `${mode === 'receipt' ? 'Receipt' : 'Invoice'} - ${fileSafe(sale.customer_name) || 'Customer'} - ${fileSafe(ref)}.pdf`;
    // GDPR: invoices carry customer PII — never cache in shared proxies.
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
    res.send(pdf);

    query(`INSERT INTO audit_log (user_id, action, target_type, target_id, metadata, ip_address)
           VALUES (NULL, 'customer_download_invoice', 'sale', $1, $2, $3)`,
      [saleId, JSON.stringify({ via: 'public_link' }), req.ip]).catch(() => {});
  } catch (e) { next(e); }
});

module.exports = router;
