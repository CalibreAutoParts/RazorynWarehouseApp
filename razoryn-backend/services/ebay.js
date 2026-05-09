// services/ebay.js — eBay Sell API client
//
// Uses OAuth refresh-token flow to get a fresh access token, then calls
// the Inventory and Fulfillment APIs.
//
// Env vars supported (either naming convention works — eBay's dashboard uses
// APP_ID/CERT_ID, the OAuth spec uses CLIENT_ID/CLIENT_SECRET; pick whichever):
//   EBAY_CLIENT_ID    or  EBAY_APP_ID         — public app identifier
//   EBAY_CLIENT_SECRET or EBAY_CERT_ID        — secret key
//   EBAY_REFRESH_TOKEN                        — long-lived seller token (required)
//   EBAY_DEV_ID                               — optional, only some Trading API calls need it
//   EBAY_MARKETPLACE_ID                       — defaults to EBAY_GB
//   EBAY_SITE_ID                              — defaults to 3 (UK) for Trading API
const axios = require('axios');

const ENV = process.env.EBAY_ENV || 'production';
const BASE = ENV === 'production'
  ? 'https://api.ebay.com'
  : 'https://api.sandbox.ebay.com';

// Accept either naming pattern
const CLIENT_ID = process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID;
const REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;

function isConfigured() {
  // Two valid configurations:
  //  A. Auth'n'Auth: just need EBAY_AUTH_TOKEN + APP_ID + CERT_ID + DEV_ID (for Trading API)
  //  B. OAuth: need APP_ID/CLIENT_ID + CERT_ID/CLIENT_SECRET + REFRESH_TOKEN
  if (process.env.EBAY_AUTH_TOKEN && CLIENT_ID && CLIENT_SECRET) return true;
  return !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (!isConfigured()) {
    const have = {
      EBAY_APP_ID_or_CLIENT_ID: !!CLIENT_ID,
      EBAY_CERT_ID_or_CLIENT_SECRET: !!CLIENT_SECRET,
      EBAY_REFRESH_TOKEN: !!REFRESH_TOKEN,
    };
    throw new Error('ebay_not_configured. Have: ' + JSON.stringify(have));
  }
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  try {
    const r = await axios.post(
      `${BASE}/identity/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN,
        scope: [
          // Basic scope — required for IAF tokens with Trading API
          'https://api.ebay.com/oauth/api_scope',
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
        timeout: 15000,
      }
    );
    cachedToken = r.data.access_token;
    tokenExpiresAt = Date.now() + (r.data.expires_in * 1000);
    return cachedToken;
  } catch (e) {
    const body = e.response?.data;
    const errCode = body?.error || 'unknown';
    const errDesc = body?.error_description || e.message;
    const detail = `eBay token refresh failed [${errCode}]: ${errDesc}`;
    console.error('[ebay] ' + detail, body);
    throw new Error(detail);
  }
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
  // Two auth options for Trading API:
  //  A. EBAY_AUTH_TOKEN (Auth'n'Auth legacy token from User Tokens page) →
  //     uses Dev/App/Cert headers + <RequesterCredentials><eBayAuthToken> in body.
  //     Simpler, works without OAuth scope dance. Tokens last ~18 months.
  //  B. OAuth IAF token via refresh-token flow → modern, uses X-EBAY-API-IAF-TOKEN header,
  //     no <RequesterCredentials> in body. Requires `https://api.ebay.com/oauth/api_scope` granted.
  const authToken = process.env.EBAY_AUTH_TOKEN;
  const useAuthnAuth = !!authToken;

  let headers;
  let xml;

  if (useAuthnAuth) {
    headers = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '3',
      'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
      'X-EBAY-API-APP-NAME': CLIENT_ID || '',
      'X-EBAY-API-CERT-NAME': CLIENT_SECRET || '',
    };
    xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${authToken}</eBayAuthToken></RequesterCredentials>
  ${bodyInner}
</${callName}Request>`;
  } else {
    const token = await getAccessToken();
    headers = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '3',
      'X-EBAY-API-IAF-TOKEN': token,
    };
    xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${bodyInner}
</${callName}Request>`;
  }

  try {
    const r = await axios.post(TRADING_BASE, xml, { headers, timeout: 60000 });
    return r.data;
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data;
    let detail = `Trading API ${callName} failed`;
    if (status) detail += ` (HTTP ${status})`;
    if (typeof body === 'string') {
      const short = extractOne(body, 'ShortMessage');
      const long = extractOne(body, 'LongMessage');
      const errCode = extractOne(body, 'ErrorCode');
      if (short || long) detail += `: [${errCode || '?'}] ${decodeEntities(long || short)}`;
      else detail += `: ${body.slice(0, 300)}`;
    } else if (body) {
      detail += `: ${JSON.stringify(body).slice(0, 300)}`;
    } else {
      detail += `: ${e.message}`;
    }
    console.error('[ebay] ' + detail);
    throw new Error(detail);
  }
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
  const seenItemIds = new Set(); // dedupe — eBay sometimes returns the same item twice across pages
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
      </ActiveList>`);

    if (xml.includes('<Ack>Failure</Ack>')) {
      const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
      throw new Error('eBay error: ' + decodeEntities(err));
    }

    // Scope extraction to ActiveList > ItemArray. Without this, the regex picks up
    // <Item> tags from elsewhere in the response (Summary section, etc.) inflating the count.
    const activeListBlock = extractOne(xml, 'ActiveList') || '';
    const itemArrayBlock = extractOne(activeListBlock, 'ItemArray') || '';
    const items = extractAll(itemArrayBlock, 'Item');
    if (!items.length) break;

    for (const itemXml of items) {
      const itemId = extractOne(itemXml, 'ItemID');
      if (!itemId || seenItemIds.has(itemId)) continue; // dedupe
      seenItemIds.add(itemId);

      const title = decodeEntities(extractOne(itemXml, 'Title') || '');
      const sku = decodeEntities(extractOne(itemXml, 'SKU') || '');
      const startPrice = extractOne(itemXml, 'StartPrice') || extractOne(itemXml, 'CurrentPrice') || '0';
      const buyItNow = extractOne(itemXml, 'BuyItNowPrice');
      const currency = (extractOne(itemXml, 'StartPrice') || '').match(/currencyID="([^"]+)"/);
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

    // PaginationResult lives inside ActiveList — read it from the scoped block
    const totalPages = parseInt(extractOne(activeListBlock, 'TotalNumberOfPages') || '1');
    if (page >= totalPages) break;
    page++;
  }

  // Step 2: GetMyeBaySelling only returns the GalleryURL (1 photo) and sometimes
  // omits photos entirely. Enrich every listing with GetItem to get the full picture set.
  // Concurrency-limited to avoid hammering eBay.
  const concurrency = 6;
  let enriched = 0;
  for (let i = 0; i < all.length; i += concurrency) {
    const batch = all.slice(i, i + concurrency);
    await Promise.all(batch.map(async (l) => {
      try {
        const itemXml = await tradingCall('GetItem', `<ItemID>${l.itemId}</ItemID><IncludeItemSpecifics>false</IncludeItemSpecifics>`);
        const picBlock = extractOne(itemXml, 'PictureDetails') || '';
        const pictureUrls = extractAll(picBlock, 'PictureURL').map(decodeEntities);
        const galleryUrl = decodeEntities(extractOne(picBlock, 'GalleryURL') || '');
        const allPics = [...new Set([galleryUrl, ...pictureUrls].filter(Boolean))];
        if (allPics.length) l.pictureUrls = allPics;
      } catch (e) {
        // Don't fail the whole pull if one item enrichment fails
        console.warn(`[ebay] enrich ${l.itemId} failed: ${e.message}`);
      }
    }));
    enriched += batch.length;
    if (enriched % 60 === 0) console.log(`[ebay] enriched ${enriched}/${all.length}`);
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

module.exports = {
  isConfigured,
  getAccessToken,
  setInventoryQty,
  getRecentOrders,
  pushStockForProduct,
  getActiveListings,
};
