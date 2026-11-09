// lib/stock-qty.js — how many units a sales channel may offer.
//
// Normally that's our own warehouse stock (qty_on_hand). A part sourced from a
// PARTNER warehouse (another warehouse app we buy from through the trade link)
// is sold from THEIR live stock as well: own stock + the partner's available
// units. When we sell one, it's ordered from the partner automatically (see
// lib/trade-partner autoOrderSweep) and their stock update flows back here.
const { query } = require('../db');

async function sellableQty(product) {
  if (!product) return 0;
  let own = parseInt(product.qty_on_hand) || 0;
  let src = product.source_partner_id, pq = product.partner_qty, link = product.partner_link_id;
  if (src === undefined || pq === undefined || link === undefined || product.qty_on_hand === undefined) {
    try {
      const r = (await query(`SELECT id, qty_on_hand, source_partner_id, partner_qty, partner_link_id FROM products WHERE ${product.id ? 'id = $1' : 'sku = $1'} LIMIT 1`,
        [product.id || product.sku])).rows[0];
      if (r) { src = r.source_partner_id; pq = r.partner_qty; link = r.partner_link_id; if (product.qty_on_hand === undefined) own = parseInt(r.qty_on_hand) || 0; product = { ...product, id: r.id }; }
    } catch (_) { /* partner columns not there yet → own stock only */ }
  }
  if (!src || src !== link) return own;
  return Math.max(0, own) + Math.max(0, (parseInt(pq) || 0) - await uncovered(product.id, own, link));
}

// Units WE sold that aren't on order from the partner yet (own stock below 0,
// less what's already on order from them). Their stock still includes those
// units until the order is placed, so they come off what we offer meanwhile —
// otherwise a sale here would leave the same unit for sale twice.
async function uncovered(productId, own, linkId) {
  if (own >= 0 || !productId) return 0;
  try {
    const pending = parseInt((await query(`SELECT COALESCE(SUM(GREATEST(i.qty_ordered - i.qty_received, 0)), 0)::int AS q
        FROM incoming_stock i JOIN trade_partner_links l ON l.id = $2
       WHERE i.product_id = $1 AND i.supplier = l.name AND i.status NOT IN ('received','cancelled')`, [productId, linkId])).rows[0].q) || 0;
    return Math.max(0, -own - pending);
  } catch (_) { return -own; }
}

// The same, as SQL on a products row aliased p (for bulk queries).
const SELLABLE_SQL = `(CASE WHEN p.source_partner_id IS NOT NULL AND p.source_partner_id = p.partner_link_id
  THEN GREATEST(p.qty_on_hand, 0) + GREATEST(COALESCE(p.partner_qty, 0) - CASE WHEN p.qty_on_hand >= 0 THEN 0 ELSE GREATEST(-p.qty_on_hand - COALESCE((
    SELECT SUM(GREATEST(i.qty_ordered - i.qty_received, 0)) FROM incoming_stock i JOIN trade_partner_links tl ON tl.id = p.partner_link_id
     WHERE i.product_id = p.id AND i.supplier = tl.name AND i.status NOT IN ('received','cancelled')), 0), 0) END, 0)
  ELSE p.qty_on_hand END)::int`;
module.exports = { sellableQty, SELLABLE_SQL };
