// routes/onbuy.js — OnBuy channel admin: connection, settings, listing, sync.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const onbuy = require('../services/onbuy');
const ob = require('../lib/onbuy-sync');

const router = express.Router();
router.use(requireAuth, requireAdmin);
const safe = (fn) => (req, res) => fn(req, res).catch(e => {
  console.warn('[onbuy]', e.message);
  res.status(e.code === 'onbuy_not_configured' ? 400 : 502).json({ error: e.code || 'onbuy_error', message: e.message });
});

// GET /api/onbuy/status — keys present, settings, listing counts, recent orders.
router.get('/status', safe(async (req, res) => {
  await ob.ensureSchema();
  const settings = await ob.getSettings();
  const counts = (await query(`SELECT status, COUNT(*)::int AS n FROM onbuy_listings GROUP BY status`)).rows
    .reduce((a, r) => (a[r.status] = r.n, a), {});
  const orders = (await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0) AS total FROM sales
    WHERE channel = 'onbuy' AND occurred_at >= now() - interval '30 days' AND status NOT IN ('refunded','cancelled')`)).rows[0];
  res.json({ configured: onbuy.isConfigured(), keys: onbuy.keyInfo(), siteId: onbuy.SITE_ID, settings, counts,
    orders30d: { count: orders.n, total: Number(orders.total) } });
}));

router.post('/test', safe(async (req, res) => { res.json(await onbuy.testConnection()); }));

router.put('/settings', safe(async (req, res) => {
  const s = await ob.saveSettings(req.body || {});
  await audit(req, 'onbuy_settings', null, null, { enabled: s.enabled, pricePct: s.pricePct });
  res.json({ ok: true, settings: s });
}));

router.get('/delivery-templates', safe(async (req, res) => { res.json({ templates: await onbuy.deliveryTemplates() }); }));
router.get('/categories', safe(async (req, res) => { res.json({ categories: await onbuy.categories(String(req.query.q || '').slice(0, 80)) }); }));

// GET /api/onbuy/products?filter=all|listed|unlisted|problems&q=
// Every active product with its OnBuy price/stock/margin + listing state.
router.get('/products', safe(async (req, res) => {
  await ob.ensureSchema();
  const s = await ob.pricingSettings();
  const where = ['p.active = true'], params = [];
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); where.push(`(p.sku ILIKE $${params.length} OR p.title ILIKE $${params.length} OR p.part_number ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`); }
  const f = String(req.query.filter || 'all');
  if (f === 'listed') where.push(`ol.status IN ('listed','queued')`);
  else if (f === 'unlisted') where.push(`(ol.product_id IS NULL OR ol.status = 'removed') AND p.qty_on_hand > 0`);
  else if (f === 'problems') where.push(`ol.status IN ('error','needs_ean')`);
  const rows = (await query(`SELECT p.*, ol.status AS ob_status, ol.opc AS ob_opc, ol.error AS ob_error,
       ol.stock_pushed AS ob_stock_pushed, ol.price_pushed AS ob_price_pushed, ol.updated_at AS ob_updated,
       pp.delivery_template_id AS ob_delivery
     FROM products p LEFT JOIN onbuy_listings ol ON ol.product_id = p.id
     LEFT JOIN onbuy_product_prefs pp ON pp.product_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY (ol.status IS NULL), p.qty_on_hand DESC, p.title LIMIT 2000`, params)).rows;
  const items = rows.map(p => {
    const price = ob.priceFor(p, s);
    const m = ob.marginFor(p, s, price);
    return {
      id: p.id, sku: p.sku, title: p.title, partNumber: p.part_number, imageUrl: p.image_url,
      qty: p.qty_on_hand, stock: ob.stockFor(p, s), priceEbay: p.price_ebay != null ? Number(p.price_ebay) : null,
      price, floor: ob.floorFor(p, s), net: m?.net ?? null, marginPct: m?.marginPct ?? null,
      hasEan: ob.validEan(p.barcode), status: p.ob_status || null, opc: p.ob_opc || null, error: p.ob_error || null,
      stockPushed: p.ob_stock_pushed, pricePushed: p.ob_price_pushed != null ? Number(p.ob_price_pushed) : null,
      deliveryTemplateId: p.ob_delivery || null,
    };
  });
  res.json({ items });
}));

// POST /api/onbuy/list { productIds } | { allInStock: true }
router.post('/list', safe(async (req, res) => {
  await ob.ensureSchema();
  let ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(Number).filter(Boolean) : [];
  if (req.body?.allInStock) {
    ids = (await query(`SELECT p.id FROM products p LEFT JOIN onbuy_listings ol ON ol.product_id = p.id
      WHERE p.active = true AND p.qty_on_hand > 0 AND COALESCE(p.is_placeholder, false) = false
        AND (p.price_ebay IS NOT NULL OR p.price_shopify IS NOT NULL)
        AND (ol.product_id IS NULL OR ol.status IN ('error','removed'))
      ORDER BY p.id LIMIT 200`)).rows.map(r => r.id);
  }
  ids = ids.slice(0, 200);
  if (!ids.length) return res.json({ results: [], summary: {} });
  const results = await ob.listProducts(ids);
  const summary = results.reduce((a, r) => (a[r.result] = (a[r.result] || 0) + 1, a), {});
  await audit(req, 'onbuy_list', null, null, { count: ids.length, summary });
  res.json({ results, summary, more: !!req.body?.allInStock && ids.length === 200 });
}));

// POST /api/onbuy/delivery { productIds, templateId } — shipping for many parts at once.
router.post('/delivery', safe(async (req, res) => {
  const ids = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
  if (!ids.length) return res.status(400).json({ error: 'no_products', message: 'Tick some products first.' });
  const r = await ob.setDeliveryTemplate(ids.slice(0, 5000), req.body?.templateId || '');
  await audit(req, 'onbuy_delivery_template', null, null, { count: ids.length, templateId: req.body?.templateId || null, pushed: r.pushed });
  res.json(r);
}));

router.post('/push', safe(async (req, res) => { res.json(await ob.pushStockAndPrices({ all: !!req.body?.all })); }));
router.post('/check-queues', safe(async (req, res) => { res.json(await ob.checkQueues()); }));
router.post('/import-orders', safe(async (req, res) => { res.json(await ob.importOrders()); }));
router.post('/remove', safe(async (req, res) => {
  const id = parseInt(req.body?.productId);
  if (!id) return res.status(400).json({ error: 'productId_required' });
  await ob.removeListing(id);
  await audit(req, 'onbuy_remove', 'product', id, {});
  res.json({ ok: true });
}));

module.exports = router;
