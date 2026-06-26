// lib/pricing-floor.js — the single source of truth for cost-based pricing.
//
// Given an item's landed unit cost (GBP) plus the configured selling costs, work
// out the BREAKEVEN price and a recommended FLOOR (breakeven + a margin cushion)
// per channel. Prices in this business are VAT-INCLUSIVE, so percentage selling
// fees, the ad rate and the VAT we owe HMRC all scale with the sale price — they
// must be solved for, not just added on. Pure functions, no DB access, so the
// routes compute floors server-side and the frontend just consumes the numbers.

const DEFAULTS = {
  postageSmall: 3.20,   // GBP, average parcel cost for a normal item
  postageLarge: 9.50,   // GBP, used when products.large_panel = true
  packagingCost: 0.60,  // GBP, packing materials per order
  ebayFeePct: 12.8,     // eBay final value fee % of gross (UK parts ~12.8)
  ebayFixedFee: 0.30,   // eBay fixed per-order fee (GBP)
  shopifyFeePct: 1.9,   // Shopify Payments online card rate % (UK ~1.9)
  shopifyFixedFee: 0.25,// Shopify per-transaction fixed (GBP)
  adRatePct: 0,         // promoted-listing ad rate % of gross (eBay only)
  targetMarginPct: 15,  // uplift over breakeven → recommended floor
  overstockThreshold: 25,
};

function num(v, d) {
  const n = parseFloat(v);
  return (v != null && v !== '' && !Number.isNaN(n)) ? n : d;
}

// Merge the saved app_settings.data.costs over DEFAULTS and fold in VAT (which
// lives on the main settings, not duplicated). `row` = an app_settings row.
function resolveCostSettings(row) {
  row = row || {};
  const c = (row.data && row.data.costs) || {};
  return {
    postageSmall:      num(c.postageSmall, DEFAULTS.postageSmall),
    postageLarge:      num(c.postageLarge, DEFAULTS.postageLarge),
    packagingCost:     num(c.packagingCost, DEFAULTS.packagingCost),
    ebayFeePct:        num(c.ebayFeePct, DEFAULTS.ebayFeePct),
    ebayFixedFee:      num(c.ebayFixedFee, DEFAULTS.ebayFixedFee),
    shopifyFeePct:     num(c.shopifyFeePct, DEFAULTS.shopifyFeePct),
    shopifyFixedFee:   num(c.shopifyFixedFee, DEFAULTS.shopifyFixedFee),
    adRatePct:         num(c.adRatePct, DEFAULTS.adRatePct),
    targetMarginPct:   num(c.targetMarginPct, DEFAULTS.targetMarginPct),
    overstockThreshold: num(c.overstockThreshold, DEFAULTS.overstockThreshold),
    vatRate:           num(row.vat_rate, 20),
    vatRegistered:     !!row.vat_registered,
    fxRates:           c.fxRates || {},
  };
}

// Resolve the per-channel selling-cost parameters used by both floor + margin.
// 'direct' = a cash/bank/collection sale: no marketplace fee or ad rate (VAT,
// postage and packaging still apply).
function channelParams(channel, isLarge, s) {
  const postage = isLarge ? s.postageLarge : s.postageSmall;
  if (channel === 'direct') return { postage, feePct: 0, fixedFee: 0, adRatePct: 0 };
  const feePct = channel === 'shopify' ? s.shopifyFeePct : s.ebayFeePct;
  const fixedFee = channel === 'shopify' ? s.shopifyFixedFee : s.ebayFixedFee;
  const adRatePct = channel === 'ebay' ? s.adRatePct : 0; // ads run on eBay only
  return { postage, feePct, fixedFee, adRatePct };
}

// Breakeven + recommended floor for a gross (VAT-inclusive) sale price.
//   B = F / (1 - p - v)  ;  floor = B * (1 + targetMargin)
// where F = cost + postage + packaging + fixedFee, p = (fee% + ad%)/100,
// v = VAT portion of a gross price = (rate/100)/(1+rate/100) (0 if not registered).
function computeFloor({ costPrice, isLarge, channel, settings, vatRegistered }) {
  const s = settings;
  const cost = num(costPrice, 0);
  const { postage, feePct, fixedFee, adRatePct } = channelParams(channel, isLarge, s);
  const F = cost + postage + s.packagingCost + fixedFee;
  const p = (feePct + adRatePct) / 100;
  const vr = vatRegistered != null ? vatRegistered : s.vatRegistered;
  const v = vr ? (s.vatRate / 100) / (1 + s.vatRate / 100) : 0;
  const divisor = 1 - p - v;
  const components = {
    costPrice: +cost.toFixed(2), postage, packaging: s.packagingCost, fixedFee,
    feePct, adRatePct, vatPortionRate: +v.toFixed(4), divisor: +divisor.toFixed(4),
    fixedCosts: +F.toFixed(2), targetMarginPct: s.targetMarginPct,
  };
  if (divisor <= 0) return { breakeven: null, floor: null, feasible: false, components };
  const breakeven = +(F / divisor).toFixed(2);
  const floor = +(breakeven * (1 + s.targetMarginPct / 100)).toFixed(2);
  return { breakeven, floor, feasible: true, components: { ...components, breakeven, floor } };
}

// Net profit + margin% retained at an actual sale price (same cost model).
function marginAtPrice({ price, costPrice, isLarge, channel, settings, vatRegistered }) {
  const s = settings;
  const B = num(price, 0);
  if (B <= 0) return { net: null, marginPct: null };
  const cost = num(costPrice, 0);
  const { postage, feePct, fixedFee, adRatePct } = channelParams(channel, isLarge, s);
  const vr = vatRegistered != null ? vatRegistered : s.vatRegistered;
  const v = vr ? (s.vatRate / 100) / (1 + s.vatRate / 100) : 0;
  const F = cost + postage + s.packagingCost + fixedFee;
  const net = +(B * (1 - (feePct + adRatePct) / 100 - v) - F).toFixed(2);
  const marginPct = +((net / B) * 100).toFixed(1);
  return { net, marginPct };
}

module.exports = { DEFAULTS, resolveCostSettings, computeFloor, marginAtPrice };
