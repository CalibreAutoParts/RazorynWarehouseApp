// lib/cash-round.js — cash-sale rounding rule.
//
// Nobody pays a cash counter sale with coins, so cash totals are rounded to a
// tidy figure:
//   • orders of £25 or more  → round UP to the nearest £5
//   • orders below £25       → round UP to the nearest £1
// …with one guard: cash is meant to be the cheapest option, so the rounded cash
// total must never end up HIGHER than the bank / eBay / Shopify total. If
// rounding up would breach that cap, we round DOWN to the same step instead (and
// clamp to the cap) so cash stays the best price.
function roundCashTotal(rawCash, cap) {
  const raw = Math.max(0, Number(rawCash) || 0);
  if (raw <= 0) return 0;
  const step = raw < 25 ? 1 : 5;
  let value = Math.ceil(raw / step) * step;     // round up
  if (cap != null && cap > 0 && value > cap) {
    const down = Math.floor(raw / step) * step; // rounding up breached the cap
    value = Math.min(down > 0 ? down : raw, cap);
  }
  return +value.toFixed(2);
}

// Smallest positive value among the comparison totals (bank / eBay / Shopify) —
// the ceiling cash isn't allowed to exceed.
function cheapestCap(...totals) {
  const positives = totals.map(Number).filter((v) => v > 0);
  return positives.length ? Math.min(...positives) : null;
}

module.exports = { roundCashTotal, cheapestCap };
