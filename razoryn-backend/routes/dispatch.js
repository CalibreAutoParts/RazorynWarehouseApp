// routes/dispatch.js — Dispatch & outstanding-order workflow.
//
// "Outstanding" = paid sale (not an estimate) that hasn't been dispatched yet
// (or for cash-on-collection, hasn't been collected yet). This page is the
// warehouse's "what's left to do" worklist — open it, pick the oldest one,
// stick a label on the box, scan/type the tracking number, click Dispatch.
//
// Channel push: we record dispatch in our DB unconditionally. Pushing the
// tracking number BACK to eBay or Shopify (so the customer sees their
// "marked as shipped" notification) is a best-effort second step. If the
// API call fails we still keep the local record — the user can retry via
// the "Re-push to channel" button from the sale's edit modal.

const express = require('express');
const { query, withTx } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration — adds the dispatch-related columns to `sales`
// if they don't exist yet. Runs on cold boot; idempotent.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureDispatchColumns() {
  if (_migrationDone) return;
  try {
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS dispatched_at      TIMESTAMPTZ`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS dispatched_by      INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS tracking_number    TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS carrier            TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS dispatch_notes     TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel_push_state TEXT`);   // 'pending' | 'ok' | 'error'
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel_push_error TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS collected_at       TIMESTAMPTZ`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS collected_by       INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    // Index for the worklist query — paid sales ordered by oldest unshipped first.
    await query(`CREATE INDEX IF NOT EXISTS sales_dispatch_idx ON sales (occurred_at) WHERE is_estimate = false AND dispatched_at IS NULL AND collected_at IS NULL`);
    _migrationDone = true;
  } catch (e) {
    console.warn('[dispatch.js] migration warning:', e.message);
  }
}
ensureDispatchColumns();

// Carriers we know about. Keys map to tracking-URL templates so the UI can
// generate clickable "track parcel" links for the customer-facing receipt.
// {tracking} is replaced with the tracking number at render time.
const CARRIERS = {
  'Royal Mail':   'https://www.royalmail.com/track-your-item#/tracking-results/{tracking}',
  'Parcelforce':  'https://www.parcelforce.com/portal/pw/track?trackNumber={tracking}',
  'DPD':          'https://www.dpd.co.uk/apps/tracking/?reference={tracking}',
  'Evri':         'https://www.evri.com/track/parcel/{tracking}',
  'UPS':          'https://www.ups.com/track?tracknum={tracking}',
  'DHL':          'https://www.dhl.com/gb-en/home/tracking.html?tracking-id={tracking}',
  'FedEx':        'https://www.fedex.com/fedextrack/?trknbr={tracking}',
  'Tuffnells':    'https://www.tuffnells.co.uk/track-a-parcel?consignment={tracking}',
  'Yodel':        'https://www.yodel.co.uk/tracking/{tracking}',
  'APC Overnight': 'https://apc-overnight.com/customers/tracking-customer-portal?jobref={tracking}',
  'Other / custom courier': null,  // free text, no auto-track link
};

function trackingUrlFor(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const tpl = CARRIERS[carrier];
  if (!tpl) return null;
  return tpl.replace('{tracking}', encodeURIComponent(trackingNumber));
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/dispatch/outstanding?days=10
// The main worklist. Returns three buckets:
//   • toShip — paid sales (non-cash) without a dispatched_at, within `days` cutoff
//   • toCollect — paid cash-on-collection sales without a collected_at, within `days` cutoff
//   • recent — last 14 days of dispatches/collections, for verification + edit
//
// `days` (default 10) caps how far back the worklist looks. Sales older than
// this are assumed to have been handled on the source channel (eBay/Shopify)
// before this app existed, or otherwise dealt with offline. The cutoff stops
// pre-app history from cluttering the worklist.
//
// We also defensively exclude rows where status='dispatched' even if
// dispatched_at is null — happens when a sale was synced from eBay/Shopify with
// a "shipped" status before our dispatch tracking columns existed.
// ──────────────────────────────────────────────────────────────────────────
router.get('/outstanding', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 10));
  try {
    // Outstanding orders to ship. Excludes:
    //  • Estimates (no payment yet)
    //  • Cash on collection (those go into the "to collect" bucket)
    //  • Already-dispatched sales (dispatched_at set OR status = 'dispatched')
    //  • Sales older than the configured cutoff (default 10 days)
    const toShip = await query(`
      SELECT s.*,
        (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title,
        (SELECT sku   FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_sku,
        (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count,
        EXTRACT(EPOCH FROM (now() - s.occurred_at)) / 3600 AS age_hours
      FROM sales s
      WHERE s.is_estimate = false
        AND s.dispatched_at IS NULL
        AND COALESCE(s.fulfillment_method,
              CASE WHEN s.payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'ship'
        AND s.status NOT IN ('refunded', 'cancelled', 'dispatched')
        AND s.occurred_at >= now() - ($1 || ' days')::interval
      ORDER BY s.occurred_at ASC
      LIMIT 500
    `, [String(days)]);

    const toCollect = await query(`
      SELECT s.*,
        (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title,
        (SELECT sku   FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_sku,
        (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count,
        EXTRACT(EPOCH FROM (now() - s.occurred_at)) / 3600 AS age_hours
      FROM sales s
      WHERE s.is_estimate = false
        AND COALESCE(s.fulfillment_method,
              CASE WHEN s.payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'collect'
        AND s.collected_at IS NULL
        AND s.status NOT IN ('refunded', 'cancelled', 'dispatched')
        AND s.occurred_at >= now() - ($1 || ' days')::interval
      ORDER BY s.occurred_at ASC
      LIMIT 500
    `, [String(days)]);

    const recent = await query(`
      SELECT s.*,
        (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title,
        (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count
      FROM sales s
      WHERE s.is_estimate = false
        AND (s.dispatched_at >= now() - INTERVAL '14 days' OR s.collected_at >= now() - INTERVAL '14 days')
      ORDER BY COALESCE(s.dispatched_at, s.collected_at) DESC
      LIMIT 200
    `);

    res.json({
      summary: {
        toShip: toShip.rows.length,
        toCollect: toCollect.rows.length,
        recentDispatched: recent.rows.filter(r => r.dispatched_at).length,
        recentCollected: recent.rows.filter(r => r.collected_at).length,
      },
      cutoffDays: days,
      toShip: toShip.rows,
      toCollect: toCollect.rows,
      recent: recent.rows,
      carriers: Object.keys(CARRIERS),
    });
  } catch (e) {
    console.error('[dispatch.outstanding]', e);
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/bulk-mark-dispatched
// Body: { saleIds: number[], carrier?, trackingNumber?, notes?, pushToChannel? }
//
// Bulk-clears a list of orders from the worklist. Designed for the common
// case of "all 47 of these were shipped on eBay/Shopify weeks before this app
// existed, mark them all in one click". Defaults to carrier="Already shipped
// (channel)" with no tracking + no channel push so legacy items are cleared
// without spamming eBay/Shopify.
//
// Cash-on-collection rows in the list are routed to "mark collected" instead
// (they can't be dispatched). Estimates and already-dispatched rows are skipped
// with per-row error reporting. Returns counts so the UI can give a useful toast.
// ──────────────────────────────────────────────────────────────────────────
router.post('/bulk-mark-dispatched', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const ids = Array.isArray(req.body?.saleIds) ? req.body.saleIds : [];
  if (!ids.length) return res.status(400).json({ error: 'sale_ids_required' });

  const carrier        = (req.body?.carrier || 'Already shipped (channel)').trim();
  const trackingNumber = (req.body?.trackingNumber || '').trim() || null;
  const notes          = (req.body?.notes || '').trim() || null;
  // Default to NO channel push for bulk operations — legacy items have likely
  // already been marked shipped on the source channel, no need to re-push.
  const pushToChannel  = req.body?.pushToChannel === true;

  let dispatched = 0, collected = 0, skipped = 0;
  const errors = [];

  for (const id of ids) {
    try {
      const s = await query(`SELECT * FROM sales WHERE id = $1`, [id]);
      const row = s.rows[0];
      if (!row) { skipped++; errors.push({ id, reason: 'not_found' }); continue; }
      if (row.is_estimate) { skipped++; errors.push({ id, reason: 'is_estimate' }); continue; }
      if (row.dispatched_at || row.collected_at) { skipped++; errors.push({ id, reason: 'already_done' }); continue; }

      if (row.payment_method === 'cash') {
        // Cash orders → mark collected instead
        await query(`
          UPDATE sales SET collected_at = now(), collected_by = $1,
            dispatch_notes = COALESCE($2, dispatch_notes),
            status = 'dispatched'
          WHERE id = $3
        `, [req.user.id, notes, id]);
        collected++;
      } else {
        // Non-cash → mark dispatched. channel_push_state='na' for bulk operations
        // unless the caller explicitly opted in to pushToChannel.
        await query(`
          UPDATE sales SET
            dispatched_at = now(), dispatched_by = $1,
            carrier = $2, tracking_number = $3, dispatch_notes = $4,
            channel_push_state = $5, channel_push_error = NULL,
            status = 'dispatched'
          WHERE id = $6
        `, [req.user.id, carrier, trackingNumber, notes,
            pushToChannel ? 'pending' : 'na', id]);
        dispatched++;
        // Fire-and-forget channel push only if explicitly requested
        if (pushToChannel && (row.channel || '').match(/^(shopify|ebay_)/)) {
          const updated = await query(`SELECT * FROM sales WHERE id = $1`, [id]);
          setImmediate(() => pushDispatchToChannel(updated.rows[0]).catch(e => console.warn('[dispatch.bulkPush]', e.message)));
        }
      }
    } catch (e) {
      skipped++;
      errors.push({ id, reason: e.message });
    }
  }

  await audit(req, 'bulk_dispatch', null, null, {
    requested: ids.length, dispatched, collected, skipped, carrier, pushToChannel,
  });
  res.json({ ok: true, requested: ids.length, dispatched, collected, skipped, errors });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/:saleId/mark-dispatched
// Body: { carrier, trackingNumber, notes, pushToChannel? }
//
// 1. Saves dispatch info on the sale.
// 2. Updates sale.status = 'dispatched'.
// 3. If pushToChannel=true (default true for eBay/Shopify orders):
//    fires an async push to the source channel so the customer sees their
//    "marked as shipped" notification. Failure here is non-fatal — local
//    record is still saved and channel_push_state captures the error for
//    later retry.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:saleId/mark-dispatched', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const { carrier, trackingNumber, notes, pushToChannel } = req.body || {};
  if (!carrier) return res.status(400).json({ error: 'carrier_required' });
  // Tracking can be empty for "collection courier organising their own tracking"
  // cases, but the column is text-typed so we accept null/empty.
  const trackingClean = (trackingNumber || '').trim() || null;

  const result = await withTx(async (c) => {
    const s = await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [req.params.saleId]);
    if (!s.rows[0]) return { error: 'not_found' };
    if (s.rows[0].is_estimate) return { error: 'is_estimate', message: 'Estimates cannot be dispatched. Mark as paid first.' };
    if (s.rows[0].dispatched_at) return { error: 'already_dispatched', dispatchedAt: s.rows[0].dispatched_at };
    if (s.rows[0].payment_method === 'cash') return { error: 'cash_order', message: 'Cash-on-collection orders use "Mark collected", not dispatch.' };

    const updated = await c.query(`
      UPDATE sales SET
        dispatched_at = now(), dispatched_by = $1,
        carrier = $2, tracking_number = $3, dispatch_notes = $4,
        channel_push_state = $5, channel_push_error = NULL,
        status = 'dispatched'
      WHERE id = $6 RETURNING *
    `, [req.user.id, carrier, trackingClean, (notes || '').trim() || null,
        pushToChannel === false ? null : 'pending',
        req.params.saleId]);
    return { sale: updated.rows[0] };
  });

  if (result.error) return res.status(409).json(result);
  await audit(req, 'dispatch_order', 'sale', result.sale.id, { carrier, trackingNumber: trackingClean });

  // Async push to source channel. Don't block the response on this.
  if (pushToChannel !== false && (result.sale.channel || '').match(/^(shopify|ebay_)/)) {
    setImmediate(() => pushDispatchToChannel(result.sale).catch(e => {
      console.warn('[dispatch.push]', e.message);
    }));
  } else {
    // Direct sales (bank transfer): nothing to push to a channel. Mark as N/A.
    await query(`UPDATE sales SET channel_push_state = 'na' WHERE id = $1 AND channel_push_state = 'pending'`, [result.sale.id]);
  }

  res.json({
    ok: true,
    sale: result.sale,
    trackingUrl: trackingUrlFor(carrier, trackingClean),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/:saleId/mark-collected
// For cash-on-collection orders. No tracking, no channel push — just records
// that the customer picked the part up.
// Body: { notes? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/:saleId/mark-collected', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const { notes } = req.body || {};

  const result = await withTx(async (c) => {
    const s = await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [req.params.saleId]);
    if (!s.rows[0]) return { error: 'not_found' };
    if (s.rows[0].is_estimate) return { error: 'is_estimate' };
    if (s.rows[0].collected_at) return { error: 'already_collected', collectedAt: s.rows[0].collected_at };
    if (s.rows[0].payment_method !== 'cash') return { error: 'not_a_cash_order', message: 'Only cash-on-collection orders can be marked as collected.' };

    const updated = await c.query(`
      UPDATE sales SET
        collected_at = now(), collected_by = $1,
        dispatch_notes = COALESCE($2, dispatch_notes),
        status = 'dispatched'
      WHERE id = $3 RETURNING *
    `, [req.user.id, (notes || '').trim() || null, req.params.saleId]);
    return { sale: updated.rows[0] };
  });

  if (result.error) return res.status(409).json(result);
  await audit(req, 'collect_order', 'sale', result.sale.id, {});
  res.json({ ok: true, sale: result.sale });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/:saleId/undo
// Admin-only "I clicked the wrong row" escape hatch. Clears dispatch_at /
// collected_at, restores status. Doesn't try to un-push to the channel —
// that's the staff's responsibility (open eBay, unmark shipped manually).
// ──────────────────────────────────────────────────────────────────────────
router.post('/:saleId/undo', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const result = await query(`
    UPDATE sales SET
      dispatched_at = NULL, dispatched_by = NULL,
      collected_at = NULL, collected_by = NULL,
      tracking_number = NULL, carrier = NULL, dispatch_notes = NULL,
      channel_push_state = NULL, channel_push_error = NULL,
      status = 'paid'
    WHERE id = $1 AND is_estimate = false
    RETURNING *
  `, [req.params.saleId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'undo_dispatch', 'sale', result.rows[0].id, {});
  res.json({ ok: true, sale: result.rows[0] });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/:saleId/edit-tracking
// Fix typos in carrier / tracking number after dispatch. Optional re-push.
// Body: { carrier?, trackingNumber?, notes?, repushToChannel? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/:saleId/edit-tracking', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const { carrier, trackingNumber, notes, repushToChannel } = req.body || {};
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (!s.rows[0].dispatched_at) return res.status(409).json({ error: 'not_dispatched_yet' });

  const updated = await query(`
    UPDATE sales SET
      carrier = COALESCE($1, carrier),
      tracking_number = COALESCE($2, tracking_number),
      dispatch_notes = COALESCE($3, dispatch_notes),
      channel_push_state = CASE WHEN $4::boolean THEN 'pending' ELSE channel_push_state END
    WHERE id = $5 RETURNING *
  `, [carrier || null, trackingNumber || null, notes || null, !!repushToChannel, req.params.saleId]);

  await audit(req, 'edit_tracking', 'sale', updated.rows[0].id, { carrier, trackingNumber, repush: !!repushToChannel });

  if (repushToChannel && (updated.rows[0].channel || '').match(/^(shopify|ebay_)/)) {
    setImmediate(() => pushDispatchToChannel(updated.rows[0]).catch(e => console.warn('[dispatch.repush]', e.message)));
  }

  res.json({
    ok: true,
    sale: updated.rows[0],
    trackingUrl: trackingUrlFor(updated.rows[0].carrier, updated.rows[0].tracking_number),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/dispatch/carriers
// Returns the carrier list with their tracking-URL templates.
// Used by the frontend dropdown + invoice tracking-link rendering.
// ──────────────────────────────────────────────────────────────────────────
router.get('/carriers', requireAuth, async (req, res) => {
  res.json({
    carriers: Object.keys(CARRIERS).map(name => ({
      name,
      hasUrlTemplate: !!CARRIERS[name],
    })),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Channel push helper. Pushes a tracking event to either eBay's CompleteSale
// API (Trading API) or Shopify's Fulfillment API depending on the sale's
// channel. Best-effort — sets sale.channel_push_state to 'ok' or 'error'.
//
// Returns a promise that resolves on completion (does not throw — errors are
// captured in DB). Called via setImmediate so the HTTP response goes out
// immediately and the user can carry on with the next order.
// ──────────────────────────────────────────────────────────────────────────
async function pushDispatchToChannel(sale) {
  const channel = (sale.channel || '').toLowerCase();
  try {
    if (channel.startsWith('ebay_')) {
      const ebay = require('../services/ebay');
      // CompleteSale needs the eBay store associated with the sale's channel.
      // For multi-store brands (Calibre), channel = ebay_em or ebay_cl — we
      // look up the matching store in the brand config.
      const brand = require('../lib/brand');
      const store = brand.stores.find(s => s.channelCode === sale.channel);
      if (!store) throw new Error(`No store mapped for channel ${sale.channel}`);
      if (typeof ebay.completeSale !== 'function') {
        // CompleteSale wrapper not implemented in services/ebay.js yet.
        // Surface a clear "not implemented" error rather than silently succeeding.
        throw new Error('ebay.completeSale() not implemented — push to eBay manually for now');
      }
      await ebay.completeSale(store.code, {
        orderId: sale.external_order_id,
        carrier: sale.carrier,
        trackingNumber: sale.tracking_number,
        shipped: true,
      });
    } else if (channel === 'shopify') {
      const shopify = require('../services/shopify');
      if (typeof shopify.fulfillOrder !== 'function') {
        throw new Error('shopify.fulfillOrder() not implemented — push to Shopify manually for now');
      }
      await shopify.fulfillOrder({
        orderId: sale.external_order_id,
        carrier: sale.carrier,
        trackingNumber: sale.tracking_number,
      });
    } else {
      // Direct sales — nothing to push.
      await query(`UPDATE sales SET channel_push_state = 'na' WHERE id = $1`, [sale.id]);
      return;
    }
    await query(`UPDATE sales SET channel_push_state = 'ok', channel_push_error = NULL WHERE id = $1`, [sale.id]);
  } catch (e) {
    console.warn(`[dispatch.push] sale=${sale.id} channel=${channel} failed:`, e.message);
    await query(`UPDATE sales SET channel_push_state = 'error', channel_push_error = $1 WHERE id = $2`, [e.message.slice(0, 500), sale.id]);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/dispatch/:saleId/retry-push
// Manually retry a failed channel push. Used by the "⚠ Push failed — Retry"
// button on the dispatched-orders panel.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:saleId/retry-push', requireAdmin, async (req, res) => {
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (!s.rows[0].dispatched_at) return res.status(409).json({ error: 'not_dispatched_yet' });
  await query(`UPDATE sales SET channel_push_state = 'pending', channel_push_error = NULL WHERE id = $1`, [req.params.saleId]);
  setImmediate(() => pushDispatchToChannel(s.rows[0]).catch(e => console.warn('[dispatch.retry]', e.message)));
  res.json({ ok: true, message: 'Retry queued — check back in a few seconds.' });
});

// ──────────────────────────────────────────────────────────────────────────
// eBay dispatch sync (#11)
// Orders marked dispatched ON EBAY (tracking uploaded there) should drop off the
// warehouse worklist automatically. This polls eBay's fulfillment API for
// FULFILLED orders and marks the matching warehouse sales dispatched, pulling
// across the tracking number/carrier. channel_push_state is set to 'na' because
// the tracking already lives on eBay (we must NOT push it back). Runs on a
// 30-min cron (server.js) and via the manual button below.
// ──────────────────────────────────────────────────────────────────────────
async function syncEbayDispatchCore({ days = 14 } = {}) {
  const ebay = require('../services/ebay');
  if (!ebay.isConfigured()) return { checked: 0, dispatched: 0, skipped: 'ebay_not_configured' };
  const sinceISO = new Date(Date.now() - days * 86400000).toISOString();

  // Build the set of orders shipped on eBay, plus any tracking/carrier we can
  // read up-front. Two sources so it works regardless of how the order was
  // ingested and which eBay API is set up:
  //   • OAuth Sell Fulfillment API (shared refresh token), when configured.
  //   • Trading API GetOrders per store (per-store Auth'n'Auth token) — the path
  //     order ingestion itself falls back to, so the OrderIDs match. Without this
  //     the sync silently did nothing for token-only stores like Razoryn.
  const fulfilledIds = new Set();
  const trackingByOrder = {}; // orderId -> { tracking, carrier }
  try {
    const ids = await ebay.getFulfilledOrderIds(sinceISO);
    for (const id of (ids || [])) fulfilledIds.add(id);
  } catch (e) { console.warn('[dispatch] getFulfilledOrderIds failed:', e.message); }
  try {
    for (const o of await ebay.getShippedOrdersAllStores(sinceISO)) {
      fulfilledIds.add(o.orderId);
      if (o.tracking || o.carrier) trackingByOrder[o.orderId] = { tracking: o.tracking, carrier: o.carrier };
    }
  } catch (e) { console.warn('[dispatch] getShippedOrdersAllStores failed:', e.message); }

  if (!fulfilledIds.size) return { checked: 0, dispatched: 0, shippedReported: 0 };

  // Undispatched eBay sales whose order is now fulfilled on eBay.
  const { rows } = await query(
    `SELECT id, external_order_id FROM sales
      WHERE channel IN ('ebay_em','ebay_cl') AND is_estimate = false
        AND dispatched_at IS NULL AND collected_at IS NULL
        AND external_order_id = ANY($1)`,
    [[...fulfilledIds]]
  );

  let dispatched = 0;
  for (const sale of rows) {
    let tracking = trackingByOrder[sale.external_order_id]?.tracking || null;
    let carrier = trackingByOrder[sale.external_order_id]?.carrier || null;
    // Fall back to the per-order OAuth lookup only if we didn't already have it.
    if (!tracking && !carrier) {
      try { const t = await ebay.getOrderTracking(sale.external_order_id); tracking = t.tracking; carrier = t.carrier; } catch (e) { /* best-effort */ }
    }
    await query(
      `UPDATE sales SET dispatched_at = now(), status = 'dispatched', channel_push_state = 'na',
         carrier = COALESCE($2, carrier),
         tracking_number = COALESCE($3, tracking_number),
         dispatch_notes = COALESCE(dispatch_notes, 'Auto-dispatched from eBay')
       WHERE id = $1`,
      [sale.id, carrier, tracking]
    );
    dispatched++;
  }
  // shippedReported = how many shipped orders eBay returned for the window;
  // matched = how many of those line up with an open (undispatched) sale here.
  // These let the UI explain "nothing happened" instead of failing silently.
  return { checked: rows.length, dispatched, shippedReported: fulfilledIds.size, matched: rows.length };
}

// POST /api/dispatch/sync-ebay — manual trigger for the auto-dispatch sync.
router.post('/sync-ebay', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.body?.days) || 14));
    const result = await syncEbayDispatchCore({ days });
    if (result.dispatched) await audit(req, 'ebay_dispatch_sync', null, null, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

module.exports = router;
module.exports.trackingUrlFor = trackingUrlFor;
module.exports.CARRIERS = CARRIERS;
module.exports.syncEbayDispatchCore = syncEbayDispatchCore;
