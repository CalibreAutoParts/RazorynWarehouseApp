// routes/pricing.js — feature 9: phone pricing tool (cash = eBay / 0.90)
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/pricing/quote?productId=&qty=1
// Returns all the phone-quoting prices a staff member needs.
router.get('/quote', requirePermission('pricing'), async (req, res) => {
  const { productId, qty = 1 } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId_required' });

  const settings = await query(`SELECT cash_discount_pct, bank_transfer_pct, ebay_buyer_protection_markup, free_delivery_threshold, vat_rate FROM app_settings WHERE id = 1`);
  const s = settings.rows[0] || {};
  const cashDiscountPct = parseFloat(s.cash_discount_pct ?? 10);
  const bankTransferPct = parseFloat(s.bank_transfer_pct ?? 10);
  const ebayMarkup = parseFloat(s.ebay_buyer_protection_markup ?? 0);
  const freeDeliveryThreshold = parseFloat(s.free_delivery_threshold ?? 50);

  const p = await query('SELECT * FROM products WHERE id = $1', [productId]);
  if (!p.rows[0]) return res.status(404).json({ error: 'product_not_found' });
  const pr = p.rows[0];
  const qtyN = Math.max(1, parseInt(qty));

  const shopifyUnit = parseFloat(pr.price_shopify || 0);
  const ebayUnit = parseFloat(pr.price_ebay || 0);
  const cashUnit = +(ebayUnit * (1 - cashDiscountPct / 100)).toFixed(2);
  const bankUnit = +(ebayUnit * (1 - bankTransferPct / 100)).toFixed(2);
  const ebayProtectedUnit = +(ebayUnit * (1 + ebayMarkup / 100)).toFixed(2);

  res.json({
    product: { id: pr.id, sku: pr.sku, title: pr.title, qtyOnHand: pr.qty_on_hand },
    qty: qtyN,
    config: { cashDiscountPct, bankTransferPct, ebayBuyerProtectionMarkup: ebayMarkup, shopifyFreeDeliveryOver: freeDeliveryThreshold },
    quotes: {
      shopify: { unit: shopifyUnit, total: +(shopifyUnit * qtyN).toFixed(2) },
      ebay:    { unit: ebayProtectedUnit, total: +(ebayProtectedUnit * qtyN).toFixed(2) },
      cash:    { unit: cashUnit,    total: +(cashUnit * qtyN).toFixed(2) },
      bank:    { unit: bankUnit,    total: +(bankUnit * qtyN).toFixed(2) },
    },
  });
});

module.exports = router;
