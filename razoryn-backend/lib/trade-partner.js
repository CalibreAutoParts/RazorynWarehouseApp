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
    SELECT id, sku, part_number, qty_on_hand, partner_link_id, partner_sku FROM products
     WHERE (partner_link_id = $1 AND partner_sku = ANY($2)) OR upper(sku) = ANY($3)`,
    [link.id, skus, skus.map(s => s.toUpperCase())])).rows : [];
  r.items = r.items.map(i => {
    const l = local.find(x => x.partner_link_id === link.id && x.partner_sku === i.sku) || local.find(x => x.sku.toUpperCase() === i.sku.toUpperCase());
    return { ...i, local: l ? { id: l.id, sku: l.sku, qty: l.qty_on_hand, linked: l.partner_link_id === link.id } : null };
  });
  return r;
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
  const linked = (await query(`SELECT id, partner_sku, source_partner_id, cost_price FROM products
      WHERE partner_link_id = $1 AND partner_sku IS NOT NULL`, [link.id])).rows;
  if (!linked.length) { await query(`UPDATE trade_partner_links SET last_sync_at = now(), last_error = NULL WHERE id = $1`, [link.id]); return { updated: 0, costChanged: 0 }; }
  const bySku = new Map(linked.map(p => [p.partner_sku.toUpperCase(), p]));
  let updated = 0, costChanged = 0;
  try {
    for (let off = 0; off < 20000; off += 500) {
      const page = await call(link, 'GET', `/stock?limit=500&offset=${off}`);
      for (const it of page.items) {
        const p = bySku.get(String(it.sku).toUpperCase());
        if (!p) continue;
        const setCost = link.auto_update_cost && p.source_partner_id === link.id;
        if (setCost && it.price != null && Number(p.cost_price) !== Number(it.price)) costChanged++;
        await applyItem(link, p.id, it, { setCost });
        updated++;
      }
      if (page.items.length < 500) break;
    }
    await query(`UPDATE trade_partner_links SET last_sync_at = now(), last_error = NULL WHERE id = $1`, [link.id]);
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
async function placeOrder(link, { lines = [], poRef = '', notes = '', delivery = 'ship' } = {}, userId = null) {
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
    idempotency_key: 'wh-' + crypto.createHash('sha1').update(JSON.stringify(payload.map(x => [x.sku, x.qty])) + (poRef || '') + Date.now().toString().slice(0, -4)).digest('hex').slice(0, 20),
  });
  // Incoming lines in OUR app, costed at the price they charged us (net).
  const today = new Date().toISOString().slice(0, 10);
  const incoming = [];
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

// Partner pushed an event to us (signature checked by the caller).
async function handleEvent(link, evt) {
  if (evt.event === 'stock.updated') {
    let n = 0;
    for (const it of evt.data?.items || []) {
      const r = await query(`UPDATE products SET partner_qty = $3, partner_synced_at = now()
        WHERE partner_link_id = $1 AND upper(partner_sku) = upper($2)`, [link.id, it.sku, it.available]);
      n += r.rowCount || 0;
    }
    return { updated: n };
  }
  if (evt.event === 'order.updated' && evt.data?.ref) {
    const o = evt.data;
    const note = `${link.name} order ${o.ref}: ${o.status}${o.tracking ? ' · tracking ' + o.tracking.number : ''}`;
    await query(`UPDATE incoming_stock SET notes = $2, status = CASE WHEN $3 AND status = 'on_order' THEN 'shipped' ELSE status END, updated_at = now()
      WHERE container_ref = $1 AND qty_received < qty_ordered`, [`${link.name} ${o.ref}`, note, o.status === 'dispatched']).catch(() => {});
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

module.exports = { ensureSchema, call, getLink, publicLink, connect, catalogue, importItems, sync, syncAll, placeOrder, handleEvent, origin };
