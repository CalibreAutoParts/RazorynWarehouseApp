// services/shopify.js — Shopify Admin API client
//
// Uses Admin REST API for inventory_levels (simplest for stock pushes)
// and GraphQL for order pulls (more efficient).
//
// Required scopes on the custom app:
//   read_products, write_inventory, read_inventory, read_orders, read_locations
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

function isConfigured() {
  return !!(STORE && TOKEN);
}

const http = axios.create({
  baseURL: STORE ? `https://${STORE}/admin/api/${VERSION}` : '',
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Get all locations (used once to find LOCATION_ID for the warehouse)
async function getLocations() {
  if (!isConfigured()) return [];
  const r = await http.get('/locations.json');
  return r.data.locations;
}

// Push a single inventory level (set absolute quantity at the warehouse location)
async function setInventoryLevel(inventoryItemId, qty) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  if (!LOCATION_ID) throw new Error('SHOPIFY_LOCATION_ID_not_set');
  await http.post('/inventory_levels/set.json', {
    location_id: parseInt(LOCATION_ID),
    inventory_item_id: parseInt(inventoryItemId),
    available: qty,
  });
}

// Pull recent orders (since cursor), paginated
// Returns { orders, nextCursor }
async function getRecentOrders(updatedAtMin) {
  if (!isConfigured()) return { orders: [], nextCursor: null };
  const params = {
    status: 'any',
    fulfillment_status: 'any',
    limit: 250,
    updated_at_min: updatedAtMin,
  };
  const r = await http.get('/orders.json', { params });
  return { orders: r.data.orders || [], nextCursor: null };
}

// Helper — when stock is decremented locally (e.g. direct sale), push to Shopify
async function pushStockForProduct(product) {
  if (!product.shopify_inventory_id) return { skipped: 'no_inventory_id' };
  await setInventoryLevel(product.shopify_inventory_id, product.qty_on_hand);
  return { ok: true };
}

module.exports = {
  isConfigured,
  getLocations,
  setInventoryLevel,
  getRecentOrders,
  pushStockForProduct,
};
