// services/ebay.js — eBay Sell API client
//
// MULTI-STORE: as of Pass 2, every public method accepts an optional `store`
// argument (a brand.stores[i] object). When omitted, falls back to the primary
// store from brand config. This lets one deployment serve multiple eBay seller
// accounts (Calibre has EVBODYPARTS + Evanta Grande) using the same App credentials
// but different Auth'n'Auth tokens per seller.
//
// Env vars supported:
//   EBAY_CLIENT_ID    or  EBAY_APP_ID         — public app identifier (shared by all stores)
//   EBAY_CLIENT_SECRET or EBAY_CERT_ID        — secret key (shared by all stores)
//   EBAY_DEV_ID                               — optional, only some Trading API calls need it
//   EBAY_MARKETPLACE_ID                       — defaults to EBAY_GB
//   EBAY_SITE_ID                              — defaults to 3 (UK) for Trading API
//
// Per-store tokens come from the brand config — see lib/brand.js. Each store's
// `tokenEnv` field names the env var holding its Auth'n'Auth token.
const axios = require('axios');
const brand = require('../lib/brand');

const ENV = process.env.EBAY_ENV || 'production';
const BASE = ENV === 'production'
  ? 'https://api.ebay.com'
  : 'https://api.sandbox.ebay.com';

// Accept either naming pattern
const CLIENT_ID = process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID;
// Legacy single-token fallback (used by Razoryn). For new brands prefer per-store
// tokens defined via brand.stores[i].tokenEnv.
const REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;

// Resolve a store argument to its full brand.store object. Accepts:
//  - a store code string ('razoryn', 'evbodyparts', 'evantagrande')
//  - a store object { code, token, channelCode, ... }
//  - undefined → falls back to the brand's primary store
function resolveStore(arg) {
  if (!arg) return brand.getPrimaryStore();
  if (typeof arg === 'string') return brand.getStore(arg) || brand.getPrimaryStore();
  if (arg.code) return arg;
  return brand.getPrimaryStore();
}

// Return the Auth'n'Auth token for a given store. Each store's token is
// preloaded onto the store object at brand-import time.
function tokenFor(storeArg) {
  const s = resolveStore(storeArg);
  return s && s.token ? s.token : null;
}

function isConfigured(storeArg) {
  // For multi-store brands: configured if the chosen store has a token, plus
  // the shared App credentials (CLIENT_ID/CLIENT_SECRET). For legacy single-token
  // setups, the primary store's tokenEnv defaults to EBAY_AUTH_TOKEN.
  const t = tokenFor(storeArg);
  if (t && CLIENT_ID && CLIENT_SECRET) return true;
  // OAuth fallback (Razoryn legacy)
  return !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

let cachedToken = null;
let tokenExpiresAt = 0;

// Application token via client_credentials — for public REST APIs like the
// Commerce Taxonomy API. Needs only the App ID + Cert ID (no user consent or
// refresh token), so it works wherever Trading works. Replaces the deprecated
// Trading API category calls (GetCategorySpecifics now returns HTTP 503).
let cachedAppToken = null, appTokenExpiresAt = 0;
async function getAppToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('eBay App ID / Cert ID not set');
  if (cachedAppToken && Date.now() < appTokenExpiresAt - 60000) return cachedAppToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(`${BASE}/identity/v1/oauth2/token`,
    new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  cachedAppToken = r.data.access_token;
  appTokenExpiresAt = Date.now() + (r.data.expires_in * 1000);
  return cachedAppToken;
}
async function taxonomyGet(path) {
  const token = await getAppToken();
  return axios.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 20000 });
}

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

// Pull recent orders for a given eBay store. Tries Sell Fulfillment API first (OAuth),
// falls back to Trading API GetOrders which works with the simpler Auth'n'Auth token.
async function getRecentOrders(sinceISO, storeArg) {
  // Try OAuth-based Sell Fulfillment API first (uses shared refresh-token across stores)
  if (REFRESH_TOKEN && CLIENT_ID && CLIENT_SECRET) {
    try {
      const filter = `creationdate:[${sinceISO}..]`;
      const r = await http('GET',
        `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200`);
      const orders = r.data.orders || [];
      return orders.map(o => ({
        orderId: o.orderId,
        creationDate: o.creationDate,
        buyer: o.buyer,
        pricingSummary: o.pricingSummary,
        lineItems: o.lineItems,
      }));
    } catch (e) {
      console.warn('[ebay] Sell Fulfillment API failed, falling back to Trading API:', e.message);
    }
  }
  return getRecentOrdersTrading(sinceISO, storeArg);
}

// Trading API GetOrders — per-store token
async function getRecentOrdersTrading(sinceISO, storeArg) {
  const sinceDate = new Date(sinceISO);
  const fromDate = sinceDate.toISOString();
  const toDate = new Date().toISOString();
  const bodyInner = `
    <CreateTimeFrom>${fromDate}</CreateTimeFrom>
    <CreateTimeTo>${toDate}</CreateTimeTo>
    <OrderStatus>All</OrderStatus>
    <Pagination>
      <EntriesPerPage>100</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
    <DetailLevel>ReturnAll</DetailLevel>
    <IncludeFinalValueFee>true</IncludeFinalValueFee>`;

  const xml = await tradingCall('GetOrders', bodyInner, storeArg);
  if (xml.includes('<Ack>Failure</Ack>')) {
    const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
    throw new Error('eBay GetOrders error: ' + decodeEntities(err));
  }

  const orderBlocks = extractAll(extractOne(xml, 'OrderArray') || '', 'Order');
  const orders = [];
  for (const oXml of orderBlocks) {
    const orderId = extractOne(oXml, 'OrderID');
    const creationDate = extractOne(oXml, 'CreatedTime');
    const total = parseFloat(extractOne(oXml, 'Total') || '0');
    const subtotal = parseFloat(extractOne(oXml, 'Subtotal') || '0');
    const shippingCost = parseFloat(extractOne(extractOne(oXml, 'ShippingServiceSelected') || '', 'ShippingServiceCost') || '0');
    const buyerUserId = decodeEntities(extractOne(oXml, 'BuyerUserID') || '');
    const checkoutStatus = extractOne(extractOne(oXml, 'CheckoutStatus') || '', 'Status');

    // Shipping address — Trading API puts it under ShippingAddress
    const shipBlock = extractOne(oXml, 'ShippingAddress') || '';
    let street2Raw = decodeEntities(extractOne(shipBlock, 'Street2') || '');
    // eBay sometimes injects an anonymized buyer-email proxy (e.g. "ebayerm7qr9") in Street2.
    // Strip it before it ends up on invoices.
    if (/^ebay[a-z0-9]{4,}$/i.test(street2Raw)) street2Raw = '';
    let countryRaw = decodeEntities(extractOne(shipBlock, 'Country') || '');
    // Strip GB / UK / United Kingdom — redundant for UK customers and prints poorly.
    if (countryRaw === 'GB' || countryRaw === 'UK' || countryRaw === 'GBR' || countryRaw === 'United Kingdom') countryRaw = '';
    const shipParts = [
      decodeEntities(extractOne(shipBlock, 'Name') || ''),
      decodeEntities(extractOne(shipBlock, 'Street1') || ''),
      street2Raw,
      decodeEntities(extractOne(shipBlock, 'CityName') || ''),
      decodeEntities(extractOne(shipBlock, 'StateOrProvince') || ''),
      decodeEntities(extractOne(shipBlock, 'PostalCode') || ''),
      countryRaw,
    ].filter(Boolean);
    const shippingAddress = shipParts.length ? shipParts.join('\n') : null;
    const buyerName = decodeEntities(extractOne(shipBlock, 'Name') || '') || buyerUserId || null;
    const buyerEmail = decodeEntities(extractOne(oXml, 'Email') || '') || null;
    const buyerPhone = decodeEntities(extractOne(shipBlock, 'Phone') || '') || null;

    // Transactions (line items)
    const txArray = extractOne(oXml, 'TransactionArray') || '';
    const txBlocks = extractAll(txArray, 'Transaction');
    const lineItems = txBlocks.map(tx => {
      const item = extractOne(tx, 'Item') || '';
      return {
        lineItemId: extractOne(tx, 'TransactionID'),
        sku: decodeEntities(extractOne(item, 'SKU') || ''),
        title: decodeEntities(extractOne(item, 'Title') || ''),
        quantity: parseInt(extractOne(tx, 'QuantityPurchased') || '1'),
        lineItemCost: {
          value: extractOne(tx, 'TransactionPrice') || '0',
          currency: 'GBP',
        },
      };
    });

    orders.push({
      orderId,
      creationDate,
      buyer: { username: buyerUserId || null, name: buyerName, email: buyerEmail, phone: buyerPhone },
      shippingAddress,
      pricingSummary: {
        priceSubtotal: { value: subtotal },
        total: { value: total },
        deliveryCost: { value: shippingCost },
        tax: { value: 0 },
      },
      lineItems,
      checkoutStatus,
    });
  }
  return orders;
}

async function pushStockForProduct(product) {
  if (!product.sku) return { skipped: 'no_sku' };
  // Route through the warehouse DB → mirror_links to find this product's eBay
  // ItemID(s) + store, then push via ReviseInventoryStatus (Trading API) which
  // works for legacy listings. Falls back to the Inventory-API SKU update only
  // if no mirror link exists (e.g. inventory-model listings).
  let links = [];
  try {
    const { query } = require('../db');
    const r = await query(
      `SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`,
      [product.shopify_product_id]
    );
    links = r.rows;
  } catch (e) { /* db unavailable — fall through to SKU path */ }

  if (links.length) {
    const results = [];
    for (const link of links) {
      const store = link.store_code || undefined;
      try {
        await setQuantityTradingAPI(link.ebay_item_id, product.qty_on_hand, store);
        results.push({ itemId: link.ebay_item_id, store, ok: true });
      } catch (e) {
        results.push({ itemId: link.ebay_item_id, store, error: e.message });
      }
    }
    return { ok: true, via: 'ReviseInventoryStatus', results };
  }

  // No mirror link — try the Inventory API SKU update as a last resort.
  try {
    await setInventoryQty(product.sku, product.qty_on_hand);
    return { ok: true, via: 'inventory_api' };
  } catch (e) {
    return { error: e.message };
  }
}

// setQuantityTradingAPI — update a listing's available quantity using the
// Trading API ReviseInventoryStatus call. This is the correct path for
// Calibre's listings, which are legacy Trading-API listings NOT migrated to
// the eBay Inventory (Sell) API. The Inventory-API bulk_update used by
// setInventoryQty() silently no-ops for these listings because they don't
// exist in the inventory model — which is why quantities never propagated.
//
// ReviseInventoryStatus is the lightweight quantity/price-only revise call:
// it doesn't count as heavily against revision limits and can update up to 4
// items per call. We update by ItemID (looked up from mirror_links).
async function setQuantityTradingAPI(itemId, quantity, storeArg) {
  if (!isConfigured(storeArg)) throw new Error('ebay_not_configured');
  if (!itemId) throw new Error('missing_item_id');
  const qty = Math.max(0, parseInt(quantity) || 0);
  const body = `<InventoryStatus><ItemID>${escapeXml(String(itemId))}</ItemID><Quantity>${qty}</Quantity></InventoryStatus>`;
  const xml = await tradingCall('ReviseInventoryStatus', body, storeArg);
  if (xml.includes('<Ack>Failure</Ack>')) {
    const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
    throw new Error('eBay ReviseInventoryStatus error: ' + decodeEntities(err));
  }
  return { ok: true, itemId, quantity: qty, storeCode: resolveStore(storeArg)?.code };
}

// getQuantityTradingAPI — read a listing's current available quantity via
// GetItem (Trading API). Used to PULL eBay stock into the warehouse so the app
// reflects what's actually live on each store (the import only reads Shopify
// levels, so eBay-only stock like EVBODY's was never captured).
async function getQuantityTradingAPI(itemId, storeArg) {
  if (!isConfigured(storeArg)) throw new Error('ebay_not_configured');
  if (!itemId) throw new Error('missing_item_id');
  const xml = await tradingCall('GetItem',
    `<ItemID>${escapeXml(String(itemId))}</ItemID><DetailLevel>ReturnAll</DetailLevel>`, storeArg);
  if (xml.includes('<Ack>Failure</Ack>')) {
    const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
    throw new Error('eBay GetItem error: ' + decodeEntities(err));
  }
  // Available = Quantity - QuantitySold
  const qty = parseInt(extractOne(xml, 'Quantity') || '0') || 0;
  const sold = parseInt(extractOne(xml, 'QuantitySold') || '0') || 0;
  return Math.max(0, qty - sold);
}

// ---------- Trading API (XML) — needed for GetMyeBaySelling ----------
// The newer Sell APIs only return listings migrated to the inventory model,
// which most legacy listings aren't. Trading API works for everything.
const TRADING_BASE = ENV === 'production'
  ? 'https://api.ebay.com/ws/api.dll'
  : 'https://api.sandbox.ebay.com/ws/api.dll';

async function tradingCall(callName, bodyInner, storeArg) {
  // Two auth options for Trading API:
  //  A. Auth'n'Auth token (legacy User Token) → uses Dev/App/Cert headers
  //     + <RequesterCredentials><eBayAuthToken> in body. Simpler, works without
  //     OAuth scope dance. Tokens last ~18 months. PER-STORE.
  //  B. OAuth IAF token via refresh-token flow → modern, uses X-EBAY-API-IAF-TOKEN
  //     header. Requires `https://api.ebay.com/oauth/api_scope` granted.
  //     Currently shared across stores (one refresh token in env).
  const authToken = tokenFor(storeArg);
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
    const storeCode = resolveStore(storeArg)?.code || 'default';
    let detail = `Trading API ${callName} failed [store=${storeCode}]`;
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

// Pull all active eBay listings (paginated) for a given store.
//
// Photo enrichment: by default this is OFF. Setting it on triggers a separate
// GetItem call per listing to retrieve the full picture set (GetMyeBaySelling
// only returns one gallery image). This was previously always-on, causing
// thousands of GetItem calls per scan (≈ one per active listing × stores)
// and rapidly exhausting the 5,000/day GetItem quota.
//
// Only set enrichPhotos=true when you actually need the photos (e.g. pulling
// listings into Shopify with full image sets). For force-match, hydrate,
// SKU diff, etc. — leave it off.
async function getActiveListings(storeArg, opts = {}) {
  const { enrichPhotos = false } = opts;
  if (!isConfigured(storeArg)) return [];
  const store = resolveStore(storeArg);
  const all = [];
  const seenItemIds = new Set();
  let page = 1;
  const perPage = 200;
  while (page < 50) {
    const xml = await tradingCall('GetMyeBaySelling', `
      <ActiveList>
        <Include>true</Include>
        <Pagination>
          <EntriesPerPage>${perPage}</EntriesPerPage>
          <PageNumber>${page}</PageNumber>
        </Pagination>
      </ActiveList>`, storeArg);

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
      // Quantity available = Quantity - QuantitySold
      const quantityListed = parseInt(extractOne(itemXml, 'Quantity') || '1');
      const sellingStatus = extractOne(itemXml, 'SellingStatus') || '';
      const quantitySold = parseInt(extractOne(sellingStatus, 'QuantitySold') || '0');
      const quantityAvailable = Math.max(0, quantityListed - quantitySold);
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
        quantityAvailable,
        quantitySold,
        pictureUrls: allPics,
        viewItemURL: decodeEntities(extractOne(itemXml, 'ViewItemURL') || ''),
        storeCode: store.code,
        storeName: store.name,
      });
    }

    // PaginationResult lives inside ActiveList — read it from the scoped block
    const totalPages = parseInt(extractOne(activeListBlock, 'TotalNumberOfPages') || '1');
    if (page >= totalPages) break;
    page++;
  }

  // Step 2 (OPT-IN): GetMyeBaySelling only returns the GalleryURL (1 photo) and
  // sometimes omits photos entirely. When the caller asks for it, enrich every
  // listing with a separate GetItem call to get the full picture set.
  //
  // This is gated behind opts.enrichPhotos because it makes ONE GetItem call
  // per active listing — easily 1,000+ calls per scan across two stores —
  // which used to burn through the 5,000/day GetItem quota in just a few scans.
  // Only the Shopify-cross-listing flow actually needs photos; everything else
  // (force-match, hydrate, sku-mismatches) only needs SKU + title + price.
  if (enrichPhotos) {
    const concurrency = 6;
    let enriched = 0;
    for (let i = 0; i < all.length; i += concurrency) {
      const batch = all.slice(i, i + concurrency);
      await Promise.all(batch.map(async (l) => {
        try {
          const itemXml = await tradingCall('GetItem', `<ItemID>${l.itemId}</ItemID><IncludeItemSpecifics>false</IncludeItemSpecifics>`, storeArg);
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

// ReviseItem — push a SKU and/or title change back to eBay.
// Risks: revision counts toward eBay's per-listing limit; major changes may affect search ranking;
// ReviseItem — push SKU, title, and/or price change back to eBay.
// Risks: revision counts toward eBay's per-listing limit; major changes may affect search ranking;
// some listings can't be revised (e.g. with bids). Use sparingly, with explicit user confirm.
async function reviseItem(itemId, { sku, title, price } = {}, storeArg) {
  if (!isConfigured(storeArg)) throw new Error('ebay_not_configured');
  if (!itemId) throw new Error('missing_item_id');
  if (sku == null && title == null && price == null) return { skipped: true };

  const fields = [`<ItemID>${itemId}</ItemID>`];
  if (title) fields.push(`<Title>${escapeXml(title)}</Title>`);
  if (sku) fields.push(`<SKU>${escapeXml(sku)}</SKU>`);
  if (price != null) {
    // For fixed-price listings — eBay rejects StartPrice changes on auctions with bids.
    const formatted = Number(price).toFixed(2);
    fields.push(`<StartPrice currencyID="GBP">${formatted}</StartPrice>`);
  }
  const body = `<Item>${fields.join('')}</Item>`;

  const xml = await tradingCall('ReviseItem', body, storeArg);
  if (xml.includes('<Ack>Failure</Ack>')) {
    const err = extractOne(xml, 'LongMessage') || extractOne(xml, 'ShortMessage') || 'unknown';
    throw new Error('eBay ReviseItem error: ' + decodeEntities(err));
  }
  return { ok: true, itemId, storeCode: resolveStore(storeArg)?.code };
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ----- eBay Returns (Post-Order API) -----
// The Trading API does NOT expose return cases. They live in the Post-Order Returns API.
// Even with Auth'n'Auth, the Post-Order API accepts the legacy token via
// "Authorization: TOKEN <auth-token>" — no OAuth dance needed for read-only.
async function getOpenReturns(storeArg) {
  const authToken = tokenFor(storeArg);
  if (!authToken) throw new Error('No Auth\'n\'Auth token configured for this store');
  const axios = require('axios');
  const marketplace = process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB';
  const url = 'https://api.ebay.com/post-order/v2/return/search'
            + '?filter=role:{SELLER},sellerInquiryStage:{INQUIRY_PROCESSING},returnCountFilter:{ALL_RETURNS}'
            + '&limit=50';
  try {
    const r = await axios.get(url, {
      headers: {
        'Authorization': `TOKEN ${authToken}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) {
      console.warn('[ebay returns] Post-Order needs OAuth; falling back to GetUserCases');
      return getUserCasesViaTrading(storeArg);
    }
    throw e;
  }
}

// Same as above but with broader filter — used for "show all returns" view.
// Per-store; the eBay Post-Order API is scoped to whichever seller's token you use.
async function getAllRecentReturns(days = 90, storeArg) {
  const authToken = tokenFor(storeArg);
  if (!authToken) throw new Error('No Auth\'n\'Auth token configured for this store');
  const axios = require('axios');
  const marketplace = process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB';
  const fromDate = new Date(Date.now() - days * 86400000).toISOString();
  const url = 'https://api.ebay.com/post-order/v2/return/search'
            + `?filter=role:{SELLER},creation_date:[${fromDate}..]&limit=100`;
  try {
    const r = await axios.get(url, {
      headers: {
        'Authorization': `TOKEN ${authToken}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    return r.data;
  } catch (e) {
    if (e.response) {
      const data = typeof e.response.data === 'string' ? e.response.data.slice(0, 300) : JSON.stringify(e.response.data).slice(0, 300);
      const err = new Error(`Post-Order API ${e.response.status}: ${data}`);
      err.status = e.response.status;
      err.detail = e.response.data;
      throw err;
    }
    throw e;
  }
}

async function getUserCasesViaTrading(storeArg) {
  const bodyInner = `
    <CaseStatusFilter>OpenedCases</CaseStatusFilter>
    <CaseTypeFilter>RequestReturn</CaseTypeFilter>
    <ItemFilter><DateFilter>LastThirtyDays</DateFilter></ItemFilter>
    <DetailLevel>ReturnAll</DetailLevel>`;
  try {
    const xml = await tradingCall('GetUserCases', bodyInner, storeArg);
    return { source: 'trading_getusercases', xml };
  } catch (e) {
    console.warn('[ebay returns] GetUserCases failed:', e.message);
    return { source: 'unavailable', error: e.message };
  }
}

// Single-order detail via Trading-API GetOrders with a specific OrderID filter.
async function getOrderDetail(orderId, storeArg) {
  const bodyInner = `
    <OrderIDArray><OrderID>${orderId}</OrderID></OrderIDArray>
    <DetailLevel>ReturnAll</DetailLevel>
    <IncludeFinalValueFee>true</IncludeFinalValueFee>`;
  const xml = await tradingCall('GetOrders', bodyInner, storeArg);
  return xml;
}

// Returns raw XML for debugging — sanitises auth token from output.
async function dumpOrderXml(orderId, days, storeArg) {
  let xml;
  if (orderId) {
    xml = await getOrderDetail(orderId, storeArg);
  } else {
    const sinceISO = new Date(Date.now() - (parseInt(days || 7) * 86400000)).toISOString();
    const bodyInner = `
      <CreateTimeFrom>${sinceISO}</CreateTimeFrom>
      <CreateTimeTo>${new Date().toISOString()}</CreateTimeTo>
      <OrderStatus>All</OrderStatus>
      <Pagination><EntriesPerPage>3</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
      <DetailLevel>ReturnAll</DetailLevel>`;
    xml = await tradingCall('GetOrders', bodyInner, storeArg);
  }
  return xml.replace(/<eBayAuthToken>[^<]*<\/eBayAuthToken>/g, '<eBayAuthToken>***REDACTED***</eBayAuthToken>');
}

// ──────────────────────────────────────────────────────────────────────────
// CompleteSale — push tracking info back to eBay so the buyer sees the
// "marked as shipped" notification + carrier/tracking link inside eBay.
//
// Called by routes/dispatch.js after staff marks an order dispatched locally.
// Uses the Trading API CompleteSale call (well-supported, accepts Auth'n'Auth
// per-store tokens, simpler than the modern Fulfillment API for this case).
//
// `opts`:
//   orderId         — the eBay OrderID from sale.external_order_id
//   trackingNumber  — tracking number (optional — eBay still accepts "shipped"
//                     with no tracking, useful for collection couriers)
//   carrier         — our internal carrier name (e.g. "DPD"); mapped below
//   shipped         — boolean, default true. Set false to *unmark* shipped.
//
// "Already shipped" errors from eBay (error code 16500) are treated as success
// — the goal state matches, no point bothering the user.
// ──────────────────────────────────────────────────────────────────────────
async function completeSale(storeArg, opts = {}) {
  const { orderId, trackingNumber, carrier, shipped = true } = opts;
  if (!orderId) throw new Error('orderId required');

  // Map our internal carrier name → eBay's ShippingCarrierUsed enum value.
  // eBay is fairly permissive (accepts arbitrary strings), but standard names
  // unlock the buyer-facing "track parcel" link inside the eBay app.
  // Notably: eBay still uses "Hermes" (the old name); Evri may not be recognised
  // for tracking-link generation, so we map it back to Hermes for eBay only.
  const carrierMap = {
    'Royal Mail':            'Royal Mail',
    'Parcelforce':           'Parcelforce',
    'DPD':                   'DPD',
    'Evri':                  'Hermes',                  // eBay still uses Hermes
    'UPS':                   'UPS',
    'DHL':                   'DHL',
    'FedEx':                 'FedEx',
    'Tuffnells':             'Tuffnells',
    'Yodel':                 'Yodel',
    'APC Overnight':         'APC Overnight',
    'Other / custom courier': 'Other',
    'Already shipped (channel)': null,  // shouldn't get here — dispatch route filters this
  };
  const ebayCarrier = (carrierMap[carrier] !== undefined ? carrierMap[carrier] : carrier) || 'Other';

  // Build the Shipment block only if we have something to ship with. eBay
  // accepts Shipped=true with no Shipment node (just marks as posted, no
  // tracking shown), which is the right behaviour for "I posted it via the
  // local Post Office and didn't get a tracking number" cases.
  let shipmentXml = '';
  if (trackingNumber && shipped) {
    shipmentXml = `<Shipment>
      <ShipmentTrackingDetails>
        <ShipmentTrackingNumber>${escapeXml(trackingNumber)}</ShipmentTrackingNumber>
        <ShippingCarrierUsed>${escapeXml(ebayCarrier)}</ShippingCarrierUsed>
      </ShipmentTrackingDetails>
    </Shipment>`;
  }

  const bodyInner = `<OrderID>${escapeXml(orderId)}</OrderID>
    <Shipped>${shipped ? 'true' : 'false'}</Shipped>
    ${shipmentXml}`;

  let xml;
  try {
    xml = await tradingCall('CompleteSale', bodyInner, storeArg);
  } catch (e) {
    // tradingCall surfaces HTTP errors. Parse the XML body if present to
    // distinguish "already shipped" (16500) from genuine failures.
    const body = e.response?.data || '';
    if (typeof body === 'string' && body.includes('16500')) {
      return { ok: true, alreadyShipped: true };
    }
    throw e;
  }

  // Even with HTTP 200, CompleteSale can return Failure inside the XML.
  // Look for <Ack>Failure</Ack> and the error code.
  const ack = extractOne(xml, 'Ack') || '';
  if (ack === 'Success' || ack === 'Warning') {
    return { ok: true, ack };
  }
  // Failure path — extract error details
  const errCode = extractOne(xml, 'ErrorCode') || 'unknown';
  const errMsg  = extractOne(xml, 'ShortMessage') || extractOne(xml, 'LongMessage') || 'eBay returned Failure';
  // 16500 = "Order already shipped" — treat as success since goal state matches
  if (errCode === '16500') return { ok: true, alreadyShipped: true };
  throw new Error(`CompleteSale ${ack} [${errCode}]: ${errMsg}`);
}

// ──────────────────────────────────────────────────────────────────────────
// addItem — create a new fixed-price listing on eBay using the Trading API
// AddItem call. Uses per-store Auth'n'Auth tokens so it works for both
// Razoryn (OAuth fallback) and Calibre's two stores.
//
// `opts`:
//   sku              — required, the SKU to set on the eBay listing
//   title            — required, eBay limits to 80 characters; we truncate
//   description      — HTML or plain text, shown in the listing body
//   categoryId       — required, eBay PrimaryCategory ID (numeric string)
//   conditionId      — required: 1000=New, 1500=New other, 3000=Used, etc.
//   price            — listing price (number)
//   quantity         — stock to list (integer)
//   currency         — defaults to GBP
//   imageUrls        — array of public image URLs; eBay scrapes them
//   businessPolicies — { paymentId, shippingId, returnId }
//   location         — { country: 'GB', postalCode, city }
//   itemSpecifics    — array of { name, value } pairs (Brand, MPN, etc.)
//   brand            — optional convenience param, auto-adds to itemSpecifics
//   mpn              — optional, auto-adds Manufacturer Part Number specific
//
// Returns: { ok: true, itemId, fees? } on success
// ──────────────────────────────────────────────────────────────────────────
async function addItem(storeArg, opts = {}) {
  const {
    sku, title, description = '', categoryId, conditionId = 1000,
    price, quantity = 1, currency = 'GBP',
    imageUrls = [], businessPolicies = {}, location = {},
    itemSpecifics = [], brand, mpn,
    // Optional extras — each only added to the XML when supplied, so existing
    // listings (which pass none of these) build exactly as before.
    storeCategoryId = null,   // eBay shop/store category (Storefront)
    vatPercent = null,        // VAT percent charged on the item (e.g. 20)
    // verify=true runs VerifyAddItem instead of AddItem: same validation +
    // fee preview, but creates NO live listing. eBay's Trading API has no
    // Seller-Hub "draft" concept, so this is the safe dry-run equivalent.
    verify = false,
  } = opts;

  if (!sku)        throw new Error('sku required');
  if (!title)      throw new Error('title required');
  if (!categoryId) throw new Error('categoryId required');
  if (price == null || isNaN(parseFloat(price))) throw new Error('valid price required');

  // eBay title limit is 80 characters. Truncate cleanly at a word boundary
  // if possible, else hard-cut.
  let cleanTitle = String(title).replace(/\s+/g, ' ').trim();
  if (cleanTitle.length > 80) {
    const truncated = cleanTitle.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    cleanTitle = lastSpace > 60 ? truncated.slice(0, lastSpace) : truncated;
  }

  // Auto-add Brand and MPN to item specifics if supplied separately, dedupe
  // by name so the user-provided list wins. A specific's value may be a single
  // string OR an array of strings (multi-value aspects like "Placement on
  // Vehicle" — e.g. ["Front","Left"]). Stored as arrays internally.
  const specsByName = new Map();
  for (const s of itemSpecifics) {
    if (!s.name || s.value == null) continue;
    const vals = (Array.isArray(s.value) ? s.value : [s.value])
      .map(v => String(v).trim()).filter(Boolean);
    if (vals.length) specsByName.set(s.name, vals);
  }
  if (brand && !specsByName.has('Brand')) specsByName.set('Brand', [String(brand)]);
  if (mpn   && !specsByName.has('Manufacturer Part Number')) specsByName.set('Manufacturer Part Number', [String(mpn)]);

  // Build ItemSpecifics XML — required for most parts/accessories categories.
  // Multi-value aspects emit several <Value> elements under one <NameValueList>.
  const itemSpecificsXml = specsByName.size > 0
    ? `<ItemSpecifics>${[...specsByName.entries()].map(([name, values]) =>
        `<NameValueList><Name>${escapeXml(name)}</Name>${
          values.map(v => `<Value>${escapeXml(v)}</Value>`).join('')
        }</NameValueList>`
      ).join('')}</ItemSpecifics>`
    : '';

  // PictureDetails — eBay-hosted images. Using PictureURL with public URLs is
  // the simplest path: eBay fetches and hosts them. Max 12 URLs.
  const pictureXml = imageUrls.length
    ? `<PictureDetails>${imageUrls.slice(0, 12).map(u => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('')}</PictureDetails>`
    : '';

  // Business policy IDs — eBay strongly recommends these over inline shipping
  // / payment / return blocks. If the seller hasn't enabled business policies,
  // the call returns an error code and the user can re-run with inline blocks.
  const policiesXml = (businessPolicies.paymentId || businessPolicies.shippingId || businessPolicies.returnId)
    ? `<SellerProfiles>
         ${businessPolicies.paymentId  ? `<SellerPaymentProfile><PaymentProfileID>${escapeXml(businessPolicies.paymentId)}</PaymentProfileID></SellerPaymentProfile>` : ''}
         ${businessPolicies.shippingId ? `<SellerShippingProfile><ShippingProfileID>${escapeXml(businessPolicies.shippingId)}</ShippingProfileID></SellerShippingProfile>` : ''}
         ${businessPolicies.returnId   ? `<SellerReturnProfile><ReturnProfileID>${escapeXml(businessPolicies.returnId)}</ReturnProfileID></SellerReturnProfile>` : ''}
       </SellerProfiles>`
    : '';

  const country    = location.country || 'GB';
  const postalCode = location.postalCode || '';
  const city       = location.city || '';

  // eBay shop/store category — places the listing into the seller's custom
  // storefront category. Only emitted when a category was chosen.
  const storefrontXml = storeCategoryId
    ? `<Storefront><StoreCategoryID>${escapeXml(storeCategoryId)}</StoreCategoryID></Storefront>`
    : '';

  // VAT — charge a VAT percentage on the item (business sellers). Only emitted
  // when a positive percent is supplied; eBay shows it as VAT-inclusive pricing.
  const vatNum = vatPercent != null ? parseFloat(vatPercent) : NaN;
  const vatXml = (!isNaN(vatNum) && vatNum > 0)
    ? `<VATDetails><VATPercent>${vatNum.toFixed(1)}</VATPercent></VATDetails>`
    : '';

  // AddItem XML body. ListingDuration GTC = Good Till Cancelled, the standard
  // for fixed-price listings. DispatchTimeMax=1 means we ship within 1 business day.
  const bodyInner = `
    <Item>
      <Title>${escapeXml(cleanTitle)}</Title>
      <Description><![CDATA[${description || cleanTitle}]]></Description>
      <PrimaryCategory><CategoryID>${escapeXml(categoryId)}</CategoryID></PrimaryCategory>
      <StartPrice currencyID="${escapeXml(currency)}">${parseFloat(price).toFixed(2)}</StartPrice>
      <Quantity>${parseInt(quantity) || 1}</Quantity>
      <SKU>${escapeXml(sku)}</SKU>
      <ConditionID>${parseInt(conditionId) || 1000}</ConditionID>
      <Country>${escapeXml(country)}</Country>
      <Currency>${escapeXml(currency)}</Currency>
      ${postalCode ? `<PostalCode>${escapeXml(postalCode)}</PostalCode>` : ''}
      ${city ? `<Location>${escapeXml(city)}</Location>` : ''}
      <ListingType>FixedPriceItem</ListingType>
      <ListingDuration>GTC</ListingDuration>
      <DispatchTimeMax>1</DispatchTimeMax>
      ${pictureXml}
      ${itemSpecificsXml}
      ${storefrontXml}
      ${vatXml}
      ${policiesXml}
    </Item>`;

  const callName = verify ? 'VerifyAddItem' : 'AddItem';
  let xml;
  try {
    xml = await tradingCall(callName, bodyInner, storeArg);
  } catch (e) {
    const body = e.response?.data || '';
    throw new Error(`${callName} HTTP error: ${e.message}${typeof body === 'string' && body.includes('<ShortMessage>') ? ' / ' + (body.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] || '') : ''}`);
  }

  const ack = extractOne(xml, 'Ack') || '';
  if (ack === 'Success' || ack === 'Warning') {
    const itemId = extractOne(xml, 'ItemID');
    // VerifyAddItem returns no real ItemID (it's a validation), but does return fees.
    return { ok: true, verified: verify, ack, itemId: verify ? null : itemId, fees: extractOne(xml, 'Fee') };
  }
  // Failure — return the most useful error code + message
  const errCode = extractOne(xml, 'ErrorCode') || 'unknown';
  const errMsg  = extractOne(xml, 'ShortMessage') || extractOne(xml, 'LongMessage') || 'eBay returned Failure';
  throw new Error(`${callName} ${ack} [${errCode}]: ${errMsg}`);
}

// ---------- eBay shop/store categories ----------
// Fetch the seller's custom storefront categories via the Trading API GetStore
// call, so the listing UI can offer a "Shop category" dropdown. Returns a flat
// list of { id, name } (top-level + nested categories), best-effort.
async function getStoreCategories(storeArg) {
  let xml;
  try {
    xml = await tradingCall('GetStore', `<CategoryStructureOnly>true</CategoryStructureOnly>`, storeArg);
  } catch (e) {
    throw new Error('GetStore failed: ' + e.message);
  }
  const ack = extractOne(xml, 'Ack') || '';
  if (ack !== 'Success' && ack !== 'Warning') {
    const msg = extractOne(xml, 'ShortMessage') || extractOne(xml, 'LongMessage') || 'GetStore returned Failure';
    throw new Error(msg);
  }
  // CustomCategory blocks can be nested; rather than parse the tree, pull every
  // (CategoryID, Name) pair regardless of element order. ID 0 is the store root
  // ("Other") — keep it out of the picker.
  const found = new Map();
  const add = (id, name) => {
    const cid = String(id).trim();
    if (cid && cid !== '0' && !found.has(cid)) found.set(cid, decodeEntities(String(name).trim()));
  };
  let m;
  const reA = /<CategoryID>(\d+)<\/CategoryID>\s*<Name>([^<]+)<\/Name>/g;
  while ((m = reA.exec(xml)) !== null) add(m[1], m[2]);
  const reB = /<Name>([^<]+)<\/Name>\s*<CategoryID>(\d+)<\/CategoryID>/g;
  while ((m = reB.exec(xml)) !== null) add(m[2], m[1]);
  return [...found.entries()].map(([id, name]) => ({ id, name }));
}

// ---------- Promoted Listings (General) ----------
// Promoted Listings General (formerly "Standard") uses the Marketing API and a
// separate OAuth scope (sell.marketing) that the SHARED token deliberately does
// NOT request — adding it there could break every eBay call if the refresh
// token isn't consented for it. So promotion uses its own isolated token: if
// the scope isn't granted the promotion step fails on its own and listing
// creation is unaffected.
let _mktToken = null, _mktExpiresAt = 0;
async function getMarketingToken() {
  if (_mktToken && Date.now() < _mktExpiresAt - 60_000) return _mktToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(
    `${BASE}/identity/v1/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.marketing',
    }),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  _mktToken = r.data.access_token;
  _mktExpiresAt = Date.now() + (r.data.expires_in * 1000);
  return _mktToken;
}

// Turn an axios error from an eBay REST (Sell) call into a readable message,
// pulling out eBay's structured error array (errorId / message / longMessage /
// parameters) so callers surface the real reason instead of "status code 400".
function ebayRestError(e, label) {
  const data = e.response?.data;
  const errs = data?.errors || data?.warnings;
  if (Array.isArray(errs) && errs.length) {
    const parts = errs.map(x => {
      const params = (x.parameters || []).map(p => `${p.name}=${p.value}`).join(', ');
      return `[${x.errorId}] ${x.longMessage || x.message}${params ? ` (${params})` : ''}`;
    });
    return new Error(`${label}: ${parts.join(' | ')}`);
  }
  const status = e.response?.status;
  return new Error(`${label}: ${status ? 'HTTP ' + status + ' — ' : ''}${e.message}`);
}

async function marketingApi(method, path, data) {
  const token = await getMarketingToken();
  return axios({
    method, url: `${BASE}${path}`, data,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-GB',
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB',
    },
    timeout: 30000,
  });
}

// Find (or create) a reusable "Promoted Listings General" campaign for this
// marketplace, returning its campaignId. eBay General uses the COST_PER_SALE
// funding model (you pay an ad fee only when the item sells).
const GENERAL_CAMPAIGN_NAME = 'General Promotion';
async function ensureGeneralCampaign() {
  const mkt = process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB';
  // Look for an existing COST_PER_SALE campaign we can reuse.
  try {
    const r = await marketingApi('get', `/sell/marketing/v1/ad_campaign?limit=100`);
    const campaigns = r.data?.campaigns || [];
    const usable = campaigns.filter(c =>
      c.fundingStrategy?.fundingModel === 'COST_PER_SALE' && c.campaignStatus !== 'ENDED');
    const match = usable.find(c => c.campaignName?.startsWith(GENERAL_CAMPAIGN_NAME)) || usable[0];
    if (match) return match.campaignId;
  } catch (e) {
    throw ebayRestError(e, 'list campaigns failed');
  }

  // Create a new General campaign. eBay requires the startDate to be in the
  // future, so we nudge it ~1 minute ahead to avoid "must be in the future".
  const body = {
    campaignName: `${GENERAL_CAMPAIGN_NAME} ${new Date().toISOString().slice(0, 10)}`,
    fundingStrategy: { fundingModel: 'COST_PER_SALE' },
    marketplaceId: mkt,
    startDate: new Date(Date.now() + 60_000).toISOString(),
  };
  let cr;
  try {
    cr = await marketingApi('post', `/sell/marketing/v1/ad_campaign`, body);
  } catch (e) {
    throw ebayRestError(e, 'create campaign failed');
  }
  // 201 returns the new campaign URL in the Location header; the id is its tail.
  const loc = cr.headers?.location || cr.headers?.Location || '';
  const id = loc.split('/').pop();
  if (id) return id;
  // Fallback: re-list and grab the newest COST_PER_SALE campaign.
  const r2 = await marketingApi('get', `/sell/marketing/v1/ad_campaign?limit=100`);
  const c2 = (r2.data?.campaigns || []).find(c => c.fundingStrategy?.fundingModel === 'COST_PER_SALE');
  if (!c2) throw new Error('campaign created but could not resolve campaignId');
  return c2.campaignId;
}

// Promote a freshly-created listing with Promoted Listings General at the given
// ad rate (%). Best-effort and fully isolated — callers should treat a thrown
// error as "listing is live but not promoted" rather than a hard failure.
//   bidPercent: e.g. 10 → "10.0" ad rate.
async function promoteListing(storeArg, { itemId, bidPercent }) {
  if (!itemId) throw new Error('itemId required');
  const pct = parseFloat(bidPercent);
  if (isNaN(pct) || pct < 2) throw new Error('ad rate must be at least 2%');
  const campaignId = await ensureGeneralCampaign();
  const body = { requests: [{ listingId: String(itemId), bidPercentage: pct.toFixed(1) }] };
  let r;
  try {
    r = await marketingApi('post',
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/bulk_create_ads_by_listing_id`, body);
  } catch (e) {
    throw ebayRestError(e, 'create ad failed');
  }
  const resp = (r.data?.responses || [])[0] || {};
  // Per-item failures come back in the 200 body with a statusCode + errors.
  if (resp.statusCode && resp.statusCode >= 400) {
    const msg = (resp.errors || []).map(e => `[${e.errorId}] ${e.message}`).join('; ') || `ad creation failed (${resp.statusCode})`;
    throw new Error(msg);
  }
  return { ok: true, campaignId, adId: resp.adId || null, bidPercent: pct };
}

// List the seller's eBay business policies (payment / fulfillment[shipping] /
// return) via the REST Account API, so the listing UI can offer dropdowns.
// Uses the shared OAuth token (scope sell.account.readonly), so it returns the
// OAuth-linked account's policies (the primary store). marketplace defaults to
// EBAY_GB. Each list is best-effort — a failure on one returns [] for it.
async function getBusinessPolicies(marketplaceId = "EBAY_GB", storeArg) {
  // Primary: Trading API GetUserPreferences — works with the per-store
  // Auth'n'Auth token (the REST Account API needs OAuth, which isn't set up
  // for Calibre, so it returned nothing). Falls back to REST if a refresh token
  // exists (Razoryn).
  const payment = [], shipping = [], returns = [];
  try {
    const xml = await tradingCall("GetUserPreferences",
      "<ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>", storeArg);
    for (const block of extractAll(xml, "SupportedSellerProfile")) {
      const id = extractOne(block, "ProfileID");
      const name = decodeEntities(extractOne(block, "ProfileName") || "");
      const type = (extractOne(block, "ProfileType") || "").toUpperCase();
      if (!id) continue;
      const entry = { id, name: name || id };
      if (type.includes("PAYMENT")) payment.push(entry);
      else if (type.includes("RETURN")) returns.push(entry);
      else if (type.includes("SHIPPING")) shipping.push(entry);
    }
    if (payment.length || shipping.length || returns.length) {
      return { payment, shipping, return: returns };
    }
  } catch (e) {
    console.warn("[ebay] GetUserPreferences profiles failed:", e.message);
  }
  // REST fallback (OAuth refresh token).
  if (REFRESH_TOKEN && CLIENT_ID && CLIENT_SECRET) {
    try {
      const token = await getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      const params = { marketplace_id: marketplaceId };
      const base = `${BASE}/sell/account/v1`;
      const fetchList = async (path, listKey, idKey) => {
        const r = await axios.get(`${base}/${path}`, { headers, params, timeout: 20000 });
        return (r.data?.[listKey] || []).map(p => ({ id: p[idKey], name: p.name }));
      };
      const [p2, s2, r2] = await Promise.all([
        fetchList("payment_policy", "paymentPolicies", "paymentPolicyId").catch(() => []),
        fetchList("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId").catch(() => []),
        fetchList("return_policy", "returnPolicies", "returnPolicyId").catch(() => []),
      ]);
      return { payment: p2, shipping: s2, return: r2 };
    } catch (e) {
      console.warn("[ebay] REST business policies failed:", e.message);
    }
  }
  return { payment, shipping, return: returns };
}

// Diagnostic for the empty-policy-dropdown problem. Returns the raw eBay XML
// (trimmed), the auth mode used, and the parsed profiles so the cause is
// visible: Ack/Errors reveal auth issues; an empty SupportedSellerProfile list
// means the account hasn't opted into Business Policies.
async function debugBusinessPolicies(storeArg) {
  const store = resolveStore(storeArg);
  const out = {
    store: store?.code || 'default',
    hasStoreToken: !!tokenFor(storeArg),
    hasOAuthRefresh: !!(REFRESH_TOKEN && CLIENT_ID && CLIENT_SECRET),
    raw: null, ack: null, errors: [], parsed: null,
  };
  try {
    const xml = await tradingCall('GetUserPreferences',
      '<ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>', storeArg);
    out.raw = String(xml).slice(0, 4000);
    out.ack = extractOne(xml, 'Ack');
    for (const errBlock of extractAll(xml, 'Errors')) {
      out.errors.push({
        code: extractOne(errBlock, 'ErrorCode'),
        shortMessage: decodeEntities(extractOne(errBlock, 'ShortMessage') || ''),
        longMessage: decodeEntities(extractOne(errBlock, 'LongMessage') || ''),
      });
    }
    out.parsed = await getBusinessPolicies('EBAY_GB', storeArg);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Auto-dispatch support: which recent orders have been shipped/fulfilled ON
// eBay (so the warehouse app can auto-mark them dispatched). Returns a Set of
// orderIds with orderFulfillmentStatus === FULFILLED. Needs the OAuth Sell
// Fulfillment API; returns an empty Set if that isn't configured.
async function getFulfilledOrderIds(sinceISO) {
  const ids = new Set();
  if (!(REFRESH_TOKEN && CLIENT_ID && CLIENT_SECRET)) return ids;
  const filter = `creationdate:[${sinceISO}..]`;
  const r = await http('GET', `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200`);
  for (const o of (r.data.orders || [])) {
    if (o.orderFulfillmentStatus === 'FULFILLED') ids.add(o.orderId);
  }
  return ids;
}

// Best-effort tracking lookup for one eBay order (called only for orders we're
// about to auto-dispatch, so the call volume stays small).
async function getOrderTracking(orderId) {
  try {
    const r = await http('GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`);
    const f = (r.data.fulfillments || [])[0];
    if (!f) return { tracking: null, carrier: null };
    return { tracking: f.shipmentTrackingNumber || null, carrier: f.shippingCarrierCode || null };
  } catch (e) {
    return { tracking: null, carrier: null };
  }
}

// Search eBay categories by NAME (not numeric ID) using the Trading API
// GetSuggestedCategories — this works with the per-store Auth'n'Auth token (the
// same one used to list items), so it doesn't depend on an OAuth setup. Returns
// the leaf name + the ancestor path so the UI can show context and flag vehicle
// parts. e.g. "grille" -> Vehicle Parts & Accessories › Car Parts › … › Grilles.
async function getSuggestedCategories(query) {
  if (!query || query.trim().length < 2) return [];
  const treeId = process.env.EBAY_CATEGORY_TREE_ID || '3'; // 3 = eBay UK
  const r = await taxonomyGet(`/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query.trim())}`);
  return (r.data?.categorySuggestions || []).map(s => {
    const anc = (s.categoryTreeNodeAncestors || []).map(a => a.categoryName).reverse();
    const leaf = s.category?.categoryName;
    return {
      id: s.category?.categoryId,
      name: leaf,
      path: [...anc, leaf].filter(Boolean).join(' › '),
      automotive: /vehicle parts|car parts|parts & accessories|automotive|vehicle/i.test([...anc, leaf].join(' ')),
    };
  }).filter(c => c.id);
}

// GetCategorySpecifics — fetch the item-specific names eBay recommends/requires
// for a category, so we can pre-validate an AddItem before submitting it (and
// surface exactly which required specifics are missing). Returns:
//   { categoryId, specifics: [{ name, required, values: [...] }] }
// `required` = the specific has MinValues >= 1 in its validation rules.
async function getCategorySpecifics(storeArg, categoryId) {
  // storeArg kept for call-site compatibility; the Taxonomy API uses the app
  // token (client_credentials), not a per-store token.
  if (!categoryId) throw new Error('categoryId required');
  const treeId = process.env.EBAY_CATEGORY_TREE_ID || '3';
  const r = await taxonomyGet(`/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(String(categoryId))}`);
  const specifics = [];
  for (const a of (r.data?.aspects || [])) {
    const name = a.localizedAspectName;
    if (!name) continue;
    specifics.push({
      name,
      required: !!a.aspectConstraint?.aspectRequired,
      values: (a.aspectValues || []).map(v => v.localizedValue).filter(Boolean),
    });
  }
  return { categoryId: String(categoryId), specifics };
}

// ──────────────────────────────────────────────────────────────────────────
// getRateLimits — query the eBay Developer Analytics API for the App's
// current API call quotas + usage. Per-app (EBAY_CLIENT_ID), not per-store.
//
// History: this used to be GetAPIAccessRules in the Trading API. eBay
// decommissioned that call on March 10, 2023. Replacement is the Developer
// Analytics REST API, which uses an OAuth client_credentials access token —
// no user token / refresh token required. Just CLIENT_ID + CLIENT_SECRET.
//
// Endpoint: GET https://api.ebay.com/developer/analytics/v1_beta/rate_limit/
// Scope:    https://api.ebay.com/oauth/api_scope
//
// Note: rate-limit fetches themselves do NOT count against the Trading API
// daily quota — they're on a separate plane — so this is safe to call even
// when you're already over the cap.
//
// Returns a flattened array shaped to match the old GetAPIAccessRules format,
// so existing callers in routes/listings.js don't need to change much.
// ──────────────────────────────────────────────────────────────────────────
let _appOAuthCache = { token: null, expiresAt: 0 };
async function getAppOAuthToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set — cannot generate app-level OAuth token');
  }
  if (_appOAuthCache.token && Date.now() < _appOAuthCache.expiresAt - 60_000) return _appOAuthCache.token;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(
    `${BASE}/identity/v1/oauth2/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    }
  );
  _appOAuthCache.token = r.data.access_token;
  _appOAuthCache.expiresAt = Date.now() + (r.data.expires_in * 1000);
  return _appOAuthCache.token;
}

async function getRateLimits(apiContext = 'tradingapi') {
  const token = await getAppOAuthToken();
  const url = `${BASE}/developer/analytics/v1_beta/rate_limit/` +
    (apiContext ? `?api_context=${encodeURIComponent(apiContext)}` : '');
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  // Response shape (verified against the live eBay Developer Analytics API on 2026-05-27):
  // { rateLimits: [{ apiContext, apiName, resources: [{ name, rates: [{ count, limit, remaining, reset, timeWindow }] }] }] }
  //
  // FIELDS (clearer than the docs):
  //   count     — calls USED so far in the current period (the "usage" counter)
  //   limit     — total calls allowed per period
  //   remaining — calls left (limit - count)
  //   reset     — ISO timestamp when the period resets
  //
  // CAVEAT: eBay sometimes returns `count: 0, remaining: 0` for unused call-names
  // (looks like a bug on their side — both should logically equal `limit` when
  // unused). To detect this, we cross-check: if count == 0 AND remaining == 0
  // AND limit > 0, treat the call as untouched (remaining = limit, count = 0).
  // This matches what we see for AddItem in real data (eBay correctly returns
  // remaining = limit there), so the inconsistency is per-call.
  const out = [];
  for (const api of (r.data?.rateLimits || [])) {
    for (const resource of (api.resources || [])) {
      const rate = (resource.rates && resource.rates[0]) || {};
      const limit = parseInt(rate.limit) || 0;
      let count = (rate.count !== undefined && rate.count !== null) ? parseInt(rate.count) : null;
      let remaining = (rate.remaining !== undefined && rate.remaining !== null) ? parseInt(rate.remaining) : null;
      // Reconcile the two: prefer `count` for usage when present
      let usage, leftover;
      if (count !== null && remaining !== null) {
        // Both present. Trust whichever is more informative.
        if (count > 0) {
          // Real usage data — trust count
          usage = count;
          leftover = Math.max(0, limit - count);
        } else if (remaining === 0 && limit > 0) {
          // count=0 AND remaining=0 — eBay's buggy "untouched" pattern.
          // Display as "no usage" rather than "100% used".
          usage = 0;
          leftover = limit;
        } else {
          usage = Math.max(0, limit - remaining);
          leftover = remaining;
        }
      } else if (count !== null) {
        usage = count;
        leftover = Math.max(0, limit - count);
      } else if (remaining !== null) {
        usage = Math.max(0, limit - remaining);
        leftover = remaining;
      } else {
        usage = 0;
        leftover = limit;
      }
      out.push({
        callName: resource.name || api.apiName || 'unknown',
        apiContext: api.apiContext,
        apiName: api.apiName,
        dailyHardLimit: limit,
        dailyUsage: usage,
        dailyRemaining: leftover,
        resetAt: rate.reset || null,
        timeWindow: parseInt(rate.timeWindow) || 0,
        _raw: rate,
      });
    }
  }
  return out;
}

// itemBelongsToStore — check whether a given eBay ItemID is a listing owned by
// the given store's account. Used to backfill store_code on legacy mirror_links
// without a full GetMyeBaySelling scan. One GetItem call per check.
//
// GetItem with a store's token returns the item if that token's account can see
// it. To confirm *ownership* (not just visibility) we compare the item's Seller
// UserID against the store. Since we don't store each store's eBay username,
// we use a simpler proxy: GetItem called with the OWNING seller's token returns
// Ack=Success AND includes the item; called with a different seller's token it
// still returns the public item (GetItem is public), so that alone isn't enough.
//
// Instead we use GetSellerList-style scoping: call GetItem and read the
// <Seller><UserID>. We cache each store's own UserID via GetUser on first use.
let _storeUserIdCache = {};
async function getStoreUserId(storeArg) {
  const store = resolveStore(storeArg);
  if (!store) return null;
  if (_storeUserIdCache[store.code] !== undefined) return _storeUserIdCache[store.code];
  try {
    const xml = await tradingCall('GetUser', '', storeArg);
    const uid = extractOne(xml, 'UserID') || null;
    _storeUserIdCache[store.code] = uid;
    return uid;
  } catch (e) {
    _storeUserIdCache[store.code] = null;
    return null;
  }
}

async function itemBelongsToStore(itemId, storeArg) {
  if (!itemId) return false;
  const myUserId = await getStoreUserId(storeArg);
  if (!myUserId) return false;
  try {
    const xml = await tradingCall('GetItem', `<ItemID>${escapeXml(String(itemId))}</ItemID><DetailLevel>ReturnAll</DetailLevel>`, storeArg);
    const ack = extractOne(xml, 'Ack') || '';
    if (ack !== 'Success' && ack !== 'Warning') return false;
    // Read the seller's UserID from the item and compare to this store's UserID
    const sellerBlock = extractOne(xml, 'Seller') || xml;
    const itemSellerId = extractOne(sellerBlock, 'UserID') || '';
    return itemSellerId && itemSellerId.toLowerCase() === myUserId.toLowerCase();
  } catch (e) {
    return false;
  }
}

module.exports = {
  isConfigured,
  getAccessToken,
  setInventoryQty,
  getRecentOrders,
  getOrderDetail,
  dumpOrderXml,
  getOpenReturns,
  getAllRecentReturns,
  pushStockForProduct,
  setQuantityTradingAPI,
  getQuantityTradingAPI,
  getActiveListings,
  reviseItem,
  completeSale,
  addItem,
  getStoreCategories,
  promoteListing,
  getCategorySpecifics,
  getSuggestedCategories,
  getBusinessPolicies,
  debugBusinessPolicies,
  getFulfilledOrderIds,
  getOrderTracking,
  getRateLimits,
  itemBelongsToStore,
  getStoreUserId,
  // Multi-store helpers
  listStores: () => brand.stores.map(s => ({ code: s.code, name: s.name, channelCode: s.channelCode, hasToken: !!s.token, primary: !!s.primary, standalone: !!s.standalone, disabled: !!s.disabled, disabledReason: s.disabledReason || null })),
  getPrimaryStore: () => brand.getPrimaryStore(),
  getStore: (code) => brand.getStore(code),
};
