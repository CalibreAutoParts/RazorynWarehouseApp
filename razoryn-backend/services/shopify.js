// services/shopify.js — Shopify Admin API client
//
// Supports TWO auth methods (whichever is configured):
//
//   1. Client credentials OAuth (same as Calibre warehouse-sync):
//      - SHOPIFY_CLIENT_ID
//      - SHOPIFY_CLIENT_SECRET
//      Token is fetched at runtime and cached for 1 hour.
//
//   2. Static Admin API access token (legacy custom apps):
//      - SHOPIFY_ADMIN_TOKEN  (or SHOPIFY_ACCESS_TOKEN — both names work)
//
// Plus:
//   - SHOPIFY_STORE_DOMAIN  (e.g. razoryn-eparts.myshopify.com)
//   - SHOPIFY_LOCATION_ID   (warehouse location — set after first import)
//   - SHOPIFY_API_VERSION   (defaults to 2025-01)
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || null;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

function isConfigured() {
  if (!STORE) return false;
  return !!(STATIC_TOKEN || (CLIENT_ID && CLIENT_SECRET));
}

// ---------- Auth: get an access token ----------
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  // 1. Static token (custom app shpat_...) — preferred if present, no fetch needed
  if (STATIC_TOKEN) return STATIC_TOKEN;

  // 2. Cached client-credentials token still valid
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  // 3. Request a fresh token via OAuth client_credentials grant
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('shopify_not_configured: need SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_TOKEN');
  }
  const r = await axios.post(
    `https://${STORE}/admin/oauth/access_token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );
  cachedToken = r.data.access_token;
  // Cache for 1 hour (tokens last longer but refresh safely)
  cachedTokenExpiry = Date.now() + 60 * 60 * 1000;
  return cachedToken;
}

// HTTP client — token added per-request so it can refresh
async function shopifyRequest(method, path, opts = {}) {
  const token = await getAccessToken();
  const maxRetries = opts.retries != null ? opts.retries : 5;
  let attempt = 0;
  while (true) {
    try {
      return await axios({
        method,
        url: `https://${STORE}/admin/api/${VERSION}${path}`,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
        params: opts.params,
        data: opts.data,
        timeout: opts.timeout || 60000,
      });
    } catch (e) {
      // Shopify's REST bucket is shared across the app, so a burst (e.g. a stock
      // push running at the same time) can throttle other calls with 429. Back
      // off and retry, honouring Retry-After when present.
      const status = e.response?.status;
      if ((status === 429 || status === 503) && attempt < maxRetries) {
        attempt++;
        const ra = parseFloat(e.response?.headers?.['retry-after']);
        const waitMs = (!isNaN(ra) && ra > 0) ? ra * 1000 : Math.min(500 * 2 ** attempt, 8000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
}

// ---------- Public API ----------
async function getLocations() {
  if (!isConfigured()) return [];
  const r = await shopifyRequest('get', '/locations.json');
  return r.data.locations;
}

// Read the live available quantity for one inventory item at our location.
async function getInventoryLevel(inventoryItemId) {
  if (!isConfigured() || !inventoryItemId) return null;
  const params = { inventory_item_ids: inventoryItemId };
  if (LOCATION_ID) params.location_ids = LOCATION_ID;
  const r = await shopifyRequest('get', '/inventory_levels.json', { params });
  const lvl = (r.data?.inventory_levels || [])[0];
  return lvl ? parseInt(lvl.available) : null;
}

async function setInventoryLevel(inventoryItemId, qty) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  if (!LOCATION_ID) throw new Error('SHOPIFY_LOCATION_ID_not_set');
  await shopifyRequest('post', '/inventory_levels/set.json', {
    data: {
      location_id: parseInt(LOCATION_ID),
      inventory_item_id: parseInt(inventoryItemId),
      available: qty,
    },
  });
}

async function getRecentOrders(updatedAtMin) {
  if (!isConfigured()) return { orders: [] };
  const r = await shopifyRequest('get', '/orders.json', {
    params: {
      status: 'any',
      fulfillment_status: 'any',
      limit: 250,
      updated_at_min: updatedAtMin,
    },
  });
  return { orders: r.data.orders || [] };
}

// ---------- IMPORT: paginate full catalogue ----------
async function* iterateAllProductsAndVariants() {
  if (!isConfigured()) throw new Error('shopify_not_configured');

  let pageInfo = null;
  let pageCount = 0;
  while (true) {
    pageCount++;
    if (pageCount > 50) break;

    const params = pageInfo
      ? { limit: 250, page_info: pageInfo }
      : { limit: 250 };
    const r = await shopifyRequest('get', '/products.json', { params });
    const products = r.data.products || [];

    const inventoryItemIds = products
      .flatMap(p => p.variants)
      .map(v => v.inventory_item_id)
      .filter(Boolean);

    let levelsMap = {};
    if (LOCATION_ID && inventoryItemIds.length) {
      const chunks = [];
      for (let i = 0; i < inventoryItemIds.length; i += 50) {
        chunks.push(inventoryItemIds.slice(i, i + 50));
      }
      for (const chunk of chunks) {
        try {
          const lr = await shopifyRequest('get', '/inventory_levels.json', {
            params: {
              location_ids: LOCATION_ID,
              inventory_item_ids: chunk.join(','),
            },
          });
          for (const lvl of lr.data.inventory_levels || []) {
            levelsMap[lvl.inventory_item_id] = lvl.available;
          }
        } catch (e) {
          console.warn('[shopify] inventory_levels fetch failed:', e.message);
        }
      }
    }

    for (const p of products) {
      const primaryImage = (p.images && p.images[0] && p.images[0].src) || null;
      for (const v of p.variants || []) {
        yield {
          shopify_product_id: String(p.id),
          shopify_variant_id: String(v.id),
          shopify_inventory_id: v.inventory_item_id ? String(v.inventory_item_id) : null,
          // Shopify product handle — the URL slug for the storefront /products/{handle}.
          // All variants of a product share the same handle. Used by Quote Builder
          // to generate direct product links instead of search-by-SKU.
          shopify_handle: p.handle || null,
          sku: v.sku || `SHOPIFY-${v.id}`,
          title: v.title === 'Default Title' ? p.title : `${p.title} — ${v.title}`,
          brand: p.vendor || null,
          model: p.product_type || null,
          part_number: v.barcode || null,
          barcode: v.barcode || null,
          price_shopify: parseFloat(v.price) || null,
          qty_on_hand: levelsMap[v.inventory_item_id] != null
            ? parseInt(levelsMap[v.inventory_item_id])
            : 0,
          image_url: primaryImage,
        };
      }
    }

    const link = r.headers['link'] || r.headers['Link'];
    if (!link || !link.includes('rel="next"')) break;
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) break;
    const url = new URL(m[1]);
    pageInfo = url.searchParams.get('page_info');
    if (!pageInfo) break;
  }
}

async function pushStockForProduct(product) {
  if (!product.shopify_inventory_id) return { skipped: 'no_inventory_id' };
  await setInventoryLevel(product.shopify_inventory_id, product.qty_on_hand);
  return { ok: true };
}

// ---------- Listing creation (eBay → Shopify mirror) ----------

// Find a Shopify product by SKU. Returns { product_id, variant_id, inventory_item_id, image_count } or null.
async function findProductBySku(sku) {
  if (!isConfigured() || !sku) return null;
  // Shopify doesn't have a direct product search by SKU; we use the variants endpoint via GraphQL would be cleanest,
  // but to avoid GraphQL token scope, we use the products.json with a search query.
  // Most reliable: products.json?title= won't match SKU; fall back to scanning.
  // Better: use GraphQL since 2024-04 — variantBySku requires read_products.
  try {
    const query = `query($sku: String!) {
      productVariants(first: 1, query: $sku) {
        edges { node { id sku product { id title images(first: 1) { edges { node { id } } } } inventoryItem { id } } }
      }
    }`;
    const r = await shopifyRequest('post', '/graphql.json', {
      data: { query, variables: { sku: `sku:${sku}` } },
    });
    const edge = r.data.data?.productVariants?.edges?.[0];
    if (!edge) return null;
    const node = edge.node;
    if (node.sku !== sku) return null; // GraphQL returns close matches; require exact
    // Convert GIDs back to numeric
    const gid = (s) => s ? s.split('/').pop() : null;
    return {
      product_id: gid(node.product.id),
      variant_id: gid(node.id),
      inventory_item_id: gid(node.inventoryItem?.id),
      title: node.product.title,
      image_count: (node.product.images?.edges || []).length,
    };
  } catch (e) {
    console.warn('[shopify] findProductBySku failed:', e.message);
    return null;
  }
}

// Create a new Shopify product with SKU, barcode (= sku), price, and image URLs.
// imageUrls is an array of public image URLs Shopify will fetch and host.

// Upgrade an eBay-hosted image URL to its largest standard rendition. eBay's
// gallery/thumbnail URLs (s-l64 … s-l500) otherwise mirror to Shopify at low
// quality — forcing s-l1600 fetches the full-size image (eBay scales down to the
// original if it's smaller, so this is always safe).
function maxResImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/\.ebayimg\.com/i.test(url)) return url.replace(/\/s-l\d+(?=\.|\?|$)/i, '/s-l1600');
  return url;
}
// Normalise + de-dupe a list of image URLs before sending to Shopify. After the
// resolution upgrade the gallery thumbnail and full image often collapse to the
// same URL, so de-duping avoids importing the same photo twice.
function normaliseImageUrls(imageUrls = []) {
  return [...new Set((imageUrls || []).map(maxResImageUrl).filter(Boolean))];
}

async function createProduct({ title, sku, price, imageUrls = [], imageData = [], status = 'draft', metafields = [], qty = null, tags = null, templateSuffix = null, description = null, taxable = true }) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const imgs = normaliseImageUrls(imageUrls);
  // imageData = base64 data URLs (uploaded files). Strip the data: prefix —
  // Shopify wants raw base64 in `attachment`.
  const attachments = (imageData || [])
    .map(d => String(d || '').replace(/^data:[^;]+;base64,/, '').trim())
    .filter(Boolean);
  const productPayload = {
    title,
    status,
    variants: [{
      sku,
      barcode: sku,
      price: price != null ? String(price) : undefined,
      inventory_management: 'shopify',
      taxable: taxable !== false,
    }],
    // Pin an explicit position on every image so the FIRST one we send stays the
    // main image. Without this Shopify can return base64 uploads in a different
    // order (whichever finishes processing first), making a random photo the hero
    // — which then propagates to eBay too (it mirrors Shopify's order).
    images: [...imgs.map(src => ({ src })), ...attachments.map(attachment => ({ attachment }))]
      .map((img, i) => ({ ...img, position: i + 1 })),
  };
  if (description != null) productPayload.body_html = description;
  if (tags) productPayload.tags = tags; // comma-separated string
  if (templateSuffix) productPayload.template_suffix = templateSuffix; // e.g. "large-parts"

  const r = await shopifyRequest('post', '/products.json', { data: { product: productPayload } });
  const product = r.data.product;
  await publishProductToAllChannels(product.id);
  if (qty != null) await setInitialInventory(product, qty);
  if (metafields.length) product.__metafieldResults = await applyMetafields(product.id, metafields);
  return product;
}

// Update an existing product's title, price, and replace images.
async function updateProduct(productId, { title, sku, price, imageUrls = [], status, metafields = [], qty = null, tags = null, templateSuffix = null, description = null }) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const ex = await shopifyRequest('get', `/products/${productId}.json`);
  const existing = ex.data.product;
  const variant = existing.variants[0];

  const patchData = { product: { id: productId } };
  if (title) patchData.product.title = title;
  if (status) patchData.product.status = status;
  if (tags != null) patchData.product.tags = tags;
  if (templateSuffix != null) patchData.product.template_suffix = templateSuffix;
  if (description != null) patchData.product.body_html = description;
  await shopifyRequest('put', `/products/${productId}.json`, { data: patchData });

  if (variant && (sku || price != null)) {
    await shopifyRequest('put', `/variants/${variant.id}.json`, {
      data: {
        variant: {
          id: variant.id,
          sku: sku || variant.sku,
          barcode: sku || variant.barcode,
          price: price != null ? String(price) : variant.price,
        },
      },
    });
  }

  const imgs = normaliseImageUrls(imageUrls);
  if (imgs.length) {
    for (const img of existing.images || []) {
      try { await shopifyRequest('delete', `/products/${productId}/images/${img.id}.json`); } catch (e) {}
    }
    for (const src of imgs) {
      try {
        await shopifyRequest('post', `/products/${productId}/images.json`, {
          data: { image: { src } },
        });
      } catch (e) {
        console.warn('[shopify] image upload failed:', src, e.message);
      }
    }
  }

  let metafieldResults = [];
  if (metafields.length) metafieldResults = await applyMetafields(productId, metafields);
  await publishProductToAllChannels(productId);
  if (qty != null) await setInitialInventory(existing, qty);

  const out = (await shopifyRequest('get', `/products/${productId}.json`)).data.product;
  out.__metafieldResults = metafieldResults;
  return out;
}

// Images-only update — replaces a product's images with the given (full-res,
// de-duped) set WITHOUT touching title, price, metafields or inventory. Used by
// the one-click "re-push selected images" tool so an image refresh can't disturb
// anything else. Returns { ok, count }.
async function setProductImages(productId, imageUrls) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const imgs = normaliseImageUrls(imageUrls);
  if (!imgs.length) return { ok: false, count: 0, skipped: 'no_images' };
  const ex = await shopifyRequest('get', `/products/${productId}.json`);
  const existing = ex.data.product;
  for (const img of existing.images || []) {
    try { await shopifyRequest('delete', `/products/${productId}/images/${img.id}.json`); } catch (e) {}
  }
  let count = 0;
  for (const src of imgs) {
    try {
      await shopifyRequest('post', `/products/${productId}/images.json`, { data: { image: { src } } });
      count++;
    } catch (e) { console.warn('[shopify] image upload failed:', src, e.message); }
  }
  return { ok: count > 0, count };
}

// Replace a product's images with an ORDERED set that can mix already-hosted
// URLs and freshly-uploaded base64 data URLs (e.g. when swapping out watermarked
// photos). Order is preserved (first = main image). Returns the resulting hosted
// image src URLs in order — handy for then pointing eBay at the same photos.
async function replaceProductImagesOrdered(productId, items = []) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const list = (items || []).map(s => String(s || '').trim()).filter(Boolean);
  const ex = await shopifyRequest('get', `/products/${productId}.json`);
  const existing = ex.data.product;
  for (const img of existing.images || []) {
    try { await shopifyRequest('delete', `/products/${productId}/images/${img.id}.json`); } catch (e) {}
  }
  let position = 1;
  for (const item of list) {
    const isData = /^data:[^;]+;base64,/.test(item);
    const image = isData
      ? { attachment: item.replace(/^data:[^;]+;base64,/, ''), position }
      : { src: item, position };
    try { await shopifyRequest('post', `/products/${productId}/images.json`, { data: { image } }); position++; }
    catch (e) { console.warn('[shopify] ordered image set failed:', isData ? '(upload)' : item, e.message); }
  }
  const out = (await shopifyRequest('get', `/products/${productId}.json`)).data.product;
  return (out.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(im => im.src).filter(Boolean);
}

// Lightweight SKU-only update — sets the first variant's SKU (and keeps barcode
// in sync with it, so scanning works) without touching title, price, images or
// inventory. Used by the cross-channel bulk-SKU tool.
async function setVariantSku(shopifyProductId, sku) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const s = String(sku || '').trim();
  if (!s) throw new Error('valid sku required');
  const ex = await shopifyRequest('get', `/products/${encodeURIComponent(shopifyProductId)}.json`);
  const variant = ex.data.product?.variants?.[0];
  if (!variant) throw new Error('no_variant_for_product');
  await shopifyRequest('put', `/variants/${variant.id}.json`, {
    data: { variant: { id: variant.id, sku: s, barcode: s } },
  });
  return { ok: true, productId: String(shopifyProductId), sku: s };
}

// Lightweight price-only update — sets just the first variant's price without
// touching title, images, or inventory. Used by the pricing-sync tool.
async function setVariantPrice(shopifyProductId, price) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const p = parseFloat(price);
  if (isNaN(p) || p < 0) throw new Error('valid price required');
  const ex = await shopifyRequest('get', `/products/${encodeURIComponent(shopifyProductId)}.json`);
  const variant = ex.data.product?.variants?.[0];
  if (!variant) throw new Error('no_variant_for_product');
  await shopifyRequest('put', `/variants/${variant.id}.json`, {
    data: { variant: { id: variant.id, price: p.toFixed(2) } },
  });
  return { ok: true, productId: String(shopifyProductId), price: +p.toFixed(2) };
}

// List delivery (shipping) profiles. Returns [{id, name}].
let cachedProfiles = null;
async function getDeliveryProfiles() {
  // Only the SUCCESSFUL, non-empty result is cached — otherwise an early failure
  // (e.g. before read_shipping was granted) would stick as "[]" for the whole
  // process lifetime, so the dropdown would stay empty even after the scope fix.
  if (cachedProfiles && cachedProfiles.length) return cachedProfiles;
  try {
    const r = await shopifyRequest('post', '/graphql.json', {
      data: { query: `query { deliveryProfiles(first: 25) { edges { node { id name } } } }` },
    });
    if (r.data.errors) {
      // Common cause: missing read_shipping scope on the custom app.
      throw new Error(JSON.stringify(r.data.errors));
    }
    const profiles = (r.data.data?.deliveryProfiles?.edges || []).map(e => e.node);
    if (profiles.length) cachedProfiles = profiles;
    return profiles;
  } catch (e) {
    console.warn('[shopify] getDeliveryProfiles failed:', e.response?.data || e.message);
    return [];
  }
}

// Assign a product (all variants) to a non-default delivery profile.
// Pass profileId as a Shopify GID like "gid://shopify/DeliveryProfile/12345".
async function assignProductToDeliveryProfile(productId, profileId) {
  if (!profileId) return;
  try {
    // Get all variant IDs of the product
    const r = await shopifyRequest('get', `/products/${productId}.json`);
    const variantGids = (r.data.product.variants || []).map(v => `gid://shopify/ProductVariant/${v.id}`);
    if (!variantGids.length) return;

    const mutation = `mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
      deliveryProfileUpdate(id: $id, profile: $profile) {
        userErrors { field message }
      }
    }`;
    const mr = await shopifyRequest('post', '/graphql.json', {
      data: {
        query: mutation,
        variables: {
          id: profileId,
          profile: { variantsToAssociate: variantGids },
        },
      },
    });
    const userErrors = mr.data.data?.deliveryProfileUpdate?.userErrors || [];
    if (userErrors.length) console.warn('[shopify] profile assign userErrors:', JSON.stringify(userErrors));
  } catch (e) {
    console.warn('[shopify] assignProductToDeliveryProfile failed:', e.response?.data || e.message);
  }
}

// Apply a list of metafields to a product. Each metafield: { namespace, key, value, type }.
// Returns a per-metafield result list [{ namespace, key, ok, error? }] so callers
// can surface failures — previously these were swallowed, so a rejected metafield
// (the usual cause of "my metafields didn't come through") was invisible.
//
// Two robustness measures that fix the common silent-rejection cases:
//   • The TYPE is taken from the Shopify metafield DEFINITION when one exists —
//     a mismatched client type (e.g. sending single_line to a list.* field) is
//     the #1 reason Shopify returns 422 and the value never lands.
//   • list.* definitions require a JSON-array value, so scalar / comma-separated
//     input is coerced into a JSON array (this is what storefront filter fields
//     like Position / Finish are usually defined as).
async function applyMetafields(productId, metafields) {
  const results = [];
  let defByKey = {};
  try {
    const defs = await getMetafieldDefinitions();
    for (const d of defs) defByKey[`${d.namespace}.${d.key}`] = d;
  } catch (_) { /* fall back to client-provided types */ }

  for (const mf of metafields) {
    if (!mf.key || mf.value == null || mf.value === '') continue;
    const namespace = mf.namespace || 'custom';
    const def = defByKey[`${namespace}.${mf.key}`];
    const type = def?.type || mf.type || 'single_line_text_field';
    let value = String(mf.value);
    // list.* metafields must be a JSON array string. Accept an already-JSON array,
    // otherwise split comma-separated values so multi-value filters work.
    if (/^list\./.test(type)) {
      let arr = null;
      try { const p = JSON.parse(value); if (Array.isArray(p)) arr = p; } catch (_) {}
      if (!arr) arr = value.split(',').map(s => s.trim()).filter(Boolean);
      value = JSON.stringify(arr);
    }
    try {
      await shopifyRequest('post', `/products/${productId}/metafields.json`, {
        data: { metafield: { namespace, key: mf.key, value, type } },
      });
      results.push({ namespace, key: mf.key, ok: true });
    } catch (e) {
      const detail = e.response?.data?.errors || e.response?.data || e.message;
      const error = typeof detail === 'string' ? detail : JSON.stringify(detail);
      console.warn(`[shopify] metafield ${namespace}.${mf.key} failed:`, error);
      results.push({ namespace, key: mf.key, ok: false, error });
    }
  }
  return results;
}

// List all sales channels (publications) on this Shopify store
let cachedPublications = null;
async function getPublications() {
  if (cachedPublications) return cachedPublications;
  try {
    const r = await shopifyRequest('post', '/graphql.json', {
      data: { query: `query { publications(first: 25) { edges { node { id name } } } }` },
    });
    if (r.data.errors) {
      console.warn('[shopify] getPublications errors:', JSON.stringify(r.data.errors));
      return [];
    }
    cachedPublications = (r.data.data?.publications?.edges || []).map(e => e.node);
    return cachedPublications;
  } catch (e) {
    console.warn('[shopify] getPublications failed:', e.response?.data || e.message);
    return [];
  }
}

// Publish a product to all sales channels.
async function publishProductToAllChannels(productId) {
  try {
    const pubs = await getPublications();
    if (!pubs.length) {
      console.warn('[shopify] no publications found — token likely missing read_publications scope');
      return;
    }
    const productGid = `gid://shopify/Product/${productId}`;
    const mutation = `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`;
    const r = await shopifyRequest('post', '/graphql.json', {
      data: {
        query: mutation,
        variables: { id: productGid, input: pubs.map(p => ({ publicationId: p.id })) },
      },
    });
    const userErrors = r.data.data?.publishablePublish?.userErrors || [];
    if (userErrors.length) {
      console.warn('[shopify] publish userErrors for product', productId, ':', JSON.stringify(userErrors));
    }
    if (r.data.errors) {
      console.warn('[shopify] publish GraphQL errors for product', productId, ':', JSON.stringify(r.data.errors));
    }
  } catch (e) {
    console.warn('[shopify] publish to channels failed:', e.response?.data || e.message);
  }
}

// Debug helper — used by /api/listings/debug-shopify
async function debugShopifyAccess() {
  const out = {
    isConfigured: isConfigured(),
    locationId: LOCATION_ID,
    storeDomain: STORE,
    apiVersion: VERSION,
  };
  try {
    const pubs = await getPublications();
    out.publications = pubs.map(p => ({ id: p.id, name: p.name }));
    out.publicationCount = pubs.length;
  } catch (e) {
    out.publicationsError = e.message;
  }
  try {
    const defs = await getMetafieldDefinitions();
    out.metafieldDefinitions = defs.map(d => ({ namespace: d.namespace, key: d.key, name: d.name, type: d.type }));
  } catch (e) {
    out.metafieldDefError = e.message;
  }
  try {
    const profiles = await getDeliveryProfiles();
    out.deliveryProfiles = profiles.map(p => ({ id: p.id, name: p.name }));
    out.deliveryProfileCount = profiles.length;
    if (!profiles.length) {
      out.deliveryProfileHint = 'Empty result — your Shopify custom app token likely needs read_shipping scope. Shopify admin → Apps → custom app → Configuration → Admin API access scopes → enable read_shipping (and write_shipping if you want to assign products to profiles), then click Save and reinstall the app.';
    }
  } catch (e) {
    out.deliveryProfilesError = e.message;
  }
  return out;
}

// Fetch metafield definitions for the PRODUCT ownerType — these are the ones
// the user has defined on their store (Part Number, Position, Finish, etc.)
let cachedMetafieldDefs = null;
async function getMetafieldDefinitions() {
  if (cachedMetafieldDefs) return cachedMetafieldDefs;
  try {
    const query = `query {
      metafieldDefinitions(first: 50, ownerType: PRODUCT) {
        edges { node { id namespace key name description type { name } } }
      }
    }`;
    const r = await shopifyRequest('post', '/graphql.json', { data: { query } });
    if (r.data.errors) {
      console.warn('[shopify] metafield defs errors:', JSON.stringify(r.data.errors));
      return [];
    }
    cachedMetafieldDefs = (r.data.data?.metafieldDefinitions?.edges || []).map(e => ({
      id: e.node.id,
      namespace: e.node.namespace,
      key: e.node.key,
      name: e.node.name,
      description: e.node.description,
      type: e.node.type?.name || 'single_line_text_field',
    }));
    return cachedMetafieldDefs;
  } catch (e) {
    console.warn('[shopify] getMetafieldDefinitions failed:', e.response?.data || e.message);
    return [];
  }
}

// deleteProduct — permanently delete a Shopify product (used to remove duplicate
// products). Idempotent: a 404 (already gone) is treated as success.
async function deleteProduct(productId) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  if (!productId) throw new Error('missing_product_id');
  try {
    await shopifyRequest('delete', `/products/${productId}.json`);
    return { ok: true, productId: String(productId) };
  } catch (e) {
    if (e.response?.status === 404) return { ok: true, alreadyDeleted: true, productId: String(productId) };
    throw new Error('Shopify delete failed: ' + (e.response?.data?.errors || e.message));
  }
}

// Write the part number into the store's "Part Number" product metafield (the
// one shown on the Shopify product page). SKU + barcode are variant fields and
// already set by setVariantSku, but the catalogue's Part Number metafield is
// separate — without this it stays blank after a SKU push. Matches the definition
// named exactly "Part Number" so it never clobbers "Part Number Purchased" etc.
async function setPartNumberMetafield(productId, partNumber) {
  if (!isConfigured() || !productId || !partNumber) return { skipped: 'no_input' };
  const defs = await getMetafieldDefinitions();
  const def = defs.find(d => String(d.name || '').trim().toLowerCase() === 'part number');
  if (!def) return { skipped: 'no_definition' };
  const results = await applyMetafields(productId, [{ namespace: def.namespace, key: def.key, value: String(partNumber), type: def.type }]);
  const r = results[0] || {};
  return r.ok ? { ok: true, namespace: def.namespace, key: def.key } : { error: r.error || 'failed' };
}

// Set the inventory quantity for a freshly-created product at the warehouse location.
async function setInitialInventory(product, qty) {
  if (!LOCATION_ID || qty == null) return;
  const variant = product.variants && product.variants[0];
  if (!variant || !variant.inventory_item_id) return;
  // Connect inventory item to location first (no-op if already connected)
  try {
    await shopifyRequest('post', '/inventory_levels/connect.json', {
      data: {
        location_id: parseInt(LOCATION_ID),
        inventory_item_id: parseInt(variant.inventory_item_id),
      },
    });
  } catch (e) { /* already connected, ignore */ }
  await shopifyRequest('post', '/inventory_levels/set.json', {
    data: {
      location_id: parseInt(LOCATION_ID),
      inventory_item_id: parseInt(variant.inventory_item_id),
      available: qty,
    },
  });
}

// Batch SKU lookup — given an array of SKUs, return which already exist on Shopify.
// Uses Shopify's OR query syntax (max ~25 SKUs per request).
async function findProductsBySkus(skus) {
  if (!isConfigured() || !skus.length) return {};
  const found = {};
  const chunkSize = 25;
  for (let i = 0; i < skus.length; i += chunkSize) {
    const chunk = skus.slice(i, i + chunkSize);
    const q = chunk.map(s => `sku:"${s.replace(/"/g, '\\"')}"`).join(' OR ');
    try {
      const query = `query($q: String!) {
        productVariants(first: 250, query: $q) {
          edges { node { sku product { id title } } }
        }
      }`;
      const r = await shopifyRequest('post', '/graphql.json', {
        data: { query, variables: { q } },
      });
      const edges = r.data.data?.productVariants?.edges || [];
      for (const e of edges) {
        const sku = e.node.sku;
        if (sku && chunk.includes(sku)) {
          found[sku] = {
            product_id: e.node.product.id.split('/').pop(),
            title: e.node.product.title,
          };
        }
      }
    } catch (e) {
      console.warn('[shopify] batch SKU lookup failed:', e.message);
    }
  }
  return found;
}

// ──────────────────────────────────────────────────────────────────────────
// fulfillOrder — push fulfillment + tracking back to Shopify so the customer
// gets the standard "your order is on its way" email + sees tracking in their
// account / order status page.
//
// Modern Shopify uses the FulfillmentOrders API (the old
// `/orders/{id}/fulfillments.json` was deprecated 2022-07). Flow:
//   1. Fetch the open fulfillment orders for the order
//   2. POST a Fulfillment for each open fulfillment order, attaching tracking
//
// `opts`:
//   orderId        — Shopify order ID from sale.external_order_id
//   trackingNumber — optional tracking number
//   carrier        — our internal carrier name (e.g. "DPD"); mapped below
//   notifyCustomer — default true; sends Shopify's shipped-notification email
//
// Already-fulfilled orders are treated as success.
// ──────────────────────────────────────────────────────────────────────────
async function fulfillOrder(opts = {}) {
  const { orderId, trackingNumber, carrier, notifyCustomer = true } = opts;
  if (!orderId) throw new Error('orderId required');

  // Carrier mapping → Shopify's `tracking_company`. Shopify accepts arbitrary
  // strings but matches known carrier names to auto-generate the tracking-link
  // URL in the customer email. See:
  //   https://help.shopify.com/en/manual/orders/status-tracking/supported-tracking-carriers
  const carrierMap = {
    'Royal Mail':             'Royal Mail',
    'Parcelforce':            'Parcelforce',
    'DPD':                    'DPD',
    'Evri':                   'Evri',          // Shopify accepts Evri (renamed from Hermes)
    'UPS':                    'UPS',
    'DHL':                    'DHL Express',   // Shopify uses "DHL Express" for UK
    'FedEx':                  'FedEx',
    'Tuffnells':              'Tuffnells',
    'Yodel':                  'Yodel',
    'APC Overnight':          'APC Overnight',
    'Other / custom courier': 'Other',
    'Already shipped (channel)': null,
  };
  const shopifyCarrier = carrierMap[carrier] !== undefined ? carrierMap[carrier] : carrier;

  // 1. Get open fulfillment orders for this order
  let foRes;
  try {
    foRes = await shopifyRequest('GET', `/orders/${encodeURIComponent(orderId)}/fulfillment_orders.json`);
  } catch (e) {
    if (e.response?.status === 404) {
      throw new Error(`Shopify order ${orderId} not found`);
    }
    throw e;
  }
  const fulfillmentOrders = foRes.data?.fulfillment_orders || [];
  // Only fulfillment orders in 'open' or 'in_progress' state can be fulfilled.
  // 'closed' = already shipped, 'cancelled' = cancelled. 'scheduled' = future.
  const fulfillable = fulfillmentOrders.filter(fo =>
    fo.status === 'open' || fo.status === 'in_progress'
  );
  if (fulfillable.length === 0) {
    // Nothing left to fulfil — order is already shipped or all line items are
    // in non-shippable states. Match the eBay behaviour: success.
    return { ok: true, alreadyFulfilled: true, totalFulfillmentOrders: fulfillmentOrders.length };
  }

  // 2. POST a Fulfillment that covers every open fulfillment order in one go.
  // The line_items_by_fulfillment_order without explicit line items means
  // "fulfil everything in this fulfillment order".
  const payload = {
    fulfillment: {
      notify_customer: !!notifyCustomer,
      line_items_by_fulfillment_order: fulfillable.map(fo => ({
        fulfillment_order_id: fo.id,
      })),
    },
  };
  if (trackingNumber || shopifyCarrier) {
    payload.fulfillment.tracking_info = {};
    if (trackingNumber)  payload.fulfillment.tracking_info.number  = trackingNumber;
    if (shopifyCarrier)  payload.fulfillment.tracking_info.company = shopifyCarrier;
  }

  try {
    const r = await shopifyRequest('POST', `/fulfillments.json`, { data: payload });
    return {
      ok: true,
      fulfillmentId: r.data?.fulfillment?.id,
      status: r.data?.fulfillment?.status,
    };
  } catch (e) {
    const msg = e.response?.data?.errors
      ? JSON.stringify(e.response.data.errors)
      : e.message;
    throw new Error(`Shopify fulfillment failed: ${msg}`);
  }
}

// Fetch a single Shopify product with its full description + all images.
// Used by the Shopify→eBay listing creator to enrich the eBay listing with
// content we don't store locally (HTML description, secondary images).
async function getShopifyProductFull(shopifyProductId) {
  if (!shopifyProductId) throw new Error('shopifyProductId required');
  const r = await shopifyRequest('GET', `/products/${encodeURIComponent(shopifyProductId)}.json`);
  const p = r.data?.product;
  if (!p) throw new Error('Shopify returned no product');
  return {
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    description: p.body_html || '',
    vendor: p.vendor,
    productType: p.product_type,
    tags: p.tags,
    price: p.variants?.[0]?.price != null ? parseFloat(p.variants[0].price) : null,
    imageUrls: (p.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(img => img.src).filter(Boolean),
    primaryImage: p.image?.src || (p.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0))[0]?.src || null,
  };
}

// Bulk-set every Shopify variant's barcode = its SKU. Many products had random
// Shopify auto-generated barcodes (≠ SKU), which breaks scanning. dryRun=true
// (the default) returns what WOULD change without writing anything. Writes are
// throttled to ~4/sec to stay under Shopify's REST bucket.
async function bulkSetBarcodeToSku({ dryRun = true } = {}) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let pageInfo = null, pageCount = 0;
  let totalVariants = 0, candidates = 0, updated = 0, skippedNoSku = 0;
  const sample = [];
  const errors = [];

  while (true) {
    if (++pageCount > 100) break;  // safety bound
    const params = pageInfo ? { limit: 250, page_info: pageInfo } : { limit: 250 };
    const r = await shopifyRequest('get', '/products.json', { params });
    for (const p of r.data.products || []) {
      for (const v of p.variants || []) {
        totalVariants++;
        const sku = (v.sku || '').trim();
        const barcode = (v.barcode || '').trim();
        if (!sku) { skippedNoSku++; continue; }   // never set an empty barcode
        if (barcode === sku) continue;             // already correct
        candidates++;
        if (sample.length < 25) sample.push({ product: p.title, sku, currentBarcode: barcode || '(empty)' });
        if (!dryRun) {
          try {
            await shopifyRequest('put', `/variants/${v.id}.json`, { data: { variant: { id: v.id, barcode: sku } } });
            updated++;
            await sleep(250);
          } catch (e) {
            if (errors.length < 50) errors.push({ sku, variantId: String(v.id), error: e.response?.data?.errors || e.message });
          }
        }
      }
    }
    const link = r.headers['link'] || r.headers['Link'];
    if (!link || !link.includes('rel="next"')) break;
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) break;
    pageInfo = new URL(m[1]).searchParams.get('page_info');
    if (!pageInfo) break;
    await sleep(300);  // gentle pacing between pages to avoid the 429 bucket
  }
  return { dryRun, totalVariants, candidates, updated, skippedNoSku, sample, errors, errorCount: errors.length };
}

// ---------- Custom collections (shop categories) ----------
// Shopify has SMART collections (auto-populated by rules — can't add manually)
// and CUSTOM collections (manual). The app manages CUSTOM ones via collects.
async function getCustomCollections() {
  if (!isConfigured()) return [];
  const out = [];
  let pageInfo = null, guard = 0;
  while (guard++ < 20) {
    const params = pageInfo ? { limit: 250, page_info: pageInfo } : { limit: 250 };
    const r = await shopifyRequest('get', '/custom_collections.json', { params });
    for (const c of (r.data.custom_collections || [])) out.push({ id: String(c.id), title: c.title, handle: c.handle });
    const link = r.headers['link'] || r.headers['Link'];
    const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) break;
    pageInfo = new URL(m[1]).searchParams.get('page_info');
    if (!pageInfo) break;
  }
  return out;
}

// Which custom collections a product belongs to. Returns collect rows
// ({ collectId, collectionId }) so a membership can be removed by collectId.
async function getProductCollects(productId) {
  if (!isConfigured()) return [];
  const r = await shopifyRequest('get', '/collects.json', { params: { product_id: productId, limit: 250 } });
  return (r.data.collects || []).map(c => ({ collectId: String(c.id), collectionId: String(c.collection_id) }));
}

async function addProductToCollection(productId, collectionId) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const r = await shopifyRequest('post', '/collects.json', { data: { collect: { product_id: Number(productId), collection_id: Number(collectionId) } } });
  return { collectId: String(r.data.collect.id) };
}

async function removeCollect(collectId) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  await shopifyRequest('delete', `/collects/${encodeURIComponent(collectId)}.json`);
  return { ok: true };
}

// ---------- Search-engine listing (SEO) ----------
// Read a product's current SEO fields + category, so the optimiser can show a
// before/after preview. Uses GraphQL (REST doesn't expose seo/category cleanly).
async function getProductSeo(productGid) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const id = String(productGid).startsWith('gid://') ? productGid : `gid://shopify/Product/${productGid}`;
  const query = `query($id: ID!) {
    product(id: $id) {
      id title handle
      seo { title description }
      category { id fullName }
    }
  }`;
  const r = await shopifyRequest('post', '/graphql.json', { data: { query, variables: { id } } });
  if (r.data.errors) throw new Error('graphql: ' + JSON.stringify(r.data.errors));
  const p = r.data.data?.product;
  if (!p) return null;
  return {
    id: p.id,
    handle: p.handle,
    seoTitle: p.seo?.title || '',
    seoDescription: p.seo?.description || '',
    categoryId: p.category?.id || null,
    categoryName: p.category?.fullName || null,
  };
}

// Look up a Shopify standard taxonomy category by a search term (e.g. "Fog
// Lights"), preferring matches under Vehicles & Parts. Returns { id, fullName }
// or null. Cached per term for the process lifetime.
const _categoryCache = new Map();
async function findTaxonomyCategory(term) {
  if (!term) return null;
  const key = term.toLowerCase();
  if (_categoryCache.has(key)) return _categoryCache.get(key);
  const query = `query($q: String!) {
    taxonomy { categories(search: $q, first: 25) { edges { node { id fullName } } } }
  }`;
  let result = null;
  try {
    const r = await shopifyRequest('post', '/graphql.json', { data: { query, variables: { q: term } } });
    if (r.data.errors) throw new Error(JSON.stringify(r.data.errors));
    const nodes = (r.data.data?.taxonomy?.categories?.edges || []).map(e => e.node);
    // Prefer categories under the vehicle-parts branch; then an exact leaf-name
    // match; otherwise the first result.
    const vehicle = nodes.filter(n => /vehicle|automotive|motor/i.test(n.fullName));
    const pool = vehicle.length ? vehicle : nodes;
    const leaf = (n) => (n.fullName.split('>').pop() || '').trim().toLowerCase();
    result = pool.find(n => leaf(n) === term.toLowerCase()) || pool[0] || null;
  } catch (e) {
    console.warn('[shopify] findTaxonomyCategory failed for', term, '-', e.message);
  }
  _categoryCache.set(key, result);
  return result;
}

// Search Shopify's standard product taxonomy by name, returning a list of
// { id, fullName } for a category picker (vehicle-parts matches first).
async function searchTaxonomyCategories(term) {
  if (!term || term.trim().length < 2) return [];
  const query = `query($q: String!) {
    taxonomy { categories(search: $q, first: 25) { edges { node { id fullName } } } }
  }`;
  try {
    const r = await shopifyRequest('post', '/graphql.json', { data: { query, variables: { q: term.trim() } } });
    if (r.data.errors) throw new Error(JSON.stringify(r.data.errors));
    const nodes = (r.data.data?.taxonomy?.categories?.edges || []).map(e => e.node);
    nodes.sort((a, b) => {
      const va = /vehicle|automotive|motor/i.test(a.fullName) ? 0 : 1;
      const vb = /vehicle|automotive|motor/i.test(b.fullName) ? 0 : 1;
      return va - vb;
    });
    return nodes.slice(0, 20);
  } catch (e) {
    console.warn('[shopify] searchTaxonomyCategories failed:', e.message);
    return [];
  }
}

// Apply SEO fields to a product. Any field left undefined is not touched.
//   { seoTitle, seoDescription, handle, categoryId }
// Returns { ok, userErrors }.
async function applyProductSeo(productGid, { seoTitle, seoDescription, handle, categoryId } = {}) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const id = String(productGid).startsWith('gid://') ? productGid : `gid://shopify/Product/${productGid}`;
  const input = { id };
  if (seoTitle !== undefined || seoDescription !== undefined) {
    input.seo = {};
    if (seoTitle !== undefined) input.seo.title = seoTitle;
    if (seoDescription !== undefined) input.seo.description = seoDescription;
  }
  if (handle !== undefined && handle) input.handle = handle;
  if (categoryId !== undefined && categoryId) input.category = categoryId;

  const mutation = `mutation($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id handle }
      userErrors { field message }
    }
  }`;
  const r = await shopifyRequest('post', '/graphql.json', { data: { query: mutation, variables: { input } } });
  if (r.data.errors) throw new Error('graphql: ' + JSON.stringify(r.data.errors));
  const ue = r.data.data?.productUpdate?.userErrors || [];
  return { ok: ue.length === 0, userErrors: ue, product: r.data.data?.productUpdate?.product || null };
}

// Write a product's review rating + count metafields (reviews.rating /
// reviews.rating_count). Storefront themes read exactly these for star displays
// and aggregateRating JSON-LD. productId may be numeric or a GID.
async function setProductRating(productId, rating, count) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const gid = String(productId).startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
  const mutation = `mutation SetReviews($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;
  const variables = { metafields: [
    { ownerId: gid, namespace: 'reviews', key: 'rating', type: 'rating',
      value: JSON.stringify({ value: String(rating), scale_min: '1.0', scale_max: '5.0' }) },
    { ownerId: gid, namespace: 'reviews', key: 'rating_count', type: 'number_integer',
      value: String(count) },
  ] };
  const r = await shopifyRequest('post', '/graphql.json', { data: { query: mutation, variables } });
  const errs = r.data?.data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(errs.map(e => `${(e.field || []).join('.')}: ${e.message}`).join('; '));
  return true;
}

module.exports = {
  isConfigured,
  setProductRating,
  getAccessToken,
  getProductSeo,
  findTaxonomyCategory,
  searchTaxonomyCategories,
  applyProductSeo,
  getInventoryLevel,
  getCustomCollections,
  getProductCollects,
  addProductToCollection,
  removeCollect,
  bulkSetBarcodeToSku,
  getLocations,
  setInventoryLevel,
  getRecentOrders,
  pushStockForProduct,
  iterateAllProductsAndVariants,
  findProductBySku,
  findProductsBySkus,
  createProduct,
  updateProduct,
  deleteProduct,
  setVariantPrice,
  setVariantSku,
  setPartNumberMetafield,
  setProductImages,
  replaceProductImagesOrdered,
  publishProductToAllChannels,
  getPublications,
  getMetafieldDefinitions,
  getDeliveryProfiles,
  assignProductToDeliveryProfile,
  debugShopifyAccess,
  fulfillOrder,
  getShopifyProductFull,
};
