// routes/trade.js — staff side of wholesale / trade (mounted at /api/trade).
// Trade accounts, their price rules, orders taken for them, consolidated
// invoices, payments, clean photos, and links to OTHER warehouse apps we buy
// from. The customers' own API lives in routes/trade-api.js.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const trade = require('../lib/trade');
const partner = require('../lib/trade-partner');

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(aw(async (req, res, next) => { await trade.ensureSchema(); next(); }));

const baseUrl = req => `${req.protocol}://${req.get('host')}`;
function fail(res, e) {
  if (e instanceof trade.TradeError) { const { code, message, ...extra } = e; return res.status(e.code === 'not_found' ? 404 : 400).json({ error: code, message, ...extra }); }
  if (e.status) return res.status(e.status >= 500 ? 502 : (e.status === 401 ? 400 : e.status)).json({ error: 'partner_error', message: e.status === 401 ? 'The partner app rejected the key — check it in their Trade page.' : e.message, data: e.data || null });
  throw e;
}
function cleanAccount(a) { if (!a) return a; const { api_key_hash, webhook_secret, ...rest } = a; return { ...rest, has_key: !!api_key_hash }; }

// ── Settings ──────────────────────────────────────────────────────────────
router.get('/settings', aw(async (req, res) => res.json(await trade.getSettings())));
router.put('/settings', aw(async (req, res) => {
  const s = await trade.saveSettings(req.body || {});
  await audit(req, 'trade_settings', null, null, req.body || {});
  res.json(s);
}));

// ── Accounts ──────────────────────────────────────────────────────────────
const ACCOUNT_FIELDS = {
  name: 'text', contact_name: 'text', email: 'text', phone: 'text', address: 'text', vat_number: 'text',
  account_type: ['vat', 'cash'], markup_pct: 'num', retail_discount_pct: 'num', show_cost: 'bool',
  terms: ['prepay', 'account'], invoice_period: ['per_order', 'daily', 'weekly', 'monthly'], due_days: 'int',
  credit_limit: 'num', block_when_overdue: 'bool', delivery_charge: 'num0', free_delivery_over: 'num',
  photo_access: ['branded', 'clean'], stock_buffer: 'int', stock_cap: 'int', is_partner: 'bool', partner_brand: 'text',
  share_locations: 'bool', webhook_url: 'text', active: 'bool', notes: 'text',
};
function pickAccount(b) {
  const out = {};
  for (const [k, t] of Object.entries(ACCOUNT_FIELDS)) {
    if (!(k in b)) continue;
    const v = b[k];
    if (Array.isArray(t)) { if (t.includes(v)) out[k] = v; }
    else if (t === 'bool') out[k] = !!v;
    else if (t === 'int') out[k] = v === '' || v == null ? null : (parseInt(v) || 0);
    else if (t === 'num') out[k] = v === '' || v == null ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
    else if (t === 'num0') out[k] = Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0;
    else out[k] = v == null ? null : String(v).trim().slice(0, 2000) || null;
  }
  if (out.webhook_url && !/^https:\/\//i.test(out.webhook_url)) out.webhook_url = null;
  return out;
}

router.get('/accounts', aw(async (req, res) => {
  const rows = (await query(`SELECT * FROM trade_accounts ORDER BY active DESC, name`)).rows;
  const out = [];
  for (const a of rows) out.push({ ...cleanAccount(a), summary: await trade.accountSummary(a.id) });
  res.json({ accounts: out });
}));

router.post('/accounts', aw(async (req, res) => {
  const f = pickAccount(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'name_required', message: 'Enter the business name.' });
  // Mirror into the shared customers list (lifetime spend, search).
  let customerId = null;
  try {
    customerId = (await query(`INSERT INTO customers (name, business_name, email, phone, address, is_trade, created_by)
      VALUES ($1,$1,$2,$3,$4,true,$5) RETURNING id`, [f.name, f.email || null, f.phone || null, f.address || null, req.user.id])).rows[0].id;
  } catch (_) {}
  const cols = Object.keys(f);
  const r = (await query(`INSERT INTO trade_accounts (${cols.join(', ')}, customer_id) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}) RETURNING *`,
    [...cols.map(c => f[c]), customerId])).rows[0];
  await audit(req, 'trade_account_create', 'trade_account', r.id, { name: r.name });
  res.status(201).json({ account: cleanAccount(r) });
}));

router.get('/accounts/:id', aw(async (req, res) => {
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'not_found' });
  const [summary, rules, invoices, payments, orders, top] = await Promise.all([
    trade.accountSummary(a.id),
    query(`SELECT r.*, p.sku AS product_sku, p.title AS product_title FROM trade_price_rules r LEFT JOIN products p ON p.id = r.product_id
           WHERE r.account_id = $1 ORDER BY r.product_id NULLS LAST, r.brand NULLS LAST, r.min_qty`, [a.id]).then(r => r.rows),
    query(`SELECT * FROM trade_invoices WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 100`, [a.id]).then(r => r.rows),
    query(`SELECT * FROM trade_payments WHERE account_id = $1 ORDER BY paid_at DESC LIMIT 100`, [a.id]).then(r => r.rows),
    trade.listOrders(a.id, { limit: 100 }),
    trade.topProducts(a.id),
  ]);
  res.json({ account: cleanAccount(a), summary, rules, invoices, payments, orders, top, portalUrl: `${baseUrl(req)}/trade` });
}));

router.put('/accounts/:id', aw(async (req, res) => {
  const f = pickAccount(req.body || {});
  const cols = Object.keys(f);
  if (!cols.length) return res.status(400).json({ error: 'nothing_to_update' });
  const r = (await query(`UPDATE trade_accounts SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, ...cols.map(c => f[c])])).rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.customer_id) query(`UPDATE customers SET name = $2, business_name = $2, email = $3, phone = $4, address = $5, updated_at = now() WHERE id = $1`,
    [r.customer_id, r.name, r.email, r.phone, r.address]).catch(() => {});
  await audit(req, 'trade_account_update', 'trade_account', r.id, f);
  res.json({ account: cleanAccount(r) });
}));

router.post('/accounts/:id/api-key', aw(async (req, res) => {
  const a = (await query(`SELECT id, email FROM trade_accounts WHERE id = $1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'not_found' });
  const key = await trade.issueApiKey(a.id);
  await audit(req, 'trade_api_key', 'trade_account', a.id, {});
  let emailed = null;
  if (req.body?.email) { try { await trade.emailInvite(a.id, key, baseUrl(req)); emailed = true; } catch (e) { emailed = e.message; } }
  res.json({ key, portalLink: `${baseUrl(req)}/trade#key=${key}`, apiBase: `${baseUrl(req)}/api/trade/v1`, emailed });
}));
router.delete('/accounts/:id/api-key', aw(async (req, res) => {
  await query(`UPDATE trade_accounts SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1`, [req.params.id]);
  await audit(req, 'trade_api_key_revoke', 'trade_account', req.params.id, {});
  res.json({ ok: true });
}));
router.post('/accounts/:id/test-webhook', aw(async (req, res) => {
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [req.params.id])).rows[0];
  if (!a?.webhook_url) return res.status(400).json({ error: 'no_webhook', message: 'No webhook address set.' });
  if (!a.webhook_secret) { a.webhook_secret = crypto.randomBytes(24).toString('hex'); await query(`UPDATE trade_accounts SET webhook_secret = $2 WHERE id = $1`, [a.id, a.webhook_secret]); }
  res.json(await trade.sendWebhook(a, 'webhook.test', { ok: true }));
}));

// Price check for one part + quantity (shows how the price was reached).
router.get('/accounts/:id/quote', aw(async (req, res) => {
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'not_found' });
  const p = (await query(`SELECT * FROM products WHERE upper(sku) = upper($1) OR id::text = $1 LIMIT 1`, [String(req.query.sku || '')])).rows[0];
  if (!p) return res.status(404).json({ error: 'unknown_sku' });
  const settings = await trade.getSettings();
  const rules = await trade.loadRules(a.id);
  const qty = Math.max(1, parseInt(req.query.qty) || 1);
  const pr = trade.priceFor(a, p, qty, rules, settings);
  res.json({ product: { id: p.id, sku: p.sku, title: p.title, qty_on_hand: p.qty_on_hand, price_shopify: p.price_shopify },
    qty, ...pr, available: trade.availableFor(a, p, settings), breaks: trade.priceBreaks(a, p, rules, settings), vatRate: trade.vatRateFor(a, settings) });
}));

// Customer's full price list (with our cost + margin, for staff).
router.get('/accounts/:id/price-list.csv', aw(async (req, res) => {
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).end();
  const lines = ['sku,title,make,model,part_number,available,trade_price_ex_vat,our_cost,margin_pct,rrp'];
  const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const staffView = { ...a, show_cost: true };
  for (let off = 0; off < 20000; off += 500) {
    const page = await trade.stockList(staffView, { limit: 500, offset: off, inStock: req.query.in_stock === '1' });
    for (const i of page.items) lines.push([i.sku, i.title, i.make, i.model, i.part_number, i.available, i.price, i.our_cost, i.margin_pct, i.rrp].map(cell).join(','));
    if (page.items.length < 500) break;
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${a.name.replace(/[^\w.-]+/g, '_')}-price-list.csv"`);
  res.send(lines.join('\n'));
}));

// ── Price rules ───────────────────────────────────────────────────────────
router.get('/rules', aw(async (req, res) => {
  const global = req.query.accountId === 'global' || !req.query.accountId;
  const rows = (await query(`SELECT r.*, p.sku AS product_sku, p.title AS product_title FROM trade_price_rules r LEFT JOIN products p ON p.id = r.product_id
    WHERE ${global ? 'r.account_id IS NULL' : 'r.account_id = $1'} ORDER BY r.product_id NULLS LAST, r.brand NULLS LAST, r.min_qty`, global ? [] : [req.query.accountId])).rows;
  res.json({ rules: rows });
}));
router.post('/rules', aw(async (req, res) => {
  const b = req.body || {};
  const kind = ['markup', 'discount', 'fixed'].includes(b.kind) ? b.kind : 'markup';
  const value = parseFloat(b.value);
  if (!Number.isFinite(value)) return res.status(400).json({ error: 'value_required', message: 'Enter the % or price.' });
  let productId = b.productId ? parseInt(b.productId) : null;
  if (!productId && b.productSku) {
    const p = (await query(`SELECT id FROM products WHERE upper(sku) = upper($1) LIMIT 1`, [String(b.productSku).trim()])).rows[0];
    if (!p) return res.status(404).json({ error: 'unknown_sku', message: `No product with SKU ${b.productSku}` });
    productId = p.id;
  }
  const r = (await query(`INSERT INTO trade_price_rules (account_id, product_id, brand, min_qty, kind, value, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.accountId ? parseInt(b.accountId) : null, productId, productId ? null : (String(b.brand || '').trim() || null),
     Math.max(1, parseInt(b.minQty) || 1), kind, value, String(b.note || '').slice(0, 200) || null])).rows[0];
  await audit(req, 'trade_rule_create', 'trade_rule', r.id, r);
  res.status(201).json({ rule: r });
}));
router.delete('/rules/:id', aw(async (req, res) => {
  await query(`DELETE FROM trade_price_rules WHERE id = $1`, [req.params.id]);
  await audit(req, 'trade_rule_delete', 'trade_rule', req.params.id, {});
  res.json({ ok: true });
}));

// ── Orders ────────────────────────────────────────────────────────────────
router.get('/orders', aw(async (req, res) => {
  const params = [];
  let where = 's.trade_account_id IS NOT NULL AND s.is_estimate = false';
  if (req.query.accountId) { params.push(req.query.accountId); where += ` AND s.trade_account_id = $${params.length}`; }
  if (req.query.unpaid === '1') where += ` AND s.is_paid = false AND s.status NOT IN ('cancelled','refunded')`;
  const rows = (await query(`SELECT s.*, ta.name AS account_name, ta.terms, ti.number AS trade_invoice_number
      FROM sales s JOIN trade_accounts ta ON ta.id = s.trade_account_id LEFT JOIN trade_invoices ti ON ti.id = s.trade_invoice_id
     WHERE ${where} ORDER BY s.occurred_at DESC LIMIT 300`, params)).rows;
  const items = rows.length ? (await query(`SELECT sale_id, sku, title, qty, unit_price, line_total FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`, [rows.map(r => r.id)])).rows : [];
  res.json({ orders: rows.map(s => ({ ...trade.formatOrder(s, items.filter(i => i.sale_id === s.id)), account_id: s.trade_account_id, account_name: s.account_name, sale_id: s.id })) });
}));

router.post('/orders', aw(async (req, res) => {
  const b = req.body || {};
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [b.accountId])).rows[0];
  if (!a) return res.status(404).json({ error: 'not_found', message: 'Pick a trade account.' });
  try {
    const order = await trade.createOrder(a, {
      lines: b.lines || [], poRef: b.poRef, notes: b.notes, delivery: b.delivery, shipping: b.shipping,
      shippingAddress: b.shippingAddress, idempotencyKey: b.idempotencyKey,
    }, { source: 'staff', userId: req.user.id });
    await audit(req, 'trade_order_create', 'sale', order.id, { account: a.name, total: order.total });
    res.status(201).json(order);
  } catch (e) { fail(res, e); }
}));

router.post('/orders/:saleId/cancel', aw(async (req, res) => {
  try {
    const r = await trade.cancelOrder(parseInt(req.params.saleId), req.user.id);
    await audit(req, 'trade_order_cancel', 'sale', req.params.saleId, {});
    res.json(r);
  } catch (e) { fail(res, e); }
}));

// ── Consolidated invoices ─────────────────────────────────────────────────
router.get('/invoices', aw(async (req, res) => {
  const params = [];
  let where = 'true';
  if (req.query.accountId) { params.push(req.query.accountId); where = `ti.account_id = $1`; }
  const rows = (await query(`SELECT ti.*, ta.name AS account_name FROM trade_invoices ti JOIN trade_accounts ta ON ta.id = ti.account_id
    WHERE ${where} ORDER BY ti.issued_at DESC LIMIT 300`, params)).rows;
  res.json({ invoices: rows });
}));
router.post('/invoices/run', aw(async (req, res) => {
  const issued = await trade.runDueInvoices();
  await audit(req, 'trade_invoice_run', null, null, { issued: issued.length });
  res.json({ issued });
}));
router.post('/accounts/:id/invoice-now', aw(async (req, res) => {
  try {
    const inv = await trade.issueInvoice(parseInt(req.params.id), null);
    if (!inv) return res.json({ ok: true, invoice: null, message: 'Nothing to invoice — no un-invoiced orders on account.' });
    await audit(req, 'trade_invoice_issue', 'trade_invoice', inv.id, { number: inv.number });
    res.json({ ok: true, invoice: inv });
  } catch (e) { fail(res, e); }
}));
router.get('/invoices/:id/view', aw(async (req, res) => {
  const d = await trade.invoiceDetail(parseInt(req.params.id));
  if (!d) return res.status(404).send('Not found');
  const company = await require('./sales').getCompanySettings();
  res.type('html').send(require('../lib/trade-invoice').renderHtml(d, { company, brand: require('../lib/brand') }));
}));
router.get('/invoices/:id/pdf', aw(async (req, res) => {
  const d = await trade.invoiceDetail(parseInt(req.params.id));
  if (!d) return res.status(404).send('Not found');
  const company = await require('./sales').getCompanySettings();
  const pdf = await require('../lib/trade-invoice').buildPdf(d, { company, brand: require('../lib/brand') });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${d.invoice.number}.pdf"`);
  res.send(pdf);
}));
router.post('/invoices/:id/email', aw(async (req, res) => {
  try { await trade.emailInvoice(parseInt(req.params.id), req.body?.to || null); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
}));
router.post('/invoices/:id/void', aw(async (req, res) => {
  try { const r = await trade.voidInvoice(parseInt(req.params.id)); await audit(req, 'trade_invoice_void', 'trade_invoice', req.params.id, {}); res.json(r); }
  catch (e) { fail(res, e); }
}));

// ── Payments ──────────────────────────────────────────────────────────────
router.get('/payments', aw(async (req, res) => {
  const params = [];
  let where = 'true';
  if (req.query.accountId) { params.push(req.query.accountId); where = 'tp.account_id = $1'; }
  const rows = (await query(`SELECT tp.*, ta.name AS account_name FROM trade_payments tp JOIN trade_accounts ta ON ta.id = tp.account_id
    WHERE ${where} ORDER BY tp.paid_at DESC LIMIT 300`, params)).rows;
  res.json({ payments: rows });
}));
router.post('/accounts/:id/payments', aw(async (req, res) => {
  const b = req.body || {};
  try {
    const p = await trade.recordPayment(parseInt(req.params.id), {
      amount: b.amount, method: b.method || 'bank', reference: b.reference, notes: b.notes,
      paidAt: b.paidAt || null, invoiceId: b.invoiceId ? parseInt(b.invoiceId) : null,
    }, req.user.id);
    await audit(req, 'trade_payment', 'trade_account', req.params.id, { amount: p.amount, method: p.method });
    res.status(201).json({ payment: p, summary: await trade.accountSummary(parseInt(req.params.id)) });
  } catch (e) { fail(res, e); }
}));

// ── Clean (unbranded) photos per product ──────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
router.get('/products/:id/clean-images', aw(async (req, res) => {
  const urls = await trade.cleanImages(parseInt(req.params.id));
  res.json({ urls: urls.map(u => /^local:/.test(u) ? { stored: true, ref: u } : { url: u, ref: u }) });
}));
// Body: { keep: [refs in order], add: [https urls], uploads: [dataUrl] }
router.put('/products/:id/clean-images', aw(async (req, res) => {
  const pid = parseInt(req.params.id);
  const b = req.body || {};
  const urls = (Array.isArray(b.keep) ? b.keep : []).map(String).filter(u => /^(https:\/\/|local:)/.test(u));
  for (const u of Array.isArray(b.add) ? b.add : []) if (/^https:\/\//.test(String(u).trim())) urls.push(String(u).trim());
  const dir = path.join(UPLOAD_DIR, 'trade-clean', String(pid));
  for (const d of Array.isArray(b.uploads) ? b.uploads.slice(0, 20) : []) {
    const m = String(d).match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!m) continue;
    await fs.promises.mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    await fs.promises.writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'));
    urls.push(`local:trade-clean/${pid}/${name}`);
  }
  await query(`INSERT INTO product_clean_images (product_id, urls, updated_at) VALUES ($1, $2::jsonb, now())
    ON CONFLICT (product_id) DO UPDATE SET urls = EXCLUDED.urls, updated_at = now()`, [pid, JSON.stringify(urls.slice(0, 30))]);
  await audit(req, 'trade_clean_images', 'product', pid, { count: urls.length });
  res.json({ ok: true, count: urls.length });
}));
router.get('/clean-image', aw(async (req, res) => {
  const ref = String(req.query.ref || '');
  if (!/^local:trade-clean\/\d+\/[\w.-]+$/.test(ref)) return res.status(400).end();
  res.sendFile(path.join(path.resolve(UPLOAD_DIR), ref.slice(6)));
}));

// ── Partner warehouse apps we BUY from ────────────────────────────────────
router.get('/partners', aw(async (req, res) => {
  await partner.ensureSchema();
  const rows = (await query(`SELECT l.*, (SELECT COUNT(*)::int FROM products p WHERE p.partner_link_id = l.id) AS linked
    FROM trade_partner_links l ORDER BY l.name`)).rows;
  res.json({ partners: rows.map(partner.publicLink) });
}));
router.post('/partners', aw(async (req, res) => {
  await partner.ensureSchema();
  const b = req.body || {};
  if (!b.name || !b.baseUrl || !b.apiKey) return res.status(400).json({ error: 'missing_fields', message: 'Name, app address and trade key are all needed.' });
  const l = (await query(`INSERT INTO trade_partner_links (name, base_url, api_key, auto_update_cost) VALUES ($1,$2,$3,$4) RETURNING *`,
    [String(b.name).trim(), partner.origin(b.baseUrl), String(b.apiKey).trim(), b.autoUpdateCost !== false])).rows[0];
  let connected = null;
  try { connected = await partner.connect(l, baseUrl(req)); }
  catch (e) { await query(`UPDATE trade_partner_links SET last_error = $2 WHERE id = $1`, [l.id, e.message]); connected = { error: e.message }; }
  await audit(req, 'trade_partner_create', 'trade_partner', l.id, { name: l.name });
  res.status(201).json({ partner: partner.publicLink((await partner.getLink(l.id))), connected });
}));
router.put('/partners/:id', aw(async (req, res) => {
  const b = req.body || {};
  const l = await partner.getLink(req.params.id);
  await query(`UPDATE trade_partner_links SET name = $2, base_url = $3, api_key = $4, auto_update_cost = $5 WHERE id = $1`,
    [l.id, b.name || l.name, b.baseUrl ? partner.origin(b.baseUrl) : l.base_url, b.apiKey ? String(b.apiKey).trim() : l.api_key,
     b.autoUpdateCost === undefined ? l.auto_update_cost : !!b.autoUpdateCost]);
  res.json({ partner: partner.publicLink(await partner.getLink(l.id)) });
}));
router.delete('/partners/:id', aw(async (req, res) => {
  await query(`UPDATE products SET partner_link_id = NULL, partner_sku = NULL WHERE partner_link_id = $1`, [req.params.id]);
  await query(`DELETE FROM trade_partner_links WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));
router.post('/partners/:id/connect', aw(async (req, res) => {
  try { res.json(await partner.connect(await partner.getLink(req.params.id), baseUrl(req))); } catch (e) { fail(res, e); }
}));
router.get('/partners/:id/catalogue', aw(async (req, res) => {
  try {
    res.json(await partner.catalogue(await partner.getLink(req.params.id), {
      q: String(req.query.q || ''), inStock: req.query.in_stock === '1', offset: parseInt(req.query.offset) || 0 }));
  } catch (e) { fail(res, e); }
}));
router.post('/partners/:id/import', aw(async (req, res) => {
  try {
    const r = await partner.importItems(await partner.getLink(req.params.id), (req.body?.skus || []).map(String), req.user.id);
    await audit(req, 'trade_partner_import', 'trade_partner', req.params.id, r);
    res.json(r);
  } catch (e) { fail(res, e); }
}));
router.post('/partners/:id/sync', aw(async (req, res) => {
  try { res.json(await partner.sync(await partner.getLink(req.params.id))); } catch (e) { fail(res, e); }
}));
router.get('/partners/:id/linked', aw(async (req, res) => {
  const rows = (await query(`SELECT id, sku, title, qty_on_hand, partner_sku, partner_qty, partner_cost, partner_location, partner_barcode,
      partner_synced_at, cost_price, price_shopify, price_ebay, (source_partner_id = $1) AS sourced
    FROM products WHERE partner_link_id = $1 ORDER BY title LIMIT 2000`, [req.params.id])).rows;
  res.json({ products: rows });
}));
router.post('/partners/:id/order', aw(async (req, res) => {
  try {
    const r = await partner.placeOrder(await partner.getLink(req.params.id), req.body || {}, req.user.id);
    await audit(req, 'trade_partner_order', 'trade_partner', req.params.id, { ref: r.order?.ref, total: r.order?.total });
    res.status(201).json(r);
  } catch (e) { fail(res, e); }
}));

router.use((err, req, res, next) => {
  console.error('[trade]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'server_error', message: err.message });
});

module.exports = router;

// Public receiver for events a partner app pushes to us (no login; HMAC).
// Mounted at /api/trade-partner-hook in server.js.
const hookRouter = express.Router();
hookRouter.post('/:id', aw(async (req, res) => {
  await partner.ensureSchema();
  const l = (await query(`SELECT * FROM trade_partner_links WHERE id = $1`, [req.params.id])).rows[0];
  if (!l || !l.hook_secret) return res.status(404).json({ error: 'unknown' });
  const raw = req.rawBody || JSON.stringify(req.body || {});
  const expected = trade.sign(l.hook_secret, raw);
  const given = String(req.get('X-Trade-Signature') || '');
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'bad_signature' });
  res.json(await partner.handleEvent(l, req.body || {}));
}));
module.exports.hookRouter = hookRouter;
