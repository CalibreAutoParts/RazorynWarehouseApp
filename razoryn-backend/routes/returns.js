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
  const { status, days = 60 } = req.query;
  const where = ['r.created_at > now() - $1::interval'];
  const params = [`${parseInt(days)} days`];
  if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
  const { rows } = await query(`
    SELECT r.*, p.sku, p.title, s.invoice_number, s.external_order_id,
           u.name AS handled_by_name,
           (SELECT COUNT(*)::int FROM return_photos WHERE return_id = r.id) AS photo_count
    FROM returns r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN sales s ON s.id = r.sale_id
    LEFT JOIN users u ON u.id = r.handled_by
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN r.respond_by IS NOT NULL AND r.status = 'open' THEN 0 ELSE 1 END,
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

    // If resolution = restock, push stock back in.
    if (b.resolution === 'restock' && b.status === 'processed' && r.rows[0].product_id) {
      await c.query(
        `UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`,
        [r.rows[0].qty, r.rows[0].product_id]
      );
      await c.query(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
         VALUES ($1,$2,'return',$3,$4)`,
        [r.rows[0].product_id, r.rows[0].qty, r.rows[0].id, req.user.id]
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
// Each eBay return → one returns row (matched by external_return_id).
// Captures: case ID, buyer, item, reason, respond-by deadline, refund amount, state.
router.post('/sync-ebay', requirePermission('returns'), async (req, res) => {
  const ebay = require('../services/ebay');
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });

  const days = Math.min(180, parseInt(req.body.days || 90));

  let data;
  try {
    data = await ebay.getAllRecentReturns(days);
  } catch (e) {
    // If the Post-Order API rejects our token, surface the actionable error
    if (e.status === 401 || e.status === 403) {
      return res.status(503).json({
        error: 'post_order_api_unavailable',
        message: 'eBay Post-Order Returns API requires the OAuth scope `sell.post-order` to be granted to your application. '
               + 'In your eBay developer dashboard, regenerate the User Token with this scope checked, '
               + 'then update EBAY_AUTH_TOKEN in Railway and try again.',
        ebayDetail: e.detail,
      });
    }
    return res.status(500).json({ error: 'fetch_failed', message: e.message });
  }

  // Post-Order returns shape: { members: [...returns], total: N }
  const returns = data.members || data.returns || [];
  let created = 0, updated = 0, noLocalSale = 0;

  for (const ret of returns) {
    const returnId = ret.returnId || ret.itemId || null;
    if (!returnId) continue;

    // Find matching sale by eBay order ID
    const orderId = ret.orderId || ret.transactionId || null;
    let saleId = null, productId = null, qty = 1, channel = 'ebay_em';
    if (orderId) {
      const sale = await query(
        `SELECT id, channel FROM sales WHERE external_order_id = $1 LIMIT 1`,
        [orderId]
      );
      if (sale.rows[0]) {
        saleId = sale.rows[0].id;
        channel = sale.rows[0].channel;
        const item = await query(
          `SELECT product_id, qty FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
          [saleId]
        );
        productId = item.rows[0]?.product_id || null;
        qty = ret.itemQty || item.rows[0]?.qty || 1;
      } else {
        noLocalSale++;
      }
    }

    // Reason — eBay uses a code like NOT_AS_DESCRIBED, BUYER_REMORSE, etc.
    const reason = ret.reason || ret.returnReason || 'Return requested';
    const state = ret.state || ret.returnState || 'open';
    const respondBy = ret.sellerResponseDueDate || ret.respondByDate || null;
    const buyerUser = ret.buyerLoginName || ret.buyer?.username || null;
    const refundAmt = ret.totalRefundAmount?.value || ret.refundAmount?.value || null;

    // Map eBay state to our status
    const statusMap = {
      'OPEN': 'open',
      'AWAITING_SELLER_RESPONSE': 'open',
      'AWAITING_BUYER_SHIPMENT': 'open',
      'SHIPPED_IN_TRANSIT': 'open',
      'DELIVERED': 'received',
      'CLOSED': 'closed',
      'CLOSED_REFUNDED': 'processed',
      'CLOSED_DENIED': 'closed',
    };
    const ourStatus = statusMap[state] || 'open';

    // Upsert by external_return_id
    const existing = await query(`SELECT id FROM returns WHERE external_return_id = $1 LIMIT 1`, [returnId]);
    if (existing.rows[0]) {
      await query(
        `UPDATE returns SET status = $1, external_state = $2, respond_by = $3,
                            refund_amount = COALESCE($4, refund_amount),
                            last_synced_at = now()
         WHERE id = $5`,
        [ourStatus, state, respondBy, refundAmt, existing.rows[0].id]
      );
      updated++;
    } else {
      await query(
        `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                              refund_amount, status, notes, handled_by,
                              external_return_id, external_state, respond_by, buyer_username, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())`,
        [saleId, productId, channel, qty, reason, 'pending', refundAmt, ourStatus,
         `eBay return · order ${orderId || '?'}`, req.user.id,
         returnId, state, respondBy, buyerUser]
      );
      created++;
    }
  }
  await audit(req, 'sync_ebay_returns', null, null, { fetched: returns.length, created, updated, noLocalSale });
  res.json({ fetched: returns.length, created, updated, noLocalSale });
});

module.exports = router;
