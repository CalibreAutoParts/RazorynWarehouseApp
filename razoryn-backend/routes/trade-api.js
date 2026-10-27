// routes/trade-api.js — the trade customers' API (v1), mounted at /api/trade/v1.
//
// No staff login: every call carries the customer's API key —
//   Authorization: Bearer tk_…   (preferred)
//   X-API-Key: tk_…
//   ?key=tk_…                    (CSV feed / spreadsheet imports only)
// Keys are stored hashed; staff issue / rotate them on the Trade page.
//
// The same API powers the /trade portal and another warehouse app (Razoryn ↔
// Calibre) buying from this one. GET /api/trade/v1 (no key) lists the endpoints.

const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const trade = require('../lib/trade');

const router = express.Router();

// Open CORS: customers may call from their own sites/tools. Keys, not cookies,
// authenticate, so this exposes nothing extra.
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function keyFrom(req) {
  const h = String(req.get('Authorization') || '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return String(req.get('X-API-Key') || req.query.key || '').trim();
}

const ENDPOINTS = {
  auth: 'Authorization: Bearer <your key>  (or X-API-Key header)',
  'GET  /me': 'Your account: terms, credit limit, balance, what you can see',
  'GET  /stock?q=&make=&in_stock=1&changed_since=ISO&limit=100&offset=0': 'Live stock + your prices (ex VAT) + quantity breaks',
  'GET  /stock/:sku': 'One part, with photos and alternate part numbers',
  'GET  /feed.csv?key=': 'Whole price/stock list as CSV (e.g. Google Sheets =IMPORTDATA)',
  'POST /orders': '{ lines:[{sku,qty}], po_ref, notes, delivery:"ship"|"collect", shipping_address, idempotency_key } — stock is reserved the moment it is accepted',
  'GET  /orders?status=&since=': 'Your orders with status, tracking and invoice',
  'GET  /orders/:ref': 'One order',
  'GET  /invoices': 'Consolidated invoices',
  'GET  /invoices/:number(.html|.pdf)': 'One invoice (JSON, printable page or PDF)',
  'GET  /statement': 'Balance, overdue, open invoices, recent payments',
  'GET  /images/:sku': 'Photo list for a part (clean, unbranded photos if your account allows)',
  'GET  /images/:sku/:n': 'Download one photo',
  'GET  /images/:sku.zip  |  POST /images/zip {skus:[]}': 'Download photos as a ZIP',
  'PUT  /webhook {url, secret}': 'Get pushed stock.updated / order.updated / invoice.issued events (HMAC-SHA256 in X-Trade-Signature)',
  'DELETE /webhook': 'Stop webhooks',
};
router.get('/', (req, res) => res.json({ api: 'trade', version: 1, endpoints: ENDPOINTS }));

// Rate limit per key (falls back to IP before auth).
router.use(rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => { const k = keyFrom(req); return k ? 'k:' + trade.hashKey(k).slice(0, 16) : 'ip:' + req.ip; },
  validate: false,
  message: { error: 'rate_limited', message: 'Too many requests — slow down (300/min).' },
}));

router.use(aw(async (req, res, next) => {
  await trade.ensureSchema();
  const account = await trade.accountByKey(keyFrom(req));
  if (!account) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid API key.' });
  req.trade = account;
  if (!account.last_api_at || Date.now() - new Date(account.last_api_at).getTime() > 5 * 60 * 1000) {
    query(`UPDATE trade_accounts SET last_api_at = now() WHERE id = $1`, [account.id]).catch(() => {});
  }
  next();
}));

router.get('/me', aw(async (req, res) => {
  const a = req.trade;
  const settings = await trade.getSettings();
  const sum = await trade.accountSummary(a.id);
  const brand = require('../lib/brand');
  res.json({
    account: { name: a.name, contact: a.contact_name, email: a.email, vat_number: a.vat_number, type: a.account_type },
    supplier: { name: brand.fullName || brand.name, brand: brand.code, vat_registered: settings.vatRegistered },
    terms: { kind: a.terms, invoice_period: a.terms === 'account' ? a.invoice_period : 'per_order', due_days: a.due_days,
      credit_limit: a.credit_limit != null ? Number(a.credit_limit) : null },
    pricing: { ex_vat: true, vat_rate: trade.vatRateFor(a, settings), shows_cost: !!a.show_cost },
    delivery: { charge: Number(a.delivery_charge || 0), free_over: a.free_delivery_over != null ? Number(a.free_delivery_over) : null },
    photos: a.photo_access, shares_locations: !!a.share_locations, partner: !!a.is_partner,
    webhook: a.webhook_url ? { url: a.webhook_url, last_error: a.last_webhook_error || null } : null,
    account_summary: sum,
    message: settings.portalMessage || null,
  });
}));

router.get('/stock', aw(async (req, res) => {
  res.json(await trade.stockList(req.trade, {
    q: String(req.query.q || '').trim(), make: String(req.query.make || '').trim(),
    inStock: req.query.in_stock === '1' || req.query.in_stock === 'true',
    changedSince: req.query.changed_since || null, limit: req.query.limit, offset: req.query.offset,
  }));
}));

router.get('/stock/:sku', aw(async (req, res) => {
  const p = await trade.productBySku(req.params.sku);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const settings = await trade.getSettings();
  const rules = await trade.loadRules(req.trade.id);
  const out = trade.present(req.trade, p, rules, settings, { detail: true });
  const imgs = await trade.imagesFor(req.trade, p);
  out.images = imgs.urls.map((u, i) => ({ n: i + 1, url: /^https?:\/\//.test(u) ? u : `/api/trade/v1/images/${encodeURIComponent(p.sku)}/${i + 1}` }));
  out.images_clean = imgs.clean;
  res.json(out);
}));

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
router.get('/feed.csv', aw(async (req, res) => {
  const a = req.trade;
  const cols = ['sku', 'title', 'make', 'model', 'part_number', 'position', 'available', 'price_ex_vat', 'vat_rate', 'rrp', 'image', 'updated_at'];
  if (a.show_cost) cols.push('our_cost', 'margin_pct');
  if (a.share_locations) cols.push('barcode', 'location');
  const lines = [cols.join(',')];
  for (let off = 0; off < 20000; off += 500) {
    const page = await trade.stockList(a, { limit: 500, offset: off, inStock: req.query.in_stock === '1' });
    for (const i of page.items) {
      const row = { ...i, price_ex_vat: i.price, location: i.location ? (i.location.code || i.location.note) : '' };
      lines.push(cols.map(c => csvCell(row[c] instanceof Date ? row[c].toISOString() : row[c])).join(','));
    }
    if (page.items.length < 500) break;
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="trade-stock.csv"');
  res.send(lines.join('\n'));
}));

function sendTradeError(res, e) {
  if (e instanceof trade.TradeError) {
    const { code, message, ...extra } = e;
    return res.status(code === 'insufficient_stock' || code === 'credit_limit' || code === 'account_overdue' ? 409 : 400)
      .json({ error: code, message, ...extra });
  }
  throw e;
}

router.post('/orders', aw(async (req, res) => {
  const b = req.body || {};
  try {
    const order = await trade.createOrder(req.trade, {
      lines: (b.lines || b.items || []).map(l => ({ sku: l.sku, qty: l.qty ?? l.quantity })),
      poRef: b.po_ref || b.poRef, notes: b.notes, delivery: b.delivery, shippingAddress: b.shipping_address,
      idempotencyKey: b.idempotency_key || req.get('Idempotency-Key') || null,
    }, { source: req.get('X-Trade-Client') === 'portal' ? 'portal' : 'api' });
    res.status(order.replayed ? 200 : 201).json(order);
  } catch (e) { sendTradeError(res, e); }
}));

router.get('/orders', aw(async (req, res) => {
  res.json({ orders: await trade.listOrders(req.trade.id, { status: req.query.status || null, since: req.query.since || null, limit: req.query.limit, offset: req.query.offset }) });
}));

router.get('/orders/:ref', aw(async (req, res) => {
  const s = (await query(`SELECT id FROM sales WHERE trade_account_id = $1 AND (invoice_number = $2 OR id::text = $2)`, [req.trade.id, req.params.ref])).rows[0];
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json(await trade.getOrder(req.trade.id, s.id));
}));

router.get('/invoices', aw(async (req, res) => {
  const rows = (await query(`SELECT number, period_from, period_to, issued_at, due_date, net, vat, total, amount_paid, status, order_count
    FROM trade_invoices WHERE account_id = $1 AND status <> 'void' ORDER BY issued_at DESC LIMIT 200`, [req.trade.id])).rows;
  res.json({ invoices: rows.map(r => ({ ...r, net: Number(r.net), vat: Number(r.vat), total: Number(r.total), amount_paid: Number(r.amount_paid),
    balance: trade.round2(Number(r.total) - Number(r.amount_paid)), overdue: r.status !== 'paid' && new Date(r.due_date) < new Date() })) });
}));

router.get('/invoices/:number', aw(async (req, res) => {
  const m = String(req.params.number).match(/^(.+?)(\.html|\.pdf)?$/);
  const inv = (await query(`SELECT id FROM trade_invoices WHERE account_id = $1 AND number = $2 AND status <> 'void'`, [req.trade.id, m[1]])).rows[0];
  if (!inv) return res.status(404).json({ error: 'not_found' });
  const detail = await trade.invoiceDetail(inv.id, req.trade.id);
  if (m[2]) {
    const company = await require('./sales').getCompanySettings();
    const brand = require('../lib/brand');
    const ti = require('../lib/trade-invoice');
    if (m[2] === '.pdf') {
      const pdf = await ti.buildPdf(detail, { company, brand });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${detail.invoice.number}.pdf"`);
      return res.send(pdf);
    }
    return res.type('html').send(ti.renderHtml(detail, { company, brand }));
  }
  res.json({
    invoice: detail.invoice,
    orders: detail.orders.map(o => trade.formatOrder({ ...o.sale, terms: req.trade.terms }, o.items)),
  });
}));

router.get('/statement', aw(async (req, res) => {
  const a = req.trade;
  const summary = await trade.accountSummary(a.id);
  const open = (await query(`SELECT number, issued_at, due_date, total, amount_paid, status FROM trade_invoices
    WHERE account_id = $1 AND status IN ('issued','part_paid') ORDER BY due_date`, [a.id])).rows;
  const uninvoiced = (await query(`SELECT invoice_number AS ref, occurred_at, total, COALESCE(amount_paid,0) AS amount_paid FROM sales
    WHERE trade_account_id = $1 AND is_paid = false AND trade_invoice_id IS NULL AND is_estimate = false AND status NOT IN ('cancelled','refunded')
    ORDER BY occurred_at`, [a.id])).rows;
  const payments = (await query(`SELECT amount, method, reference, paid_at FROM trade_payments WHERE account_id = $1 ORDER BY paid_at DESC LIMIT 50`, [a.id])).rows;
  res.json({ summary, open_invoices: open, not_yet_invoiced: uninvoiced, payments });
}));

// ── Photos ────────────────────────────────────────────────────────────────
async function imageBuffer(u) {
  if (/^local:/.test(u)) {
    const base = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
    const file = path.resolve(base, u.slice(6));
    if (!file.startsWith(base + path.sep)) throw new Error('bad_path');
    const ext = path.extname(file).toLowerCase();
    return { buf: await fs.promises.readFile(file), type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  }
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
}
const extFor = t => /png/.test(t) ? 'png' : /webp/.test(t) ? 'webp' : 'jpg';

async function zipImages(req, res, skus) {
  const archiver = require('archiver');
  const list = [];
  for (const sku of skus.slice(0, 50)) {
    const p = await trade.productBySku(sku);
    if (!p) continue;
    const imgs = await trade.imagesFor(req.trade, p);
    imgs.urls.forEach((u, i) => list.push({ sku: p.sku, n: i + 1, u }));
  }
  if (!list.length) return res.status(404).json({ error: 'no_images' });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${skus.length === 1 ? String(skus[0]).replace(/[^\w.-]+/g, '_') : 'photos'}.zip"`);
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', e => { try { res.destroy(e); } catch (_) {} });
  zip.pipe(res);
  for (const it of list) {
    try { const { buf, type } = await imageBuffer(it.u); zip.append(buf, { name: `${it.sku.replace(/[^\w.-]+/g, '_')}/${it.sku.replace(/[^\w.-]+/g, '_')}-${it.n}.${extFor(type)}` }); }
    catch (e) { zip.append(`Could not fetch ${it.u}: ${e.message}`, { name: `${it.sku}/ERROR-${it.n}.txt` }); }
  }
  await zip.finalize();
}

router.post('/images/zip', aw(async (req, res) => {
  const skus = Array.isArray(req.body?.skus) ? req.body.skus.map(String).filter(Boolean) : [];
  if (!skus.length) return res.status(400).json({ error: 'skus_required' });
  await zipImages(req, res, skus);
}));

router.get('/images/:sku', aw(async (req, res) => {
  const zipM = req.params.sku.match(/^(.+)\.zip$/i);
  if (zipM) return zipImages(req, res, [zipM[1]]);
  const p = await trade.productBySku(req.params.sku);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const imgs = await trade.imagesFor(req.trade, p);
  res.json({ sku: p.sku, clean: imgs.clean, images: imgs.urls.map((u, i) => ({ n: i + 1, download: `/api/trade/v1/images/${encodeURIComponent(p.sku)}/${i + 1}`, url: /^https?:\/\//.test(u) ? u : null })) });
}));

router.get('/images/:sku/:n', aw(async (req, res) => {
  const p = await trade.productBySku(req.params.sku);
  if (!p) return res.status(404).end();
  const imgs = await trade.imagesFor(req.trade, p);
  const u = imgs.urls[(parseInt(req.params.n) || 1) - 1];
  if (!u) return res.status(404).end();
  const { buf, type } = await imageBuffer(u);
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${p.sku.replace(/[^\w.-]+/g, '_')}-${req.params.n}.${extFor(type)}"`);
  res.send(buf);
}));

// ── Webhook self-service ──────────────────────────────────────────────────
router.put('/webhook', aw(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(url)) return res.status(400).json({ error: 'https_url_required' });
  const secret = String(req.body?.secret || '').trim() || require('crypto').randomBytes(24).toString('hex');
  await query(`UPDATE trade_accounts SET webhook_url = $2, webhook_secret = $3, last_webhook_error = NULL, updated_at = now() WHERE id = $1`, [req.trade.id, url, secret]);
  const test = await trade.sendWebhook({ ...req.trade, webhook_url: url, webhook_secret: secret }, 'webhook.test', { ok: true });
  res.json({ ok: true, url, secret, test });
}));
router.delete('/webhook', aw(async (req, res) => {
  await query(`UPDATE trade_accounts SET webhook_url = NULL, webhook_secret = NULL WHERE id = $1`, [req.trade.id]);
  res.json({ ok: true });
}));

router.use((err, req, res, next) => {
  console.error('[trade-api]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'server_error', message: err.message });
});

module.exports = router;
