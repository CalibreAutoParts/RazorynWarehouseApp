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

      // Generate REP reference (Shopify orders are card or shopify-pay; mark as S)
      const paymentRef = 'REP-' + Math.random().toString(36).slice(2,6).toUpperCase()
                        + Math.random().toString(36).slice(2,6).toUpperCase() + '-S';

      const sale = await c.query(
        `INSERT INTO sales (channel, external_order_id, customer_name, customer_email, customer_phone,
                            subtotal, vat, shipping, total, status, occurred_at, shipping_address,
                            payment_method, payment_reference, order_number)
         VALUES ('shopify',$1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11,$12,$13) RETURNING id`,
        [
          String(order.id),
          [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || ship?.first_name + ' ' + ship?.last_name || null,
          order.customer?.email || order.email || null,
          order.customer?.phone || ship?.phone || null,
          subtotal, vat, shipping, total,
          order.created_at,
          shipAddr,
          'shopify', paymentRef, order.name || String(order.order_number || order.id),
        ]
      );

      for (const li of order.line_items || []) {
        const p = await c.query(
          `SELECT id FROM products WHERE sku = $1 LIMIT 1`, [li.sku]
        );
        const productId = p.rows[0]?.id || null;
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
        const p = await c.query(`SELECT id FROM products WHERE sku = $1 LIMIT 1`, [li.sku]);
        if (p.rows[0]) await recordLowStockIfNeeded(p.rows[0].id);
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
  if (!ebay.isConfigured()) return { skipped: 'not_configured' };

  const state = await getCursor('ebay');
  const since = (state && state.last_synced_at)
    ? state.last_synced_at.toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const orders = await ebay.getRecentOrders(since);
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

      const paymentRef = 'REP-' + Math.random().toString(36).slice(2,6).toUpperCase()
                        + Math.random().toString(36).slice(2,6).toUpperCase() + '-E';

      const sale = await c.query(
        `INSERT INTO sales (channel, external_order_id, customer_name, customer_email, customer_phone,
                            subtotal, vat, shipping, total, status, occurred_at, shipping_address,
                            payment_method, payment_reference, order_number)
         VALUES ('ebay_em',$1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11,$12,$13) RETURNING id`,
        [
          order.orderId,
          order.buyer?.name || order.buyer?.username || null,
          order.buyer?.email || null,
          order.buyer?.phone || null,
          subtotal, vat, shipping, total,
          order.creationDate,
          order.shippingAddress || null,
          'ebay', paymentRef, order.orderId,
        ]
      );

      for (const li of order.lineItems || []) {
        const p = await c.query(`SELECT id FROM products WHERE sku = $1 LIMIT 1`, [li.sku]);
        const productId = p.rows[0]?.id || null;
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
             VALUES ($1,$2,'sale_ebay',$3)`,
            [productId, -qty, sale.rows[0].id]
          );
        }
      }
      for (const li of order.lineItems || []) {
        const p = await c.query(`SELECT id FROM products WHERE sku = $1 LIMIT 1`, [li.sku]);
        if (p.rows[0]) await recordLowStockIfNeeded(p.rows[0].id);
      }
    });
    inserted++;
  }

  await setCursor('ebay', { lastSyncedAt: new Date(), status: 'ok' });
  return { channel: 'ebay', orders: orders.length, inserted };
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
  try { results.shopifyStock = await pushAllStockToShopify(); }
  catch (e) {
    console.error('[sync] stock push failed:', e.message);
    results.shopifyStock = { error: e.message };
  }
  return results;
}

module.exports = {
  runFullSync,
  pullShopify,
  pullEbay,
  pushStockForSaleItems,
  pushAllStockToShopify,
  recordLowStockIfNeeded,
};
