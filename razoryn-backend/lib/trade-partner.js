// lib/trade-partner.js — THIS warehouse buying from ANOTHER warehouse app
// (Razoryn ↔ Calibre) through that app's trade API.
//
// Set up once: the selling app creates a trade account for us (ticked "other
// warehouse app", locations shared), and we paste its address + key here.
// Then:
//   • browse its live stock at our trade price (their cost shown if allowed),
//   • import / link parts → local products tagged with the partner as source
//     (filterable in Inventory, kept apart from our own stock),
//   • their bin location + barcode come across, so their labels scan here,
//   • our cost for a partner part = the price they charge us (net of VAT),
//     kept up to date by sync, so margins on our side stay right,
//   • ordering creates the order in THEIR app (stock comes off there live)
//     and an Incoming line in OURS — receiving it adds stock + books the cost.
//   • they push stock/order changes to us by webhook; a sync job backs it up.

const crypto = require('crypto');
const { query } = require('../db');

let _ready = null;
function ensureSchema() {
  if (!_ready) _ready = (async () => {
    await require('./trade').ensureSchema();
    await query(`CREATE TABLE IF NOT EXISTS trade_partner_links (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      base_url        TEXT NOT NULL,
      api_key         TEXT NOT NULL,
      hook_secret     TEXT,
      auto_update_cost BOOLEAN NOT NULL DEFAULT true,
      last_sync_at    TIMESTAMPTZ,
      last_error      TEXT,
      account_info    JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Order from the partner automatically when we sell one of their parts.
    await query(`ALTER TABLE trade_partner_links ADD COLUMN IF NOT EXISTS auto_order BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE trade_partner_links ADD COLUMN IF NOT EXISTS auto_order_delivery TEXT NOT NULL DEFAULT 'collect'`);   // collect | ship | dropship
    await query(`ALTER TABLE trade_partner_links ADD COLUMN IF NOT EXISTS auto_order_since TIMESTAMPTZ`);
    await query(`CREATE TABLE IF NOT EXISTS partner_auto_orders (
      sale_item_id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL, sale_id INTEGER, product_id INTEGER,
      qty INTEGER NOT NULL DEFAULT 0, partner_ref TEXT, delivery TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

function origin(u) {
  const v = String(u || '').trim();
  try { return new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v).origin; } catch (_) { return v.replace(/\/+$/, ''); }
}

async function call(link, method, path, body) {
  const r = await fetch(origin(link.base_url) + '/api/trade/v1' + path, {
    method, signal: AbortSignal.timeout(30000),
    headers: { 'Authorization': 'Bearer ' + link.api_key, 'Content-Type': 'application/json', 'X-Trade-Client': 'warehouse-app' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : null;
  if (!r.ok) {
    const e = new Error((data && (data.message || data.error)) || `Partner returned HTTP ${r.status}`);
    e.status = r.status; e.data = data; throw e;
  }
  return data;
}

async function getLink(id) {
  await ensureSchema();
  const l = (await query(`SELECT * FROM trade_partner_links WHERE id = $1`, [id])).rows[0];
  if (!l) { const e = new Error('Partner link not found'); e.status = 404; throw e; }
  return l;
}
function publicLink(l) {
  const { api_key, hook_secret, ...rest } = l;
  return { ...rest, api_key_hint: api_key ? api_key.slice(0, 9) + '…' + api_key.slice(-4) : null };
}

// Test + (re)register our webhook on the partner so they push changes to us.
async function connect(link, ourBaseUrl) {
  const me = await call(link, 'GET', '/me');
  await query(`UPDATE trade_partner_links SET account_info = $2::jsonb, last_error = NULL WHERE id = $1`, [link.id, JSON.stringify(me)]);
  let hook = null;
  if (ourBaseUrl && /^https:\/\//.test(ourBaseUrl)) {
    const secret = link.hook_secret || crypto.randomBytes(24).toString('hex');
    if (!link.hook_secret) await query(`UPDATE trade_partner_links SET hook_secret = $2 WHERE id = $1`, [link.id, secret]);
    try { hook = await call(link, 'PUT', '/webhook', { url: `${ourBaseUrl}/api/trade-partner-hook/${link.id}`, secret }); }
    catch (e) { hook = { ok: false, error: e.message }; }
  }
  return { me, hook };
}

// Their stock, with what we already hold locally for each part.
async function catalogue(link, { q = '', inStock = false, offset = 0 } = {}) {
  const p = new URLSearchParams({ q, limit: 100, offset });
  if (inStock) p.set('in_stock', '1');
  const r = await call(link, 'GET', '/stock?' + p);
  const skus = r.items.map(i => i.sku);
  const local = skus.length ? (await query(`
    SELECT id, sku, part_number, qty_on_hand, partner_link_id, partner_sku, active, shopify_product_id FROM products
     WHERE (partner_link_id = $1 AND partner_sku = ANY($2)) OR upper(sku) = ANY($3)`,
    [link.id, skus, skus.map(s => s.toUpperCase())])).rows : [];
  // Where each local part is LISTED: eBay accounts with a live listing (ended
  // / relisted item numbers don't count once the live list is known) + Shopify.
  const listed = new Map();
  const sids = local.map(l => l.shopify_product_id).filter(Boolean).map(String);
  if (sids.length) {
    const rows = (await query(`SELECT ml.shopify_product_id::text AS sid, ml.store_code, ml.ebay_item_id,
        (NOT EXISTS (SELECT 1 FROM ebay_live_refresh lr WHERE lr.store_code = ml.store_code AND lr.count > 0)
          OR EXISTS (SELECT 1 FROM ebay_live_items li WHERE li.store_code = ml.store_code AND li.ebay_item_id = ml.ebay_item_id)) AS live
        FROM mirror_links ml WHERE ml.shopify_product_id::text = ANY($1)`, [sids]).catch(async () =>
        query(`SELECT shopify_product_id::text AS sid, store_code, ebay_item_id, true AS live FROM mirror_links WHERE shopify_product_id::text = ANY($1)`, [sids]))).rows;
    for (const x of rows) if (x.live) { if (!listed.has(x.sid)) listed.set(x.sid, new Set()); listed.get(x.sid).add(x.store_code || ''); }
  }
  r.items = r.items.map(i => {
    const l = local.find(x => x.partner_link_id === link.id && x.partner_sku === i.sku) || local.find(x => x.sku.toUpperCase() === i.sku.toUpperCase());
    const ebayStores = l && l.shopify_product_id ? [...(listed.get(String(l.shopify_product_id)) || [])] : [];
    return { ...i, local: l ? { id: l.id, sku: l.sku, qty: l.qty_on_hand, linked: l.partner_link_id === link.id, active: l.active !== false,
      onShopify: !!l.shopify_product_id, ebayStores, listed: ebayStores.length > 0 } : null };
  });
  try { r.items = await withMargins(r.items); } catch (e) { console.warn('[partner] margins:', e.message); }
  return r;
}

// What WE would make listing each partner part — eBay, Shopify and cash — using
// our own fees, VAT, packaging and overhead. Cost = their trade price: ex VAT when
// we're VAT registered (we claim their VAT back), plus VAT when we aren't.
// Selling prices start from their retail prices (a guide — you set your own).
async function withMargins(items) {
  const PF = require('./pricing-floor');
  const row = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
  const S = PF.resolveCostSettings(row);
  const shopPct = row.price_link_pct != null ? parseFloat(row.price_link_pct) : (row.bank_transfer_pct != null ? parseFloat(row.bank_transfer_pct) : 10);
  const cashPct = row.cash_discount_pct != null ? parseFloat(row.cash_discount_pct) : 10;
  const bankPct = row.bank_transfer_pct != null ? parseFloat(row.bank_transfer_pct) : 10;
  const vPart = S.vatRegistered ? (S.vatRate / 100) / (1 + S.vatRate / 100) : 0;
  return items.map(it => {
    if (it.price == null) return it;
    const cost = Number(it.price) * (S.vatRegistered ? 1 : 1 + (Number(it.vat_rate) || 0) / 100);
    const pc = it.parcel || {};
    const item = pc.postage != null ? { band: 'custom', shippingCost: pc.postage, isLarge: !!pc.large } : { isLarge: !!pc.large };
    const pack = pc.packaged === true ? 0 : (pc.packaging_cost != null ? Number(pc.packaging_cost) : S.packagingCost);
    const ebay = Number(it.rrp_ebay ?? it.rrp) || null;
    let cash = ebay ? ebay * (1 - cashPct / 100) : null;
    if (cash > 20) cash = Math.floor(cash / 5) * 5;
    const prices = { ebay, shopify: Number(it.rrp_shopify) || (ebay ? ebay * (1 - shopPct / 100) : null),
      bank: ebay ? ebay * (1 - bankPct / 100) : null, cash };
    const margins = {};
    for (const [k, B] of Object.entries(prices)) {
      if (!(B > 0)) { margins[k] = null; continue; }
      const direct = k === 'cash' || k === 'bank';
      const ch = PF.channelParams(direct ? 'direct' : k, item, S);
      const v = k === 'cash' ? 0 : vPart;                          // cash sales are VAT-free
      const fees = B * ((ch.feePct + ch.adRatePct) / 100) * ch.feeVatMult + ch.fixedFee * ch.feeVatMult
        + (direct ? 0 : B * (Number(S.externalAdPct) || 0) / 100);
      const inPrice = !pc.large;                                     // big panels usually charge postage on top
      const postage = k === 'cash' ? 0 : (inPrice ? ch.postage : 0); // cash = collected; bank = posted
      const overhead = Number(S.overheadPerUnit) || 0;
      const net = B - B * v - fees - postage - pack - overhead - cost;
      const r2 = n => +Number(n).toFixed(2);
      margins[k] = { price: r2(B), net: r2(net), pct: +(net / B * 100).toFixed(1),
        breakdown: { vat: r2(B * v), fees: r2(fees), postage: r2(postage), packaging: r2(pack), overhead: r2(overhead), cost: r2(cost) },
        // The rates behind it, so the buyer can test other prices / rates.
        params: { vatPart: v, feePct: +(((ch.feePct + ch.adRatePct) * ch.feeVatMult) + (direct ? 0 : (Number(S.externalAdPct) || 0))).toFixed(3),
          fixedFee: r2(ch.fixedFee * ch.feeVatMult), postage: r2(postage), packaging: r2(pack), overhead: r2(overhead), cost: r2(cost) } };
    }
    return { ...it, cost: +cost.toFixed(2), margins };
  });
}

// Write partner details onto a local product (and cost, when the product is
// stocked from that partner).
async function applyItem(link, productId, item, { setCost = false } = {}) {
  const loc = item.location ? [item.location.code, item.location.name || item.location.note].filter(Boolean).join(' · ') : null;
  await query(`UPDATE products SET partner_qty = $2::int, partner_cost = $3::numeric, partner_location = COALESCE($4::text, partner_location),
      partner_barcode = COALESCE($5::text, partner_barcode), barcode = COALESCE(NULLIF(barcode,''), $5::text), partner_synced_at = now(),
      cost_price = CASE WHEN $6::boolean AND $3::numeric IS NOT NULL THEN $3::numeric ELSE cost_price END,
      landed_cost = CASE WHEN $6::boolean AND $3::numeric IS NOT NULL THEN $3::numeric ELSE landed_cost END,
      updated_at = now()
    WHERE id = $1`, [productId, item.available ?? null, item.price ?? null, loc, item.barcode || null, !!setCost]);
  // Their carton size / weight / packaging / postage → ours, where we have none.
  const pc = item.parcel || {};
  if (Object.keys(pc).length) {
    await query(`UPDATE products SET
        pkg_length_cm = COALESCE(pkg_length_cm, $2), pkg_width_cm = COALESCE(pkg_width_cm, $3), pkg_height_cm = COALESCE(pkg_height_cm, $4),
        pkg_weight_g = COALESCE(pkg_weight_g, $5), packaging_included = COALESCE(packaging_included, $6), packaging_cost = COALESCE(packaging_cost, $7),
        large_panel = COALESCE(large_panel, $8),
        shipping_cost = CASE WHEN shipping_band IS NULL AND $9::numeric IS NOT NULL THEN $9 ELSE shipping_cost END,
        shipping_band = CASE WHEN shipping_band IS NULL AND $9::numeric IS NOT NULL THEN 'custom' ELSE shipping_band END
      WHERE id = $1`, [productId, pc.length_cm ?? null, pc.width_cm ?? null, pc.height_cm ?? null, pc.weight_g != null ? Math.round(pc.weight_g) : null,
        pc.packaged ?? null, pc.packaging_cost ?? null, pc.large ?? null, pc.postage ?? null]).catch(e => console.warn('[partner] parcel:', e.message));
  }
}

// Import / link parts. Existing local product (same SKU, or already linked) is
// linked; otherwise a new product is created, tagged with the partner as its
// source, at 0 own stock.
async function importItems(link, skus = [], userId = null) {
  await ensureSchema();
  const out = { linked: 0, created: 0, errors: [] };
  for (const sku of skus.slice(0, 200)) {
    try {
      const it = await call(link, 'GET', '/stock/' + encodeURIComponent(sku));
      let p = (await query(`SELECT * FROM products WHERE (partner_link_id = $1 AND partner_sku = $2) OR upper(sku) = upper($2)
        ORDER BY (partner_link_id = $1) DESC NULLS LAST LIMIT 1`, [link.id, it.sku])).rows[0];
      if (p) {
        // Our own product already exists → link it. The partner only becomes its
        // stock/cost SOURCE when we have no cost of our own for it yet.
        const fromPartner = !p.cost_price || p.source_partner_id === link.id;
        await query(`UPDATE products SET partner_sku = $2, partner_link_id = $3,
            source_partner_id = CASE WHEN $4 THEN $3 ELSE source_partner_id END WHERE id = $1`,
          [p.id, it.sku, link.id, fromPartner]);
        await applyItem(link, p.id, it, { setCost: fromPartner && link.auto_update_cost });
        out.linked++;
      } else {
        const ins = (await query(`INSERT INTO products (sku, title, brand, model, part_number, position, barcode, image_url, qty_on_hand,
              cost_price, landed_cost, active, source_partner_id, partner_link_id, partner_sku)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$9,true,$10,$10,$1) RETURNING id`,
          [it.sku, it.title || it.sku, it.make || null, it.model || null, it.part_number || null, it.position || null,
           it.barcode || null, (it.images && it.images[0] && it.images[0].url) || it.image || null, it.price ?? null, link.id])).rows[0];
        await applyItem(link, ins.id, it, { setCost: true });
        for (const code of it.alternate_part_numbers || []) {
          await query(`INSERT INTO product_part_numbers (product_id, code, note) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ins.id, code, 'From ' + link.name]).catch(() => {});
        }
        out.created++;
      }
    } catch (e) { out.errors.push({ sku, error: e.message }); }
  }
  return out;
}

// Refresh partner stock + cost + location for every linked product.
async function sync(link) {
  await ensureSchema();
  const linked = (await query(`SELECT id, partner_sku, source_partner_id, cost_price, partner_qty FROM products
      WHERE partner_link_id = $1 AND partner_sku IS NOT NULL`, [link.id])).rows;
  const changedStock = [];
  if (!linked.length) { await query(`UPDATE trade_partner_links SET last_sync_at = now(), last_error = NULL WHERE id = $1`, [link.id]); return { updated: 0, costChanged: 0 }; }
  const bySku = new Map(linked.map(p => [p.partner_sku.toUpperCase(), p]));
  let updated = 0, costChanged = 0;
  const seen = new Set();
  try {
    for (let off = 0; off < 20000; off += 500) {
      const page = await call(link, 'GET', `/stock?limit=500&offset=${off}`);
      for (const it of page.items) {
        const p = bySku.get(String(it.sku).toUpperCase());
        if (!p) continue;
        seen.add(p.id);
        const setCost = link.auto_update_cost && p.source_partner_id === link.id;
        if (setCost && it.price != null && Number(p.cost_price) !== Number(it.price)) costChanged++;
        if (p.source_partner_id === link.id && Number(p.partner_qty) !== Number(it.available)) changedStock.push(p.id);
        await applyItem(link, p.id, it, { setCost });
        updated++;
      }
      if (page.items.length < 500) break;
    }
    // Parts they no longer offer us (hidden / not for trade / withdrawn):
    // nothing left to sell from their stock.
    for (const p of linked) {
      if (seen.has(p.id) || !(Number(p.partner_qty) > 0)) continue;
      await query(`UPDATE products SET partner_qty = 0, partner_synced_at = now() WHERE id = $1`, [p.id]);
      if (p.source_partner_id === link.id) changedStock.push(p.id);
    }
    await query(`UPDATE trade_partner_links SET last_sync_at = now(), last_error = NULL WHERE id = $1`, [link.id]);
    pushPartnerStock(changedStock);
  } catch (e) {
    await query(`UPDATE trade_partner_links SET last_error = $2 WHERE id = $1`, [link.id, e.message.slice(0, 300)]);
    throw e;
  }
  return { updated, costChanged };
}

async function syncAll() {
  await ensureSchema();
  const links = (await query(`SELECT * FROM trade_partner_links`)).rows;
  const out = [];
  for (const l of links) { try { out.push({ id: l.id, ...(await sync(l)) }); } catch (e) { out.push({ id: l.id, error: e.message }); } }
  return out;
}

// Place an order with the partner and book the matching Incoming lines here.
// lines: [{ productId, qty }]
async function placeOrder(link, { lines = [], poRef = '', notes = '', delivery = 'ship', shippingAddress = null, idempotencyKey = null, noIncoming = false } = {}, userId = null) {
  await ensureSchema();
  const prods = (await query(`SELECT id, sku, title, part_number, partner_sku FROM products WHERE id = ANY($1) AND partner_link_id = $2`,
    [lines.map(l => parseInt(l.productId)), link.id])).rows;
  const payload = [];
  for (const l of lines) {
    const p = prods.find(x => x.id === parseInt(l.productId));
    if (!p || !p.partner_sku) throw Object.assign(new Error(`Product ${l.productId} isn't linked to ${link.name}`), { status: 400 });
    payload.push({ sku: p.partner_sku, qty: parseInt(l.qty), _p: p });
  }
  const order = await call(link, 'POST', '/orders', {
    lines: payload.map(x => ({ sku: x.sku, qty: x.qty })), po_ref: poRef || undefined, notes, delivery,
    shipping_address: shippingAddress || undefined,
    idempotency_key: idempotencyKey || 'wh-' + crypto.createHash('sha1').update(JSON.stringify(payload.map(x => [x.sku, x.qty])) + (poRef || '') + Date.now().toString().slice(0, -4)).digest('hex').slice(0, 20),
  });
  // Incoming lines in OUR app, costed at the price they charged us (net).
  // (Not for dropship — the goods go straight to our customer.)
  const today = new Date().toISOString().slice(0, 10);
  const incoming = [];
  if (noIncoming) return { order, incoming };
  for (const it of order.items || []) {
    const mine = payload.find(x => x.sku.toUpperCase() === String(it.sku).toUpperCase());
    if (!mine) continue;
    const row = (await query(`INSERT INTO incoming_stock (product_id, sku, title, part_number, qty_ordered, container_ref, supplier, expected_date,
          status, notes, created_by, unit_cost_foreign, currency, fx_rate, unit_cost_gbp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'on_order',$9,$10,$11,'GBP',1,$11) RETURNING id`,
      [mine._p.id, mine._p.sku, mine._p.title, mine._p.part_number, it.qty, `${link.name} ${order.ref}`, link.name, today,
       `Ordered from ${link.name} (order ${order.ref}${order.po_ref ? ', our PO ' + order.po_ref : ''})`, userId, it.unit_price])).rows[0];
    incoming.push(row.id);
  }
  try { await require('../routes/suppliers').ensureSupplierByName(link.name, { currency: 'GBP' }); } catch (_) {}
  return { order, incoming };
}

// ── Automatic ordering ─────────────────────────────────────────────────────
// When we sell a part we stock from a partner and don't have enough of our own,
// order it from them straight away. State-based (each sale line is ordered at
// most once — partner_auto_orders), so it's safe to run often and from anywhere.
//   collect  → one order per run; we collect it (Incoming line here)
//   ship     → one order per run; they send it to us (Incoming line here)
//   dropship → one order per sale, sent to OUR customer's address; their
//              tracking marks our order dispatched (and goes to eBay / Shopify).
let _autoRunning = false;
async function autoOrderSweep() {
  if (_autoRunning) return { skipped: 'running' };
  _autoRunning = true;
  const out = [];
  try {
    await ensureSchema();
    const links = (await query(`SELECT * FROM trade_partner_links WHERE auto_order = true`)).rows;
    for (const link of links) {
      try { out.push({ link: link.id, ...(await autoOrderFor(link)) }); }
      catch (e) { out.push({ link: link.id, error: e.message }); console.warn('[partner] auto-order', link.name, e.message); }
    }
  } finally { _autoRunning = false; }
  return out;
}
async function autoOrderFor(link) {
  const cands = (await query(`
    SELECT si.id AS sale_item_id, si.sale_id, si.qty, si.product_id, p.qty_on_hand, p.sku, p.partner_sku, p.title,
           s.invoice_number, s.channel, s.customer_name, s.customer_phone, s.shipping_address, s.occurred_at
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
     WHERE p.partner_link_id = $1 AND p.source_partner_id = $1 AND p.partner_sku IS NOT NULL
       AND s.status NOT IN ('refunded','cancelled') AND COALESCE(s.is_estimate, false) = false
       AND s.trade_account_id IS NULL
       AND ($2::timestamptz IS NULL OR s.occurred_at >= $2)
       AND NOT EXISTS (SELECT 1 FROM partner_auto_orders pa WHERE pa.sale_item_id = si.id)
    UNION ALL
    -- Their part sold inside a BUNDLE: the sale line is the bundle, the part
    -- comes off through a stock movement (keyed by -movement id).
    SELECT -sm.id AS sale_item_id, s.id AS sale_id, -sm.delta AS qty, sm.product_id, p.qty_on_hand, p.sku, p.partner_sku, p.title,
           s.invoice_number, s.channel, s.customer_name, s.customer_phone, s.shipping_address, s.occurred_at
      FROM stock_movements sm JOIN products p ON p.id = sm.product_id JOIN sales s ON s.id = sm.reference_id
     WHERE sm.reason LIKE 'sale_bundle%' AND sm.delta < 0
       AND p.partner_link_id = $1 AND p.source_partner_id = $1 AND p.partner_sku IS NOT NULL
       AND s.status NOT IN ('refunded','cancelled') AND COALESCE(s.is_estimate, false) = false
       AND s.trade_account_id IS NULL
       AND ($2::timestamptz IS NULL OR s.occurred_at >= $2)
       AND NOT EXISTS (SELECT 1 FROM partner_auto_orders pa WHERE pa.sale_item_id = -sm.id)
     ORDER BY occurred_at, sale_item_id LIMIT 200`, [link.id, link.auto_order_since])).rows;
  if (!cands.length) return { ordered: 0 };
  // How much of each product still has to come from the partner: what our own
  // stock can't cover, less what's already on order from them.
  const need = new Map();
  for (const pid of new Set(cands.map(c => c.product_id))) {
    const own = parseInt(cands.find(c => c.product_id === pid).qty_on_hand) || 0;
    const pending = parseInt((await query(`SELECT COALESCE(SUM(GREATEST(qty_ordered - qty_received, 0)), 0)::int AS q FROM incoming_stock
        WHERE product_id = $1 AND supplier = $2 AND status NOT IN ('received','cancelled')`, [pid, link.name])).rows[0].q) || 0;
    need.set(pid, Math.max(0, -own - pending));
  }
  const mark = (c, qty, ref, note) => query(`INSERT INTO partner_auto_orders (sale_item_id, link_id, sale_id, product_id, qty, partner_ref, delivery, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (sale_item_id) DO NOTHING`, [c.sale_item_id, link.id, c.sale_id, c.product_id, qty, ref, link.auto_order_delivery, note]);
  const plan = [];
  for (const c of cands) {
    const n = need.get(c.product_id) || 0;
    const q = Math.min(parseInt(c.qty) || 0, n);
    need.set(c.product_id, n - q);
    if (q > 0) plan.push({ ...c, orderQty: q });
    else await mark(c, 0, null, 'covered by own stock / already on order');
  }
  if (!plan.length) return { ordered: 0 };
  const delivery = link.auto_order_delivery || 'collect';
  const groups = delivery === 'dropship'
    ? [...new Set(plan.map(c => c.sale_id))].map(id => plan.filter(c => c.sale_id === id))
    : [plan];
  let ordered = 0;
  for (const g of groups) {
    const lines = []; for (const c of g) { const l = lines.find(x => x.productId === c.product_id); if (l) l.qty += c.orderQty; else lines.push({ productId: c.product_id, qty: c.orderQty }); }
    const first = g[0];
    // Dropship: our customer's delivery address, as the plain text the partner stores.
    const ship = delivery === 'dropship' ? [first.customer_name, first.shipping_address, first.customer_phone ? 'Tel ' + first.customer_phone : null].filter(Boolean).join('\n') || null : null;
    const key = 'auto-' + crypto.createHash('sha1').update(g.map(c => c.sale_item_id).join(',')).digest('hex').slice(0, 24);
    try {
      const r = await placeOrder(link, {
        lines, delivery: delivery === 'collect' ? 'collect' : 'ship', shippingAddress: ship,
        poRef: delivery === 'dropship' ? first.invoice_number : `AUTO ${new Date().toISOString().slice(0, 10)}`,
        notes: delivery === 'dropship' ? `Dropship to our customer for ${first.invoice_number} (${first.channel})` : `Sold by us: ${g.map(c => c.invoice_number).join(', ')}`,
        idempotencyKey: key, noIncoming: delivery === 'dropship',
      });
      for (const c of g) await mark(c, c.orderQty, r.order.ref, null);
      if (delivery === 'dropship') {
        // Their stock fulfils our sale directly: our own count goes back to where it was.
        for (const c of g) {
          await query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [c.orderQty, c.product_id]);
          await query(`INSERT INTO stock_movements (product_id, delta, reason, reference_id) VALUES ($1,$2,'partner_dropship',$3)`, [c.product_id, c.orderQty, c.sale_id]).catch(() => {});
        }
        await query(`UPDATE sales SET notes = TRIM(COALESCE(notes, '') || ' ' || $2), updated_at = now() WHERE id = $1`,
          [first.sale_id, `[Dropshipped by ${link.name}, their order ${r.order.ref}]`]).catch(() => {});
      }
      ordered += lines.reduce((a, l) => a + l.qty, 0);
      require('./notify').notifyEvent({ type: 'partner_order', title: `🔁 Ordered from ${link.name}: ${r.order.ref}`,
        body: `${g.map(c => `${c.orderQty}× ${c.title || c.sku}`).join(', ')} — sold on ${[...new Set(g.map(c => c.invoice_number))].join(', ')}` + (delivery === 'dropship' ? ' · dropship' : delivery === 'collect' ? ' · to collect' : ' · they ship to us'),
        audience: 'staff', url: '/#incoming' }).catch(() => {});
    } catch (e) {
      require('./notify').notifyEvent({ type: 'partner_order', title: `⚠ Couldn't order from ${link.name}`, body: `${g.map(c => c.sku).join(', ')}: ${e.message}`, audience: 'admin', url: '/#trade' }).catch(() => {});
      throw e;
    }
  }
  return { ordered };
}
// Dropship: their dispatch (with tracking) marks OUR customer's order dispatched.
async function dropshipDispatched(link, o) {
  const rows = (await query(`SELECT DISTINCT sale_id FROM partner_auto_orders WHERE link_id = $1 AND partner_ref = $2 AND delivery = 'dropship'`, [link.id, o.ref])).rows;
  for (const r of rows) {
    const t = o.tracking || {};
    const upd = (await query(`UPDATE sales SET status = CASE WHEN status IN ('paid','pending') THEN 'dispatched' ELSE status END,
        dispatched_at = COALESCE(dispatched_at, now()), tracking_number = COALESCE($2, tracking_number), carrier = COALESCE($3, carrier)
      WHERE id = $1 AND dispatched_at IS NULL RETURNING *`, [r.sale_id, t.number || null, t.carrier || null])).rows[0];
    if (upd) { try { await require('../routes/dispatch').pushDispatchToChannel(upd); } catch (_) {} }
  }
}

// Partner stock changed on parts we sell from their stock → push to our channels.
function pushPartnerStock(productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return;
  setImmediate(async () => {
    for (const id of ids) { try { await pushOne(id); } catch (e) { console.warn('[partner] stock push:', e.message); } }
    try { require('./onbuy-sync').pushStockAndPrices().catch(() => {}); } catch (_) {}
  });
}

// Push one part's sellable stock (own + partner) to each of its eBay listings
// and its Shopify product, and keep the outcome on the product so the partner
// page shows what each channel actually took.
// → { productId, sku, qty, ebay: [{ itemId, store, sent, asked, limitedBy, error }], shopify: { sent | skipped | error } }
async function pushOne(productId) {
  const ebay = require('../services/ebay');
  const shopify = require('../services/shopify');
  const product = (await query(`SELECT * FROM products WHERE id = $1`, [productId])).rows[0];
  if (!product) throw new Error('product_not_found');
  const qty = await require('./stock-qty').sellableQty(product);
  const out = { productId: product.id, sku: product.sku, own: product.qty_on_hand, partner: product.partner_qty, qty, ebay: [], shopify: null };

  let links = [];
  if (product.shopify_product_id) {
    links = (await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`, [String(product.shopify_product_id)])).rows;
  }
  if (!links.length && product.sku) {
    links = (await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE upper(last_synced_sku) = upper($1)`, [product.sku]).catch(() => ({ rows: [] }))).rows;
  }
  for (const l of links) {
    const row = { itemId: l.ebay_item_id, store: l.store_code || null };
    try {
      const r = await ebay.setQuantityTradingAPI(l.ebay_item_id, qty, l.store_code || undefined);
      row.sent = r.quantity; row.asked = r.asked; row.limitedBy = r.limitedBy || null;
    } catch (e) {
      const m = String(e.message || e);
      row.error = (m === 'ebay_not_configured' ? 'this eBay account is not connected (Settings → eBay shops)' : m).slice(0, 300);
    }
    out.ebay.push(row);
  }

  if (!product.shopify_inventory_id) out.shopify = { skipped: 'not on Shopify' };
  else if (!shopify.isConfigured()) out.shopify = { skipped: 'Shopify not connected' };
  else {
    try { await shopify.setInventoryLevel(product.shopify_inventory_id, qty); out.shopify = { sent: qty }; }
    catch (e) { out.shopify = { error: String(e.response?.data?.errors ? JSON.stringify(e.response.data.errors) : (e.message || e)).slice(0, 300) }; }
  }
  out.at = new Date().toISOString();
  await query(`UPDATE products SET stock_pushed_at = now(), stock_push_result = $2::jsonb WHERE id = $1`, [product.id, JSON.stringify(out)]).catch(() => {});
  return out;
}

// Partner pushed an event to us (signature checked by the caller).
async function handleEvent(link, evt) {
  if (evt.event === 'stock.updated') {
    let n = 0; const ids = [];
    for (const it of evt.data?.items || []) {
      const r = await query(`UPDATE products SET partner_qty = $3, partner_synced_at = now()
        WHERE partner_link_id = $1 AND upper(partner_sku) = upper($2) RETURNING id, source_partner_id`, [link.id, it.sku, it.available]);
      n += r.rowCount || 0;
      for (const row of r.rows) if (row.source_partner_id === link.id) ids.push(row.id);
    }
    pushPartnerStock(ids);   // their stock is what we sell → update our eBay / Shopify / OnBuy now
    return { updated: n };
  }
  if (evt.event === 'order.updated' && evt.data?.ref) {
    const o = evt.data;
    const note = `${link.name} order ${o.ref}: ${o.status}${o.tracking ? ' · tracking ' + o.tracking.number : ''}`;
    await query(`UPDATE incoming_stock SET notes = $2, status = CASE WHEN $3 AND status = 'on_order' THEN 'shipped' ELSE status END, updated_at = now()
      WHERE container_ref = $1 AND qty_received < qty_ordered`, [`${link.name} ${o.ref}`, note, o.status === 'dispatched']).catch(() => {});
    if (o.status === 'dispatched') { await dropshipDispatched(link, o).catch(e => console.warn('[partner] dropship dispatch:', e.message)); }
    if (o.status === 'dispatched') {
      require('./notify').notifyEvent({ type: 'partner_order', title: `🚚 ${link.name} dispatched ${o.ref}`, body: note, audience: 'staff', url: '/#incoming' }).catch(() => {});
    }
    return { ok: true };
  }
  if (evt.event === 'invoice.issued') {
    const i = evt.data?.invoice || {};
    require('./notify').notifyEvent({ type: 'partner_invoice', title: `🧾 ${link.name} invoice ${i.number || ''}`, body: `£${Number(i.total || 0).toFixed(2)} due ${i.due_date || ''}`, audience: 'admin', url: '/#trade' }).catch(() => {});
    return { ok: true };
  }
  return { ignored: true };
}

module.exports = { ensureSchema, call, getLink, publicLink, connect, catalogue, importItems, sync, syncAll, placeOrder, handleEvent, origin, autoOrderSweep, pushPartnerStock, pushOne };
