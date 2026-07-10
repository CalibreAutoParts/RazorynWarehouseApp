// lib/refunds.js — single source of truth for how much of a sale has been
// refunded, so refunds (full OR partial) stop counting toward revenue, total
// sales and dispatch.
//
// The problem this solves: refund data arrives from THREE independent places —
//   1. Shopify order feed  (order.refunds / financial_status / total_refunded)
//   2. eBay                (Post-Order return cases + order-level cancellations)
//   3. Manual returns       (routes/returns.js "book a return against a sale")
// …and none of them wrote a refunded figure onto the sale itself, so the money
// still showed up as revenue and the order could still sit in Dispatch.
//
// We fold every source onto the `sales` row:
//   • channel_refunded_amount — the cumulative refund the CHANNEL reports for the
//     order (Shopify total_refunded / eBay order refund). High-water mark.
//   • refunded_amount         — the authoritative amount netted off revenue:
//     GREATEST(channel-reported, sum of processed/closed local returns), capped
//     at the order total.
//   • refunded_at             — when the order first showed any refund.
// When the whole order is refunded we also flip status → 'refunded' (that value
// is already in the CHECK constraint and is what Dispatch + the sales count
// exclude). Partial refunds leave the order shippable but reduce its revenue.
//
// Using GREATEST (not a sum) across the channel figure and the returns figure is
// deliberate: the same refund is often visible from both sides, so summing would
// double-count. The channel's cumulative total already captures multiple partials.
const { query } = require('../db');

let _ready = false;
async function ensureRefundColumns() {
  if (_ready) return;
  try {
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel_refunded_amount NUMERIC(10,2)`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    _ready = true;
  } catch (e) { console.warn('[refunds] ensureRefundColumns:', e.message); }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Recompute a single sale's refunded figure from all sources and persist it.
// opts.channelRefund — a fresh cumulative refund total reported by the channel
//   (Shopify/eBay). Stored as a high-water mark, never lowered by a stale feed.
// Returns { refunded, fully } or null when the sale is gone.
async function reconcileSaleRefund(saleId, opts = {}) {
  if (!saleId) return null;
  await ensureRefundColumns();
  if (opts.channelRefund != null) {
    const cr = Math.max(0, round2(opts.channelRefund));
    await query(
      `UPDATE sales SET channel_refunded_amount = GREATEST(COALESCE(channel_refunded_amount, 0), $2) WHERE id = $1`,
      [saleId, cr]);
  }
  const r = await query(
    `SELECT s.total, s.status, COALESCE(s.channel_refunded_amount, 0) AS channel_refunded,
            COALESCE((SELECT SUM(refund_amount) FROM returns
                        WHERE sale_id = s.id AND status IN ('processed','closed')
                          AND refund_amount IS NOT NULL), 0) AS returns_sum
       FROM sales s WHERE s.id = $1`, [saleId]);
  const row = r.rows[0];
  if (!row) return null;
  const total = round2(row.total);
  // Authoritative refund = the larger of the two views, capped at the order total.
  let refunded = Math.max(round2(row.channel_refunded), round2(row.returns_sum));
  if (refunded > total) refunded = total;
  refunded = round2(refunded);
  const fully = refunded > 0 && refunded >= total - 0.005;
  await query(
    `UPDATE sales SET
        refunded_amount = $2,
        refunded_at = CASE WHEN $2 > 0 AND refunded_at IS NULL THEN now()
                           WHEN $2 = 0 THEN NULL ELSE refunded_at END,
        status = CASE WHEN $3 AND status NOT IN ('refunded','cancelled') THEN 'refunded'
                      ELSE status END
      WHERE id = $1`,
    [saleId, refunded, fully]);
  return { refunded, fully, total };
}

module.exports = { ensureRefundColumns, reconcileSaleRefund, round2 };
