// lib/pricing-floor.js — the single source of truth for cost-based pricing.
//
// Given an item's landed unit cost (GBP) plus the configured selling costs, work
// out the BREAKEVEN price and a recommended FLOOR (breakeven + a margin cushion)
// per channel. Prices in this business are VAT-INCLUSIVE, so percentage selling
// fees, the ad rate and the VAT we owe HMRC all scale with the sale price — they
// must be solved for, not just added on. Pure functions, no DB access, so the
// routes compute floors server-side and the frontend just consumes the numbers.
//
// eBay's fee is several components, and eBay charges 20% VAT ON the fee itself:
//   final value fee %  (category-based, vehicle parts ~9.5% of the order total)
//   + regulatory operating fee %  (~0.35%)
//   + account "high return rate" extra %  (0 for most; some accounts pay ~4%)
//   + promoted-listing ad rate %  (if you run ads)
//   + a per-order fixed fee  (~£0.40 for orders over £10)
//   then +VAT (20%) on the whole fee.
// We model each component so the recommended price actually clears the real fees.

const DEFAULT_BANDS = [
  { code: 'small',  label: 'Small parcel', cost: 3.20 },
  { code: 'medium', label: 'Medium',       cost: 6.00 },
  { code: 'large',  label: 'Large panel',  cost: 9.50 },
  { code: 'pallet', label: 'Pallet / freight', cost: 25.00 },
];

const DEFAULTS = {
  postageSmall: 3.20,   // GBP — fallback when an item has no shipping band (small)
  postageLarge: 9.50,   // GBP — fallback for a large_panel item with no band
  packagingCost: 0.60,  // GBP, packing materials per order
  // eBay fee components (all % of the gross order total unless noted)
  ebayFvfPct: 9.5,         // final value fee % (vehicle parts band £0–750)
  ebayRegulatoryPct: 0.35, // regulatory operating fee %
  ebayHighReturnPct: 0,    // account-specific "high return rate" extra % (0 = none)
  ebayPerOrderFee: 0.40,   // per-order fixed fee (GBP) for orders over £10
  feesVatPct: 20,          // VAT charged ON eBay fees
  feesVatOnEbay: true,     // eBay adds VAT to its fees
  feesVatOnShopify: false, // Shopify Payments fees aren't VAT-rated the same way
  shopifyFeePct: 1.9,   // Shopify Payments online card rate % (UK ~1.9)
  shopifyFixedFee: 0.25,// Shopify per-transaction fixed (GBP)
  adRatePct: 0,         // promoted-listing ad rate % of gross (eBay only)
  targetMarginPct: 15,  // uplift over breakeven → recommended floor
  offerDiscountPct: 5,  // the standard eBay "send offer" discount (min 5%)
  overstockThreshold: 25,
  shippingBands: DEFAULT_BANDS,
};

function num(v, d) {
  const n = parseFloat(v);
  return (v != null && v !== '' && !Number.isNaN(n)) ? n : d;
}
function bool(v, d) { return (v == null) ? d : !!v; }

// Merge the saved app_settings.data.costs over DEFAULTS and fold in VAT (which
// lives on the main settings, not duplicated). `row` = an app_settings row.
function resolveCostSettings(row) {
  row = row || {};
  const c = (row.data && row.data.costs) || {};
  // Shipping bands: use saved bands if present, else default. Each band normalised.
  let bands = Array.isArray(c.shippingBands) && c.shippingBands.length ? c.shippingBands : DEFAULT_BANDS;
  bands = bands.map(b => ({ code: String(b.code || '').trim() || 'band', label: String(b.label || b.code || 'Band'), cost: num(b.cost, 0) }));
  return {
    postageSmall:      num(c.postageSmall, DEFAULTS.postageSmall),
    postageLarge:      num(c.postageLarge, DEFAULTS.postageLarge),
    packagingCost:     num(c.packagingCost, DEFAULTS.packagingCost),
    // eBay fee components (migrate: if an old flat ebayFeePct was saved, keep it as the FVF%).
    ebayFvfPct:        num(c.ebayFvfPct, num(c.ebayFeePct, DEFAULTS.ebayFvfPct)),
    ebayRegulatoryPct: num(c.ebayRegulatoryPct, DEFAULTS.ebayRegulatoryPct),
    ebayHighReturnPct: num(c.ebayHighReturnPct, DEFAULTS.ebayHighReturnPct),
    ebayPerOrderFee:   num(c.ebayPerOrderFee, num(c.ebayFixedFee, DEFAULTS.ebayPerOrderFee)),
    feesVatPct:        num(c.feesVatPct, DEFAULTS.feesVatPct),
    feesVatOnEbay:     bool(c.feesVatOnEbay, DEFAULTS.feesVatOnEbay),
    feesVatOnShopify:  bool(c.feesVatOnShopify, DEFAULTS.feesVatOnShopify),
    shopifyFeePct:     num(c.shopifyFeePct, DEFAULTS.shopifyFeePct),
    shopifyFixedFee:   num(c.shopifyFixedFee, DEFAULTS.shopifyFixedFee),
    adRatePct:         num(c.adRatePct, DEFAULTS.adRatePct),
    targetMarginPct:   num(c.targetMarginPct, DEFAULTS.targetMarginPct),
    offerDiscountPct:  num(c.offerDiscountPct, DEFAULTS.offerDiscountPct),
    overstockThreshold: num(c.overstockThreshold, DEFAULTS.overstockThreshold),
    shippingBands:     bands,
    vatRate:           num(row.vat_rate, 20),
    vatRegistered:     !!row.vat_registered,
    fxRates:           c.fxRates || {},
  };
}

// Resolve a product's postage cost from its shipping band (falling back to the
// large/small defaults when it has no band). `item` = { band, isLarge }.
function postageFor(s, item) {
  item = item || {};
  if (item.band) {
    const b = (s.shippingBands || []).find(x => x.code === item.band);
    if (b) return num(b.cost, 0);
  }
  return item.isLarge ? s.postageLarge : s.postageSmall;
}

// Resolve the per-channel selling-cost parameters used by both floor + margin.
// 'direct' = a cash/bank/collection sale: no marketplace fee or ad rate (VAT,
// postage and packaging still apply). `item` = { band, isLarge } for postage.
// feeVatMult scales the fee (and fixed fee) by the VAT charged ON the fee.
function channelParams(channel, item, s) {
  const postage = postageFor(s, item);
  if (channel === 'direct') return { postage, feePct: 0, fixedFee: 0, adRatePct: 0, feeVatMult: 1 };
  if (channel === 'shopify') {
    return {
      postage, feePct: s.shopifyFeePct, fixedFee: s.shopifyFixedFee, adRatePct: 0,
      feeVatMult: s.feesVatOnShopify ? (1 + s.feesVatPct / 100) : 1,
    };
  }
  // eBay: sum the percentage components; ads run on eBay only.
  const feePct = s.ebayFvfPct + s.ebayRegulatoryPct + s.ebayHighReturnPct;
  return {
    postage, feePct, fixedFee: s.ebayPerOrderFee, adRatePct: s.adRatePct,
    feeVatMult: s.feesVatOnEbay ? (1 + s.feesVatPct / 100) : 1,
  };
}

// Breakeven + recommended floor for a gross (VAT-inclusive) sale price.
//   B = F / (1 - p - v)  ;  floor = B * (1 + targetMargin)
// where F = cost + postage + packaging + fixedFee×feeVat, p = (fee%+ad%)/100×feeVat,
// v = VAT portion of a gross price = (rate/100)/(1+rate/100) (0 if not registered).
function computeFloor({ costPrice, isLarge, band, channel, settings, vatRegistered }) {
  const s = settings;
  const cost = num(costPrice, 0);
  const { postage, feePct, fixedFee, adRatePct, feeVatMult } = channelParams(channel, { band, isLarge }, s);
  const F = cost + postage + s.packagingCost + fixedFee * feeVatMult;
  const p = ((feePct + adRatePct) / 100) * feeVatMult;
  const vr = vatRegistered != null ? vatRegistered : s.vatRegistered;
  const v = vr ? (s.vatRate / 100) / (1 + s.vatRate / 100) : 0;
  const divisor = 1 - p - v;
  const components = {
    costPrice: +cost.toFixed(2), postage, packaging: s.packagingCost, fixedFee: +(fixedFee * feeVatMult).toFixed(2),
    feePct, adRatePct, feeVatMult, vatPortionRate: +v.toFixed(4), divisor: +divisor.toFixed(4),
    fixedCosts: +F.toFixed(2), targetMarginPct: s.targetMarginPct,
  };
  if (divisor <= 0) return { breakeven: null, floor: null, feasible: false, components };
  const breakeven = +(F / divisor).toFixed(2);
  const floor = +(breakeven * (1 + s.targetMarginPct / 100)).toFixed(2);
  return { breakeven, floor, feasible: true, components: { ...components, breakeven, floor } };
}

// Net profit + margin% retained at an actual sale price (same cost model).
function marginAtPrice({ price, costPrice, isLarge, band, channel, settings, vatRegistered }) {
  const s = settings;
  const B = num(price, 0);
  if (B <= 0) return { net: null, marginPct: null };
  const cost = num(costPrice, 0);
  const { postage, feePct, fixedFee, adRatePct, feeVatMult } = channelParams(channel, { band, isLarge }, s);
  const vr = vatRegistered != null ? vatRegistered : s.vatRegistered;
  const v = vr ? (s.vatRate / 100) / (1 + s.vatRate / 100) : 0;
  const F = cost + postage + s.packagingCost + fixedFee * feeVatMult;
  const net = +(B * (1 - ((feePct + adRatePct) / 100) * feeVatMult - v) - F).toFixed(2);
  const marginPct = +((net / B) * 100).toFixed(1);
  return { net, marginPct };
}

// Margin if we drop the price by the standard "send offer" discount (min 5%).
function marginAtOffer(args) {
  const s = args.settings;
  const disc = num(s.offerDiscountPct, 5);
  const price = num(args.price, 0) * (1 - disc / 100);
  return { ...marginAtPrice({ ...args, price }), offerPrice: +price.toFixed(2), offerDiscountPct: disc };
}

module.exports = { DEFAULTS, DEFAULT_BANDS, resolveCostSettings, channelParams, postageFor, computeFloor, marginAtPrice, marginAtOffer };
