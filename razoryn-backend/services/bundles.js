// services/bundles.js — eBay "bundle" listings.
//
// A bundle is a VIRTUAL eBay listing made of 2+ warehouse products (components),
// each with a per-bundle quantity. The bundle is NOT a warehouse product and is
// never stock-taken — its availability is DERIVED from its components:
//
//     available = min over components of floor(component.qty_on_hand / qty_in_bundle)
//
// so it can never sell more sets than the scarcest component allows. When any
// component's stock changes we recompute and push the new quantity to the live
// eBay listing; when the bundle itself sells we deduct each component.
const { query } = require('../db');

let _ensured = false;
async function ensureBundleTables() {
  if (_ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS bundles (
      id           SERIAL PRIMARY KEY,
      ebay_item_id TEXT UNIQUE,
      store_code   TEXT,
      sku          TEXT,
      title        TEXT,
      active       BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS bundle_components (
      id         SERIAL PRIMARY KEY,
      bundle_id  INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      qty        INTEGER NOT NULL DEFAULT 1
    )`);
  await query(`CREATE INDEX IF NOT EXISTS bundle_components_bundle_idx ON bundle_components (bundle_id)`);
  await query(`CREATE INDEX IF NOT EXISTS bundle_components_product_idx ON bundle_components (product_id)`);
  _ensured = true;
}

// Derived availability for one bundle. Any missing/inactive component → 0 (we
// can't fulfil a set if a part is gone). Negative stock is clamped to 0.
async function computeAvailable(bundleId, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `SELECT bc.qty AS need, p.qty_on_hand AS have, p.active
       FROM bundle_components bc
       LEFT JOIN products p ON p.id = bc.product_id
      WHERE bc.bundle_id = $1`,
    [bundleId]
  );
  if (!rows.length) return 0;
  let avail = Infinity;
  for (const r of rows) {
    if (r.have == null || r.active === false) return 0;
    const can = Math.floor(Math.max(0, r.have) / Math.max(1, r.need || 1));
    if (can < avail) avail = can;
  }
  return avail === Infinity ? 0 : Math.max(0, avail);
}

// Compute a bundle's availability and push it to the live eBay listing.
async function recomputeAndPush(bundleId) {
  await ensureBundleTables();
  const { rows } = await query(`SELECT id, ebay_item_id, store_code, active FROM bundles WHERE id = $1`, [bundleId]);
  const b = rows[0];
  if (!b || !b.active) return { bundleId, skipped: 'inactive_or_missing' };
  const avail = await computeAvailable(bundleId);
  let pushed = false, error = null;
  if (b.ebay_item_id) {
    try {
      const ebay = require('./ebay');
      if (ebay.isConfigured()) { await ebay.setQuantityTradingAPI(b.ebay_item_id, avail, b.store_code || undefined); pushed = true; }
    } catch (e) { error = e.message; console.warn(`[bundles] push qty failed bundle=${bundleId} item=${b.ebay_item_id}: ${e.message}`); }
  }
  return { bundleId, available: avail, pushed, error };
}

// Recompute every active bundle that contains a given component product.
async function recomputeBundlesForProduct(productId) {
  await ensureBundleTables();
  const { rows } = await query(
    `SELECT DISTINCT b.id FROM bundles b
       JOIN bundle_components bc ON bc.bundle_id = b.id
      WHERE bc.product_id = $1 AND b.active = true`,
    [productId]
  );
  const out = [];
  for (const r of rows) { try { out.push(await recomputeAndPush(r.id)); } catch (e) { /* best-effort */ } }
  return out;
}

// Recompute + push every active bundle (sync backstop).
async function recomputeAllBundles() {
  await ensureBundleTables();
  const { rows } = await query(`SELECT id FROM bundles WHERE active = true`);
  let pushed = 0, failed = 0;
  for (const r of rows) {
    try { const res = await recomputeAndPush(r.id); if (res.pushed) pushed++; else if (res.error) failed++; }
    catch (e) { failed++; }
  }
  return { bundles: rows.length, pushed, failed };
}

// Find an active bundle whose SKU matches a sold line item's SKU (normalised).
async function findBundleBySku(sku, client) {
  if (!sku) return null;
  const q = client ? client.query.bind(client) : query;
  const norm = String(sku).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!norm) return null;
  const { rows } = await q(
    `SELECT id, ebay_item_id, sku, title FROM bundles
      WHERE active = true AND REGEXP_REPLACE(UPPER(COALESCE(sku,'')), '[^A-Z0-9]', '', 'g') = $1
      LIMIT 1`,
    [norm]
  );
  return rows[0] || null;
}

// Deduct each component when a bundle sells `qtySold` sets. Records a stock
// movement per component. Runs inside the caller's transaction client.
async function deductBundleComponents(client, bundleId, qtySold, saleId, reason) {
  const { rows: comps } = await client.query(
    `SELECT product_id, qty FROM bundle_components WHERE bundle_id = $1`, [bundleId]
  );
  const touched = [];
  for (const c of comps) {
    const delta = -(qtySold * (c.qty || 1));
    await client.query(`UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = now() WHERE id = $2`, [delta, c.product_id]);
    await client.query(
      `INSERT INTO stock_movements (product_id, delta, reason, reference_id)
       VALUES ($1,$2,$3,$4)`,
      [c.product_id, delta, reason || 'sale_bundle', saleId || null]
    );
    touched.push(c.product_id);
  }
  return touched;
}

module.exports = {
  ensureBundleTables,
  computeAvailable,
  recomputeAndPush,
  recomputeBundlesForProduct,
  recomputeAllBundles,
  findBundleBySku,
  deductBundleComponents,
};
