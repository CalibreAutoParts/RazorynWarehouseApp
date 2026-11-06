// lib/onbuy-sync.js — OnBuy as a sales channel, kept in step with the warehouse.
//
//  • Listing: OnBuy is catalogue-based. For each part we look for the product
//    already in OnBuy's catalogue (by barcode/EAN, then by part number as MPN)
//    and add OUR listing to it (sku = warehouse SKU). If it isn't there and we
//    have an EAN-13, we create the catalogue product (title, description,
//    photos, brand, MPN, category) with our listing attached — OnBuy requires
//    an EAN to create products, so parts without one are flagged "needs EAN".
//  • Price: eBay price ± a % (OnBuy fees are lower), rounded to .99; stock =
//    warehouse stock minus an optional hold-back. Changes are pushed in batches
//    of up to 1000 SKUs by the 10-minute job (and on demand).
//  • Orders: imported as sales (channel 'onbuy'), stock comes off and is
//    pushed to eBay + Shopify like any other order; cancellations/refunds net
//    off; dispatching in the app marks the OnBuy order dispatched with tracking.

const { query, withTx } = require('../db');
const onbuy = require('../services/onbuy');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

let _ready = null;
function ensureSchema() {
  if (!_ready) _ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS onbuy_listings (
      product_id   INTEGER PRIMARY KEY,
      sku          TEXT NOT NULL,
      opc          TEXT,
      status       TEXT NOT NULL DEFAULT 'listed',   -- listed | queued | needs_ean | error | removed
      queue_id     TEXT,
      price        NUMERIC(10,2),
      stock_pushed INTEGER,
      price_pushed NUMERIC(10,2),
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS onbuy_listings_sku_idx ON onbuy_listings (LOWER(sku))`);
    // Per-part delivery template (shipping) — overrides the default in OnBuy settings.
    await query(`CREATE TABLE IF NOT EXISTS onbuy_product_prefs (
      product_id INTEGER PRIMARY KEY, delivery_template_id TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // OnBuy orders are sales on channel 'onbuy'.
    try {
      await query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_channel_check`);
      await query(`ALTER TABLE sales ADD CONSTRAINT sales_channel_check CHECK (channel IN ('shopify','ebay_em','ebay_cl','ebay_r3','onbuy','direct_cash','direct_bank','direct_card'))`);
    } catch (e) { console.warn('[onbuy] channel constraint:', e.message); }
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

// ── Settings ───────────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: false, pricePct: -5, roundTo99: true, stockBuffer: 0, handlingTime: 1,
  deliveryTemplateId: '', categoryId: '', brandName: '', condition: 'new', autoImportOrders: true,
  feePct: 9, vatOff: false, protectMargin: true, lastOrderSync: null,
};
async function getSettings() {
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  return { ...DEFAULTS, ...(d.onbuy || {}) };
}
// Settings + the Costs & margins model (for the margin floor on OnBuy prices).
async function pricingSettings() {
  const s = await getSettings();
  try {
    const row = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
    const S = require('./pricing-floor').resolveCostSettings(row);
    s._cost = { ...S, onbuyFeePct: Number(s.feePct) || 9 };
    if (s.vatOff) s._cost.vatRegistered = false;
  } catch (_) {}
  return s;
}
async function saveSettings(patch = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const s = { ...DEFAULTS, ...(cur.onbuy || {}) };
  const numK = ['pricePct', 'stockBuffer', 'handlingTime', 'feePct'];
  if ('categoryId' in patch && patch.categoryId != null) patch.categoryId = String(patch.categoryId);
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in patch) || k === 'lastOrderSync') continue;
    if (numK.includes(k)) { const n = parseFloat(patch[k]); if (Number.isFinite(n)) s[k] = n; }
    else if (typeof DEFAULTS[k] === 'boolean') s[k] = !!patch[k];
    else s[k] = String(patch[k] ?? '').trim().slice(0, 120);
  }
  if ('lastOrderSync' in patch) s.lastOrderSync = patch.lastOrderSync;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify({ ...cur, onbuy: s })]);
  return s;
}

const to99 = v => Math.max(0.99, Math.ceil(round2(v)) - 0.01);   // £12.40 → £12.99, £13.00 → £12.99
// The lowest OnBuy price that still hits the target margin (Costs & margins), or null.
function floorFor(p, s) {
  if (!s._cost || p.cost_price == null || !(parseFloat(p.cost_price) > 0)) return null;
  const pf = require('./pricing-floor');
  const f = pf.computeFloor({ costPrice: p.cost_price, landedCost: p.landed_cost ?? null, isLarge: !!p.large_panel,
    band: p.shipping_band || null, shippingCost: p.shipping_cost, postageInPrice: p.postage_in_price ?? null,
    channel: 'onbuy', settings: s._cost });
  return f.feasible ? f.floor : null;
}
// OnBuy price from the eBay price (or Shopify's when there's no eBay price),
// never below the margin floor when "protect margin" is on.
function priceFor(p, s) {
  const base = parseFloat(p.price_ebay) || parseFloat(p.price_shopify) || 0;
  if (!(base > 0)) return null;
  let v = base * (1 + (Number(s.pricePct) || 0) / 100);
  if (s.protectMargin) { const f = floorFor(p, s); if (f && v < f) v = f; }
  if (s.roundTo99) v = to99(v);
  return round2(v);
}
// Net profit + margin at a price on OnBuy (null without a cost).
function marginFor(p, s, price) {
  if (!s._cost || p.cost_price == null || !price) return null;
  return require('./pricing-floor').marginAtPrice({ price, costPrice: p.cost_price, landedCost: p.landed_cost ?? null,
    isLarge: !!p.large_panel, band: p.shipping_band || null, shippingCost: p.shipping_cost,
    postageInPrice: p.postage_in_price ?? null, channel: 'onbuy', settings: s._cost });
}
function stockFor(p, s) {
  // Partner-sourced part: their live stock counts too (own + partner).
  const own = parseInt(p.qty_on_hand) || 0;
  const avail = (p.source_partner_id && p.source_partner_id === p.partner_link_id) ? Math.max(0, own) + Math.max(0, parseInt(p.partner_qty) || 0) : own;
  return Math.max(0, avail - (parseInt(s.stockBuffer) || 0));
}

// EAN-13 / GTIN check digit.
function validEan(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(c.length) || String(code).replace(/\s/g, '').length !== c.length) return false;
  const digits = c.split('').map(Number); const check = digits.pop();
  const sum = digits.reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function listingBlock(p, s) {
  const l = { sku: p.sku, price: priceFor(p, s), stock: stockFor(p, s), handling_time: parseInt(s.handlingTime) || 1 };
  const tpl = p._deliveryTemplateId || s.deliveryTemplateId;
  if (tpl) l.delivery_template_id = String(tpl);
  return l;
}

// Set the OnBuy delivery template for many parts: saved per part (used when
// listed) and pushed straight away to the ones already on OnBuy. templateId ''
// = back to the default from OnBuy settings.
async function setDeliveryTemplate(productIds, templateId) {
  await ensureSchema();
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  const tpl = templateId ? String(templateId) : null;
  for (const id of ids) {
    await query(`INSERT INTO onbuy_product_prefs (product_id, delivery_template_id, updated_at) VALUES ($1,$2,now())
      ON CONFLICT (product_id) DO UPDATE SET delivery_template_id = EXCLUDED.delivery_template_id, updated_at = now()`, [id, tpl]);
  }
  const s = await getSettings();
  const effective = tpl || s.deliveryTemplateId || null;
  const listed = (await query(`SELECT sku FROM onbuy_listings WHERE product_id = ANY($1) AND status = 'listed'`, [ids])).rows;
  let pushed = 0, error = null;
  if (listed.length && effective) {
    try { await onbuy.updateBySku(listed.map(r => ({ sku: r.sku, delivery_template_id: String(effective) }))); pushed = listed.length; }
    catch (e) { error = e.message; }
  }
  return { saved: ids.length, pushed, listed: listed.length, error, noTemplate: !effective };
}

// ── Listing parts on OnBuy ─────────────────────────────────────────────────
async function findOpc(p) {
  const tries = [];
  if (validEan(p.barcode)) tries.push(['product_code', String(p.barcode).replace(/\D/g, '')]);
  // Every common way the part number is written (86563-G2550 / 86563G2550 /
  // spaced Stellantis groups), plus public alternate numbers — OnBuy's catalogue
  // stores manufacturers' numbers in different forms.
  const { allPnForms } = require('./part-numbers');
  let alts = [];
  try { alts = (await query(`SELECT code FROM product_part_numbers WHERE product_id = $1 AND NOT COALESCE(private, false) ORDER BY id LIMIT 5`, [p.id])).rows.map(r => r.code); } catch (_) {}
  const forms = allPnForms(p.part_number || null, [p.sku !== p.part_number ? p.sku : null, ...alts].filter(Boolean), { cap: 8 });
  for (const f of forms) tries.push(['mpn', f]);
  for (const [field, value] of tries) {
    const hits = await onbuy.searchProducts(field, value, { limit: 5 }).catch(() => []);
    if (hits.length === 1) return { opc: hits[0].opc, name: hits[0].name, via: field };
    // Several MPN hits: only trust one whose product codes include our EAN.
    if (hits.length > 1 && field === 'product_code') return { opc: hits[0].opc, name: hits[0].name, via: field };
  }
  return null;
}

async function productPayload(p, s) {
  let images = [];
  try { images = await require('./trade').brandedImages(p); } catch (_) {}
  if (!images.length && p.image_url) images = [p.image_url];
  images = [...new Set(images)].filter(u => /^https:\/\//.test(u));
  const desc = String(p.ebay_description || '').replace(/<!--RZN_DESC_BODY-->|<!--\/RZN_DESC_BODY-->/g, '') || p.title;
  const points = [p.part_number ? `Part number: ${p.part_number}` : null,
    [p.brand, p.model].filter(Boolean).length ? `Fits: ${[p.brand, p.model].filter(Boolean).join(' ')}` : null,
    p.position ? `Position: ${p.position}` : null].filter(Boolean);
  return {
    uid: `wh-${p.id}`, published: '1', category_id: String(s.categoryId),
    product_codes: [String(p.barcode).replace(/\D/g, '')], mpn: p.part_number || p.sku,
    product_name: String(p.title).slice(0, 150), brand_name: s.brandName || p.brand || 'Unbranded',
    description: desc.slice(0, 20000), default_image: images[0], additional_images: images.slice(1, 10),
    summary_points: points, rrp: p.price_shopify ? String(p.price_shopify) : undefined,
    listings: { [s.condition || 'new']: listingBlock(p, s) },
  };
}

// List the given products. Returns per-product outcomes.
async function listProducts(productIds) {
  await ensureSchema();
  const s = await pricingSettings();
  const out = [];
  const rows = (await query(`SELECT p.*, pp.delivery_template_id AS "_deliveryTemplateId" FROM products p
    LEFT JOIN onbuy_product_prefs pp ON pp.product_id = p.id WHERE p.id = ANY($1) AND p.active = true`, [productIds])).rows;
  for (const p of rows) {
    const r = { productId: p.id, sku: p.sku };
    try {
      const ex = (await query(`SELECT status FROM onbuy_listings WHERE product_id = $1`, [p.id])).rows[0];
      if (ex && ['listed', 'queued'].includes(ex.status)) { r.result = 'already'; out.push(r); continue; }
      if (!priceFor(p, s)) throw new Error('no eBay / Shopify price to base the OnBuy price on');
      const hit = await findOpc(p);
      if (hit) {
        await onbuy.createListing(hit.opc, listingBlock(p, s), s.condition || 'new');
        await upsert(p, { opc: hit.opc, status: 'listed', price: priceFor(p, s), stock_pushed: stockFor(p, s), price_pushed: priceFor(p, s), error: null });
        r.result = 'listed'; r.opc = hit.opc; r.via = hit.via; r.onbuyName = hit.name;
      } else if (validEan(p.barcode)) {
        if (!s.categoryId) throw new Error('set a default OnBuy category in OnBuy settings to create new products');
        const payload = await productPayload(p, s);
        if (!payload.default_image) throw new Error('needs at least one photo (https) to create the OnBuy product');
        const d = await onbuy.createProduct(payload);
        const qid = d?.results?.queue_id || d?.queue_id || (Array.isArray(d?.results) ? d.results[0]?.queue_id : null);
        await upsert(p, { status: 'queued', queue_id: qid ? String(qid) : null, price: priceFor(p, s), stock_pushed: stockFor(p, s), price_pushed: priceFor(p, s), error: null });
        r.result = 'queued'; r.queueId = qid;
      } else {
        await upsert(p, { status: 'needs_ean', error: 'Not in OnBuy\'s catalogue yet (searched by barcode and every form of the part number). OnBuy only creates new products that have an EAN-13 barcode.' });
        r.result = 'needs_ean';
      }
    } catch (e) {
      await upsert(p, { status: 'error', error: e.message.slice(0, 500) }).catch(() => {});
      r.result = 'error'; r.error = e.message;
    }
    out.push(r);
    await new Promise(res => setTimeout(res, 250));
  }
  return out;
}

async function upsert(p, f) {
  await query(`INSERT INTO onbuy_listings (product_id, sku, opc, status, queue_id, price, stock_pushed, price_pushed, error, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
    ON CONFLICT (product_id) DO UPDATE SET sku = EXCLUDED.sku, opc = COALESCE(EXCLUDED.opc, onbuy_listings.opc), status = EXCLUDED.status,
      queue_id = COALESCE(EXCLUDED.queue_id, onbuy_listings.queue_id), price = COALESCE(EXCLUDED.price, onbuy_listings.price),
      stock_pushed = COALESCE(EXCLUDED.stock_pushed, onbuy_listings.stock_pushed), price_pushed = COALESCE(EXCLUDED.price_pushed, onbuy_listings.price_pushed),
      error = EXCLUDED.error, updated_at = now()`,
    [p.id, p.sku, f.opc || null, f.status, f.queue_id || null, f.price ?? null, f.stock_pushed ?? null, f.price_pushed ?? null, f.error ?? null]);
}

// New products are processed in OnBuy's queue — pick up the results.
async function checkQueues() {
  await ensureSchema();
  const rows = (await query(`SELECT * FROM onbuy_listings WHERE status = 'queued' AND queue_id IS NOT NULL LIMIT 100`)).rows;
  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      const q = await onbuy.queue(r.queue_id);
      if (q.status === 'success') {
        await query(`UPDATE onbuy_listings SET status = 'listed', opc = $2, error = NULL, updated_at = now() WHERE product_id = $1`, [r.product_id, q.opc || null]);
        done++;
      } else if (q.status === 'failed') {
        await query(`UPDATE onbuy_listings SET status = 'error', error = $2, updated_at = now() WHERE product_id = $1`,
          [r.product_id, String(q.error_message || q.message || 'OnBuy rejected the product').slice(0, 500)]);
        failed++;
      }
    } catch (e) { /* try again next run */ }
  }
  return { checked: rows.length, done, failed };
}

// Push stock + price for every listed product whose numbers changed.
async function pushStockAndPrices({ all = false } = {}) {
  await ensureSchema();
  const s = await pricingSettings();
  const rows = (await query(`SELECT p.*, ol.* FROM onbuy_listings ol
    JOIN products p ON p.id = ol.product_id WHERE ol.status = 'listed'`)).rows;
  const batch = [];
  for (const r of rows) {
    const stock = r.active ? stockFor(r, s) : 0;
    const price = priceFor(r, s);
    if (!all && stock === r.stock_pushed && (price == null || Number(price) === Number(r.price_pushed))) continue;
    batch.push({ sku: r.sku, stock, ...(price != null ? { price } : {}), _pid: r.product_id });
  }
  if (!batch.length) return { pushed: 0 };
  await onbuy.updateBySku(batch.map(({ _pid, ...l }) => l));
  for (const b of batch) {
    await query(`UPDATE onbuy_listings SET stock_pushed = $2, price_pushed = COALESCE($3, price_pushed), price = COALESCE($3, price), updated_at = now() WHERE product_id = $1`,
      [b._pid, b.stock, b.price ?? null]);
  }
  return { pushed: batch.length };
}

async function removeListing(productId) {
  await ensureSchema();
  const r = (await query(`SELECT * FROM onbuy_listings WHERE product_id = $1`, [productId])).rows[0];
  if (!r) return { ok: true };
  if (r.status === 'listed') await onbuy.deleteBySku([r.sku]);
  await query(`DELETE FROM onbuy_listings WHERE product_id = $1`, [productId]);
  return { ok: true };
}

// ── Orders → sales ─────────────────────────────────────────────────────────
const CANCELLED = /cancel/i, REFUNDED = /refund/i;
async function importOrders() {
  await ensureSchema();
  const s = await getSettings();
  const since = s.lastOrderSync;
  const started = new Date();
  const fmt = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
  let inserted = 0, existing = 0, reconciled = 0;
  const brandMod = require('./brand');
  const sync = require('../services/sync');
  for (const status of since ? ['all'] : ['awaiting_dispatch']) {
    for (let offset = 0; offset < 2000; offset += 50) {
      const orders = await onbuy.getOrders({ status, modifiedSince: since ? fmt(since) : null, limit: 50, offset });
      for (const o of orders) {
        const r = await importOne(o, { brandMod, sync });
        if (r === 'inserted') inserted++; else if (r === 'reconciled') reconciled++; else existing++;
      }
      if (orders.length < 50) break;
    }
  }
  await saveSettings({ lastOrderSync: new Date(started.getTime() - 5 * 60 * 1000).toISOString() });
  return { inserted, existing, reconciled };
}

async function importOne(o, { brandMod, sync }) {
  const ex = (await query(`SELECT id, status FROM sales WHERE external_order_id = $1 AND channel = 'onbuy'`, [o.order_id])).rows[0];
  const total = parseFloat(o.price_total) || 0;
  if (ex) {
    // Cancelled / refunded on OnBuy → net it off (same path as eBay refunds).
    if ((CANCELLED.test(o.status) || REFUNDED.test(o.status)) && ex.status !== 'refunded') {
      const refunded = REFUNDED.test(o.status) && o.price_refunded != null ? parseFloat(o.price_refunded) : total;
      try {
        const { ensureRefundColumns, reconcileSaleRefund } = require('./refunds');
        await ensureRefundColumns();
        await reconcileSaleRefund(ex.id, { channelRefund: refunded });
        return 'reconciled';
      } catch (e) { console.warn('[onbuy] refund reconcile:', e.message); }
    }
    return 'existing';
  }
  if (CANCELLED.test(o.status)) return 'existing';   // never imported, already cancelled
  const ukVat = require('./uk-vat');
  const vr = (await query(`SELECT vat_rate, vat_registered FROM app_settings WHERE id = 1`)).rows[0] || {};
  const st = await getSettings();
  const subtotal = parseFloat(o.price_subtotal) || 0, shipping = parseFloat(o.price_delivery) || 0;
  const addr = o.delivery_address || {};
  // UK delivery from a VAT-registered business → VAT is the portion of the gross;
  // outside the UK (or the OnBuy account is run without VAT) → none.
  const domestic = !addr.country_code || /^(GB|UK)$/i.test(addr.country_code);
  const vat = vr.vat_registered && !st.vatOff && domestic ? ukVat.vatPortion(subtotal + shipping, parseFloat(vr.vat_rate || 20)) : 0;
  const ref = `${brandMod.invoicePrefix || 'REP'}-O-${o.order_id}`;
  const addressText = [addr.name, addr.line_1, addr.line_2, addr.line_3, addr.town, addr.county, addr.postcode, addr.country].filter(Boolean).join('\n');
  const items = [];
  let saleId = null;
  await withTx(async (c) => {
    const sale = (await c.query(`INSERT INTO sales (channel, external_order_id, customer_name, customer_email, customer_phone, subtotal, vat, shipping, total,
        status, occurred_at, shipping_address, payment_method, payment_reference, order_number, invoice_number, fulfillment_method, notes)
      VALUES ('onbuy',$1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,'onbuy',$11,$1,$11,'ship',$12) RETURNING id`,
      [o.order_id, o.buyer?.name || addr.name || null, o.buyer?.email || null, o.buyer?.phone || null, subtotal, vat, shipping, total,
       o.date ? new Date(o.date.replace(' ', 'T') + 'Z') : new Date(), addressText || null, ref,
       o.sales_fee_inc_VAT != null ? `OnBuy fee £${o.sales_fee_inc_VAT} inc VAT · ${o.delivery_service || ''}`.trim() : null])).rows[0];
    saleId = sale.id;
    for (const li of o.products || []) {
      const qty = parseInt(li.quantity) || 1;
      const matched = await sync.resolveProductBySku(c, li.sku);
      await c.query(`INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.id, matched?.id || null, li.sku || 'ONBUY', li.name, qty, parseFloat(li.unit_price) || 0, parseFloat(li.total_price) || 0]);
      if (matched) {
        await c.query(`UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = now() WHERE id = $2`, [qty, matched.id]);
        await c.query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id) VALUES ($1,$2,'sale_onbuy',$3)`, [matched.id, -qty, sale.id]);
        if (sync.mirrorSaleToStockGroup) await sync.mirrorSaleToStockGroup(c, matched.id, qty, 'sale_onbuy', sale.id);
        items.push({ productId: matched.id, sku: li.sku, title: li.name, qty });
      }
    }
  });
  // Same follow-through as any channel order: push stock everywhere + "sold" alert.
  setImmediate(() => {
    sync.pushStockForSaleItems(items).catch(() => {});
    for (const it of items) sync.handleStockOutIfIncoming?.(it.productId)?.catch?.(() => {});
    pushStockAndPrices().catch(() => {});
  });
  try { require('./notify').saleSold({ saleId, channel: 'onbuy', ref: o.order_id, customer: o.buyer?.name, total, occurredAt: new Date(), items: items.map(i => ({ title: i.title, sku: i.sku, qty: i.qty })) }); } catch (_) {}
  return 'inserted';
}

// Called by Dispatch when an OnBuy order is marked dispatched.
async function pushDispatch(sale) {
  return onbuy.dispatchOrder(sale.external_order_id, { trackingNumber: sale.tracking_number || null, carrier: sale.carrier || sale.tracking_company || null, url: sale.tracking_url || null });
}

// The 10-minute job.
let _running = false;
async function runAll() {
  if (_running || !onbuy.isConfigured()) return { skipped: true };
  const s = await getSettings();
  if (!s.enabled) return { skipped: 'disabled' };
  _running = true;
  try {
    const out = {};
    if (s.autoImportOrders) out.orders = await importOrders().catch(e => ({ error: e.message }));
    out.queues = await checkQueues().catch(e => ({ error: e.message }));
    out.stock = await pushStockAndPrices().catch(e => ({ error: e.message }));
    return out;
  } finally { _running = false; }
}

module.exports = { setDeliveryTemplate, ensureSchema, getSettings, pricingSettings, saveSettings, priceFor, floorFor, marginFor, stockFor, validEan, findOpc, listProducts, checkQueues,
  pushStockAndPrices, removeListing, importOrders, importOne, pushDispatch, runAll };
