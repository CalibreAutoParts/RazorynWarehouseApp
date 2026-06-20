// services/market-analysis.js — per-product "whole eBay market" analysis.
//
// For one of OUR products, search ALL eBay sellers competing on that part
// (NEW condition only — used/salvage is counted for awareness but never ranked
// as a competitor), rank them by DELIVERED price (item + postage), measure
// saturation, work out where we sit, and compute OUR OWN suggested Promoted
// Listings ad rate (deliberately NOT eBay's inflated suggestion).
const { query } = require('../db');
const ebay = require('./ebay');
const { extractPartType } = require('../lib/vehicle');

const NEW_CONDITION = '1000';
const USED_CONDITIONS = '3000|7000'; // Used + "For parts or not working" (salvage)

const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const AD_RATE_BASE = () => num(process.env.COMPETITOR_AD_RATE_BASE, 2);
const AD_RATE_MIN = () => num(process.env.COMPETITOR_AD_RATE_MIN, 1);
const AD_RATE_MAX = () => num(process.env.COMPETITOR_AD_RATE_MAX, 12);

// Sellers that are us — so we highlight rather than treat ourselves as a rival.
function ourSellers() {
  return String(process.env.OUR_EBAY_SELLERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Delivered price = item + postage (free → +0; unknown/calculated/collection → item only).
function delivered(it) {
  if (it.price == null) return null;
  return Number(it.price) + (it.shipping_free ? 0 : Number(it.shipping_cost || 0));
}

function median(nums) {
  const a = nums.filter(n => n != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Build the eBay search query for a product: exact part number when we have one
// (most precise), else make + model + part type.
function buildMarketQuery(p) {
  if (p.part_number && String(p.part_number).trim()) return String(p.part_number).trim();
  const pt = extractPartType(p.title) || '';
  const q = [p.brand, p.model, pt].filter(Boolean).join(' ').trim();
  return q || p.title;
}

// Our own ad-rate heuristic. Rationale is returned as a breakdown so it's
// explainable and tunable, never a black box.
function suggestAdRate({ saturationNew, ourDelivered, marketMin }) {
  const base = AD_RATE_BASE();
  const breakdown = [{ label: 'Base rate', pct: base }];
  let rate = base;

  // More competing NEW listings → needs more visibility. +0.4% per rival beyond
  // the first, capped at +6%.
  const rivals = Math.max(0, (saturationNew || 1) - 1);
  const satAdj = Math.min(6, Math.round(rivals * 0.4 * 10) / 10);
  rate += satAdj;
  breakdown.push({ label: `Saturation (${saturationNew || 0} NEW listings)`, pct: satAdj });

  // Price position: if we're dearer than the cheapest, push harder (proportional,
  // capped +5%). If we're the cheapest, ease off (−1%).
  let posAdj = 0, posLabel = 'Price position';
  if (ourDelivered != null && marketMin != null && marketMin > 0) {
    const abovePct = ((ourDelivered - marketMin) / marketMin) * 100;
    if (abovePct > 0.5) { posAdj = Math.min(5, Math.round(abovePct * 0.25 * 10) / 10); posLabel = `Price position (${abovePct.toFixed(0)}% above cheapest)`; }
    else { posAdj = -1; posLabel = 'Price position (we are cheapest)'; }
  }
  rate += posAdj;
  breakdown.push({ label: posLabel, pct: posAdj });

  const min = AD_RATE_MIN(), max = AD_RATE_MAX();
  const suggested = Math.max(min, Math.min(max, Math.round(rate * 10) / 10));
  return { suggested, breakdown, bounds: { min, max } };
}

// Analyse one product's market. persist=true stores a snapshot row.
async function analyzeProductMarket(productId, { persist = true, limit = 100, marketplaceId } = {}) {
  const p = (await query(
    `SELECT id, sku, title, brand, model, part_number, price_ebay, price_shopify,
            ebay_listing_id_em, ebay_listing_id_cl
       FROM products WHERE id = $1`, [productId]
  )).rows[0];
  if (!p) throw new Error('product not found');

  const q = buildMarketQuery(p);
  const us = ourSellers();

  // NEW listings (ranked) + used saturation (count only).
  const [{ items, total: saturationNew }, saturationUsed] = await Promise.all([
    ebay.searchActiveListings({ q, conditionIds: NEW_CONDITION, marketplaceId, limit }),
    ebay.countActiveListings({ q, conditionIds: USED_CONDITIONS, marketplaceId }),
  ]);

  // Rank sellers by cheapest delivered listing each (one row per seller).
  const bySeller = new Map();
  const allDelivered = [];
  for (const it of items) {
    const d = delivered(it);
    if (d != null) allDelivered.push(d);
    const key = (it.seller_username || it.external_id || '').toLowerCase();
    const isUs = it.seller_username && us.includes(it.seller_username.toLowerCase());
    const row = { ...it, delivered: d, is_us: !!isUs };
    const cur = bySeller.get(key);
    if (!cur || (d != null && (cur.delivered == null || d < cur.delivered))) bySeller.set(key, row);
  }
  const sellers = [...bySeller.values()].sort((a, b) => {
    if (a.delivered == null) return 1;
    if (b.delivered == null) return -1;
    return a.delivered - b.delivered;
  }).map((s, i) => ({ ...s, rank: i + 1 }));

  const minDelivered = allDelivered.length ? Math.min(...allDelivered) : null;
  const medianDelivered = median(allDelivered);

  // Where do WE sit? Prefer our actual listing in the results; else fall back to
  // our stored price (assume free postage on ours).
  const ourRow = sellers.find(s => s.is_us) || null;
  const ourDelivered = ourRow ? ourRow.delivered
    : (p.price_ebay != null ? Number(p.price_ebay) : (p.price_shopify != null ? Number(p.price_shopify) : null));
  let ourRank = ourRow ? ourRow.rank : null;
  if (ourRank == null && ourDelivered != null) {
    ourRank = 1 + allDelivered.filter(d => d < ourDelivered).length;
  }

  const adRate = suggestAdRate({ saturationNew, ourDelivered, marketMin: minDelivered });

  if (persist) {
    await query(
      `INSERT INTO product_market_snapshot
        (product_id, query, saturation_new, saturation_used, seller_count,
         min_delivered, median_delivered, our_delivered, our_rank, suggested_ad_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, q, saturationNew, saturationUsed, sellers.filter(s => !s.is_us).length,
       minDelivered, medianDelivered, ourDelivered, ourRank, adRate.suggested]
    );
  }

  return {
    product: { id: p.id, sku: p.sku, title: p.title, ebay_item_id: p.ebay_listing_id_em || p.ebay_listing_id_cl || null },
    query: q,
    saturationNew, saturationUsed,
    minDelivered, medianDelivered,
    ourDelivered, ourRank,
    adRate,
    // Cap the ranked list sent to the UI.
    sellers: sellers.slice(0, 50),
  };
}

// Periodic refresh: snapshot the market for products that have at least one
// matched competitor listing (bounded per run to respect API limits).
async function refreshMarkets(limit = 25) {
  const { rows } = await query(
    `SELECT DISTINCT m.product_id
       FROM competitor_match m
      WHERE m.product_id IS NOT NULL
      ORDER BY m.product_id
      LIMIT $1`, [limit]
  );
  const out = { products: 0, errors: 0 };
  for (const r of rows) {
    try { await analyzeProductMarket(r.product_id, { persist: true }); out.products++; }
    catch (e) { out.errors++; }
  }
  return out;
}

module.exports = { analyzeProductMarket, refreshMarkets, suggestAdRate, buildMarketQuery };
