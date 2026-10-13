// lib/invoice-discount.js — order-level discount line for customer invoices.
//
// Website (Shopify) orders store each part at its full price (sale_items) and the
// order subtotal AFTER discounts (discount codes, trade tiers, bundle offers). The
// invoice must show that difference as its own line or the lines won't add up to
// the subtotal. It's worked out from the rounded figures actually printed, so
// items − discount = subtotal to the penny (e.g. £237.48 − £11.86 = £225.62).
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// netFactor converts gross → net (1 when VAT isn't broken out).
// Returns { items, discount, subtotal } in display terms, or null when there's none.
function orderDiscount({ sale, items, netFactor = 1 }) {
  if (!sale || sale.channel !== 'shopify') return null;
  const itemsShown = r2((items || []).reduce((s, i) => s + r2(Number(i.line_total) * netFactor), 0));
  const subtotalShown = r2(Number(sale.subtotal || 0) * netFactor);
  const discount = r2(itemsShown - subtotalShown);
  if (discount < 0.01) return null;
  return { items: itemsShown, discount, subtotal: subtotalShown, label: String(sale.discount_label || '').trim() };
}

module.exports = { orderDiscount };
