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
        'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
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

// ---------- Trading API (XML) — needed for GetMyeBaySelling ----------
// The newer Sell APIs only return listings migrated to the inventory model,
// which most legacy listings aren't. Trading API works for everything.
const TRADING_BASE = ENV === 'production'
  ? 'https://api.ebay.com/ws/api.dll'
  : 'https://api.sandbox.ebay.com/ws/api.dll';

async function tradingCall(callName, bodyInner) {
  const token = await getAccessToken();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  ${bodyInner}
</${callName}Request>`;
  const r = await axios.post(TRADING_BASE, xml, {
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '3', // 3 = UK
      'X-EBAY-API-IAF-TOKEN': token,
    },
    timeout: 60000,
  });
  return r.data; // raw XML string
}

// Tiny XML extractor — avoids pulling in a full XML parser dep
function extractAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}
function extractOne(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Pull all active eBay listings (paginated)
async function getActiveListings() {
  if (!isConfigured()) return [];
  const all = [];
  let page = 1;
  const perPage = 200;
  while (page < 50) { // safety cap (~10k listings)
    const xml = await tradingCall('GetMyeBaySelling', `
      <ActiveList>
        <Include>true</Include>
        <Pagination>
          <EntriesPerPage>${perPage}</EntriesPerPage>
          <PageNumber>${page}</PageNumber>
        </Pagination>
      </ActiveList>
      <DetailLevel>ReturnAll</DetailLevel>`);

    if (xml.includes('<Ack>Failure</Ack>')) {
      const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
      throw new Error('eBay error: ' + decodeEntities(err));
    }

    const items = extractAll(xml, 'Item');
    if (!items.length) break;

    for (const itemXml of items) {
      const itemId = extractOne(itemXml, 'ItemID');
      const title = decodeEntities(extractOne(itemXml, 'Title') || '');
      const sku = decodeEntities(extractOne(itemXml, 'SKU') || '');
      const startPrice = extractOne(itemXml, 'StartPrice') || extractOne(itemXml, 'CurrentPrice') || '0';
      const buyItNow = extractOne(itemXml, 'BuyItNowPrice');
      const currency = (extractOne(itemXml, 'StartPrice') || '').match(/currencyID="([^"]+)"/);
      // PictureDetails > PictureURL (multiple)
      const picBlock = extractOne(itemXml, 'PictureDetails') || '';
      const pictureUrls = extractAll(picBlock, 'PictureURL').map(decodeEntities);
      const galleryUrl = decodeEntities(extractOne(picBlock, 'GalleryURL') || '');
      const allPics = [...new Set([galleryUrl, ...pictureUrls].filter(Boolean))];

      all.push({
        itemId,
        sku: sku || null,
        title,
        priceEbay: parseFloat(buyItNow || startPrice) || 0,
        currency: currency ? currency[1] : 'GBP',
        pictureUrls: allPics,
        viewItemURL: decodeEntities(extractOne(itemXml, 'ViewItemURL') || ''),
      });
    }

    // Pagination — stop if this page wasn't full
    const totalPages = parseInt(extractOne(xml, 'TotalNumberOfPages') || '1');
    if (page >= totalPages) break;
    page++;
  }

  // Auto-detect probable template images: any image URL appearing in 2+ listings
  // is almost certainly a banner/policy/template, not a real product photo.
  const urlCount = {};
  for (const l of all) {
    for (const u of l.pictureUrls) urlCount[u] = (urlCount[u] || 0) + 1;
  }
  for (const l of all) {
    l.imageMeta = l.pictureUrls.map(u => ({
      url: u,
      likelyTemplate: (urlCount[u] || 0) > 1,
    }));
  }
  return all;
}

module.exports.getActiveListings = getActiveListings;

module.exports = {
  isConfigured,
  getAccessToken,
  setInventoryQty,
  getRecentOrders,
  pushStockForProduct,
};
