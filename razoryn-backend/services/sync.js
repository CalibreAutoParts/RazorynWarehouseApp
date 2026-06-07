// services/sync.js — orchestrates Shopify + eBay sync
//
// Two operations:
//   1. PULL  — fetch new orders from each channel since last sync, insert
//              sales rows, decrement stock, log movements, fire low-stock notifs.
//   2. PUSH  — for products whose stock changed locally (e.g. direct sale,
//              stock check, return), push the new qty to Shopify + eBay.
//
// State is tracked in the sync_state table.
const { query, withTx } = require('../db');
const shopify = require('./shopify');
const ebay = require('./ebay');

// Try to find a warehouse product for an order's SKU.
// Many sales channels send SKUs in slightly different formats. This helper
// tries exact match first, then progressively looser matches:
//   1. Exact (case-sensitive): "86551-Q0000"
//   2. Exact (case-insensitive)
//   3. Strip common prefixes like "HYUNDAI I20 - 86551-Q0000" → "86551-Q0000"
//   4. Strip all non-alphanumeric: "86551Q0000" matches "86551-Q0000"
//   5. Match by part_number column
async function resolveProductBySku(client, sku) {
  if (!sku) return null;
  const q = client ? client.query.bind(client) : query;
  // 1. exact
  let r = await q(`SELECT id, sku FROM products WHERE sku = $1 LIMIT 1`, [sku]);
  if (r.rows[0]) return r.rows[0];
  // 2. case-insensitive
  r = await q(`SELECT id, sku FROM products WHERE LOWER(sku) = LOWER($1) LIMIT 1`, [sku]);
  if (r.rows[0]) return r.rows[0];
  // 3. Strip everything before the last " - " or " : " (e.g. "HYUNDAI I20 - 86551-Q0000" → "86551-Q0000")
  const tail = sku.split(/\s+-\s+|\s+:\s+/).pop().trim();
  if (tail && tail !== sku) {
    r = await q(`SELECT id, sku FROM products WHERE sku = $1 OR LOWER(sku) = LOWER($1) LIMIT 1`, [tail]);
    if (r.rows[0]) return r.rows[0];
  }
  // 4. Normalise (strip all non-alphanumeric) and match
  const norm = (s) => (s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const normalised = norm(sku);
  const normalisedTail = norm(tail);
  if (normalised || normalisedTail) {
    r = await q(`SELECT id, sku FROM products WHERE REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') IN ($1, $2) LIMIT 1`,
      [normalised, normalisedTail]);
    if (r.rows[0]) return r.rows[0];
  }
  // 5. Match by part_number column if it exists
  r = await q(`SELECT id, sku FROM products WHERE part_number = $1 OR part_number = $2 LIMIT 1`, [sku, tail]);
  if (r.rows[0]) return r.rows[0];
  return null;
}

async function getCursor(channel) {
  const { rows } = await query('SELECT * FROM sync_state WHERE channel = $1', [channel]);
  return rows[0] || null;
}

async function setCursor(channel, { lastSyncedAt, status, error }) {
  await query(`
    INSERT INTO sync_state (channel, last_synced_at, last_status, last_error, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (channel) DO UPDATE
    SET last_synced_at = EXCLUDED.last_synced_at,
        last_status   = EXCLUDED.last_status,
        last_error    = EXCLUDED.last_error,
        updated_at    = now()
  `, [channel, lastSyncedAt, status, error || null]);
}

async function recordLowStockIfNeeded(productId) {
  const p = await query(
    `SELECT id, sku, title, qty_on_hand, low_stock_threshold
     FROM products WHERE id = $1`, [productId]
  );
  if (!p.rows[0]) return;
  const pr = p.rows[0];
  if (pr.qty_on_hand <= pr.low_stock_threshold) {
    // Suppress if we already have an unread low-stock notif for this product
    const existing = await query(
      `SELECT id FROM notifications
       WHERE type = 'low_stock' AND related_id = $1 AND read_at IS NULL`,
      [pr.id]
    );
    if (existing.rows.length) return;
    await query(
      `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
       VALUES ('low_stock', $1, $2, 'warn', 'product', $3)`,
      [
        `Low stock: ${pr.title}`,
        `${pr.sku} — ${pr.qty_on_hand} left (threshold ${pr.low_stock_threshold})`,
        pr.id,
      ]
    );
    require('./push').sendToAll({
      title: 'Low stock', body: `${pr.title} — ${pr.qty_on_hand} left`, url: '/', tag: 'lowstock-' + pr.id, category: 'low_stock',
    }).catch(() => {});
  }
}

// --------- PULL: Shopify orders ---------
async function pullShopify() {
  if (!shopify.isConfigured()) return { skipped: 'not_configured' };

  const state = await getCursor('shopify');
  const since = (state && state.last_synced_at)
    ? state.last_synced_at.toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { orders } = await shopify.getRecentOrders(since);
  let inserted = 0;

  for (const order of orders) {
    // Skip if we already have it
    const existing = await query(
      `SELECT id FROM sales WHERE channel = 'shopify' AND external_order_id = $1`,
      [String(order.id)]
    );
    if (existing.rows.length) continue;

    await withTx(async (c) => {
      const subtotal = parseFloat(order.subtotal_price || 0);
      const vat = parseFloat(order.total_tax || 0);
      const shipping = parseFloat(
        (order.shipping_lines || []).reduce((sum, s) => sum + parseFloat(s.price || 0), 0)
      );
      const total = parseFloat(order.total_price || 0);

      // Build shipping address string
      const ship = order.shipping_address || order.billing_address;
      const shipAddr = ship ? [
        [ship.first_name, ship.last_name].filter(Boolean).join(' '),
        ship.company, ship.address1, ship.address2,
        ship.city, ship.province, ship.zip, ship.country,
      ].filter(Boolean).join('\n') : null;

      // Unified reference: <PREFIX>-S-<Shopify order #> (CAP for Calibre, REP for
      // Razoryn). Same value in invoice_number and payment_reference.
      const brand = require('../lib/brand');
      const prefix = brand.invoicePrefix || 'REP';
      const orderNum = order.order_number || order.name || order.id;
      const paymentRef = `${prefix}-S-${orderNum}`;

      const sale = await c.query(
        `INSERT INTO sales (channel, external_order_id, customer_name, customer_email, customer_phone,
                            subtotal, vat, shipping, total, status, occurred_at, shipping_address,
                            payment_method, payment_reference, order_number, invoice_number)
         VALUES ('shopify',$1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          String(order.id),
          [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || ship?.first_name + ' ' + ship?.last_name || null,
          order.customer?.email || order.email || null,
          order.customer?.phone || ship?.phone || null,
          subtotal, vat, shipping, total,
          order.created_at,
          shipAddr,
          'shopify', paymentRef, order.name || String(order.order_number || order.id), paymentRef,
        ]
      );

      for (const li of order.line_items || []) {
        const matched = await resolveProductBySku(c, li.sku);
        const productId = matched?.id || null;
        await c.query(
          `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sale.rows[0].id, productId, li.sku || `(no-sku-${li.id})`, li.title,
           li.quantity, li.price, parseFloat(li.price) * li.quantity]
        );
        if (productId) {
          await c.query(
            `UPDATE products SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`,
            [li.quantity, productId]
          );
          await c.query(
            `INSERT INTO stock_movements (product_id, delta, reason, reference_id)
             VALUES ($1,$2,'sale_shopify',$3)`,
            [productId, -li.quantity, sale.rows[0].id]
          );
        }
      }

      // Fire low-stock notifs after the sale
      for (const li of order.line_items || []) {
        const matched = await resolveProductBySku(c, li.sku);
        if (matched) await recordLowStockIfNeeded(matched.id);
      }
    });
    inserted++;
  }

  await setCursor('shopify', {
    lastSyncedAt: new Date(),
    status: 'ok',
  });
  return { channel: 'shopify', orders: orders.length, inserted };
}

// --------- PULL: eBay orders ---------
async function pullEbay() {
  const brand = require('../lib/brand');
  if (!ebay.isConfigured()) return { skipped: 'not_configured' };

  // Sync cursor is shared across all eBay stores for this brand. Each store's
  // orders are tagged with that store's channelCode so the Sales tab can
  // differentiate them.
  const state = await getCursor('ebay');
  const since = (state && state.last_synced_at)
    ? state.last_synced_at.toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Determine which stores have a usable token. Skip silently for stores
  // without tokens (warning logged at brand-import time).
  const activeStores = brand.stores.filter(s => s.token);
  if (!activeStores.length) {
    console.warn('[sync.pullEbay] no eBay stores have tokens configured');
    return { channel: 'ebay', orders: 0, inserted: 0, stores: [] };
  }

  let totalOrders = 0, totalInserted = 0;
  const perStore = [];

  for (const store of activeStores) {
    let orders = [];
    try {
      orders = await ebay.getRecentOrders(since, store);
    } catch (e) {
      console.error(`[sync.pullEbay] store=${store.code} fetch failed: ${e.message}`);
      perStore.push({ code: store.code, error: e.message, orders: 0, inserted: 0 });
      continue;
    }
    let inserted = 0;

    for (const order of orders) {
      const existing = await query(
        `SELECT id FROM sales WHERE external_order_id = $1`,
        [order.orderId]
      );
      if (existing.rows.length) continue;

      await withTx(async (c) => {
        const subtotal = parseFloat(order.pricingSummary?.priceSubtotal?.value || 0);
        const vat = parseFloat(order.pricingSummary?.tax?.value || 0);
        const shipping = parseFloat(order.pricingSummary?.deliveryCost?.value || 0);
        const total = parseFloat(order.pricingSummary?.total?.value || 0);

        // Unified reference: <PREFIX>-E-<eBay order #>. Same value in
        // invoice_number and payment_reference.
        const prefix = brand.invoicePrefix || 'REP';
        const paymentRef = `${prefix}-E-${order.orderId}`;

        // Channel = the store's channelCode (ebay_em / ebay_cl / etc.).
        const channelCode = store.channelCode || 'ebay_em';

        const sale = await c.query(
          `INSERT INTO sales (channel, external_order_id, customer_name, customer_email, customer_phone,
                              subtotal, vat, shipping, total, status, occurred_at, shipping_address,
                              payment_method, payment_reference, order_number, invoice_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'paid',$10,$11,$12,$13,$14,$15) RETURNING id`,
          [
            channelCode,
            order.orderId,
            order.buyer?.name || order.buyer?.username || null,
            order.buyer?.email || null,
            order.buyer?.phone || null,
            subtotal, vat, shipping, total,
            order.creationDate,
            order.shippingAddress || null,
            'ebay', paymentRef, order.orderId, paymentRef,
          ]
        );

        for (const li of order.lineItems || []) {
          const matched = await resolveProductBySku(c, li.sku);
          const productId = matched?.id || null;
          const qty = li.quantity || 1;
          const unitPrice = parseFloat(li.lineItemCost?.value || 0) / qty;
          await c.query(
            `INSERT INTO sale_items (sale_id, product_id, sku, title, qty, unit_price, line_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [sale.rows[0].id, productId, li.sku || `(no-sku-${li.lineItemId})`,
             li.title, qty, unitPrice, parseFloat(li.lineItemCost?.value || 0)]
          );
          if (productId) {
            await c.query(`UPDATE products SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`,
              [qty, productId]);
            await c.query(
              `INSERT INTO stock_movements (product_id, delta, reason, reference_id)
               VALUES ($1,$2,$3,$4)`,
              [productId, -qty, `sale_${channelCode}`, sale.rows[0].id]
            );
          }
        }
        for (const li of order.lineItems || []) {
          const matched = await resolveProductBySku(c, li.sku);
          if (matched) await recordLowStockIfNeeded(matched.id);
        }
      });
      inserted++;
    }
    totalOrders += orders.length;
    totalInserted += inserted;
    perStore.push({ code: store.code, orders: orders.length, inserted });
  }

  await setCursor('ebay', { lastSyncedAt: new Date(), status: 'ok' });
  return { channel: 'ebay', orders: totalOrders, inserted: totalInserted, stores: perStore };
}

// --------- PUSH: stock levels for sale items ---------
// Called immediately after a direct sale so eBay/Shopify reflect the new stock.
async function pushStockForSaleItems(items) {
  for (const it of items) {
    if (!it.productId) continue;
    const p = await query('SELECT * FROM products WHERE id = $1', [it.productId]);
    const product = p.rows[0];
    if (!product) continue;
    if (shopify.isConfigured()) {
      try { await shopify.pushStockForProduct(product); }
      catch (e) { console.warn('[sync] shopify push failed for', product.sku, e.message); }
    }
    if (ebay.isConfigured()) {
      try { await ebay.pushStockForProduct(product); }
      catch (e) { console.warn('[sync] ebay push failed for', product.sku, e.message); }
    }
  }
}

// Push warehouse stock to Shopify for all products that have a Shopify ID.
// Useful as part of a manual "Sync now" so stock changes from the warehouse
// (sales, stock checks, returns) propagate to Shopify even if a previous push failed.
async function pushAllStockToShopify() {
  if (!shopify.isConfigured()) return { skipped: 'not_configured' };
  const { rows } = await query(
    `SELECT id, sku, qty_on_hand, shopify_inventory_id
     FROM products
     WHERE active = true AND shopify_inventory_id IS NOT NULL`
  );
  let pushed = 0, errors = 0;
  for (const p of rows) {
    try {
      await shopify.pushStockForProduct(p);
      pushed++;
    } catch (e) {
      errors++;
      console.warn('[sync] push fail for', p.sku, e.message);
    }
  }
  return { channel: 'shopify_stock', pushed, errors, total: rows.length };
}

// --------- Orchestrator ---------
async function runFullSync() {
  const results = {};
  try { results.shopify = await pullShopify(); }
  catch (e) {
    console.error('[sync] shopify pull failed:', e.message);
    results.shopify = { error: e.message };
    await setCursor('shopify', { lastSyncedAt: new Date(), status: 'error', error: e.message });
  }
  try { results.ebay = await pullEbay(); }
  catch (e) {
    console.error('[sync] ebay pull failed:', e.message);
    results.ebay = { error: e.message };
    await setCursor('ebay', { lastSyncedAt: new Date(), status: 'error', error: e.message });
  }

  // MASTER-STOCK PROPAGATION: the warehouse is the master. Re-push the latest
  // qty to BOTH channels for every product whose stock changed recently — from
  // ANY source (orders, stock-checks, returns, manual edits, incoming receipts),
  // not just sales. This is the backstop that keeps eBay in sync (Shopify also
  // gets a full push below); the window (40 min) comfortably covers the 30-min
  // sync cron so nothing is missed between runs.
  try {
    const touched = await query(`
      SELECT DISTINCT p.id, p.sku, p.qty_on_hand, p.shopify_inventory_id, p.shopify_product_id
      FROM products p
      JOIN stock_movements sm ON sm.product_id = p.id
      WHERE sm.created_at > now() - interval '40 minutes'
        AND p.active = true
    `);
    let pushed = 0;
    for (const product of touched.rows) {
      if (shopify.isConfigured()) {
        try { await shopify.pushStockForProduct(product); } catch (e) { console.warn('[sync] shopify re-push', product.sku, e.message); }
      }
      if (ebay.isConfigured()) {
        try { await ebay.pushStockForProduct(product); } catch (e) { console.warn('[sync] ebay re-push', product.sku, e.message); }
      }
      pushed++;
    }
    results.stockPropagation = { productsRepushed: pushed };
  } catch (e) {
    console.error('[sync] stock propagation failed:', e.message);
    results.stockPropagation = { error: e.message };
  }

  try { results.shopifyStock = await pushAllStockToShopify(); }
  catch (e) {
    console.error('[sync] stock push failed:', e.message);
    results.shopifyStock = { error: e.message };
  }

  try { results.autoDispatch = await autoMarkDispatched(); }
  catch (e) {
    console.error('[sync] auto-dispatch failed:', e.message);
    results.autoDispatch = { error: e.message };
  }
  return results;
}

// --------- AUTO-DISPATCH: mark orders shipped ON the platform ---------
// If an outstanding order has been fulfilled/shipped (with tracking) directly on
// Shopify or eBay, mark it dispatched in the warehouse so it drops off the
// dispatch worklist. We pull the tracking IN but never push it back out (the
// platform already has it). dispatched_by stays NULL = system/auto.
async function autoMarkDispatched() {
  const result = { shopify: 0, ebay: 0, errors: [] };
  const { rows: outstanding } = await query(`
    SELECT id, channel, external_order_id FROM sales
    WHERE is_estimate = false AND dispatched_at IS NULL AND collected_at IS NULL
      AND status NOT IN ('refunded','cancelled','dispatched')
      AND external_order_id IS NOT NULL
  `);
  if (!outstanding.length) return result;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ----- Shopify -----
  const shopifyOut = outstanding.filter(s => s.channel === 'shopify');
  if (shopifyOut.length && shopify.isConfigured()) {
    try {
      const { orders } = await shopify.getRecentOrders(since);
      const fulfilled = {};
      for (const o of orders) {
        if (o.fulfillment_status === 'fulfilled' || o.fulfillment_status === 'partial') {
          const f = (o.fulfillments || []).find(x => x.tracking_number) || (o.fulfillments || [])[0] || {};
          fulfilled[String(o.id)] = { tracking: f.tracking_number || null, carrier: f.tracking_company || null };
        }
      }
      for (const s of shopifyOut) {
        const hit = fulfilled[String(s.external_order_id)];
        if (hit) { await markAutoDispatched(s.id, 'Shopify', hit.tracking, hit.carrier); result.shopify++; }
      }
    } catch (e) { result.errors.push('shopify: ' + e.message); }
  }

  // ----- eBay -----
  const ebayOut = outstanding.filter(s => (s.channel || '').startsWith('ebay'));
  if (ebayOut.length && ebay.isConfigured()) {
    try {
      const fulfilledIds = await ebay.getFulfilledOrderIds(since);
      for (const s of ebayOut) {
        if (!fulfilledIds.has(s.external_order_id)) continue;
        const { tracking, carrier } = await ebay.getOrderTracking(s.external_order_id);
        await markAutoDispatched(s.id, 'eBay', tracking, carrier);
        result.ebay++;
      }
    } catch (e) { result.errors.push('ebay: ' + e.message); }
  }

  if (result.shopify || result.ebay) {
    console.log(`[sync] auto-dispatched ${result.shopify} Shopify + ${result.ebay} eBay order(s) from platform fulfillment`);
  }
  return result;
}

async function markAutoDispatched(saleId, platform, tracking, carrier) {
  await query(`
    UPDATE sales
       SET dispatched_at = now(), status = 'dispatched',
           tracking_number = COALESCE($2, tracking_number),
           carrier = COALESCE($3, carrier),
           dispatch_notes = $4
     WHERE id = $1 AND dispatched_at IS NULL
  `, [saleId, tracking, carrier, `Auto-detected from ${platform}`]);
}

// Push EVERY linked product's current warehouse qty to eBay (manual full
// reconcile — e.g. after a monthly stock-take). One ReviseInventoryStatus per
// linked listing; best-effort per product.
async function pushAllStockToEbay() {
  if (!ebay.isConfigured()) return { skipped: 'not_configured' };
  const { rows } = await query(`
    SELECT DISTINCT p.id, p.sku, p.qty_on_hand, p.shopify_product_id
    FROM products p
    JOIN mirror_links ml ON ml.shopify_product_id::text = p.shopify_product_id
    WHERE p.active = true`);
  let pushed = 0, errors = 0;
  for (const p of rows) {
    try { await ebay.pushStockForProduct(p); pushed++; }
    catch (e) { errors++; console.warn('[sync] ebay push-all fail', p.sku, e.message); }
  }
  return { channel: 'ebay_stock', pushed, errors, total: rows.length };
}

// Push EVERY linked product's current warehouse qty to Shopify AND eBay in a
// single pass (interleaved, so eBay isn't starved if the run is long). Returns
// accurate per-channel counts INCLUDING per-eBay-listing failures + a sample
// error, so the caller can tell a real failure from a timeout. Meant to run in
// the background (it can take minutes for a big catalogue).
async function pushAllStockToBoth() {
  const { rows } = await query(`
    SELECT id, sku, qty_on_hand, shopify_inventory_id, shopify_product_id
    FROM products
    WHERE active = true AND (shopify_inventory_id IS NOT NULL OR shopify_product_id IS NOT NULL)`);
  const out = { total: rows.length, shopify: { pushed: 0, errors: 0 }, ebay: { pushed: 0, errors: 0 }, sampleEbayError: null };
  const shopOk = shopify.isConfigured();
  const ebayOk = ebay.isConfigured();
  for (const p of rows) {
    if (shopOk && p.shopify_inventory_id) {
      try { await shopify.pushStockForProduct(p); out.shopify.pushed++; }
      catch (e) { out.shopify.errors++; }
    }
    if (ebayOk && p.shopify_product_id) {
      try {
        const r = await ebay.pushStockForProduct(p);
        // pushStockForProduct catches per-link errors internally and returns
        // { results:[{ok|error}] } — so inspect them for the true count.
        if (r && Array.isArray(r.results)) {
          for (const x of r.results) {
            if (x.ok) out.ebay.pushed++;
            else { out.ebay.errors++; if (!out.sampleEbayError) out.sampleEbayError = x.error || 'unknown'; }
          }
        } else if (r && r.ok) out.ebay.pushed++;
        else if (r && r.skipped) { /* no link / no sku — not an error */ }
        else { out.ebay.errors++; if (!out.sampleEbayError && r && r.error) out.sampleEbayError = r.error; }
      } catch (e) {
        out.ebay.errors++; if (!out.sampleEbayError) out.sampleEbayError = e.message;
      }
    }
  }
  return out;
}

module.exports = {
  runFullSync,
  pullShopify,
  pullEbay,
  pushStockForSaleItems,
  pushAllStockToShopify,
  pushAllStockToEbay,
  pushAllStockToBoth,
  recordLowStockIfNeeded,
  resolveProductBySku,
  autoMarkDispatched,
};
