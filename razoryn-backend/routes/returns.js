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
    SELECT r.*, p.sku, p.title, s.invoice_number,
           u.name AS handled_by_name,
           (SELECT COUNT(*)::int FROM return_photos WHERE return_id = r.id) AS photo_count
    FROM returns r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN sales s ON s.id = r.sale_id
    LEFT JOIN users u ON u.id = r.handled_by
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_at DESC
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
// Scans the last 60 days of eBay orders for cancellations / refunds and creates Return
// rows in our warehouse. Works with Auth'n'Auth Trading API (no Post-Order OAuth needed).
//
// What it picks up:
//   - Orders with OrderStatus = Cancelled
//   - Orders with RefundStatus (any) — partial or full refunds
//   - Orders with CancelStatus other than 'NotApplicable'
// Each unique eBay order → at most one Return row (skipped if already exists).
router.post('/sync-ebay', requirePermission('returns'), async (req, res) => {
  const ebay = require('../services/ebay');
  if (!ebay.isConfigured()) return res.status(400).json({ error: 'ebay_not_configured' });

  // Fetch raw GetOrders for the last `days`
  const days = Math.min(180, parseInt(req.body.days || 60));
  const sinceISO = new Date(Date.now() - days * 86400000).toISOString();

  let xml;
  try { xml = await ebay.dumpOrderXml(null, days); }
  catch (e) { return res.status(500).json({ error: 'fetch_failed', message: e.message }); }

  // Find all <Order> blocks and detect cancel / refund
  const orderBlocks = xml.match(/<Order>[\s\S]*?<\/Order>/g) || [];
  const candidates = [];
  for (const block of orderBlocks) {
    const orderId = ((block.match(/<OrderID>([^<]+)<\/OrderID>/) || [])[1] || '').trim();
    const status = ((block.match(/<OrderStatus>([^<]+)<\/OrderStatus>/) || [])[1] || '').trim();
    const cancelStatus = ((block.match(/<CancelStatus>([^<]+)<\/CancelStatus>/) || [])[1] || '').trim();
    const refundStatus = ((block.match(/<RefundStatus>([^<]+)<\/RefundStatus>/) || [])[1] || '').trim();
    const refundAmtM = block.match(/<RefundAmount[^>]*>([^<]+)<\/RefundAmount>/);
    const refundAmount = refundAmtM ? parseFloat(refundAmtM[1]) : null;
    const buyer = ((block.match(/<BuyerUserID>([^<]+)<\/BuyerUserID>/) || [])[1] || '').trim();
    const total = parseFloat(((block.match(/<Total[^>]*>([^<]+)<\/Total>/) || [])[1] || '0'));

    const isReturn = status === 'Cancelled'
                   || refundStatus.length > 0
                   || (cancelStatus && cancelStatus !== 'NotApplicable' && cancelStatus !== '');

    if (!orderId || !isReturn) continue;
    candidates.push({ orderId, status, cancelStatus, refundStatus, refundAmount, buyer, total });
  }

  let created = 0, alreadyExists = 0, noLocalSale = 0;
  for (const c of candidates) {
    // Find the matching sale in our DB
    const sale = await query(
      `SELECT id, channel FROM sales WHERE external_order_id = $1 LIMIT 1`,
      [c.orderId]
    );
    if (!sale.rows[0]) { noLocalSale++; continue; }
    // Already a return row for this sale?
    const existing = await query(
      `SELECT id FROM returns WHERE sale_id = $1 LIMIT 1`, [sale.rows[0].id]
    );
    if (existing.rows[0]) { alreadyExists++; continue; }
    // First sale item (most eBay returns are single-line)
    const item = await query(
      `SELECT product_id, qty FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
      [sale.rows[0].id]
    );
    const productId = item.rows[0]?.product_id || null;
    const qty = item.rows[0]?.qty || 1;

    const reason = c.status === 'Cancelled' ? 'Cancelled on eBay'
                 : c.refundStatus ? `Refunded on eBay (${c.refundStatus})`
                 : c.cancelStatus ? `Cancel: ${c.cancelStatus}` : 'eBay return';

    await query(
      `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                            refund_amount, status, notes, handled_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9)`,
      [sale.rows[0].id, productId, sale.rows[0].channel, qty, reason,
       c.refundStatus ? 'refund' : 'pending',
       c.refundAmount || c.total, `eBay order ${c.orderId} · buyer ${c.buyer}`, req.user.id]
    );
    created++;
  }
  await audit(req, 'sync_ebay_returns', null, null, { scanned: candidates.length, created, alreadyExists, noLocalSale });
  res.json({ scanned: candidates.length, created, alreadyExists, noLocalSale });
});

module.exports = router;
