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
    // Shipping/tracking layer: when a delivery actually arrived, a manual status
    // override ('delivered'|'lost'|'issue'; in-transit/delayed are derived from age),
    // and the guard for our own customer dispatch/collection email.
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivered_at       TIMESTAMPTZ`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS shipping_status    TEXT`);
    await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_notified_at TIMESTAMPTZ`);
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
// The couriers we actually use. RM/Evri/FedEx/DHL are eBay-native (eBay updates the
// buyer + reports tracking back); Proovia + Dropfleet are URL-tracked specialists for
// large panels. {tracking} is substituted at render time; null = no clickable link.
const CARRIERS = {
  'Royal Mail':   'https://www.royalmail.com/track-your-item#/tracking-results/{tracking}',
  'Evri':         'https://www.evri.com/track/parcel/{tracking}',
  'FedEx':        'https://www.fedex.com/fedextrack/?trknbr={tracking}',
  'DHL':          'https://www.dhl.com/gb-en/home/tracking.html?tracking-id={tracking}',
  // Proovia + Dropfleet: URL tracking pages (owner to confirm the exact {tracking}
  // deep-link; left as null until then so we just show the number to type on their site).
  'Proovia':      null,
  'Dropfleet':    null,
  'Other / custom courier': null,  // free text, no auto-track link
};
// Carriers eBay recognises natively (so we send the real name); others map to 'Other'
// on the marketplace side. Used by services/ebay.js + services/shopify.js carrier maps.
const EBAY_NATIVE_CARRIERS = new Set(['Royal Mail', 'Evri', 'FedEx', 'DHL']);

function trackingUrlFor(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const tpl = CARRIERS[carrier];
  if (!tpl) return null;
  return tpl.replace('{tracking}', encodeURIComponent(trackingNumber));
}

// Follow-up thresholds (days): flag a shipment "delayed" then "likely lost" after
// these many days in transit without delivery. Configurable in app_settings.data.dispatch.
async function dispatchThresholds() {
  try {
    const r = await query(`SELECT data FROM app_settings WHERE id = 1`);
    const d = (r.rows[0]?.data?.dispatch) || {};
    return {
      delayDays: Number.isFinite(+d.delayDays) && +d.delayDays > 0 ? +d.delayDays : 7,
      lostDays: Number.isFinite(+d.lostDays) && +d.lostDays > 0 ? +d.lostDays : 21,
    };
  } catch (_) { return { delayDays: 7, lostDays: 21 }; }
}

async function getCompany() {
  try { return (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {}; }
  catch (_) { return {}; }
}

// Email a direct (bank/card) customer that their order shipped or is ready to
// collect. eBay/Shopify orders are skipped (the marketplace notifies the buyer).
// kind: 'dispatch' | 'collection'. Best-effort; sets customer_notified_at on success.
async function sendCustomerShippingEmail(saleId, kind) {
  try {
    const email = require('../services/email');
    if (!email.isConfigured()) return { ok: false, error: 'email_not_configured' };
    const sr = await query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    const sale = sr.rows[0];
    if (!sale || !sale.customer_email) return { ok: false, error: 'no_email_address' };
    if ((sale.channel || '').match(/^(shopify|ebay_)/)) return { ok: false, error: 'channel_handles_email' };
    const items = (await query(`SELECT title, qty FROM sale_items WHERE sale_id = $1 ORDER BY id`, [saleId])).rows;
    const company = await getCompany();
    const tmpl = require('../lib/dispatch-emails');
    const built = kind === 'collection'
      ? tmpl.buildCollectionEmail({ sale, items, company })
      : tmpl.buildDispatchEmail({ sale, items, company, carrier: sale.carrier, trackingUrl: trackingUrlFor(sale.carrier, sale.tracking_number) });
    const out = await email.sendEmail({ to: sale.customer_email, subject: built.subject, html: built.html, replyTo: company.company_email || undefined });
    if (out.ok) await query(`UPDATE sales SET customer_notified_at = now() WHERE id = $1`, [saleId]);
    return out;
  } catch (e) { console.warn('[dispatch.email]', e.message); return { ok: false, error: e.message }; }
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
        AND s.status NOT IN ('refunded', 'cancelled', 'dispatched', 'preorder')
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
        AND s.status NOT IN ('refunded', 'cancelled', 'dispatched', 'preorder')
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

  // Email OUR direct (bank/card) delivery customers their "on its way" notice with
  // the tracking link. eBay/Shopify buyers are notified by the marketplace.
  let emailed = false;
  if (['direct_bank', 'direct_card'].includes(result.sale.channel) && result.sale.customer_email && !result.sale.customer_notified_at) {
    emailed = true;
    setImmediate(() => sendCustomerShippingEmail(result.sale.id, 'dispatch').catch(e => console.warn('[dispatch.email]', e.message)));
  }

  res.json({
    ok: true,
    sale: result.sale,
    trackingUrl: trackingUrlFor(carrier, trackingClean),
    customerEmailQueued: emailed,
  });
});

// POST /api/dispatch/:saleId/notify-ready — email a collection customer that their
// order is ready to collect. Direct (bank/cash/card) collections only.
router.post('/:saleId/notify-ready', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const out = await sendCustomerShippingEmail(req.params.saleId, 'collection');
  if (out.ok) { await audit(req, 'notify_ready_collect', 'sale', req.params.saleId, {}); return res.json({ ok: true }); }
  res.status(400).json({ error: out.error || 'send_failed', message: out.error });
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
    // Collection is allowed for any order whose fulfilment is 'collect' — that's
    // every cash order plus any bank/card order explicitly set to collection.
    const fulfil = s.rows[0].fulfillment_method || (s.rows[0].payment_method === 'cash' ? 'collect' : 'ship');
    if (fulfil !== 'collect') return { error: 'not_a_collection_order', message: 'This order is set for shipping — use Mark dispatched (with tracking) instead.' };

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
      delivered_at = NULL, shipping_status = NULL,
      status = 'paid'
    WHERE id = $1 AND is_estimate = false
    RETURNING *
  `, [req.params.saleId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'undo_dispatch', 'sale', result.rows[0].id, {});
  res.json({ ok: true, sale: result.rows[0] });
});

// ──────────────────────────────────────────────────────────────────────────
// Map a sale's channel to a coarse group used by the dispatch filter chips.
function channelGroup(channel) {
  const c = (channel || '').toLowerCase();
  if (c.startsWith('ebay')) return 'ebay';
  if (c === 'shopify') return 'store';
  if (c === 'direct_bank') return 'bank';
  if (c === 'direct_cash') return 'cash';
  if (c === 'direct_card') return 'card';
  return 'other';
}

// POST /api/dispatch/:saleId/set-fulfillment  { method: 'ship'|'collect' }
// Re-classify an order between Deliveries and Collections. Fixes a mis-bucketed
// order (e.g. a bank pickup that defaulted to "ship" and was demanding a carrier).
router.post('/:saleId/set-fulfillment', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const method = req.body?.method === 'collect' ? 'collect' : req.body?.method === 'ship' ? 'ship' : null;
  if (!method) return res.status(400).json({ error: 'method_required', message: "method must be 'ship' or 'collect'." });
  const r = await query(
    `UPDATE sales SET fulfillment_method = $1 WHERE id = $2 AND is_estimate = false RETURNING *`,
    [method, req.params.saleId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'set_fulfillment', 'sale', r.rows[0].id, { method });
  res.json({ ok: true, sale: r.rows[0] });
});

// POST /api/dispatch/:saleId/mark-delivered  { date? }
// Records that a shipped delivery has arrived.
router.post('/:saleId/mark-delivered', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const when = req.body?.date ? new Date(req.body.date) : new Date();
  const r = await query(
    `UPDATE sales SET delivered_at = $1, shipping_status = 'delivered'
       WHERE id = $2 AND dispatched_at IS NOT NULL RETURNING *`,
    [when, req.params.saleId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found', message: 'Order not found or not dispatched yet.' });
  await audit(req, 'mark_delivered', 'sale', r.rows[0].id, {});
  res.json({ ok: true, sale: r.rows[0] });
});

// POST /api/dispatch/:saleId/shipping-status  { status: 'lost'|'issue'|'delivered'|'clear' }
// Manual override of a shipment's delivery state (for chasing/flagging).
router.post('/:saleId/shipping-status', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const raw = String(req.body?.status || '').toLowerCase();
  const status = ['lost', 'issue', 'delivered', 'booked_in'].includes(raw) ? raw : (raw === 'clear' || raw === '' ? null : null);
  if (raw && status === null && raw !== 'clear') return res.status(400).json({ error: 'bad_status' });
  const r = await query(
    `UPDATE sales SET shipping_status = $1,
        delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END
       WHERE id = $2 AND dispatched_at IS NOT NULL RETURNING *`,
    [status, req.params.saleId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'shipping_status', 'sale', r.rows[0].id, { status });
  res.json({ ok: true, sale: r.rows[0] });
});

// GET /api/dispatch/shipments?status=&channel=&days=&q=
// The tracking hub: dispatched DELIVERIES with a derived delivery state +
// days-in-transit, filterable by delivery status, channel group, and a free-text
// search (order ref / tracking number / customer). A search widens the date window
// so an old parcel can be found by its number.
//   status: all | needs_followup | booked_in | in_transit | delivered | exception
//   channel: all | ebay | store | bank | cash | card
router.get('/shipments', requireAdmin, async (req, res) => {
  await ensureDispatchColumns();
  const q = String(req.query.q || '').trim();
  const days = q ? 365 : Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 60));
  const { delayDays, lostDays } = await dispatchThresholds();
  const rows = (await query(`
    SELECT s.*,
      (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title,
      (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS item_count,
      EXTRACT(EPOCH FROM (now() - s.dispatched_at)) / 86400.0 AS days_in_transit
    FROM sales s
    WHERE s.is_estimate = false
      AND s.dispatched_at IS NOT NULL
      AND s.status NOT IN ('refunded', 'cancelled')
      AND COALESCE(s.fulfillment_method, CASE WHEN s.payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'ship'
      AND s.dispatched_at >= now() - ($1 || ' days')::interval
    ORDER BY s.dispatched_at DESC
    LIMIT 2000`, [String(days)])).rows;

  const wantStatus = String(req.query.status || 'all').toLowerCase();
  const wantChannel = String(req.query.channel || 'all').toLowerCase();
  const ql = q.toLowerCase();
  const items = rows.map(s => {
    const dit = Math.floor(parseFloat(s.days_in_transit) || 0);
    // Derived state: explicit override (booked_in/delivered/lost/issue) wins, else
    // delivered_at, else the age thresholds (in_transit → delayed → lost).
    let state;
    if (s.shipping_status) state = s.shipping_status;
    else if (s.delivered_at) state = 'delivered';
    else if (dit >= lostDays) state = 'lost';
    else if (dit >= delayDays) state = 'delayed';
    else state = 'in_transit';
    const isException = (state === 'delayed' || state === 'lost' || state === 'issue');
    return {
      ...s,
      days_in_transit: dit,
      delivery_state: state,
      channel_group: channelGroup(s.channel),
      tracking_url: trackingUrlFor(s.carrier, s.tracking_number),
      needs_followup: isException,
      is_exception: isException,
    };
  }).filter(s => {
    if (wantChannel !== 'all' && s.channel_group !== wantChannel) return false;
    if (ql) {
      const hay = [s.invoice_number, s.payment_reference, s.order_number, s.external_order_id, s.tracking_number, s.customer_name, s.first_item_title]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    if (wantStatus === 'all') return true;
    if (wantStatus === 'needs_followup') return s.needs_followup;
    if (wantStatus === 'exception') return s.is_exception;
    return s.delivery_state === wantStatus;
  });

  res.json({
    shipments: items,
    thresholds: { delayDays, lostDays },
    summary: {
      total: items.length,
      bookedIn: items.filter(s => s.delivery_state === 'booked_in').length,
      inTransit: items.filter(s => s.delivery_state === 'in_transit').length,
      delivered: items.filter(s => s.delivery_state === 'delivered').length,
      exception: items.filter(s => s.is_exception).length,
      needsFollowup: items.filter(s => s.needs_followup).length,
    },
  });
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

// Flag shipments that have been in transit too long, so staff chase them. For each
// dispatched, undelivered delivery: age ≥ lostDays → 'shipment_lost_risk', else
// age ≥ delayDays → 'shipment_delayed'. Deduped (one unread notification per sale per
// type). Best-effort; run from the daily cron. Returns counts.
async function flagStaleShipments() {
  await ensureDispatchColumns();
  const { delayDays, lostDays } = await dispatchThresholds();
  let delayed = 0, lost = 0;
  try {
    const { rows } = await query(`
      SELECT s.id, s.invoice_number, s.payment_reference, s.customer_name,
             EXTRACT(EPOCH FROM (now() - s.dispatched_at)) / 86400.0 AS days_in_transit,
             (SELECT title FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item_title
      FROM sales s
      WHERE s.is_estimate = false AND s.dispatched_at IS NOT NULL
        AND s.delivered_at IS NULL AND (s.shipping_status IS NULL OR s.shipping_status NOT IN ('delivered','lost','issue'))
        AND COALESCE(s.fulfillment_method, CASE WHEN s.payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'ship'
        AND s.dispatched_at >= now() - INTERVAL '120 days'`);
    for (const s of rows) {
      const dit = Math.floor(parseFloat(s.days_in_transit) || 0);
      const ref = s.invoice_number || s.payment_reference || ('#' + s.id);
      const type = dit >= lostDays ? 'shipment_lost_risk' : dit >= delayDays ? 'shipment_delayed' : null;
      if (!type) continue;
      // One unread notification of this (escalating) type per sale.
      const exists = await query(`SELECT id FROM notifications WHERE type = $1 AND related_id = $2 AND read_at IS NULL`, [type, s.id]);
      if (exists.rows.length) continue;
      const title = type === 'shipment_lost_risk' ? `Possible lost parcel: ${ref}` : `Shipment delayed: ${ref}`;
      const body = `${s.first_item_title || 'Order'}${s.customer_name ? ' for ' + s.customer_name : ''} has been in transit ${dit} days with no delivery confirmed. ${type === 'shipment_lost_risk' ? 'Open a courier claim / investigate.' : 'Chase the courier.'}`;
      await query(
        `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
         VALUES ($1, $2, $3, $4, 'sale', $5)`,
        [type, title, body, type === 'shipment_lost_risk' ? 'error' : 'warn', s.id]);
      if (type === 'shipment_lost_risk') lost++; else delayed++;
    }
  } catch (e) { console.warn('[dispatch.flagStale]', e.message); }
  return { delayed, lost };
}

// Poll the carrier tracking APIs (Royal Mail / FedEx / DHL) for in-transit
// deliveries and update their status. Carriers without an API (Evri / Proovia /
// Dropfleet) are skipped — they stay manual. Best-effort, capped per run so we
// stay within API limits. Returns counts.
async function refreshTrackingStatuses({ limit = 120 } = {}) {
  await ensureDispatchColumns();
  const tracking = require('../services/tracking');
  if (!tracking.anyConfigured()) return { checked: 0, delivered: 0, exceptions: 0, skipped: 'no_carrier_api_configured' };
  const carriers = [...tracking.SUPPORTED].filter(c => tracking.supports(c));
  if (!carriers.length) return { checked: 0, delivered: 0, exceptions: 0 };
  let rows;
  try {
    rows = (await query(`
      SELECT id, carrier, tracking_number FROM sales
       WHERE is_estimate = false AND dispatched_at IS NOT NULL
         AND tracking_number IS NOT NULL AND carrier = ANY($1)
         AND delivered_at IS NULL
         AND (shipping_status IS NULL OR shipping_status NOT IN ('delivered','lost'))
         AND dispatched_at >= now() - INTERVAL '90 days'
       ORDER BY dispatched_at ASC
       LIMIT $2`, [carriers, limit])).rows;
  } catch (e) { console.warn('[tracking.refresh]', e.message); return { checked: 0, delivered: 0, exceptions: 0 }; }

  let checked = 0, delivered = 0, exceptions = 0;
  for (const s of rows) {
    const res = await tracking.lookup(s.carrier, s.tracking_number);
    checked++;
    if (!res || !res.state) continue;
    if (res.state === 'delivered') {
      await query(`UPDATE sales SET shipping_status = 'delivered', delivered_at = COALESCE($1::timestamptz, delivered_at, now()) WHERE id = $2`,
        [res.deliveredAt || null, s.id]).catch(() => {});
      delivered++;
    } else if (res.state === 'exception') {
      // Don't override a manual 'issue'/'booked_in'; only flag a clean in-transit one.
      await query(`UPDATE sales SET shipping_status = 'issue' WHERE id = $1 AND (shipping_status IS NULL OR shipping_status = 'delivered')`, [s.id]).catch(() => {});
      exceptions++;
    }
  }
  return { checked, delivered, exceptions };
}

// POST /api/dispatch/refresh-tracking — manual trigger for the carrier-API poll.
router.post('/refresh-tracking', requireAdmin, async (req, res) => {
  try {
    const out = await refreshTrackingStatuses({ limit: Math.min(300, Math.max(1, parseInt(req.body?.limit) || 120)) });
    if (out.delivered || out.exceptions) await audit(req, 'tracking_refresh', null, null, out);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: 'refresh_failed', message: e.message }); }
});

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
module.exports.EBAY_NATIVE_CARRIERS = EBAY_NATIVE_CARRIERS;
module.exports.syncEbayDispatchCore = syncEbayDispatchCore;
module.exports.flagStaleShipments = flagStaleShipments;
module.exports.refreshTrackingStatuses = refreshTrackingStatuses;
