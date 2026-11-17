// lib/ship-terms.js — the delivery the customer chose and paid for, so the
// dispatch list shows which label to buy: the service (Next day / Standard /
// Express…), what they paid for postage, eBay's estimated delivery window
// (what the buyer was promised) and the dispatch-by date.
//
// eBay: from the order (ShippingServiceSelected + ShippingPackageInfo).
// Shopify: the shipping line's title; Shopify gives no date, so the window is
// estimated in working days from the service name.
const { query } = require('../db');

let _cols = false;
async function ensureColumns(run = query) {
  if (_cols) return;
  for (const col of ['ship_service TEXT', 'ship_service_code TEXT', 'ship_paid NUMERIC(10,2)', 'ship_express BOOLEAN',
    'eta_min TIMESTAMPTZ', 'eta_max TIMESTAMPTZ', 'eta_estimated BOOLEAN', 'ship_by TIMESTAMPTZ', 'ship_terms_at TIMESTAMPTZ']) {
    await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ${col}`);
  }
  _cols = true;
}

const EXPRESS_RE = /next[\s-]*day|nextday|24|express|one[\s-]*day|oneday|priority|guaranteed|special\s*delivery|tracked\s*24|by\s*1pm|by\s*9am|same[\s-]*day/i;

// eBay service codes → readable ("UK_OtherCourier24" → "Other courier 24").
function humanService(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const known = {
    UK_OtherCourier24: 'Courier — next day (24h)', UK_OtherCourier48: 'Courier — 48h', UK_OtherCourier: 'Courier — standard',
    UK_OtherCourier3Days: 'Courier — 3 days', UK_OtherCourier5Days: 'Courier — 5 days', UK_OtherCourierOrDeliveryInternational: 'International courier',
    UK_RoyalMailNextDay: 'Royal Mail next day', UK_RoyalMailSpecialDeliveryNextDay: 'Royal Mail Special Delivery (next day)',
    UK_RoyalMailFirstClassStandard: 'Royal Mail 1st class', UK_RoyalMailSecondClassStandard: 'Royal Mail 2nd class',
    UK_RoyalMailTracked24: 'Royal Mail Tracked 24', UK_RoyalMailTracked48: 'Royal Mail Tracked 48',
    UK_ParcelForceExpress24: 'Parcelforce Express 24', UK_ParcelForceExpress48: 'Parcelforce Express 48',
    UK_EconomyShippingFromOutside: 'Economy (from abroad)', UK_StandardShippingFromOutside: 'Standard (from abroad)',
    UK_ExpeditedShippingFromOutside: 'Expedited (from abroad)', UK_CollectInPerson: 'Collection in person',
    UK_SellersStandardRate: 'Standard delivery', UK_EconomyDeliveryFromOutside: 'Economy (from abroad)',
  };
  if (known[c]) return known[c];
  return c.replace(/^UK_/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/(\d+)\s*Days?/i, '$1 days').trim();
}

const el = (xml, tag) => { const m = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
const all = (xml, tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
const iso = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };

// From a Trading API <Order> block.
function fromEbayXml(oXml) {
  const sel = el(oXml, 'ShippingServiceSelected');
  const code = el(sel, 'ShippingService');
  const paid = parseFloat(el(sel, 'ShippingServiceCost')) || 0;
  let min = null, max = null, shipBy = null;
  for (const pi of all(oXml, 'ShippingPackageInfo')) {
    min = min || iso(el(pi, 'EstimatedDeliveryTimeMin') || el(pi, 'MinNativeEstimatedDeliveryTime'));
    max = max || iso(el(pi, 'EstimatedDeliveryTimeMax') || el(pi, 'MaxNativeEstimatedDeliveryTime'));
    shipBy = shipBy || iso(el(pi, 'HandleByTime'));
  }
  shipBy = shipBy || iso(el(oXml, 'ShipByDate'));
  if (!code && !min && !max) return null;
  const name = humanService(code);
  return { service: name, code: code || null, paid, express: EXPRESS_RE.test(code + ' ' + (name || '')), etaMin: min, etaMax: max, estimated: false, shipBy };
}

// Working days from a date (skips Sat/Sun).
function addWorkingDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
  return d;
}

// From a Shopify REST order.
function fromShopifyOrder(order) {
  const lines = order.shipping_lines || [];
  if (!lines.length) return null;
  const l = lines[0];
  const title = String(l.title || l.code || '').trim();
  const paid = lines.reduce((a, x) => a + (parseFloat(x.discounted_price ?? x.price) || 0), 0);
  const express = EXPRESS_RE.test(title + ' ' + (l.code || ''));
  const collect = /collect|pick[\s-]*up/i.test(title);
  // No dates from Shopify — estimate from the order time in working days.
  const placed = new Date(order.created_at || Date.now());
  const ukHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(placed));
  const afterCutoff = ukHour >= 14;   // late orders (UK time) go out the next working day
  const dispatchDay = afterCutoff || placed.getDay() === 0 || placed.getDay() === 6 ? addWorkingDays(placed, 1) : placed;
  const [a, b] = express ? [1, 1] : /2[\s-]*3|48/.test(title) ? [2, 3] : [2, 4];
  return { service: title || null, code: l.code || null, paid, express, collect,
    etaMin: collect ? null : addWorkingDays(dispatchDay, a).toISOString(), etaMax: collect ? null : addWorkingDays(dispatchDay, b).toISOString(),
    estimated: true, shipBy: dispatchDay.toISOString() };
}

async function save(saleId, t, client = null) {
  if (!saleId || !t) return;
  const run = client ? (q, p) => client.query(q, p) : query;
  // Inside an order-import transaction the ALTERs must use the same connection
  // (a separate one would wait on that transaction's lock on sales).
  await ensureColumns(run);
  await run(`UPDATE sales SET ship_service = $2, ship_service_code = $3, ship_paid = $4, ship_express = $5,
      eta_min = $6, eta_max = $7, eta_estimated = $8, ship_by = $9, ship_terms_at = now() WHERE id = $1`,
    [saleId, t.service || null, t.code || null, t.paid ?? null, !!t.express, t.etaMin || null, t.etaMax || null, !!t.estimated, t.shipBy || null]);
}

// Orders waiting to ship that were imported before this existed: look their
// delivery up once (eBay GetOrders by order number, Shopify orders by id).
let _lastBackfill = 0;
async function backfill({ force = false } = {}) {
  if (!force && Date.now() - _lastBackfill < 10 * 60 * 1000) return { skipped: true };
  _lastBackfill = Date.now();
  await ensureColumns();
  const rows = (await query(`SELECT id, channel, external_order_id FROM sales
      WHERE dispatched_at IS NULL AND ship_terms_at IS NULL AND external_order_id IS NOT NULL
        AND is_estimate = false AND status NOT IN ('refunded','cancelled','dispatched')
        AND occurred_at > now() - interval '21 days'
      ORDER BY occurred_at DESC LIMIT 200`)).rows;
  let done = 0;
  // eBay, per account.
  const ebayRows = rows.filter(r => String(r.channel || '').startsWith('ebay_'));
  if (ebayRows.length) {
    const ebay = require('../services/ebay');
    const brand = require('./brand');
    const byChannel = new Map();
    for (const r of ebayRows) { if (!byChannel.has(r.channel)) byChannel.set(r.channel, []); byChannel.get(r.channel).push(r); }
    for (const [channel, list] of byChannel) {
      const store = brand.stores.find(s => s.channelCode === channel);
      if (!store || !ebay.isConfigured(store.code)) continue;
      for (let i = 0; i < list.length; i += 20) {
        const chunk = list.slice(i, i + 20);
        try {
          const xml = await ebay.tradingCall('GetOrders', `<OrderIDArray>${chunk.map(r => `<OrderID>${String(r.external_order_id).replace(/[<&>]/g, '')}</OrderID>`).join('')}</OrderIDArray><DetailLevel>ReturnAll</DetailLevel>`, store.code);
          for (const oXml of all(el(xml, 'OrderArray'), 'Order')) {
            const id = el(oXml, 'OrderID');
            const r = chunk.find(x => String(x.external_order_id) === id);
            const t = fromEbayXml(oXml);
            if (r) { await save(r.id, t || { service: null }); done++; }
          }
        } catch (e) { console.warn('[ship-terms] eBay backfill:', e.message); }
      }
    }
  }
  // Shopify.
  const shopRows = rows.filter(r => r.channel === 'shopify');
  if (shopRows.length) {
    const shopify = require('../services/shopify');
    if (shopify.isConfigured()) {
      for (let i = 0; i < shopRows.length; i += 50) {
        const chunk = shopRows.slice(i, i + 50);
        try {
          const orders = await shopify.getOrdersByIds(chunk.map(r => r.external_order_id));
          for (const o of orders) {
            const r = chunk.find(x => String(x.external_order_id) === String(o.id));
            if (r) { await save(r.id, fromShopifyOrder(o) || { service: null }); done++; }
          }
        } catch (e) { console.warn('[ship-terms] Shopify backfill:', e.message); }
      }
    }
  }
  return { checked: rows.length, done };
}

module.exports = { ensureColumns, fromEbayXml, fromShopifyOrder, save, backfill, humanService };
