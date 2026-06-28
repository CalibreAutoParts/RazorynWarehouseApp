// routes/costs.js — the admin-only "Costs & margins" backroom API.
// Tracks landed unit cost (GBP) per item, supplier cost history, and computes
// per-channel breakeven/floor so admins know the lowest safe price.
const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const fx = require('../lib/fx');
const { computeFloor, marginAtPrice, marginAtOffer, resolveCostSettings } = require('../lib/pricing-floor');

const router = express.Router();
router.use(requireAuth);

// Self-healing schema (idempotent; safe on every cold boot).
let _ready = false;
async function ensureCostSchema() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS product_cost_history (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      supplier TEXT,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      currency TEXT NOT NULL DEFAULT 'CNY',
      unit_cost_foreign NUMERIC(12,4),
      fx_rate NUMERIC(14,8),
      unit_cost_gbp NUMERIC(12,4) NOT NULL,
      qty INTEGER,
      incoming_id INTEGER,
      freight_total NUMERIC(12,2),
      duty NUMERIC(12,2),
      note TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS pch_product_idx ON product_cost_history (product_id, purchase_date DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS pch_supplier_idx ON product_cost_history (supplier)`);
    await fx.ensureFxTable();
    _ready = true;
  } catch (e) { console.warn('[costs] schema migration warning:', e.message); }
}
ensureCostSchema();

async function settingsRow() {
  return (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
}
const today = () => new Date().toISOString().slice(0, 10);

// GET /api/costs/products — product list with cost, floors, margins + flags.
router.get('/products', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const S = resolveCostSettings(await settingsRow());
  const { search = '', belowFloor, overstock, brand = '' } = req.query;
  const where = ['p.active = true'];
  const params = [];
  if (search) { params.push(`%${search}%`); const i = params.length; where.push(`(p.title ILIKE $${i} OR p.sku ILIKE $${i} OR p.part_number ILIKE $${i})`); }
  if (brand) { params.push(brand); where.push(`p.brand = $${params.length}`); }
  const { rows } = await query(`
    SELECT p.id, p.sku, p.title, p.brand, p.model, p.qty_on_hand, p.large_panel, p.shipping_band,
           p.cost_price, p.price_ebay, p.price_shopify, p.image_url,
           lc.supplier AS last_supplier, lc.purchase_date AS last_purchase_date,
           lc.currency AS last_currency, lc.unit_cost_foreign AS last_unit_cost_foreign
    FROM products p
    LEFT JOIN LATERAL (
      SELECT supplier, purchase_date, currency, unit_cost_foreign
      FROM product_cost_history h WHERE h.product_id = p.id
      ORDER BY purchase_date DESC, id DESC LIMIT 1
    ) lc ON true
    WHERE ${where.join(' AND ')}
    ORDER BY p.title
    LIMIT 2000`, params);

  const items = rows.map(r => {
    const cost = r.cost_price != null ? parseFloat(r.cost_price) : null;
    const isLarge = !!r.large_panel;
    const band = r.shipping_band || null;
    const fe = cost != null ? computeFloor({ costPrice: cost, isLarge, band, channel: 'ebay', settings: S }) : null;
    const fs = cost != null ? computeFloor({ costPrice: cost, isLarge, band, channel: 'shopify', settings: S }) : null;
    const pe = r.price_ebay != null ? parseFloat(r.price_ebay) : null;
    const ps = r.price_shopify != null ? parseFloat(r.price_shopify) : null;
    const me = (cost != null && pe) ? marginAtPrice({ price: pe, costPrice: cost, isLarge, band, channel: 'ebay', settings: S }) : { net: null, marginPct: null };
    const ms = (cost != null && ps) ? marginAtPrice({ price: ps, costPrice: cost, isLarge, band, channel: 'shopify', settings: S }) : { net: null, marginPct: null };
    // Margin if we drop the eBay price by the standard "send offer" discount.
    const moe = (cost != null && pe) ? marginAtOffer({ price: pe, costPrice: cost, isLarge, band, channel: 'ebay', settings: S }) : { net: null, marginPct: null, offerPrice: null };
    return {
      id: r.id, sku: r.sku, title: r.title, brand: r.brand, model: r.model,
      qtyOnHand: r.qty_on_hand, largePanel: isLarge, shippingBand: band, imageUrl: r.image_url,
      costPrice: cost, priceEbay: pe, priceShopify: ps,
      lastSupplier: r.last_supplier, lastPurchaseDate: r.last_purchase_date,
      lastCurrency: r.last_currency, lastUnitCostForeign: r.last_unit_cost_foreign != null ? parseFloat(r.last_unit_cost_foreign) : null,
      // floor = recommended price (breakeven + target margin); breakeven = lowest safe price.
      floorEbay: fe ? fe.floor : null, floorShopify: fs ? fs.floor : null,
      breakevenEbay: fe ? fe.breakeven : null, breakevenShopify: fs ? fs.breakeven : null,
      marginEbayPct: me.marginPct, marginShopifyPct: ms.marginPct, netEbay: me.net, netShopify: ms.net,
      offerEbayPct: moe.marginPct, offerEbayPrice: moe.offerPrice, offerEbayNet: moe.net,
      // Would a 5% offer dip below the breakeven (i.e. you'd lose money on it)?
      offerBelowBreakevenEbay: !!(fe && fe.breakeven != null && moe.offerPrice != null && moe.offerPrice < fe.breakeven),
      belowFloorEbay: !!(fe && fe.floor != null && pe != null && pe < fe.floor),
      belowFloorShopify: !!(fs && fs.floor != null && ps != null && ps < fs.floor),
      overstock: !!(cost != null && r.qty_on_hand >= S.overstockThreshold),
    };
  });

  let filtered = items;
  if (belowFloor === '1') filtered = filtered.filter(x => x.belowFloorEbay || x.belowFloorShopify);
  if (overstock === '1') filtered = filtered.filter(x => x.overstock);

  const val = await query(`SELECT COALESCE(SUM(qty_on_hand * cost_price),0) AS v FROM products WHERE active=true AND cost_price IS NOT NULL`);
  res.json({
    items: filtered, settings: S,
    summary: {
      count: items.length,
      withCost: items.filter(x => x.costPrice != null).length,
      belowFloor: items.filter(x => x.belowFloorEbay || x.belowFloorShopify).length,
      overstockCount: items.filter(x => x.overstock).length,
      inventoryValueAtCost: +parseFloat(val.rows[0].v || 0).toFixed(2),
    },
  });
});

// GET /api/costs/products/:id/history — full cost trail + % trend per row.
router.get('/products/:id/history', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const { rows } = await query(`SELECT * FROM product_cost_history WHERE product_id = $1 ORDER BY purchase_date ASC, id ASC`, [req.params.id]);
  let prev = null;
  const history = rows.map(r => {
    const gbp = parseFloat(r.unit_cost_gbp);
    const trendPct = (prev != null && prev > 0) ? +(((gbp - prev) / prev) * 100).toFixed(1) : null;
    prev = gbp;
    return {
      id: r.id, supplier: r.supplier, purchaseDate: r.purchase_date, currency: r.currency,
      unitCostForeign: r.unit_cost_foreign != null ? parseFloat(r.unit_cost_foreign) : null,
      fxRate: r.fx_rate != null ? parseFloat(r.fx_rate) : null, unitCostGbp: gbp,
      qty: r.qty, note: r.note, createdAt: r.created_at, trendPct,
    };
  });
  res.json({ history });
});

// POST /api/costs/products/:id/cost — set current cost (writes history + cost_price).
router.post('/products/:id/cost', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const id = parseInt(req.params.id);
  const pr = await query(`SELECT id, large_panel, shipping_band FROM products WHERE id = $1`, [id]);
  if (!pr.rows[0]) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const currency = String(b.currency || 'CNY').toUpperCase();
  const purchaseDate = b.purchaseDate || today();
  const foreign = (b.unitCostForeign != null && b.unitCostForeign !== '') ? parseFloat(b.unitCostForeign) : null;
  let gbp = (b.unitCostGbp != null && b.unitCostGbp !== '') ? parseFloat(b.unitCostGbp) : null;
  let fxRate = (b.fxRate != null && b.fxRate !== '') ? parseFloat(b.fxRate) : null;
  if (gbp == null) {
    if (foreign == null) return res.status(400).json({ error: 'cost_required', message: 'Enter a foreign unit cost or a GBP cost.' });
    if (currency === 'GBP') { gbp = foreign; fxRate = 1; }
    else {
      try { const conv = await fx.convert(foreign, currency, 'GBP', purchaseDate, { override: fxRate }); gbp = conv.gbp; fxRate = conv.rate; }
      catch (e) { return res.status(502).json({ error: 'fx_unavailable', message: 'Could not get an exchange rate — enter the rate manually.' }); }
    }
  }
  const history = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO product_cost_history (product_id, supplier, purchase_date, currency, unit_cost_foreign, fx_rate, unit_cost_gbp, qty, freight_total, duty, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, b.supplier || null, purchaseDate, currency, foreign, fxRate, gbp,
       b.qty != null ? (parseInt(b.qty) || null) : null,
       b.freightTotal != null && b.freightTotal !== '' ? parseFloat(b.freightTotal) : null,
       b.duty != null && b.duty !== '' ? parseFloat(b.duty) : null, b.note || null, req.user.id]);
    await c.query(`UPDATE products SET cost_price = $1, updated_at = now() WHERE id = $2`, [gbp, id]);
    return ins.rows[0];
  });
  await audit(req, 'cost_set', 'product', id, { gbp, currency, foreign, fxRate });
  const S = resolveCostSettings(await settingsRow());
  const isLarge = !!pr.rows[0].large_panel;
  const band = pr.rows[0].shipping_band || null;
  res.json({
    ok: true, costPrice: gbp, history,
    floors: {
      ebay: computeFloor({ costPrice: gbp, isLarge, band, channel: 'ebay', settings: S }),
      shopify: computeFloor({ costPrice: gbp, isLarge, band, channel: 'shopify', settings: S }),
    },
  });
});

// GET /api/costs/products/:id — one product: cost, floors + components, recent history.
router.get('/products/:id', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const pr = await query(`SELECT id, sku, title, brand, model, qty_on_hand, large_panel, shipping_band, cost_price, price_ebay, price_shopify FROM products WHERE id = $1`, [req.params.id]);
  if (!pr.rows[0]) return res.status(404).json({ error: 'not_found' });
  const p = pr.rows[0];
  const S = resolveCostSettings(await settingsRow());
  const cost = p.cost_price != null ? parseFloat(p.cost_price) : null;
  const isLarge = !!p.large_panel;
  const band = p.shipping_band || null;
  const history = (await query(`SELECT * FROM product_cost_history WHERE product_id = $1 ORDER BY purchase_date DESC, id DESC LIMIT 20`, [p.id])).rows;
  res.json({
    product: { ...p, cost_price: cost },
    floors: cost != null ? {
      ebay: computeFloor({ costPrice: cost, isLarge, band, channel: 'ebay', settings: S }),
      shopify: computeFloor({ costPrice: cost, isLarge, band, channel: 'shopify', settings: S }),
    } : null,
    history,
  });
});

// GET/POST /api/costs/settings — cost knobs (stored in app_settings.data.costs).
router.get('/settings', requireAdmin, async (req, res) => {
  res.json({ settings: resolveCostSettings(await settingsRow()) });
});
router.post('/settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  // Numeric knobs (incl. the new eBay fee components + offer discount). Old keys
  // (ebayFeePct/ebayFixedFee) still accepted for back-compat.
  const numKeys = ['postageSmall', 'postageLarge', 'packagingCost',
    'ebayFvfPct', 'ebayRegulatoryPct', 'ebayHighReturnPct', 'ebayPerOrderFee', 'feesVatPct',
    'ebayFeePct', 'ebayFixedFee', 'shopifyFeePct', 'shopifyFixedFee',
    'adRatePct', 'targetMarginPct', 'offerDiscountPct', 'overstockThreshold'];
  const boolKeys = ['feesVatOnEbay', 'feesVatOnShopify'];
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const costs = { ...(cur.costs || {}) };
  for (const k of numKeys) { if (b[k] != null && b[k] !== '') { const n = parseFloat(b[k]); if (!Number.isNaN(n)) costs[k] = n; } }
  for (const k of boolKeys) { if (b[k] != null) costs[k] = !!b[k]; }
  // Shipping bands: array of { code, label, cost }. Replace wholesale when provided.
  if (Array.isArray(b.shippingBands)) {
    costs.shippingBands = b.shippingBands
      .map(x => ({ code: String(x.code || '').trim(), label: String(x.label || x.code || '').trim(), cost: parseFloat(x.cost) }))
      .filter(x => x.code && !Number.isNaN(x.cost));
  }
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify({ ...cur, costs })]);
  await audit(req, 'cost_settings', null, null, { keys: Object.keys(costs) });
  res.json({ ok: true, settings: resolveCostSettings(await settingsRow()) });
});

// GET /api/costs/fx?from=CNY&to=GBP&date= — live/cached rate for the editor preview.
router.get('/fx', requireAdmin, async (req, res) => {
  const from = String(req.query.from || 'CNY').toUpperCase();
  const to = String(req.query.to || 'GBP').toUpperCase();
  const date = req.query.date || today();
  try { res.json({ rate: await fx.getRate(from, to, date), from, to, date }); }
  catch (e) { res.status(502).json({ error: 'fx_unavailable' }); }
});

// GET /api/costs/overstock — high-stock items + safe clearance price (= floor).
router.get('/overstock', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const S = resolveCostSettings(await settingsRow());
  const { rows } = await query(
    `SELECT id, sku, title, brand, qty_on_hand, large_panel, shipping_band, cost_price, price_ebay
     FROM products WHERE active=true AND cost_price IS NOT NULL AND qty_on_hand >= $1
     ORDER BY qty_on_hand * cost_price DESC LIMIT 500`, [S.overstockThreshold]);
  const items = rows.map(r => {
    const cost = parseFloat(r.cost_price);
    const fe = computeFloor({ costPrice: cost, isLarge: !!r.large_panel, band: r.shipping_band || null, channel: 'ebay', settings: S });
    return {
      id: r.id, sku: r.sku, title: r.title, brand: r.brand, qtyOnHand: r.qty_on_hand,
      costPrice: cost, capitalTied: +(r.qty_on_hand * cost).toFixed(2),
      priceEbay: r.price_ebay != null ? parseFloat(r.price_ebay) : null,
      floorEbay: fe.floor, suggestedClearance: fe.floor,
    };
  });
  res.json({ items, threshold: S.overstockThreshold });
});

// GET /api/costs/valuation — stock value at cost, overall + by brand.
router.get('/valuation', requireAdmin, async (req, res) => {
  const t = await query(`SELECT COALESCE(SUM(qty_on_hand*cost_price),0) AS v,
      COUNT(*) FILTER (WHERE cost_price IS NOT NULL) AS priced,
      COUNT(*) FILTER (WHERE cost_price IS NULL) AS missing
    FROM products WHERE active=true`);
  const byBrand = await query(`SELECT COALESCE(brand,'(none)') AS brand,
      COALESCE(SUM(qty_on_hand*cost_price),0) AS value, COALESCE(SUM(qty_on_hand),0) AS units
    FROM products WHERE active=true AND cost_price IS NOT NULL GROUP BY brand ORDER BY value DESC`);
  res.json({
    totalAtCost: +parseFloat(t.rows[0].v || 0).toFixed(2),
    pricedProducts: parseInt(t.rows[0].priced), missingCost: parseInt(t.rows[0].missing),
    byBrand: byBrand.rows.map(b => ({ brand: b.brand, value: +parseFloat(b.value).toFixed(2), units: parseInt(b.units) })),
  });
});

// GET /api/costs/floors — lightweight per-product floor map for app-wide warnings.
router.get('/floors', requireAdmin, async (req, res) => {
  await ensureCostSchema();
  const S = resolveCostSettings(await settingsRow());
  const { rows } = await query(`SELECT id, large_panel, shipping_band, cost_price FROM products WHERE active=true AND cost_price IS NOT NULL`);
  const floors = {};
  for (const r of rows) {
    const cost = parseFloat(r.cost_price); const isLarge = !!r.large_panel; const band = r.shipping_band || null;
    const fe = computeFloor({ costPrice: cost, isLarge, band, channel: 'ebay', settings: S });
    const fs = computeFloor({ costPrice: cost, isLarge, band, channel: 'shopify', settings: S });
    const fd = computeFloor({ costPrice: cost, isLarge, band, channel: 'direct', settings: S });
    floors[r.id] = {
      costPrice: cost,
      floorEbay: fe.floor, floorShopify: fs.floor, floorDirect: fd.floor,
      breakevenEbay: fe.breakeven, breakevenShopify: fs.breakeven, breakevenDirect: fd.breakeven,
    };
  }
  res.json({ floors, targetMarginPct: S.targetMarginPct });
});

module.exports = router;
