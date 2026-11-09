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
  if (src === undefined || pq === undefined || link === undefined) {
    try {
      const r = (await query(`SELECT source_partner_id, partner_qty, partner_link_id FROM products WHERE ${product.id ? 'id = $1' : 'sku = $1'} LIMIT 1`,
        [product.id || product.sku])).rows[0];
      if (r) { src = r.source_partner_id; pq = r.partner_qty; link = r.partner_link_id; }
    } catch (_) { /* partner columns not there yet → own stock only */ }
  }
  if (!src || src !== link) return own;
  return Math.max(0, own) + Math.max(0, parseInt(pq) || 0);
}

// The same, as SQL on a products row aliased p (for bulk queries).
const SELLABLE_SQL = `(CASE WHEN p.source_partner_id IS NOT NULL AND p.source_partner_id = p.partner_link_id
  THEN GREATEST(p.qty_on_hand, 0) + GREATEST(COALESCE(p.partner_qty, 0), 0) ELSE p.qty_on_hand END)`;
module.exports = { sellableQty, SELLABLE_SQL };
