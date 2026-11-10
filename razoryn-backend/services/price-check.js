// services/price-check.js — "should we order this part?"
//
// For one part number: who sells it new on eBay and for how much (price +
// postage = what the buyer pays), how crowded it is, how well it sells
// (eBay's sold count per listing ÷ how long it's been listed), and what we
// already know (our stock, our price, our own sales). The page then runs the
// eBay profit maths with the supplier's price and the postage, using the cost
// settings (Costs & margins), and shows the most we should pay.
//
// Uses eBay's public Browse API with the app key (no seller login needed).
const { query } = require('../db');

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const median = a => { const b = a.filter(x => x != null).sort((x, y) => x - y); if (!b.length) return null; const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : +((b[m - 1] + b[m]) / 2).toFixed(2); };
const round2 = n => (n == null ? null : +Number(n).toFixed(2));

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS price_checks (
    id SERIAL PRIMARY KEY,
    part_number TEXT NOT NULL,
    query TEXT,
    result JSONB,
    supplier TEXT,
    supplier_cost NUMERIC(12,4), currency TEXT, cost_gbp NUMERIC(12,4),
    postage NUMERIC(10,2), sell_price NUMERIC(10,2), qty INTEGER,
    verdict TEXT, notes TEXT,
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query(`CREATE INDEX IF NOT EXISTS price_checks_pn_idx ON price_checks (upper(part_number))`);
}

// What we already have for this part: products whose SKU, part number or an
// alternate part number matches; their stock, price and 90-day sales.
async function ourSide(pn) {
  const n = norm(pn);
  if (!n) return { products: [], sold90: 0, sold365: 0 };
  const prods = (await query(`
    SELECT p.id, p.sku, p.title, p.part_number, p.qty_on_hand, p.price_ebay, p.price_shopify, p.cost_price, p.landed_cost, p.shopify_product_id
      FROM products p
     WHERE regexp_replace(upper(coalesce(p.part_number,'')), '[^A-Z0-9]', '', 'g') = $1
        OR regexp_replace(upper(coalesce(p.sku,'')), '[^A-Z0-9]', '', 'g') = $1
        OR EXISTS (SELECT 1 FROM product_part_numbers ppn WHERE ppn.product_id = p.id
                    AND regexp_replace(upper(ppn.code), '[^A-Z0-9]', '', 'g') = $1)
     ORDER BY p.active DESC, p.id LIMIT 10`, [n]).catch(() => ({ rows: [] }))).rows;
  if (!prods.length) return { products: [], sold90: 0, sold365: 0 };
  const ids = prods.map(p => p.id);
  const s = (await query(`
    SELECT COALESCE(SUM(si.qty) FILTER (WHERE s.occurred_at > now() - interval '90 days'), 0)::int AS d90,
           COALESCE(SUM(si.qty) FILTER (WHERE s.occurred_at > now() - interval '365 days'), 0)::int AS d365,
           MAX(s.occurred_at) AS last_sale
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE si.product_id = ANY($1) AND s.is_estimate = false AND s.status NOT IN ('cancelled')`, [ids])).rows[0] || {};
  const links = (await query(`SELECT ebay_item_id FROM mirror_links WHERE shopify_product_id::text = ANY($1)`,
    [prods.map(p => String(p.shopify_product_id || '')).filter(Boolean)]).catch(() => ({ rows: [] }))).rows.map(r => String(r.ebay_item_id));
  return { products: prods, sold90: s.d90 || 0, sold365: s.d365 || 0, lastSale: s.last_sale || null, ourItemIds: links };
}

// The eBay market for a part number.
async function market(pn, { q, used = false, demandLimit = 12, ourItemIds = null } = {}) {
  const ebay = require('./ebay');
  const search = String(q || pn).trim();
  const r = await ebay.searchActiveListings({ q: search, conditionIds: used ? undefined : '1000', limit: 100 });
  const n = norm(pn);
  const our = ourItemIds || (await ourSide(pn)).ourItemIds || [];
  const items = r.items.map(it => {
    const total = it.price != null ? round2(it.price + (it.shipping_cost || 0)) : null;
    return {
      itemId: it.external_id, legacyId: it.legacy_id, title: it.title, url: it.url, image: it.image_url,
      price: it.price, postage: it.shipping_cost, postageType: it.shipping_type, total,
      seller: it.seller_username, feedback: it.seller_feedback, positive: it.seller_positive,
      condition: it.condition, createdAt: it.created_at,
      // Exact = the part number is in the title (else eBay matched it on the
      // listing's details — still usually the same part, but check).
      exact: !!n && norm(it.title).includes(n),
      ours: !!it.legacy_id && our.includes(String(it.legacy_id)),
    };
  }).filter(x => x.total != null);

  // Demand: eBay's sold count for the best-matching listings (exact first,
  // cheapest first) → units per month since each was listed.
  const ranked = [...items].sort((a, b) => (b.exact - a.exact) || (a.total - b.total)).slice(0, demandLimit);
  for (const it of ranked) {
    try {
      const d = await ebay.getBrowseItemDemand(it.itemId);
      it.sold = d.sold; it.available = d.available;
      if (d.mpn && n && norm(d.mpn).includes(n)) it.exact = true;
      const created = d.createdAt || it.createdAt;
      if (created) {
        const months = Math.max(0.5, (Date.now() - new Date(created).getTime()) / (30.4 * 86400000));
        it.listedMonths = +months.toFixed(1);
        if (it.sold != null) it.perMonth = +(it.sold / months).toFixed(2);
      }
    } catch (_) { /* demand is best-effort */ }
  }

  const others = items.filter(x => !x.ours);
  const exact = others.filter(x => x.exact);
  const pool = exact.length ? exact : others;      // compare like-for-like when we can
  const totals = pool.map(x => x.total);
  const sellers = new Set(pool.map(x => x.seller).filter(Boolean));
  const withDemand = items.filter(x => x.sold != null);
  const soldTotal = withDemand.reduce((a, x) => a + (x.sold || 0), 0);
  const perMonth = +withDemand.reduce((a, x) => a + (x.perMonth || 0), 0).toFixed(1);
  const lowest = pool.length ? pool.reduce((m, x) => (x.total < m.total ? x : m), pool[0]) : null;

  const competition = sellers.size === 0 ? 'none' : sellers.size <= 3 ? 'low' : sellers.size <= 8 ? 'medium' : 'high';
  const demand = !withDemand.length ? 'unknown' : perMonth >= 10 ? 'high' : perMonth >= 3 ? 'medium' : perMonth > 0.5 ? 'low' : 'very low';

  return {
    query: search, totalListings: r.total, shown: items.length,
    exactCount: exact.length, sellers: sellers.size, competition,
    lowest: lowest ? { total: lowest.total, price: lowest.price, postage: lowest.postage, seller: lowest.seller, url: lowest.url, title: lowest.title } : null,
    median: median(totals), highest: totals.length ? Math.max(...totals) : null,
    demand, perMonth, soldTotal, demandListings: withDemand.length,
    items: items.sort((a, b) => (b.exact - a.exact) || (a.total - b.total)),
  };
}

async function check(pn, opts = {}) {
  const o = await ourSide(pn);
  const m = await market(pn, { ...opts, ourItemIds: o.ourItemIds || [] });
  delete o.ourItemIds;
  return { partNumber: pn, market: m, ours: o, checkedAt: new Date().toISOString() };
}

module.exports = { ensureSchema, check, market, ourSide, norm };
