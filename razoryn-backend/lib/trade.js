// lib/trade.js — wholesale / trade selling.
//
// Trade customers (businesses that buy from us to resell) get:
//   • their own prices — cost-plus by default (cost × (1 + markup%)), with
//     per-customer, per-make and per-product rules and quantity breaks,
//   • live stock (the same qty_on_hand eBay/Shopify see, minus an optional
//     safety buffer), via the API, a CSV feed, webhooks and the /trade portal,
//   • orders that reduce stock immediately and push the new level to eBay +
//     Shopify, exactly like a counter sale,
//   • payment terms: pay per order (prepay) or on account, with orders
//     consolidated into one invoice per day / week / month,
//   • a running account: purchased to date, balance, overdue, payments.
//
// Orders are ordinary `sales` rows (channel direct_bank for VAT accounts,
// direct_cash for cash accounts) tagged with trade_account_id, so dispatch,
// labels, refunds, stock movements and the books all keep working unchanged.
// VAT and cash trade are kept apart the same way counter sales already are.
//
// Prices here are NET (ex VAT). sales.unit_price/subtotal stay GROSS like every
// other sale in the app; sales.vat is the VAT portion.

const crypto = require('crypto');
const { query, withTx } = require('../db');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// ─── Schema ────────────────────────────────────────────────────────────────
let _schemaPromise = null;
function ensureSchema() {
  if (!_schemaPromise) _schemaPromise = _migrate().catch(e => { _schemaPromise = null; throw e; });
  return _schemaPromise;
}
async function _migrate() {
  await query(`CREATE TABLE IF NOT EXISTS trade_accounts (
    id                 SERIAL PRIMARY KEY,
    customer_id        INTEGER,
    name               TEXT NOT NULL,
    contact_name       TEXT,
    email              TEXT,
    phone              TEXT,
    address            TEXT,
    vat_number         TEXT,
    account_type       TEXT NOT NULL DEFAULT 'vat',        -- 'vat' (bank, VAT invoices) | 'cash'
    markup_pct         NUMERIC(7,2),                       -- NULL → settings default
    retail_discount_pct NUMERIC(7,2),                      -- fallback when a part has no cost
    show_cost          BOOLEAN NOT NULL DEFAULT false,     -- show our cost + margin up front
    terms              TEXT NOT NULL DEFAULT 'prepay',     -- 'prepay' | 'account'
    invoice_period     TEXT NOT NULL DEFAULT 'monthly',    -- 'per_order' | 'daily' | 'weekly' | 'monthly'
    due_days           INTEGER NOT NULL DEFAULT 30,
    credit_limit       NUMERIC(12,2),
    block_when_overdue BOOLEAN NOT NULL DEFAULT true,
    delivery_charge    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- net, per order
    free_delivery_over NUMERIC(10,2),                      -- net order value
    photo_access       TEXT NOT NULL DEFAULT 'branded',    -- 'branded' | 'clean'
    stock_buffer       INTEGER,                            -- NULL → settings default
    stock_cap          INTEGER,                            -- show at most N ("N+")
    is_partner         BOOLEAN NOT NULL DEFAULT false,     -- another warehouse app (Razoryn/Calibre)
    partner_brand      TEXT,
    share_locations    BOOLEAN NOT NULL DEFAULT false,     -- share bin location + barcode
    webhook_url        TEXT,
    webhook_secret     TEXT,
    last_webhook_at    TIMESTAMPTZ,
    last_webhook_error TEXT,
    api_key_hash       TEXT UNIQUE,
    api_key_prefix     TEXT,
    api_key_created_at TIMESTAMPTZ,
    last_api_at        TIMESTAMPTZ,
    active             BOOLEAN NOT NULL DEFAULT true,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS trade_price_rules (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER,                 -- NULL = every trade customer
    product_id  INTEGER,                 -- NULL = not product-specific
    brand       TEXT,                    -- vehicle make; NULL = any
    min_qty     INTEGER NOT NULL DEFAULT 1,
    kind        TEXT NOT NULL DEFAULT 'markup',   -- 'markup' (% on cost) | 'discount' (% off retail) | 'fixed' (net £)
    value       NUMERIC(12,4) NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS trade_price_rules_acct_idx ON trade_price_rules (account_id)`);
  await query(`CREATE TABLE IF NOT EXISTS trade_invoices (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER NOT NULL,
    number       TEXT UNIQUE NOT NULL,
    period_from  DATE,
    period_to    DATE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_date     DATE,
    net          NUMERIC(12,2) NOT NULL DEFAULT 0,
    vat          NUMERIC(12,2) NOT NULL DEFAULT 0,
    total        NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount_paid  NUMERIC(12,2) NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'issued',   -- issued | part_paid | paid | void
    account_type TEXT NOT NULL DEFAULT 'vat',
    order_count  INTEGER NOT NULL DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS trade_payments (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    unallocated NUMERIC(12,2) NOT NULL DEFAULT 0,
    method      TEXT,
    reference   TEXT,
    notes       TEXT,
    allocations JSONB,
    paid_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS trade_stock_state (
    product_id INTEGER PRIMARY KEY,
    qty        INTEGER,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS trade_image_cache (
    product_id INTEGER PRIMARY KEY, urls JSONB, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS product_clean_images (
    product_id INTEGER PRIMARY KEY, urls JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // Same ledger the sales page uses for part payments.
  await query(`CREATE TABLE IF NOT EXISTS sale_payments (
    id SERIAL PRIMARY KEY, sale_id INTEGER NOT NULL, amount NUMERIC(10,2) NOT NULL,
    method TEXT, notes TEXT, paid_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by INTEGER)`);
  // Columns other modules add on their own boot — added here too so trade
  // never depends on which router initialised first.
  for (const col of [
    'customer_id INTEGER', 'shipping_address TEXT', 'fulfillment_method TEXT', 'customer_vat_number TEXT',
    'is_paid BOOLEAN NOT NULL DEFAULT true', 'paid_at TIMESTAMPTZ', 'refunded_amount NUMERIC(10,2)',
    'dispatched_at TIMESTAMPTZ', 'collected_at TIMESTAMPTZ', 'tracking_number TEXT', 'carrier TEXT',
    'trade_account_id INTEGER', 'trade_invoice_id INTEGER',
    'trade_consolidated BOOLEAN NOT NULL DEFAULT false', 'trade_idem_key TEXT',
    'trade_event_state TEXT', 'amount_paid NUMERIC(10,2)',
  ]) await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS ${col}`);
  await query(`CREATE INDEX IF NOT EXISTS sales_trade_acct_idx ON sales (trade_account_id) WHERE trade_account_id IS NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_trade_idem_uq ON sales (trade_account_id, trade_idem_key) WHERE trade_idem_key IS NOT NULL`);
  // Parts linked to another warehouse app (partner). partner_link_id = which
  // partner the part is linked to; source_partner_id = that partner is where
  // our stock/cost for it comes from (the Inventory "source" filter).
  for (const col of [
    'partner_link_id INTEGER', 'source_partner_id INTEGER', 'partner_sku TEXT', 'partner_qty INTEGER', 'partner_cost NUMERIC(12,4)',
    'partner_location TEXT', 'partner_barcode TEXT', 'partner_synced_at TIMESTAMPTZ',
  ]) await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ${col}`);
}

// ─── Settings ──────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = { defaultMarkupPct: 25, stockBuffer: 0, allowBelowCost: false, portalMessage: '', autoEmailInvoices: true };
async function getSettings() {
  const r = await query(`SELECT data, vat_rate, vat_registered FROM app_settings WHERE id = 1`);
  const row = r.rows[0] || {};
  const t = (row.data && row.data.trade) || {};
  return {
    ...DEFAULT_SETTINGS, ...t,
    vatRegistered: !!row.vat_registered,
    vatRate: num(row.vat_rate) ?? 20,
  };
}
async function saveSettings(patch = {}) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const t = { ...(cur.trade || {}) };
  if (patch.defaultMarkupPct !== undefined) t.defaultMarkupPct = Math.max(0, num(patch.defaultMarkupPct) ?? 25);
  if (patch.stockBuffer !== undefined) t.stockBuffer = Math.max(0, parseInt(patch.stockBuffer) || 0);
  if (patch.allowBelowCost !== undefined) t.allowBelowCost = !!patch.allowBelowCost;
  if (patch.portalMessage !== undefined) t.portalMessage = String(patch.portalMessage || '').slice(0, 500);
  if (patch.autoEmailInvoices !== undefined) t.autoEmailInvoices = !!patch.autoEmailInvoices;
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, trade: t })]);
  return getSettings();
}

// VAT applies to a trade order when we're VAT registered and it's a VAT
// (bank) account. Cash trade follows the app's existing cash policy (no VAT
// recorded) and is kept apart in the books.
function vatRateFor(account, settings) {
  return (settings.vatRegistered && account.account_type !== 'cash') ? settings.vatRate : 0;
}

// ─── API keys ──────────────────────────────────────────────────────────────
const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');
async function issueApiKey(accountId) {
  const key = 'tk_' + crypto.randomBytes(24).toString('base64url');
  await query(`UPDATE trade_accounts SET api_key_hash = $1, api_key_prefix = $2, api_key_created_at = now(), updated_at = now() WHERE id = $3`,
    [hashKey(key), key.slice(0, 9), accountId]);
  return key;
}
async function accountByKey(key) {
  if (!key || !/^tk_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const r = await query(`SELECT * FROM trade_accounts WHERE api_key_hash = $1 AND active = true`, [hashKey(key)]);
  return r.rows[0] || null;
}

// ─── Pricing ───────────────────────────────────────────────────────────────
function costOf(p) {
  const l = num(p.landed_cost); if (l && l > 0) return l;
  const c = num(p.cost_price); return c && c > 0 ? c : null;
}
function retailNet(p, settings) {
  const g = num(p.price_shopify) || num(p.price_ebay);
  if (!g) return null;
  return settings.vatRegistered ? g / (1 + settings.vatRate / 100) : g;
}
async function loadRules(accountId) {
  const r = await query(`SELECT * FROM trade_price_rules WHERE account_id = $1 OR account_id IS NULL`, [accountId]);
  return r.rows;
}
function ruleScope(rule, p) {
  if (rule.product_id) return rule.product_id === p.id ? 3 : -1;
  if (rule.brand) return String(p.brand || '').trim().toLowerCase() === String(rule.brand).trim().toLowerCase() ? 2 : -1;
  return 1;
}
// Most specific rule wins (product > make > everything; this customer's own
// rules beat the all-customer ones), then the biggest quantity break reached.
function pickRule(rules, p, qty) {
  let best = null, bestKey = null;
  for (const r of rules) {
    const scope = ruleScope(r, p);
    if (scope < 0 || (r.min_qty || 1) > qty) continue;
    const key = [scope, r.account_id ? 1 : 0, r.min_qty || 1];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      best = r; bestKey = key;
    }
  }
  return best;
}
// → { net, cost, basis, ruleId, clamped } ; net null = price on request.
function priceFor(account, p, qty, rules, settings) {
  const cost = costOf(p);
  const rule = pickRule(rules, p, Math.max(1, qty || 1));
  let net = null, basis = null;
  const markup = rule && rule.kind === 'markup' ? num(rule.value)
    : (num(account.markup_pct) ?? num(settings.defaultMarkupPct) ?? 25);
  if (rule && rule.kind === 'fixed') { net = num(rule.value); basis = 'fixed'; }
  else if (rule && rule.kind === 'discount') {
    const rn = retailNet(p, settings);
    if (rn != null) { net = rn * (1 - num(rule.value) / 100); basis = 'retail_discount'; }
  } else if (cost != null) { net = cost * (1 + markup / 100); basis = 'cost_plus'; }
  if (net == null && num(account.retail_discount_pct) != null) {
    const rn = retailNet(p, settings);
    if (rn != null) { net = rn * (1 - num(account.retail_discount_pct) / 100); basis = 'retail_discount'; }
  }
  let clamped = false;
  if (net != null && cost != null && net < cost && !settings.allowBelowCost) { net = cost; clamped = true; }
  return { net: net != null ? round2(net) : null, cost, basis, ruleId: rule ? rule.id : null, markupPct: basis === 'cost_plus' ? markup : null, clamped };
}
// Quantity breaks that apply to this product for this customer.
function priceBreaks(account, p, rules, settings) {
  const qtys = new Set([1]);
  for (const r of rules) if ((r.min_qty || 1) > 1 && ruleScope(r, p) >= 0) qtys.add(r.min_qty);
  return [...qtys].sort((a, b) => a - b)
    .map(q => ({ min_qty: q, price: priceFor(account, p, q, rules, settings).net }))
    .filter((b, i, arr) => b.price != null && (i === 0 || b.price !== arr[i - 1].price));
}

// ─── Stock view ────────────────────────────────────────────────────────────
function bufferFor(account, settings) {
  return Math.max(0, parseInt(account.stock_buffer != null ? account.stock_buffer : settings.stockBuffer) || 0);
}
function availableFor(account, p, settings) {
  return Math.max(0, (parseInt(p.qty_on_hand) || 0) - bufferFor(account, settings));
}

const PRODUCT_COLS = `p.id, p.sku, p.title, p.brand, p.model, p.part_number, p.position, p.barcode,
  p.qty_on_hand, p.price_shopify, p.price_ebay, p.cost_price, p.landed_cost, p.image_url,
  p.shopify_product_id, p.updated_at, p.location_id, p.location_note, l.code AS location_code, l.name AS location_name,
  ts.changed_at AS stock_changed_at`;

// One product as a trade customer sees it.
function present(account, p, rules, settings, { detail = false } = {}) {
  const pr = priceFor(account, p, 1, rules, settings);
  const avail = availableFor(account, p, settings);
  const cap = parseInt(account.stock_cap) || 0;
  const out = {
    sku: p.sku, title: p.title, make: p.brand || null, model: p.model || null,
    part_number: p.part_number || null, position: p.position || null,
    available: cap && avail > cap ? cap : avail,
    available_display: cap && avail > cap ? `${cap}+` : String(avail),
    in_stock: avail > 0,
    price: pr.net, currency: 'GBP', price_ex_vat: true,
    vat_rate: vatRateFor(account, settings),
    price_breaks: priceBreaks(account, p, rules, settings),
    image: p.image_url || null,
    rrp: num(p.price_shopify) || num(p.price_ebay),
    updated_at: p.stock_changed_at || p.updated_at,
  };
  if (account.show_cost) {
    out.our_cost = pr.cost != null ? round2(pr.cost) : null;
    out.margin_pct = (pr.cost && pr.net) ? round2((pr.net - pr.cost) / pr.net * 100) : null;
  }
  if (account.share_locations) {
    out.barcode = p.barcode || null;
    out.location = p.location_code ? { code: p.location_code, name: p.location_name, note: p.location_note || null } : (p.location_note ? { note: p.location_note } : null);
  }
  if (detail) out.alternate_part_numbers = p.alternates || [];
  return out;
}

async function stockList(account, { q = '', make = '', inStock = false, changedSince = null, limit = 100, offset = 0 } = {}) {
  await ensureSchema();
  const settings = await getSettings();
  const rules = await loadRules(account.id);
  const params = [];
  const where = ['p.active = true'];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(p.sku ILIKE $${params.length} OR p.title ILIKE $${params.length} OR p.part_number ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM product_part_numbers pp WHERE pp.product_id = p.id AND pp.code ILIKE $${params.length}))`);
  }
  if (make) { params.push(make); where.push(`lower(p.brand) = lower($${params.length})`); }
  if (inStock) { params.push(bufferFor(account, settings)); where.push(`p.qty_on_hand > $${params.length}`); }
  if (changedSince) { params.push(changedSince); where.push(`GREATEST(p.updated_at, COALESCE(ts.changed_at, p.updated_at)) > $${params.length}::timestamptz`); }
  const lim = Math.min(500, Math.max(1, parseInt(limit) || 100));
  const off = Math.max(0, parseInt(offset) || 0);
  const base = `FROM products p LEFT JOIN locations l ON l.id = p.location_id
                LEFT JOIN trade_stock_state ts ON ts.product_id = p.id WHERE ${where.join(' AND ')}`;
  let total = 0;
  try { total = (await query(`SELECT COUNT(*)::int AS n ${base}`, params)).rows[0].n; }
  catch (e) {
    // product_part_numbers may not exist on a fresh database.
    if (!/product_part_numbers/.test(e.message)) throw e;
    await query(`CREATE TABLE IF NOT EXISTS product_part_numbers (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, code TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    total = (await query(`SELECT COUNT(*)::int AS n ${base}`, params)).rows[0].n;
  }
  const rows = (await query(`SELECT ${PRODUCT_COLS} ${base} ORDER BY p.title, p.sku LIMIT ${lim} OFFSET ${off}`, params)).rows;
  return { total, limit: lim, offset: off, items: rows.map(p => present(account, p, rules, settings)) };
}

async function productBySku(sku) {
  const r = await query(`SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN locations l ON l.id = p.location_id
    LEFT JOIN trade_stock_state ts ON ts.product_id = p.id
    WHERE upper(p.sku) = upper($1) AND p.active = true LIMIT 1`, [String(sku || '').trim()]);
  const p = r.rows[0];
  if (!p) return null;
  try { p.alternates = (await query(`SELECT code FROM product_part_numbers WHERE product_id = $1 ORDER BY id`, [p.id])).rows.map(x => x.code); }
  catch (_) { p.alternates = []; }
  return p;
}

// ─── Photos ────────────────────────────────────────────────────────────────
// Branded = the listing photos (Shopify CDN, as made by the Thumbnail Maker).
// Clean = photos without our branding/watermark, only for customers allowed them.
async function brandedImages(p) {
  const c = (await query(`SELECT urls, fetched_at FROM trade_image_cache WHERE product_id = $1`, [p.id])).rows[0];
  if (c && Date.now() - new Date(c.fetched_at).getTime() < 24 * 3600 * 1000 && Array.isArray(c.urls)) return c.urls;
  let urls = p.image_url ? [p.image_url] : [];
  try {
    const shopify = require('../services/shopify');
    if (p.shopify_product_id && shopify.isConfigured()) {
      const sp = await shopify.getShopifyProductFull(p.shopify_product_id);
      if (sp.imageUrls?.length) urls = sp.imageUrls;
    }
  } catch (_) {}
  await query(`INSERT INTO trade_image_cache (product_id, urls, fetched_at) VALUES ($1, $2::jsonb, now())
    ON CONFLICT (product_id) DO UPDATE SET urls = EXCLUDED.urls, fetched_at = now()`, [p.id, JSON.stringify(urls)]).catch(() => {});
  return urls;
}
async function cleanImages(productId) {
  const r = (await query(`SELECT urls FROM product_clean_images WHERE product_id = $1`, [productId])).rows[0];
  return Array.isArray(r?.urls) ? r.urls : [];
}
async function imagesFor(account, p) {
  if (account.photo_access === 'clean') {
    const clean = await cleanImages(p.id);
    if (clean.length) return { urls: clean, clean: true };
  }
  return { urls: await brandedImages(p), clean: false };
}

// ─── Account figures ───────────────────────────────────────────────────────
async function accountSummary(accountId) {
  const r = (await query(`
    SELECT
      COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled')), 0)                                    AS lifetime,
      COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled') AND occurred_at >= date_trunc('year', now())), 0) AS ytd,
      COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled') AND occurred_at >= now() - interval '30 days'), 0) AS last30,
      COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))                                                    AS orders,
      COALESCE(SUM(total - COALESCE(amount_paid,0) - COALESCE(refunded_amount,0))
               FILTER (WHERE is_paid = false AND status NOT IN ('cancelled','refunded')), 0)                AS owed,
      MAX(occurred_at)                                                                                       AS last_order_at
    FROM sales WHERE trade_account_id = $1 AND is_estimate = false`, [accountId])).rows[0];
  const credit = (await query(`SELECT COALESCE(SUM(unallocated),0) AS c FROM trade_payments WHERE account_id = $1`, [accountId])).rows[0].c;
  const overdue = (await query(`
    SELECT COALESCE(SUM(total - amount_paid),0) AS amt, COUNT(*)::int AS n FROM trade_invoices
     WHERE account_id = $1 AND status IN ('issued','part_paid') AND due_date < CURRENT_DATE`, [accountId])).rows[0];
  const owed = Math.max(0, round2(num(r.owed) - num(credit)));
  return {
    lifetime: round2(r.lifetime), ytd: round2(r.ytd), last30: round2(r.last30), orders: parseInt(r.orders) || 0,
    balance: owed, credit: round2(credit), overdue: round2(overdue.amt), overdueInvoices: overdue.n,
    lastOrderAt: r.last_order_at,
  };
}

async function topProducts(accountId, limit = 15) {
  return (await query(`
    SELECT si.sku, MAX(si.title) AS title, SUM(si.qty)::int AS qty, ROUND(SUM(si.line_total)::numeric, 2) AS spend
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.trade_account_id = $1 AND s.status <> 'cancelled' AND s.is_estimate = false
     GROUP BY si.sku ORDER BY spend DESC LIMIT $2`, [accountId, limit])).rows;
}

// ─── Orders ────────────────────────────────────────────────────────────────
class TradeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

function publicOrderStatus(s) {
  if (s.status === 'cancelled') return 'cancelled';
  if (s.status === 'refunded') return 'refunded';
  if (s.dispatched_at) return 'dispatched';
  if (s.collected_at) return 'collected';
  if (!s.is_paid && !s.trade_consolidated && s.terms === 'prepay') return 'awaiting_payment';
  return 'processing';
}

// lines: [{ sku | productId, qty, unitPrice? (staff override, net) }]
async function createOrder(account, input = {}, ctx = {}) {
  await ensureSchema();
  if (!account || !account.active) throw new TradeError('account_inactive', 'This trade account is not active.');
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw new TradeError('lines_required', 'Add at least one item.');
  if (lines.length > 200) throw new TradeError('too_many_lines', 'Max 200 lines per order.');
  const staff = ctx.source === 'staff';
  const idem = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 80) : null;
  if (idem) {
    const ex = (await query(`SELECT id FROM sales WHERE trade_account_id = $1 AND trade_idem_key = $2`, [account.id, idem])).rows[0];
    if (ex) return { ...(await getOrder(account.id, ex.id)), replayed: true };
  }
  const settings = await getSettings();
  const rules = await loadRules(account.id);
  const vatRate = vatRateFor(account, settings);
  const r = vatRate / 100;
  const consolidated = account.terms === 'account' && account.invoice_period !== 'per_order';
  const delivery = input.delivery === 'collect' ? 'collect' : 'ship';

  // Credit control (account customers).
  if (account.terms === 'account' && !staff) {
    const sum = await accountSummary(account.id);
    if (account.block_when_overdue && sum.overdue > 0) {
      throw new TradeError('account_overdue', `Your account has £${sum.overdue.toFixed(2)} overdue. Please settle it before placing new orders.`);
    }
    ctx._balance = sum.balance;
  }

  const salesMod = require('../routes/sales');
  const result = await withTx(async (c) => {
    const shortages = [], resolved = [], noPrice = [];
    let netSubtotal = 0, grossSubtotal = 0;
    for (const ln of lines) {
      const qty = parseInt(ln.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw new TradeError('bad_qty', `Invalid quantity for ${ln.sku || ln.productId}.`);
      const pr = await c.query(
        `SELECT * FROM products WHERE ${ln.productId ? 'id = $1' : 'upper(sku) = upper($1)'} AND active = true FOR UPDATE`,
        [ln.productId || String(ln.sku || '').trim()]);
      const p = pr.rows[0];
      if (!p) throw new TradeError('unknown_sku', `Unknown part: ${ln.sku || ln.productId}`);
      const avail = staff ? (parseInt(p.qty_on_hand) || 0) : availableFor(account, p, settings);
      if (avail < qty) { shortages.push({ sku: p.sku, title: p.title, requested: qty, available: Math.max(0, avail) }); continue; }
      let net;
      if (staff && ln.unitPrice != null && ln.unitPrice !== '') net = round2(ln.unitPrice);
      else net = priceFor(account, p, qty, rules, settings).net;
      if (net == null) { noPrice.push(p.sku); continue; }
      const grossUnit = round2(net * (1 + r));
      const lineGross = round2(grossUnit * qty);
      netSubtotal += net * qty; grossSubtotal += lineGross;
      resolved.push({ productId: p.id, sku: p.sku, title: p.title, qty, net, unitPrice: grossUnit, lineTotal: lineGross, groupId: p.stock_group_id || null });
    }
    if (shortages.length) throw new TradeError('insufficient_stock', 'Not enough stock for some items.', { shortages });
    if (noPrice.length) throw new TradeError('no_price', `No trade price for: ${noPrice.join(', ')} — ask us for a quote.`, { skus: noPrice });

    let shipNet = 0;
    if (delivery === 'ship') {
      shipNet = num(account.delivery_charge) || 0;
      const freeOver = num(account.free_delivery_over);
      if (freeOver != null && netSubtotal >= freeOver) shipNet = 0;
    }
    if (staff && input.shipping != null && input.shipping !== '') shipNet = Math.max(0, num(input.shipping) || 0);
    const shipping = round2(shipNet * (1 + r));
    const grossAll = round2(grossSubtotal + shipping);
    const vat = r > 0 ? round2(grossAll - grossAll / (1 + r)) : 0;
    const total = grossAll;

    if (account.terms === 'account' && !staff && num(account.credit_limit) != null
        && (ctx._balance || 0) + total > num(account.credit_limit) + 0.005) {
      throw new TradeError('credit_limit', `This order would take your account over its £${num(account.credit_limit).toFixed(2)} credit limit (balance £${(ctx._balance || 0).toFixed(2)}).`);
    }

    const channel = account.account_type === 'cash' ? 'direct_cash' : 'direct_bank';
    const ref = await salesMod.buildSaleReference(c, { channel });
    const notes = [input.notes ? String(input.notes).slice(0, 1000) : null,
      `Trade order (${ctx.source || 'api'}) — ${account.name}`].filter(Boolean).join('\n');
    const sale = (await c.query(
      `INSERT INTO sales (channel, customer_name, customer_phone, customer_email, subtotal, vat, shipping, total, status,
                          invoice_number, notes, recorded_by, payment_method, payment_reference, is_estimate, order_number,
                          shipping_address, customer_id, is_paid, fulfillment_method, customer_vat_number,
                          trade_account_id, trade_consolidated, trade_idem_key, amount_paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$9,false,$13,$14,$15,false,$16,$17,$18,$19,$20,0) RETURNING *`,
      [channel, account.name, account.phone || null, account.email || null, round2(grossSubtotal), vat, shipping, total,
       ref, notes, ctx.userId || null, account.account_type === 'cash' ? 'cash' : 'bank',
       input.poRef ? String(input.poRef).slice(0, 80) : null,
       (input.shippingAddress || account.address || null), account.customer_id || null, delivery,
       account.vat_number || null, account.id, consolidated, idem])).rows[0];
    const sync = require('../services/sync');
    for (const it of resolved) {
      await c.query(`INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.id, it.productId, it.sku, it.title, it.qty, it.unitPrice, it.lineTotal]);
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = now() WHERE id = $2`, [it.qty, it.productId]);
      await c.query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'sale_trade',$3,$4)`,
        [it.productId, -it.qty, sale.id, ctx.userId || null]);
      if (it.groupId && sync.mirrorSaleToStockGroup) await sync.mirrorSaleToStockGroup(c, it.productId, it.qty, 'sale_trade', sale.id);
    }
    return { sale, items: resolved };
  });

  // Live channel update — same path as a counter sale.
  setImmediate(() => {
    const sync = require('../services/sync');
    sync.pushStockForSaleItems(result.items).catch(e => console.warn('[trade] stock push:', e.message));
    for (const it of result.items) {
      sync.handleStockOutIfIncoming(it.productId).catch(() => {});
      if (it.groupId) {
        query(`SELECT id FROM products WHERE stock_group_id = $1 AND id <> $2`, [it.groupId, it.productId]).then(rs => {
          const { pushProductStockToChannels } = require('../routes/products');
          for (const s of rs.rows) pushProductStockToChannels(s.id).catch(() => {});
        }).catch(() => {});
      }
    }
  });
  try {
    require('./notify').saleSold({
      saleId: result.sale.id, channel: result.sale.channel, ref: result.sale.invoice_number,
      customer: `${account.name} (trade)`, total: result.sale.total, occurredAt: new Date(),
      items: result.items.map(i => ({ title: i.title, sku: i.sku, qty: i.qty })),
    });
  } catch (_) {}
  if (ctx.source !== 'staff') {
    require('./notify').notifyEvent({
      type: 'trade_order', title: `🧾 Trade order from ${account.name}`,
      body: `${result.sale.invoice_number} · ${result.items.reduce((a, i) => a + i.qty, 0)} item(s) · £${Number(result.sale.total).toFixed(2)}${result.sale.order_number ? ' · PO ' + result.sale.order_number : ''}`,
      relatedType: 'sale', relatedId: result.sale.id, audience: 'staff', url: '/#dispatch',
    }).catch(() => {});
  }
  if (account.terms === 'account') allocateCredit(account.id).catch(() => {});
  return getOrder(account.id, result.sale.id);
}

async function getOrder(accountId, saleId) {
  const s = (await query(`SELECT s.*, ta.terms, ti.number AS trade_invoice_number FROM sales s
                           JOIN trade_accounts ta ON ta.id = s.trade_account_id
                           LEFT JOIN trade_invoices ti ON ti.id = s.trade_invoice_id
                           WHERE s.id = $1 AND s.trade_account_id = $2`, [saleId, accountId])).rows[0];
  if (!s) return null;
  const items = (await query(`SELECT sku, title, qty, unit_price, line_total FROM sale_items WHERE sale_id = $1 ORDER BY id`, [saleId])).rows;
  return formatOrder(s, items);
}
function formatOrder(s, items = []) {
  const vatFactor = (Number(s.subtotal) + Number(s.shipping)) > 0
    ? (Number(s.subtotal) + Number(s.shipping) - Number(s.vat)) / (Number(s.subtotal) + Number(s.shipping)) : 1;
  let inv = null;
  if (s.trade_invoice_number) inv = s.trade_invoice_number;
  return {
    id: s.id, ref: s.invoice_number, po_ref: s.order_number || null,
    status: publicOrderStatus(s), placed_at: s.occurred_at,
    delivery: s.fulfillment_method || 'ship',
    tracking: s.tracking_number ? { number: s.tracking_number, carrier: s.carrier || s.tracking_company || null, url: s.tracking_url || null } : null,
    dispatched_at: s.dispatched_at || null, collected_at: s.collected_at || null,
    net: round2((Number(s.subtotal) + Number(s.shipping)) * vatFactor), vat: round2(s.vat), shipping: round2(s.shipping), total: round2(s.total),
    paid: !!s.is_paid, amount_paid: round2(s.amount_paid || (s.is_paid ? s.total : 0)),
    consolidated: !!s.trade_consolidated, invoice: inv,
    items: items.map(i => ({ sku: i.sku, title: i.title, qty: i.qty,
      unit_price: round2(Number(i.unit_price) * vatFactor), line_total: round2(Number(i.line_total) * vatFactor) })),
  };
}
async function listOrders(accountId, { status = null, since = null, limit = 50, offset = 0 } = {}) {
  const params = [accountId];
  let where = 's.trade_account_id = $1 AND s.is_estimate = false';
  if (since) { params.push(since); where += ` AND s.occurred_at >= $${params.length}::timestamptz`; }
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const rows = (await query(`
    SELECT s.*, ta.terms, ti.number AS trade_invoice_number
      FROM sales s JOIN trade_accounts ta ON ta.id = s.trade_account_id
      LEFT JOIN trade_invoices ti ON ti.id = s.trade_invoice_id
     WHERE ${where} ORDER BY s.occurred_at DESC LIMIT ${lim} OFFSET ${Math.max(0, parseInt(offset) || 0)}`, params)).rows;
  const ids = rows.map(r => r.id);
  const items = ids.length ? (await query(`SELECT sale_id, sku, title, qty, unit_price, line_total FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`, [ids])).rows : [];
  let out = rows.map(s => formatOrder(s, items.filter(i => i.sale_id === s.id)));
  if (status) out = out.filter(o => o.status === status);
  return out;
}

// Cancel an order that hasn't left the building: puts the stock back and
// re-pushes it to the channels.
async function cancelOrder(saleId, userId) {
  const s = (await query(`SELECT * FROM sales WHERE id = $1 AND trade_account_id IS NOT NULL`, [saleId])).rows[0];
  if (!s) throw new TradeError('not_found', 'Trade order not found.');
  if (s.status === 'cancelled') return { ok: true, already: true };
  if (s.dispatched_at || s.collected_at) throw new TradeError('already_sent', 'This order has already been dispatched/collected — use a return instead.');
  if (s.trade_invoice_id) throw new TradeError('invoiced', 'This order is on an issued invoice — void the invoice first.');
  if (num(s.amount_paid) > 0) throw new TradeError('has_payments', 'Payments are recorded against this order — refund them first.');
  const items = (await query(`SELECT * FROM sale_items WHERE sale_id = $1`, [saleId])).rows;
  const sync = require('../services/sync');
  await withTx(async (c) => {
    await c.query(`UPDATE sales SET status = 'cancelled' WHERE id = $1`, [saleId]);
    for (const it of items) {
      if (!it.product_id) continue;
      await c.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [it.qty, it.product_id]);
      await c.query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id, performed_by) VALUES ($1,$2,'trade_cancel',$3,$4)`,
        [it.product_id, it.qty, saleId, userId || null]);
      if (sync.mirrorSaleToStockGroup) await sync.mirrorSaleToStockGroup(c, it.product_id, -it.qty, 'trade_cancel', saleId);
    }
  });
  setImmediate(() => {
    const { pushProductStockToChannels } = require('../routes/products');
    for (const it of items) if (it.product_id) pushProductStockToChannels(it.product_id).catch(() => {});
  });
  return { ok: true };
}

// ─── Consolidated invoices ─────────────────────────────────────────────────
function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// End (exclusive, London date) of the last COMPLETE period.
function periodEnd(period, today = londonToday()) {
  if (period === 'daily') return today;
  if (period === 'weekly') {                                     // weeks run Mon–Sun
    const dow = new Date(today + 'T12:00:00Z').getUTCDay();      // 0 Sun … 1 Mon
    return addDays(today, -((dow + 6) % 7));
  }
  if (period === 'monthly') return today.slice(0, 8) + '01';
  return null;
}

async function nextInvoiceNumber(c) {
  const brand = require('./brand');
  const prefix = `${brand.invoicePrefix || 'REP'}-TI-`;
  const r = await c.query(`SELECT COALESCE(MAX(SUBSTRING(number FROM '([0-9]+)$')::int), 0) + 1 AS n FROM trade_invoices WHERE number LIKE $1`, [prefix + '%']);
  return prefix + String(r.rows[0].n).padStart(4, '0');
}

// Issue one consolidated invoice for everything not yet invoiced before
// `endDate` (exclusive, London date; null = up to now).
async function issueInvoice(accountId, endDate = null) {
  await ensureSchema();
  const acct = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [accountId])).rows[0];
  if (!acct) throw new TradeError('not_found', 'Account not found.');
  const inv = await withTx(async (c) => {
    const params = [accountId];
    let cut = '';
    if (endDate) { params.push(endDate); cut = `AND s.occurred_at < ($2::date)::timestamp AT TIME ZONE 'Europe/London'`; }
    const sales = (await c.query(`
      SELECT s.* FROM sales s
       WHERE s.trade_account_id = $1 AND s.trade_consolidated = true AND s.trade_invoice_id IS NULL
         AND s.is_estimate = false AND s.status NOT IN ('cancelled') ${cut}
       ORDER BY s.occurred_at FOR UPDATE`, params)).rows;
    if (!sales.length) return null;
    const number = await nextInvoiceNumber(c);
    const total = round2(sales.reduce((a, s) => a + Number(s.total) - Number(s.refunded_amount || 0), 0));
    const vat = round2(sales.reduce((a, s) => a + Number(s.vat), 0));
    const paid = round2(sales.reduce((a, s) => a + Number(s.amount_paid || 0), 0));
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(sales[0].occurred_at));
    const to = endDate ? addDays(endDate, -1) : londonToday();
    const issued = londonToday();
    const status = paid >= total - 0.005 ? 'paid' : (paid > 0 ? 'part_paid' : 'issued');
    const row = (await c.query(`
      INSERT INTO trade_invoices (account_id, number, period_from, period_to, due_date, net, vat, total, amount_paid, status, account_type, order_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [accountId, number, from, to, addDays(issued, parseInt(acct.due_days) || 0), round2(total - vat), vat, total, paid, status,
       acct.account_type, sales.length])).rows[0];
    await c.query(`UPDATE sales SET trade_invoice_id = $1 WHERE id = ANY($2)`, [row.id, sales.map(s => s.id)]);
    return row;
  });
  if (inv) {
    await allocateCredit(accountId).catch(() => {});
    if (acct.email && (await getSettings()).autoEmailInvoices) emailInvoice(inv.id).catch(e => console.warn('[trade] invoice email:', e.message));
    queueEvent(acct, 'invoice.issued', { invoice: { number: inv.number, total: Number(inv.total), due_date: inv.due_date, period_from: inv.period_from, period_to: inv.period_to } });
  }
  return inv;
}

// Daily cron: issue invoices for every period that has closed.
async function runDueInvoices() {
  await ensureSchema();
  const accts = (await query(`SELECT * FROM trade_accounts WHERE active = true AND terms = 'account' AND invoice_period IN ('daily','weekly','monthly')`)).rows;
  const issued = [];
  for (const a of accts) {
    try { const inv = await issueInvoice(a.id, periodEnd(a.invoice_period)); if (inv) issued.push({ account: a.name, number: inv.number, total: Number(inv.total) }); }
    catch (e) { console.warn('[trade] invoice run', a.name, e.message); }
  }
  if (issued.length) {
    require('./notify').notifyEvent({
      type: 'trade_invoices', title: `🧾 ${issued.length} trade invoice${issued.length === 1 ? '' : 's'} issued`,
      body: issued.map(i => `${i.account} ${i.number} £${i.total.toFixed(2)}`).join(' · ').slice(0, 300), audience: 'admin', url: '/#trade',
    }).catch(() => {});
  }
  return issued;
}

async function voidInvoice(invoiceId) {
  const inv = (await query(`SELECT * FROM trade_invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw new TradeError('not_found', 'Invoice not found.');
  if (num(inv.amount_paid) > 0) throw new TradeError('has_payments', 'Payments are allocated to this invoice — it can’t be voided.');
  await query(`UPDATE sales SET trade_invoice_id = NULL WHERE trade_invoice_id = $1`, [invoiceId]);
  await query(`UPDATE trade_invoices SET status = 'void' WHERE id = $1`, [invoiceId]);
  return { ok: true };
}

async function invoiceDetail(invoiceId, accountId = null) {
  const inv = (await query(`SELECT * FROM trade_invoices WHERE id = $1 ${accountId ? 'AND account_id = $2' : ''}`,
    accountId ? [invoiceId, accountId] : [invoiceId])).rows[0];
  if (!inv) return null;
  const acct = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [inv.account_id])).rows[0];
  const sales = (await query(`SELECT * FROM sales WHERE trade_invoice_id = $1 ORDER BY occurred_at`, [invoiceId])).rows;
  const items = sales.length ? (await query(`SELECT * FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`, [sales.map(s => s.id)])).rows : [];
  return { invoice: inv, account: acct, orders: sales.map(s => ({ sale: s, items: items.filter(i => i.sale_id === s.id) })) };
}

// Email a consolidated invoice (PDF attached) to the account's email address.
async function emailInvoice(invoiceId, to = null) {
  const detail = await invoiceDetail(invoiceId);
  if (!detail) throw new TradeError('not_found', 'Invoice not found.');
  const recipient = to || detail.account.email;
  if (!recipient) throw new TradeError('no_email', 'This trade account has no email address.');
  const company = await require('../routes/sales').getCompanySettings();
  const brand = require('./brand');
  const pdf = await require('./trade-invoice').buildPdf(detail, { company, brand });
  const inv = detail.invoice;
  const isCash = inv.account_type === 'cash';
  const r = await require('../services/email').sendEmail({
    to: recipient, replyTo: company.company_email || undefined,
    subject: `${isCash ? 'Account statement' : 'Invoice'} ${inv.number} — £${Number(inv.total).toFixed(2)} due ${inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB') : ''}`,
    html: `<p>Hello ${detail.account.contact_name || detail.account.name},</p>
      <p>Please find attached ${isCash ? 'your account statement' : 'our consolidated invoice'} <b>${inv.number}</b> covering ${inv.order_count} order(s)
      placed ${new Date(inv.period_from).toLocaleDateString('en-GB')} – ${new Date(inv.period_to).toLocaleDateString('en-GB')}.</p>
      <p><b>Total £${Number(inv.total).toFixed(2)}</b>${Number(inv.amount_paid) > 0 ? ` · already paid £${Number(inv.amount_paid).toFixed(2)}` : ''} · due ${inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB') : ''}.
      Please quote <b>${inv.number}</b> with your payment.</p><p>Thank you,<br>${company.company_name || brand.name}</p>`,
    attachments: [{ filename: `${inv.number}.pdf`, content: pdf.toString('base64') }],
  });
  if (!r.ok) throw new TradeError('email_failed', r.error || 'Email failed');
  return r;
}

// Welcome email with the portal magic link + API key.
async function emailInvite(accountId, key, baseUrl) {
  const a = (await query(`SELECT * FROM trade_accounts WHERE id = $1`, [accountId])).rows[0];
  if (!a || !a.email) throw new TradeError('no_email', 'This trade account has no email address.');
  const brand = require('./brand');
  const company = await require('../routes/sales').getCompanySettings();
  const link = `${baseUrl}/trade#key=${key}`;
  const r = await require('../services/email').sendEmail({
    to: a.email, replyTo: company.company_email || undefined,
    subject: `Your ${brand.name} trade account`,
    html: `<p>Hello ${a.contact_name || a.name},</p>
      <p>Your trade account with ${company.company_name || brand.name} is ready. See live stock and your prices, order, download photos and view invoices here:</p>
      <p><a href="${link}" style="background:${brand.primaryColor || '#c8202d'};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open the trade portal</a></p>
      <p>Your access key (keep it private — it works like a password): <code>${key}</code><br>
      Developers: API at <code>${baseUrl}/api/trade/v1</code> with header <code>Authorization: Bearer &lt;key&gt;</code>.</p>
      <p>Thank you,<br>${company.company_name || brand.name}</p>`,
  });
  if (!r.ok) throw new TradeError('email_failed', r.error || 'Email failed');
  return r;
}

// ─── Payments ──────────────────────────────────────────────────────────────
// Put `amount` against one sale exactly like the Sales page part-payment does.
async function applyToSale(c, saleId, amount, method, note, userId) {
  const s = (await c.query(`SELECT id, total, amount_paid, status, refunded_amount FROM sales WHERE id = $1 FOR UPDATE`, [saleId])).rows[0];
  if (!s) return 0;
  const owed = round2(Number(s.total) - Number(s.refunded_amount || 0) - Number(s.amount_paid || 0));
  const amt = round2(Math.min(owed, amount));
  if (amt <= 0) return 0;
  await c.query(`INSERT INTO sale_payments (sale_id, amount, method, notes, recorded_by) VALUES ($1,$2,$3,$4,$5)`,
    [saleId, amt, method || null, note || null, userId || null]);
  const paidNow = round2(Number(s.amount_paid || 0) + amt);
  const fully = paidNow >= round2(Number(s.total) - Number(s.refunded_amount || 0)) - 0.005;
  await c.query(`UPDATE sales SET amount_paid = $2,
      is_paid = CASE WHEN $3 THEN true ELSE is_paid END,
      paid_at = CASE WHEN $3 THEN COALESCE(paid_at, now()) ELSE paid_at END,
      status = CASE WHEN $3 AND status = 'pending' THEN 'paid' ELSE status END
    WHERE id = $1`, [saleId, paidNow, fully]);
  return amt;
}
async function refreshInvoiceTotals(c, invoiceId) {
  const r = (await c.query(`SELECT COALESCE(SUM(amount_paid),0) AS p FROM sales WHERE trade_invoice_id = $1`, [invoiceId])).rows[0];
  const inv = (await c.query(`SELECT total FROM trade_invoices WHERE id = $1`, [invoiceId])).rows[0];
  const paid = round2(r.p);
  const status = paid >= Number(inv.total) - 0.005 ? 'paid' : (paid > 0 ? 'part_paid' : 'issued');
  await c.query(`UPDATE trade_invoices SET amount_paid = $2, status = $3 WHERE id = $1 AND status <> 'void'`, [invoiceId, paid, status]);
}

// Allocate money oldest-first: a chosen invoice, then overdue/oldest
// invoices, then any un-invoiced unpaid orders. Leftover stays as credit.
async function allocate(c, accountId, amount, { method, note, userId, invoiceId = null } = {}) {
  let left = round2(amount);
  const allocations = [];
  const invs = (await c.query(`SELECT id, number FROM trade_invoices WHERE account_id = $1 AND status IN ('issued','part_paid')
      ORDER BY (id = $2) DESC, due_date NULLS LAST, id`, [accountId, invoiceId || 0])).rows;
  for (const inv of invs) {
    if (left <= 0) break;
    const sales = (await c.query(`SELECT id FROM sales WHERE trade_invoice_id = $1 AND is_paid = false AND status NOT IN ('cancelled','refunded') ORDER BY occurred_at`, [inv.id])).rows;
    let used = 0;
    for (const s of sales) { if (left <= 0) break; const a = await applyToSale(c, s.id, left, method, note, userId); left = round2(left - a); used += a; }
    if (used > 0) { allocations.push({ invoice: inv.number, amount: round2(used) }); await refreshInvoiceTotals(c, inv.id); }
  }
  if (left > 0) {
    const sales = (await c.query(`SELECT id, invoice_number FROM sales WHERE trade_account_id = $1 AND trade_invoice_id IS NULL
        AND is_paid = false AND is_estimate = false AND status NOT IN ('cancelled','refunded') ORDER BY occurred_at`, [accountId])).rows;
    for (const s of sales) {
      if (left <= 0) break;
      const a = await applyToSale(c, s.id, left, method, note, userId);
      if (a > 0) { allocations.push({ order: s.invoice_number, amount: a }); left = round2(left - a); }
    }
  }
  return { allocations, left };
}

async function recordPayment(accountId, { amount, method = 'bank', reference = '', notes = '', paidAt = null, invoiceId = null } = {}, userId = null) {
  await ensureSchema();
  const amt = round2(amount);
  if (!(amt > 0)) throw new TradeError('amount_required', 'Enter the amount received.');
  return withTx(async (c) => {
    const note = `Trade payment${reference ? ' ' + reference : ''}`;
    const { allocations, left } = await allocate(c, accountId, amt, { method, note, userId, invoiceId });
    const row = (await c.query(`INSERT INTO trade_payments (account_id, amount, unallocated, method, reference, notes, allocations, paid_at, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, COALESCE($8::timestamptz, now()), $9) RETURNING *`,
      [accountId, amt, left, method, String(reference || '').slice(0, 120) || null, String(notes || '').slice(0, 500) || null,
       JSON.stringify(allocations), paidAt || null, userId])).rows[0];
    return row;
  });
}

// Apply any unallocated credit (overpayments) to newly owed orders/invoices.
async function allocateCredit(accountId) {
  return withTx(async (c) => {
    const pays = (await c.query(`SELECT * FROM trade_payments WHERE account_id = $1 AND unallocated > 0 ORDER BY paid_at FOR UPDATE`, [accountId])).rows;
    for (const p of pays) {
      const { allocations, left } = await allocate(c, accountId, Number(p.unallocated), { method: p.method, note: `Credit from payment ${p.reference || '#' + p.id}` });
      if (!allocations.length) break;
      await c.query(`UPDATE trade_payments SET unallocated = $2, allocations = COALESCE(allocations,'[]'::jsonb) || $3::jsonb WHERE id = $1`,
        [p.id, left, JSON.stringify(allocations)]);
      if (left > 0) break;
    }
  });
}

// ─── Webhooks + change detection ───────────────────────────────────────────
function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret || '')).update(body).digest('hex');
}
async function sendWebhook(account, event, data) {
  if (!account.webhook_url) return { skipped: true };
  const body = JSON.stringify({ event, account: account.name, sent_at: new Date().toISOString(), data });
  try {
    const r = await fetch(account.webhook_url, {
      method: 'POST', body, signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Trade-Event': event, 'X-Trade-Signature': sign(account.webhook_secret, body) },
    });
    const ok = r.ok;
    await query(`UPDATE trade_accounts SET last_webhook_at = now(), last_webhook_error = $2 WHERE id = $1`,
      [account.id, ok ? null : `HTTP ${r.status}`]).catch(() => {});
    return { ok, status: r.status };
  } catch (e) {
    await query(`UPDATE trade_accounts SET last_webhook_at = now(), last_webhook_error = $2 WHERE id = $1`, [account.id, e.message.slice(0, 200)]).catch(() => {});
    return { ok: false, error: e.message };
  }
}
function queueEvent(account, event, data) { setImmediate(() => sendWebhook(account, event, data).catch(() => {})); }

// Every couple of minutes: which products' stock changed? Stamp them (so
// `changed_since` polling works) and push the new levels to subscribed
// customers. Also tells customers when their orders ship.
let _detecting = false;
async function detectChanges() {
  if (_detecting) return { busy: true };
  _detecting = true;
  try {
    await ensureSchema();
    const seeded = (await query(`SELECT 1 FROM trade_stock_state LIMIT 1`)).rows.length > 0;
    const changed = (await query(`
      SELECT p.id, p.sku, p.qty_on_hand FROM products p
        LEFT JOIN trade_stock_state s ON s.product_id = p.id
       WHERE p.active = true AND s.qty IS DISTINCT FROM p.qty_on_hand
       LIMIT 5000`)).rows;
    for (const p of changed) {
      await query(`INSERT INTO trade_stock_state (product_id, qty, changed_at) VALUES ($1,$2,now())
        ON CONFLICT (product_id) DO UPDATE SET qty = EXCLUDED.qty, changed_at = now()`, [p.id, p.qty_on_hand]);
    }
    const accts = (await query(`SELECT * FROM trade_accounts WHERE active = true AND webhook_url IS NOT NULL AND webhook_url <> ''`)).rows;
    let sent = 0;
    if (seeded && changed.length && accts.length) {
      const settings = await getSettings();
      for (const a of accts) {
        const items = changed.map(p => ({ sku: p.sku, available: availableFor(a, p, settings) }));
        for (let i = 0; i < items.length; i += 500) { await sendWebhook(a, 'stock.updated', { items: items.slice(i, i + 500) }); sent++; }
      }
    }
    // Order progress events.
    const orders = (await query(`
      SELECT s.*, ta.terms FROM sales s JOIN trade_accounts ta ON ta.id = s.trade_account_id
       WHERE s.occurred_at > now() - interval '30 days' AND ta.webhook_url IS NOT NULL AND ta.webhook_url <> ''`)).rows;
    for (const s of orders) {
      const st = publicOrderStatus(s);
      if (s.trade_event_state === st) continue;
      await query(`UPDATE sales SET trade_event_state = $2 WHERE id = $1`, [s.id, st]);
      // First sighting: creation needs no event, and don't replay old history.
      if (s.trade_event_state == null && (st === 'processing' || new Date(s.occurred_at) < new Date(Date.now() - 86400000))) continue;
      const a = accts.find(x => x.id === s.trade_account_id);
      if (a) { await sendWebhook(a, 'order.updated', formatOrder(s)); sent++; }
    }
    return { changed: changed.length, seeded, webhooks: sent };
  } finally { _detecting = false; }
}

module.exports = {
  ensureSchema, getSettings, saveSettings, vatRateFor,
  issueApiKey, accountByKey, hashKey, sign,
  costOf, priceFor, priceBreaks, loadRules, pickRule, availableFor, present, stockList, productBySku,
  imagesFor, brandedImages, cleanImages,
  accountSummary, topProducts,
  createOrder, getOrder, listOrders, cancelOrder, formatOrder, publicOrderStatus, TradeError,
  periodEnd, londonToday, issueInvoice, runDueInvoices, voidInvoice, invoiceDetail, emailInvoice, emailInvite,
  recordPayment, allocateCredit,
  sendWebhook, detectChanges,
  round2,
};
