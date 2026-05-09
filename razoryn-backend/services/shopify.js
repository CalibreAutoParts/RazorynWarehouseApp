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
  return axios({
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
}

// ---------- Public API ----------
async function getLocations() {
  if (!isConfigured()) return [];
  const r = await shopifyRequest('get', '/locations.json');
  return r.data.locations;
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
async function createProduct({ title, sku, price, imageUrls = [], status = 'draft', metafields = [] }) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const r = await shopifyRequest('post', '/products.json', {
    data: {
      product: {
        title,
        status, // 'draft' | 'active'
        variants: [{
          sku,
          barcode: sku, // SKU = barcode for unified scanning
          price: price != null ? String(price) : undefined,
          inventory_management: 'shopify',
        }],
        images: imageUrls.map(src => ({ src })),
      },
    },
  });
  const product = r.data.product;
  // Apply metafields after creation
  if (metafields.length) {
    await applyMetafields(product.id, metafields);
  }
  return product;
}

// Update an existing product's title, price, and replace images.
async function updateProduct(productId, { title, sku, price, imageUrls = [], status, metafields = [] }) {
  if (!isConfigured()) throw new Error('shopify_not_configured');
  const ex = await shopifyRequest('get', `/products/${productId}.json`);
  const existing = ex.data.product;
  const variant = existing.variants[0];

  const patchData = { product: { id: productId } };
  if (title) patchData.product.title = title;
  if (status) patchData.product.status = status;
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

  if (imageUrls && imageUrls.length) {
    for (const img of existing.images || []) {
      try { await shopifyRequest('delete', `/products/${productId}/images/${img.id}.json`); } catch (e) {}
    }
    for (const src of imageUrls) {
      try {
        await shopifyRequest('post', `/products/${productId}/images.json`, {
          data: { image: { src } },
        });
      } catch (e) {
        console.warn('[shopify] image upload failed:', src, e.message);
      }
    }
  }

  if (metafields.length) {
    await applyMetafields(productId, metafields);
  }

  return (await shopifyRequest('get', `/products/${productId}.json`)).data.product;
}

// Apply a list of metafields to a product. Each metafield: { namespace, key, value, type }.
async function applyMetafields(productId, metafields) {
  for (const mf of metafields) {
    if (!mf.key || !mf.value) continue;
    try {
      await shopifyRequest('post', `/products/${productId}/metafields.json`, {
        data: {
          metafield: {
            namespace: mf.namespace || 'custom',
            key: mf.key,
            value: String(mf.value),
            type: mf.type || 'single_line_text_field',
          },
        },
      });
    } catch (e) {
      console.warn(`[shopify] metafield ${mf.namespace}.${mf.key} failed:`, e.message);
    }
  }
}

module.exports = {
  isConfigured,
  getAccessToken,
  getLocations,
  setInventoryLevel,
  getRecentOrders,
  pushStockForProduct,
  iterateAllProductsAndVariants,
  findProductBySku,
  createProduct,
  updateProduct,
};
