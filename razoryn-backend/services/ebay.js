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
  await setInventoryQty(product.sku, product.qty_on_hand);
  return { ok: true };
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
async function getActiveListings(storeArg) {
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

  // Step 2: GetMyeBaySelling only returns the GalleryURL (1 photo) and sometimes
  // omits photos entirely. Enrich every listing with GetItem to get the full picture set.
  // Concurrency-limited to avoid hammering eBay.
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
  getActiveListings,
  reviseItem,
  // Multi-store helpers
  listStores: () => brand.stores.map(s => ({ code: s.code, name: s.name, channelCode: s.channelCode, hasToken: !!s.token, primary: !!s.primary, standalone: !!s.standalone })),
  getPrimaryStore: () => brand.getPrimaryStore(),
  getStore: (code) => brand.getStore(code),
};
