// routes/returns.js — feature 5: returns workflow with photos
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query, withTx } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const RETURNS_DIR = path.join(UPLOAD_DIR, 'returns');
fs.mkdirSync(RETURNS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RETURNS_DIR),
    filename: (req, file, cb) => {
      const stamp = Date.now() + '-' + Math.round(Math.random() * 1e6);
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '') || '.jpg';
      cb(null, `return-${stamp}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|heic)$/i.test(file.mimetype)) {
      return cb(new Error('only_images'));
    }
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// GET /api/returns?status=open&days=60
router.get('/', requirePermission('returns'), async (req, res) => {
  const { status, days = 90 } = req.query;
  const where = ['r.created_at > now() - $1::interval'];
  const params = [`${parseInt(days)} days`];
  if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
  const { rows } = await query(`
    SELECT r.*,
           COALESCE(p.sku, r.item_sku) AS sku,
           COALESCE(p.title, r.item_title) AS title,
           s.invoice_number,
           COALESCE(s.external_order_id, r.external_order_id) AS external_order_id,
           u.name AS handled_by_name,
           (SELECT COUNT(*)::int FROM return_photos WHERE return_id = r.id) AS photo_count
    FROM returns r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN sales s ON s.id = r.sale_id
    LEFT JOIN users u ON u.id = r.handled_by
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN r.status = 'open' THEN 0
           WHEN r.status = 'received' THEN 1
           WHEN r.status = 'processed' THEN 2
           ELSE 3 END,
      r.respond_by NULLS LAST,
      r.created_at DESC
  `, params);
  res.json({ returns: rows });
});

// GET /api/returns/:id (with photos)
router.get('/:id', requirePermission('returns'), async (req, res) => {
  const r = await query(`
    SELECT r.*, p.sku, p.title, s.invoice_number, s.channel AS sale_channel
    FROM returns r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN sales s ON s.id = r.sale_id
    WHERE r.id = $1
  `, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  const photos = await query(
    'SELECT id, photo_path, caption, uploaded_at FROM return_photos WHERE return_id = $1 ORDER BY uploaded_at',
    [req.params.id]
  );
  res.json({ return: r.rows[0], photos: photos.rows });
});

// POST /api/returns
router.post('/', requirePermission('returns'), async (req, res) => {
  const b = req.body || {};
  if (!b.channel || !b.qty) return res.status(400).json({ error: 'channel_and_qty_required' });

  const { rows } = await query(
    `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                          refund_amount, status, notes, handled_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9) RETURNING *`,
    [b.saleId || null, b.productId || null, b.channel, b.qty,
     b.reason || null, b.resolution || null, b.refundAmount || null,
     b.notes || null, req.user.id]
  );
  await audit(req, 'create_return', 'return', rows[0].id);
  res.status(201).json({ return: rows[0] });
});

// POST /api/returns/:id/photos  (multipart)
router.post('/:id/photos', requirePermission('returns'), upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo_required' });
  const relPath = path.relative(UPLOAD_DIR, req.file.path);
  const { rows } = await query(
    `INSERT INTO return_photos (return_id, photo_path, caption) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, relPath, req.body.caption || null]
  );
  res.status(201).json({ photo: rows[0], url: '/uploads/' + relPath });
});

// PATCH /api/returns/:id  — update status / resolution
router.patch('/:id', requirePermission('returns'), async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  for (const [k, v] of Object.entries({
    status: b.status, resolution: b.resolution,
    refund_amount: b.refundAmount, notes: b.notes,
  })) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (b.status === 'closed') sets.push('closed_at = now()');
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);

  const result = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE returns SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows[0]) return null;

    // Stock outcomes by resolution. Only fire when this PATCH actually moves to 'processed'.
    // - restock     → add qty back to inventory (item came back in good condition)
    // - relist_used → no stock change; user creates a new "used/damaged" listing manually
    // - dispose     → no stock change; item scrapped
    // - refund      → no stock change; buyer kept item
    // - replacement → no stock change; we shipped another
    if (b.status === 'processed' && r.rows[0].resolution === 'restock' && r.rows[0].product_id) {
      await c.query(
        `UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`,
        [r.rows[0].qty, r.rows[0].product_id]
      );
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,$2,'return_restock',$3,$4)`,
        [r.rows[0].product_id, r.rows[0].qty, r.rows[0].id, req.user.id]
      );
    }
    if (b.status === 'processed' && r.rows[0].resolution === 'relist_used' && r.rows[0].product_id) {
      // Log a movement of zero so it appears in the audit trail without changing on-hand qty
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,0,'return_relist_used',$2,$3)`,
        [r.rows[0].product_id, r.rows[0].id, req.user.id]
      );
    }
    if (b.status === 'processed' && r.rows[0].resolution === 'dispose' && r.rows[0].product_id) {
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,0,'return_scrapped',$2,$3)`,
        [r.rows[0].product_id, r.rows[0].id, req.user.id]
      );
    }
    return r.rows[0];
  });
  if (!result) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_return', 'return', result.id, b);
  res.json({ return: result });
});

// POST /api/returns/sync-ebay
// Pull live return cases from eBay's Post-Order API and sync them to our Returns table.
router.post('/sync-ebay', requirePermission('returns'), async (req, res) => {
  const days = Math.min(180, parseInt(req.body.days || 90));
  try {
    const result = await syncEbayReturnsCore({ days, performedByUserId: req.user.id });
    await audit(req, 'sync_ebay_returns', null, null, result);
    res.json(result);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return res.status(503).json({
        error: 'post_order_api_unavailable',
        message: 'eBay Post-Order Returns API requires the OAuth scope `sell.post-order` to be granted to your application.',
        ebayDetail: e.detail,
      });
    }
    res.status(500).json({ error: 'fetch_failed', message: e.message });
  }
});

// Shared core used by both the manual route and the background cron.
// Returns { fetched, created, updated, noLocalSale, notifications: N }
// Generates notifications whenever a new case appears or an existing case
// changes state — so staff see "New eBay return" / "eBay return closed" alerts.
async function syncEbayReturnsCore({ days = 90, performedByUserId = null } = {}) {
  const ebay = require('../services/ebay');
  if (!ebay.isConfigured()) throw Object.assign(new Error('ebay_not_configured'), { status: 400 });

  const data = await ebay.getAllRecentReturns(days);
  const returns = data.members || data.returns || [];
  let created = 0, updated = 0, noLocalSale = 0, notifications = 0;

  const dig = (obj, ...keys) => {
    let v = obj;
    for (const k of keys) { if (v == null) return null; v = v[k]; }
    return v;
  };

  for (const ret of returns) {
    const returnId = ret.returnId || dig(ret, 'returnInfo', 'returnId') || null;
    if (!returnId) continue;

    const itemTitle = ret.itemTitle
                   || dig(ret, 'creationInfo', 'item', 'itemTitle')
                   || dig(ret, 'item', 'itemTitle') || null;
    const itemId = dig(ret, 'creationInfo', 'item', 'itemId')
                || dig(ret, 'item', 'itemId') || null;
    const variationSku = dig(ret, 'creationInfo', 'item', 'variationSku')
                      || dig(ret, 'item', 'variationSku') || null;
    const itemQty = ret.itemQty
                 || dig(ret, 'creationInfo', 'item', 'quantity')
                 || dig(ret, 'item', 'quantity') || 1;
    const orderId = ret.orderId
                 || dig(ret, 'creationInfo', 'order', 'orderId')
                 || dig(ret, 'order', 'orderId') || null;
    const legacyOrderId = dig(ret, 'creationInfo', 'order', 'legacyOrderId')
                       || dig(ret, 'order', 'legacyOrderId') || null;

    let saleId = null, productId = null, qty = itemQty, channel = 'ebay_em', sku = variationSku;
    const candidateOrderIds = [orderId, legacyOrderId].filter(Boolean);
    for (const oid of candidateOrderIds) {
      const sale = await query(
        `SELECT id, channel FROM sales WHERE external_order_id = $1 LIMIT 1`,
        [oid]
      );
      if (sale.rows[0]) {
        saleId = sale.rows[0].id;
        channel = sale.rows[0].channel;
        const item = await query(
          `SELECT product_id, qty, sku FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
          [saleId]
        );
        productId = item.rows[0]?.product_id || null;
        qty = itemQty || item.rows[0]?.qty || 1;
        sku = sku || item.rows[0]?.sku || null;
        break;
      }
    }
    if (!saleId) noLocalSale++;
    if (!productId && (sku || itemId)) {
      for (const s of [sku, itemId].filter(Boolean)) {
        const p = await query(`SELECT id FROM products WHERE sku = $1 OR barcode = $1 LIMIT 1`, [s]);
        if (p.rows[0]) { productId = p.rows[0].id; break; }
      }
    }

    const reasonRaw = ret.reason || dig(ret, 'creationInfo', 'reason') || ret.returnReason || 'Return requested';
    const reason = String(reasonRaw).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const state = ret.state || ret.returnState || dig(ret, 'detail', 'state') || 'OPEN';
    const dueRaw = ret.sellerResponseDueDate
                || ret.respondByDate
                || dig(ret, 'sellerActionDueDate')
                || dig(ret, 'detail', 'sellerActionDueDate')
                || dig(ret, 'expectedTimelines', 'sellerResponseDueDate') || null;
    const respondBy = (dueRaw && typeof dueRaw === 'object') ? (dueRaw.value || null) : dueRaw;
    const buyerUser = ret.buyerLoginName || dig(ret, 'creationInfo', 'buyerLoginName') || dig(ret, 'buyer', 'username') || null;
    const refundRaw = ret.totalRefundAmount || ret.refundAmount || null;
    const refundAmt = refundRaw && typeof refundRaw === 'object' ? (refundRaw.value || null) : refundRaw;

    const statusMap = {
      'OPEN': 'open', 'RETURN_OPEN': 'open',
      'AWAITING_SELLER_RESPONSE': 'open', 'AWAITING_BUYER_SHIPMENT': 'open', 'SHIPPED_IN_TRANSIT': 'open',
      'DELIVERED': 'received',
      'CLOSED': 'closed', 'RETURN_CLOSED': 'closed', 'CLOSED_REFUNDED': 'processed', 'CLOSED_DENIED': 'closed',
    };
    const ourStatus = statusMap[state] || (String(state).includes('CLOSED') ? 'closed' : 'open');

    const existing = await query(`SELECT id, status, external_state FROM returns WHERE external_return_id = $1 LIMIT 1`, [returnId]);
    if (existing.rows[0]) {
      const wasState = existing.rows[0].external_state;
      const isStateChange = wasState && wasState !== state;
      await query(
        `UPDATE returns SET status = $1, external_state = $2, respond_by = $3,
                            refund_amount = COALESCE($4, refund_amount),
                            sale_id = COALESCE(sale_id, $5),
                            product_id = COALESCE(product_id, $6),
                            buyer_username = COALESCE(buyer_username, $7),
                            reason = $8,
                            item_title = COALESCE($9, item_title),
                            item_sku = COALESCE($10, item_sku),
                            external_order_id = COALESCE(external_order_id, $11),
                            last_synced_at = now()
         WHERE id = $12`,
        [ourStatus, state, respondBy, refundAmt, saleId, productId, buyerUser, reason,
         itemTitle, sku, orderId || legacyOrderId, existing.rows[0].id]
      );
      updated++;
      // Notify on state change (open→closed, etc.) — but only meaningful transitions
      if (isStateChange) {
        const sevMap = { closed: 'success', received: 'info', processed: 'success', open: 'warn' };
        await query(
          `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
           VALUES ('return_state_change', $1, $2, $3, 'return', $4)`,
          [
            `eBay return ${ourStatus === 'closed' ? 'closed' : 'updated'}: ${(itemTitle || returnId).slice(0, 60)}`,
            `Buyer ${buyerUser || 'unknown'} · case ${returnId} · was ${wasState}, now ${state}`,
            sevMap[ourStatus] || 'info',
            existing.rows[0].id,
          ]
        );
        notifications++;
      }
    } else {
      const inserted = await query(
        `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                              refund_amount, status, notes, handled_by,
                              external_return_id, external_state, respond_by, buyer_username,
                              item_title, item_sku, external_order_id, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now()) RETURNING id`,
        [saleId, productId, channel, qty, reason, 'pending', refundAmt, ourStatus,
         `eBay return · order ${orderId || legacyOrderId || '?'}`, performedByUserId,
         returnId, state, respondBy, buyerUser,
         itemTitle, sku, orderId || legacyOrderId]
      );
      created++;
      // Notify on every NEW return — staff need to see these immediately
      await query(
        `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
         VALUES ('return_opened', $1, $2, 'warn', 'return', $3)`,
        [
          `New eBay return: ${(itemTitle || returnId).slice(0, 60)}`,
          `Buyer ${buyerUser || 'unknown'} · reason: ${reason}${respondBy ? ' · respond by ' + new Date(respondBy).toLocaleDateString('en-GB') : ''}`,
          inserted.rows[0].id,
        ]
      );
      notifications++;
    }
  }
  return { fetched: returns.length, created, updated, noLocalSale, notifications };
}

// Exported so server.js cron can call it
module.exports = router;
module.exports.syncEbayReturnsCore = syncEbayReturnsCore;
