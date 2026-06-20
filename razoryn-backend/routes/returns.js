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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB - frontend auto-downscales
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

// POST /api/returns/from-sale — #7. Log a return against an existing sale:
// pick the returned line items (+ qty + refund amount each), optionally restock,
// and optionally mark the sale refunded. Handles cash/bank/card direct sales
// (and any sale). Creates one processed return per item and restocks in a single
// transaction.
//   { saleId, items:[{productId, qty, refundAmount}], restock, markSaleRefunded, reason, notes }
router.post('/from-sale', requirePermission('returns'), async (req, res) => {
  const b = req.body || {};
  if (!b.saleId || !Array.isArray(b.items) || !b.items.length) {
    return res.status(400).json({ error: 'saleId_and_items_required' });
  }
  const saleRes = await query('SELECT id, channel, status FROM sales WHERE id = $1', [b.saleId]);
  const sale = saleRes.rows[0];
  if (!sale) return res.status(404).json({ error: 'sale_not_found' });

  const restock = b.restock !== false;
  const result = await withTx(async (c) => {
    let created = 0, restocked = 0, totalRefund = 0;
    for (const it of b.items) {
      const qty = parseInt(it.qty) || 0;
      if (qty <= 0) continue;
      const refundAmount = it.refundAmount != null && it.refundAmount !== '' ? parseFloat(it.refundAmount) : null;
      if (refundAmount) totalRefund += refundAmount;
      const resolution = restock ? 'restock' : 'refund';
      const r = await c.query(
        `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                              refund_amount, status, notes, handled_by, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'processed',$8,$9, now()) RETURNING id`,
        [sale.id, it.productId || null, sale.channel, qty, b.reason || null, resolution,
         refundAmount, b.notes || null, req.user.id]
      );
      created++;
      if (restock && it.productId) {
        await c.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1 WHERE id = $2`, [qty, it.productId]);
        await c.query(
          `INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by)
           VALUES ($1,$2,'return_restock',$3,$4)`,
          [it.productId, qty, r.rows[0].id, req.user.id]
        );
        restocked += qty;
      }
    }
    if (b.markSaleRefunded) {
      await c.query(`UPDATE sales SET status = 'refunded' WHERE id = $1`, [sale.id]);
    }
    return { created, restocked, totalRefund: +totalRefund.toFixed(2) };
  });
  await audit(req, 'return_from_sale', 'sale', b.saleId, result);
  res.json({ ok: true, ...result });
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

// POST /api/returns/resync-statuses
// Re-applies the state→status mapping to all existing returns. Useful after the mapping
// is tightened — fixes old returns that were imported before unknown states were handled
// and got stuck on 'open'. Maps based on the stored external_state, no eBay API call needed.
router.post('/resync-statuses', requirePermission('returns'), async (req, res) => {
  const statusMap = {
    'OPEN': 'open', 'RETURN_OPEN': 'open',
    'AWAITING_SELLER_RESPONSE': 'open', 'AWAITING_BUYER_SHIPMENT': 'open', 'SHIPPED_IN_TRANSIT': 'open',
    'DELIVERED': 'received',
    'CLOSED': 'closed', 'RETURN_CLOSED': 'closed', 'CLOSED_REFUNDED': 'processed', 'CLOSED_DENIED': 'closed',
  };
  const { rows } = await query(`SELECT id, external_state, status FROM returns WHERE external_state IS NOT NULL`);
  let updated = 0;
  for (const r of rows) {
    const correct = statusMap[r.external_state] || (String(r.external_state).includes('CLOSED') ? 'closed' : r.status);
    if (correct !== r.status) {
      await query(`UPDATE returns SET status = $1 WHERE id = $2`, [correct, r.id]);
      updated++;
    }
  }
  await audit(req, 'resync_return_statuses', null, null, { scanned: rows.length, updated });
  res.json({ scanned: rows.length, updated });
});

// POST /api/returns/unlink-loose-matches
// Clears product_id from returns where the link was created by the (now-removed) loose
// title-similarity matcher. Identifies these by: product_id is set, but the product's SKU
// does NOT appear in the return's item_title. Run this once to clean up bad matches.
router.post('/unlink-loose-matches', requirePermission('returns'), async (req, res) => {
  // Pull all linked returns + their product SKU
  const linked = await query(`
    SELECT r.id, r.item_title, r.item_sku, r.product_id,
           p.sku AS product_sku, p.part_number AS product_part_number
    FROM returns r
    JOIN products p ON p.id = r.product_id
    WHERE r.external_return_id IS NOT NULL
  `);

  const norm = (s) => (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  let cleared = 0;
  for (const r of linked.rows) {
    const productKey = norm(r.product_sku) || norm(r.product_part_number);
    if (!productKey || productKey.length < 4) continue;
    // If the SKU normalised form appears in the title, KEEP the link.
    const titleNorm = norm(r.item_title);
    if (titleNorm.includes(productKey)) continue;
    // If the SKU also matches item_sku (from eBay), KEEP it.
    const itemSkuNorm = norm(r.item_sku);
    if (itemSkuNorm && (itemSkuNorm === productKey || itemSkuNorm.endsWith(productKey) || productKey.endsWith(itemSkuNorm))) continue;
    // Otherwise this was a loose title-similarity match — clear it
    await query(`UPDATE returns SET product_id = NULL WHERE id = $1`, [r.id]);
    cleared++;
  }
  await audit(req, 'unlink_loose_matches', null, null, { scanned: linked.rows.length, cleared });
  res.json({ scanned: linked.rows.length, cleared });
});

// POST /api/returns/relink-unmatched
// Re-runs the multi-strategy product matching (SKU fuzzy + title token + title similarity)
// against all returns currently missing a product_id. Useful after fixing SKUs or
// after the initial eBay sync left items unlinked.
router.post('/relink-unmatched', requirePermission('returns'), async (req, res) => {
  const sync = require('../services/sync');
  const unlinked = await query(
    `SELECT id, item_title, item_sku, sale_id, external_order_id
     FROM returns WHERE product_id IS NULL ORDER BY id DESC LIMIT 500`
  );
  let linked = 0;
  for (const r of unlinked.rows) {
    let productId = null;
    let chosenSku = r.item_sku;

    // First: pull item info from the matched sale if available
    if (r.sale_id) {
      const item = await query(
        `SELECT product_id, sku, title FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
        [r.sale_id]
      );
      if (item.rows[0]?.product_id) {
        productId = item.rows[0].product_id;
        chosenSku = chosenSku || item.rows[0].sku;
      }
    }
    // Fall back to looking up the sale via external_order_id
    if (!productId && r.external_order_id) {
      const sale = await query(
        `SELECT id FROM sales WHERE external_order_id = $1 LIMIT 1`,
        [r.external_order_id]
      );
      if (sale.rows[0]) {
        const item = await query(
          `SELECT product_id, sku, title FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
          [sale.rows[0].id]
        );
        if (item.rows[0]?.product_id) {
          productId = item.rows[0].product_id;
          chosenSku = chosenSku || item.rows[0].sku;
          await query(`UPDATE returns SET sale_id = $1 WHERE id = $2`, [sale.rows[0].id, r.id]);
        }
      }
    }

    // Fuzzy SKU
    if (!productId && r.item_sku) {
      try {
        const m = await sync.resolveProductBySku(null, r.item_sku);
        if (m) { productId = m.id; chosenSku = chosenSku || m.sku; }
      } catch (e) { /* ignore */ }
    }

    // Title-token extraction — only count tokens with BOTH letters AND digits
    // (part-number shape). Pure-letter tokens like "KONA" are too loose.
    if (!productId && r.item_title) {
      const tokens = String(r.item_title).match(/\b[A-Z0-9]{5,}(?:[-\/][A-Z0-9]{2,})*\b/gi) || [];
      const partNumberTokens = tokens.filter(t => /[A-Z]/i.test(t) && /[0-9]/.test(t));
      partNumberTokens.sort((a, b) => b.length - a.length);
      for (const tok of partNumberTokens.slice(0, 5)) {
        const norm = tok.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (norm.length < 5) continue;
        const p = await query(
          `SELECT id, sku FROM products
           WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(part_number,'')), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(barcode,'')), '[^A-Z0-9]', '', 'g') = $1
           LIMIT 1`, [norm]
        );
        if (p.rows[0]) { productId = p.rows[0].id; chosenSku = chosenSku || p.rows[0].sku; break; }
      }
    }

    // Title-similarity (first-words ILIKE) strategy was REMOVED — too loose,
    // matched things like "Kona bonnet hinge" → "Kona wing/fender".

    if (productId) {
      await query(
        `UPDATE returns SET product_id = $1, item_sku = COALESCE(item_sku, $2) WHERE id = $3`,
        [productId, chosenSku, r.id]
      );
      linked++;
    }
  }
  await audit(req, 'relink_returns', null, null, { scanned: unlinked.rows.length, linked });
  res.json({ scanned: unlinked.rows.length, linked });
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
  const brand = require('../lib/brand');
  if (!ebay.isConfigured()) throw Object.assign(new Error('ebay_not_configured'), { status: 400 });

  // Filter to stores that have a token configured. Each store's returns are
  // pulled separately because eBay's Post-Order API is scoped to whichever
  // seller's token you authenticate with.
  const activeStores = brand.stores.filter(s => s.token);
  if (!activeStores.length) throw Object.assign(new Error('no_ebay_stores_configured'), { status: 400 });

  let totalFetched = 0, created = 0, updated = 0, noLocalSale = 0, notifications = 0;
  const perStore = [];

  const dig = (obj, ...keys) => {
    let v = obj;
    for (const k of keys) { if (v == null) return null; v = v[k]; }
    return v;
  };

  for (const store of activeStores) {
    let data;
    try {
      data = await ebay.getAllRecentReturns(days, store);
    } catch (e) {
      // Propagate auth errors so the route can surface them; log others & continue.
      if (e.status === 401 || e.status === 403) {
        e.message = `[store=${store.code}] ${e.message}`;
        throw e;
      }
      console.error(`[returns.sync] store=${store.code} failed: ${e.message}`);
      perStore.push({ code: store.code, error: e.message, fetched: 0 });
      continue;
    }
    const returns = data.members || data.returns || [];
    totalFetched += returns.length;
    let storeCreated = 0, storeUpdated = 0;

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

      // Channel defaults to this store's channelCode (e.g. ebay_em, ebay_cl).
      let saleId = null, productId = null, qty = itemQty, channel = store.channelCode || 'ebay_em', sku = variationSku;
      let resolvedTitle = itemTitle;
      let resolvedSku = sku;

    // Strategy 1: match by eBay order ID → local sale → product
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
          `SELECT product_id, qty, sku, title FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`,
          [saleId]
        );
        productId = item.rows[0]?.product_id || null;
        qty = itemQty || item.rows[0]?.qty || 1;
        resolvedSku = resolvedSku || item.rows[0]?.sku || null;
        resolvedTitle = resolvedTitle || item.rows[0]?.title || null;
        break;
      }
    }
    if (!saleId) noLocalSale++;

    // Strategy 2: SKU resolution using the shared fuzzy matcher. Handles prefixed SKUs,
    // case variants, alphanumeric-only matches. SKUs are unique-ish so this is safe.
    if (!productId) {
      const sync = require('../services/sync');
      for (const candidate of [resolvedSku, sku, variationSku].filter(Boolean)) {
        try {
          const m = await sync.resolveProductBySku(null, candidate);
          if (m) { productId = m.id; resolvedSku = resolvedSku || m.sku; break; }
        } catch (e) { /* ignore */ }
      }
    }

    // Strategy 3: SKU-shape token extraction from the eBay title.
    // ONLY runs if the title contains a token that looks like a real part number
    // (5+ chars, alphanumeric with optional dashes/slashes, contains BOTH letters AND digits).
    // This avoids matching on car-model names like "KONA" — those are letters-only.
    if (!productId && resolvedTitle) {
      const tokens = String(resolvedTitle).match(/\b[A-Z0-9]{5,}(?:[-\/][A-Z0-9]{2,})*\b/gi) || [];
      // Require BOTH letters AND digits — eliminates "KONA", "HYUNDAI", etc.
      const partNumberTokens = tokens.filter(t => /[A-Z]/i.test(t) && /[0-9]/.test(t));
      partNumberTokens.sort((a, b) => b.length - a.length);
      for (const tok of partNumberTokens.slice(0, 5)) {
        const norm = tok.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (norm.length < 5) continue;
        const p = await query(
          `SELECT id, sku FROM products
           WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(part_number,'')), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(COALESCE(barcode,'')), '[^A-Z0-9]', '', 'g') = $1
           LIMIT 1`,
          [norm]
        );
        if (p.rows[0]) { productId = p.rows[0].id; resolvedSku = resolvedSku || p.rows[0].sku; break; }
      }
    }

    // Strategy 4 (title-similarity by first words) REMOVED — it produced false matches like
    // "Kona bonnet hinge" → "Kona wing/fender" because both shared "Kona Hyundai…". We now
    // only auto-link when there's a real SKU/part-number match. If a return can't be linked
    // automatically, staff can click "🔗 Re-link items" or link manually from the detail modal.

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
         resolvedTitle, resolvedSku, orderId || legacyOrderId, existing.rows[0].id]
      );
      updated++;
      storeUpdated++;
      // Notify on state change (open→closed, etc.) — but only meaningful transitions
      if (isStateChange) {
        const sevMap = { closed: 'success', received: 'info', processed: 'success', open: 'warn' };
        await query(
          `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
           VALUES ('return_state_change', $1, $2, $3, 'return', $4)`,
          [
            `eBay return ${ourStatus === 'closed' ? 'closed' : 'updated'}: ${(resolvedTitle || returnId).slice(0, 60)}`,
            `[${store.name}] Buyer ${buyerUser || 'unknown'} · case ${returnId} · was ${wasState}, now ${state}`,
            sevMap[ourStatus] || 'info',
            existing.rows[0].id,
          ]
        );
        notifications++;
        require('../services/push').sendToAll({
          title: `eBay return updated [${store.name}]`,
          body: `${(resolvedTitle || returnId).slice(0, 60)} · now ${state}`,
          url: '/', tag: 'return-' + returnId, category: 'return_closed',
        }).catch(() => {});
      }
    } else {
      const inserted = await query(
        `INSERT INTO returns (sale_id, product_id, channel, qty, reason, resolution,
                              refund_amount, status, notes, handled_by,
                              external_return_id, external_state, respond_by, buyer_username,
                              item_title, item_sku, external_order_id, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now()) RETURNING id`,
        [saleId, productId, channel, qty, reason, 'pending', refundAmt, ourStatus,
         `eBay return [${store.name}] · order ${orderId || legacyOrderId || '?'}`, performedByUserId,
         returnId, state, respondBy, buyerUser,
         resolvedTitle, resolvedSku, orderId || legacyOrderId]
      );
      created++;
      storeCreated++;
      // Notify on every NEW return — staff need to see these immediately
      await query(
        `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
         VALUES ('return_opened', $1, $2, 'warn', 'return', $3)`,
        [
          `New eBay return [${store.name}]: ${(resolvedTitle || returnId).slice(0, 60)}`,
          `Buyer ${buyerUser || 'unknown'} · reason: ${reason}${respondBy ? ' · respond by ' + new Date(respondBy).toLocaleDateString('en-GB') : ''}`,
          inserted.rows[0].id,
        ]
      );
      notifications++;
      // #2 — push the new-return alert to subscribed devices (best-effort).
      require('../services/push').sendToAll({
        title: `New eBay return [${store.name}]`,
        body: `${(resolvedTitle || returnId).slice(0, 60)} · buyer ${buyerUser || 'unknown'}`,
        url: '/', tag: 'return-' + returnId, category: 'return',
      }).catch(() => {});
    }
    }  // end per-return for loop
    perStore.push({ code: store.code, fetched: returns.length, created: storeCreated, updated: storeUpdated });
  }  // end per-store for loop

  return { fetched: totalFetched, created, updated, noLocalSale, notifications, stores: perStore };
}

// Exported so server.js cron can call it
module.exports = router;
module.exports.syncEbayReturnsCore = syncEbayReturnsCore;
