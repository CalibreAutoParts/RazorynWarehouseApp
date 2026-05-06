// services/ebay.js — eBay Sell API client
//
// Uses OAuth refresh-token flow to get a fresh access token, then calls
// the Inventory and Fulfillment APIs.
//
// Two accounts are supported (matching the existing Calibre setup):
//   - "em" Electric Motor Parts
//   - "cl" Cappanel & Lamps
//
// For Razoryn we currently only have one or two accounts; this is wired
// generically so adding more is just a config tweak.
const axios = require('axios');

const ENV = process.env.EBAY_ENV || 'production';
const BASE = ENV === 'production'
  ? 'https://api.ebay.com'
  : 'https://api.sandbox.ebay.com';

function isConfigured() {
  return !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_REFRESH_TOKEN);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (!isConfigured()) throw new Error('ebay_not_configured');
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const r = await axios.post(
    `${BASE}/identity/v1/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.EBAY_REFRESH_TOKEN,
      scope: [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      ].join(' '),
    }),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  cachedToken = r.data.access_token;
  tokenExpiresAt = Date.now() + (r.data.expires_in * 1000);
  return cachedToken;
}

async function http(method, url, data) {
  const token = await getAccessToken();
  return axios({
    method, url: `${BASE}${url}`, data,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-GB',
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB',
    },
    timeout: 30000,
  });
}

// Push stock to a single SKU on eBay
async function setInventoryQty(sku, qty) {
  // eBay Inventory API requires PUT to /sell/inventory/v1/inventory_item/{sku}
  // For a stock-only update we use the bulkUpdatePriceQuantity endpoint which
  // is faster and avoids overwriting other listing fields.
  const body = {
    requests: [
      {
        sku,
        shipToLocationAvailability: { quantity: qty },
      },
    ],
  };
  await http('POST', '/sell/inventory/v1/bulk_update_price_quantity', body);
}

// Pull recent orders from the Fulfillment API
async function getRecentOrders(sinceISO) {
  const filter = `creationdate:[${sinceISO}..]`;
  const r = await http('GET',
    `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200`);
  return r.data.orders || [];
}

async function pushStockForProduct(product) {
  if (!product.sku) return { skipped: 'no_sku' };
  await setInventoryQty(product.sku, product.qty_on_hand);
  return { ok: true };
}

module.exports = {
  isConfigured,
  getAccessToken,
  setInventoryQty,
  getRecentOrders,
  pushStockForProduct,
};
