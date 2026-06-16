// routes/pricing.js — feature 9: phone pricing tool (cash = eBay / 0.90)
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { roundCashTotal, cheapestCap } = require('../lib/cash-round');

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
  // #6: the bank-transfer price equals the Shopify price. Fall back to the eBay
  // discount only when no Shopify price is on file.
  const bankUnit = shopifyUnit > 0 ? shopifyUnit : +(ebayUnit * (1 - bankTransferPct / 100)).toFixed(2);
  const ebayProtectedUnit = +(ebayUnit * (1 + ebayMarkup / 100)).toFixed(2);

  const shopifyTotal = +(shopifyUnit * qtyN).toFixed(2);
  const ebayTotal = +(ebayProtectedUnit * qtyN).toFixed(2);
  const bankTotal = +(bankUnit * qtyN).toFixed(2);
  // Cash total is rounded (nearest £5, or £1 under £25) and never allowed to
  // exceed the cheapest of bank/eBay/Shopify. Derive the unit back from it.
  const cashTotal = roundCashTotal(cashUnit * qtyN, cheapestCap(bankTotal, ebayTotal, shopifyTotal));
  const cashUnitRounded = qtyN ? +(cashTotal / qtyN).toFixed(2) : cashTotal;

  res.json({
    product: { id: pr.id, sku: pr.sku, title: pr.title, qtyOnHand: pr.qty_on_hand },
    qty: qtyN,
    config: { cashDiscountPct, bankTransferPct, ebayBuyerProtectionMarkup: ebayMarkup, shopifyFreeDeliveryOver: freeDeliveryThreshold },
    quotes: {
      shopify: { unit: shopifyUnit, total: shopifyTotal },
      ebay:    { unit: ebayProtectedUnit, total: ebayTotal },
      cash:    { unit: cashUnitRounded, total: cashTotal },
      bank:    { unit: bankUnit, total: bankTotal },
    },
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Fixed Shopify↔eBay price link (#5)
// Shopify price = eBay price − pct%  (equivalently eBay = Shopify × (1+pct%)).
// direction:
//   'ebay_to_shopify'  master = price_ebay   → derived Shopify = ebay × (1-pct/100)
//   'shopify_to_ebay'  master = price_shopify → derived eBay   = shopify × (1+pct/100)
// Preview-then-apply: preview is read-only; apply pushes to the live channel.
// ──────────────────────────────────────────────────────────────────────────
function deriveLinked(direction, master, pct) {
  const m = parseFloat(master);
  if (!(m > 0)) return null;
  if (direction === 'shopify_to_ebay') return +(m * (1 + pct / 100)).toFixed(2);
  return +(m * (1 - pct / 100)).toFixed(2); // ebay_to_shopify (default)
}

// POST /api/pricing/link/preview { direction, pct }
router.post('/link/preview', requireAdmin, async (req, res) => {
  const direction = req.body?.direction === 'shopify_to_ebay' ? 'shopify_to_ebay' : 'ebay_to_shopify';
  const pct = parseFloat(req.body?.pct);
  if (isNaN(pct) || pct < 0 || pct >= 100) return res.status(400).json({ error: 'invalid_pct' });

  // Skip price-locked products — staff keep those manual, so the linker must
  // never auto-overwrite them.
  const { rows } = await query(`
    SELECT p.id, p.sku, p.title, p.price_ebay, p.price_shopify, p.shopify_product_id
    FROM products p WHERE p.active = true AND COALESCE(p.price_locked, false) = false
    ORDER BY p.title LIMIT 2000`);

  const items = [];
  for (const p of rows) {
    const master = direction === 'shopify_to_ebay' ? p.price_shopify : p.price_ebay;
    const current = direction === 'shopify_to_ebay' ? p.price_ebay : p.price_shopify;
    const newPrice = deriveLinked(direction, master, pct);
    if (newPrice == null) continue;                         // no master price
    // eBay→Shopify needs a Shopify product to write to.
    if (direction === 'ebay_to_shopify' && !p.shopify_product_id) continue;
    const cur = current != null ? parseFloat(current) : null;
    if (cur != null && Math.abs(cur - newPrice) < 0.005) continue; // unchanged
    items.push({
      id: p.id, sku: p.sku, title: p.title,
      masterPrice: parseFloat(master),
      currentPrice: cur,
      newPrice,
      channel: direction === 'shopify_to_ebay' ? 'eBay' : 'Shopify',
      shopifyProductId: p.shopify_product_id || null,
    });
  }
  res.json({ direction, pct, count: items.length, items });
});

// POST /api/pricing/link/apply { direction, pct, items:[{id,newPrice}] }
router.post('/link/apply', requireAdmin, async (req, res) => {
  const direction = req.body?.direction === 'shopify_to_ebay' ? 'shopify_to_ebay' : 'ebay_to_shopify';
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const shopify = require('../services/shopify');
  const ebay = require('../services/ebay');

  const results = [];
  for (const it of items) {
    const price = parseFloat(it.newPrice);
    if (!it.id || isNaN(price) || price < 0) { results.push({ id: it.id, ok: false, error: 'invalid' }); continue; }
    const pr = await query(`SELECT id, sku, shopify_product_id FROM products WHERE id = $1`, [it.id]);
    const product = pr.rows[0];
    if (!product) { results.push({ id: it.id, ok: false, error: 'not_found' }); continue; }
    try {
      if (direction === 'shopify_to_ebay') {
        // Push to every linked eBay listing, then store price_ebay.
        const links = await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`, [product.shopify_product_id]);
        if (!links.rows.length) { results.push({ id: it.id, ok: false, error: 'no_ebay_link' }); continue; }
        const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled);
        let pushed = 0;
        for (const link of links.rows) {
          const store = stores.find(s => s.code === link.store_code) || (link.store_code ? null : stores.find(s => s.primary) || stores[0]);
          if (!store) continue;
          await ebay.reviseItem(link.ebay_item_id, { price }, store.code);
          pushed++;
        }
        await query(`UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`, [price, product.id]);
        results.push({ id: it.id, ok: pushed > 0, pushed });
      } else {
        // eBay→Shopify: set the Shopify variant price, then store price_shopify.
        if (!product.shopify_product_id) { results.push({ id: it.id, ok: false, error: 'no_shopify_product' }); continue; }
        await shopify.setVariantPrice(product.shopify_product_id, price);
        await query(`UPDATE products SET price_shopify = $1, updated_at = now() WHERE id = $2`, [price, product.id]);
        results.push({ id: it.id, ok: true });
      }
    } catch (e) {
      results.push({ id: it.id, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  await audit(req, 'price_link_apply', null, null, { direction, applied: okCount, total: items.length });
  res.json({ applied: okCount, total: items.length, results });
});

module.exports = router;
