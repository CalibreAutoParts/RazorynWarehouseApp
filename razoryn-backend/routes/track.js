// routes/track.js — PUBLIC server-side tracking relay.
//
// The storefront Web Pixel (deployed to Shopify via the CLI — see
// storefront/tracking-pixel/) POSTs each consented event here; we forward it
// server-side to GA4 (Measurement Protocol) + Meta (Conversions API). This
// survives ad-blockers and third-party-cookie loss, and keeps the secrets on
// the server. No auth (it's called from the storefront), CORS open.
const express = require('express');
const { query } = require('../db');
const { sendGA4 } = require('../services/ga4');
const { sendMeta } = require('../services/meta');

const router = express.Router();

// Open CORS for the storefront origin(s) — this endpoint carries no secrets and
// no PII beyond what the visitor's own pixel already has.
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Storefront event name → GA4 / Meta standard names.
const GA4_NAME = {
  page_viewed: 'page_view', product_viewed: 'view_item',
  product_added_to_cart: 'add_to_cart', search_submitted: 'search',
  checkout_started: 'begin_checkout', checkout_completed: 'purchase',
};
const META_NAME = {
  page_viewed: 'PageView', product_viewed: 'ViewContent',
  product_added_to_cart: 'AddToCart', search_submitted: 'Search',
  checkout_started: 'InitiateCheckout', checkout_completed: 'Purchase',
};

// Pull GA4/Meta-friendly params out of the raw Shopify pixel event.
function extractParams(event) {
  const d = event?.data ?? {};
  const out = { currency: 'GBP' };
  const variant = d.productVariant || d.cartLine?.merchandise;
  if (variant) {
    out.value = Number(variant.price?.amount) || undefined;
    out.items = [{
      item_id: variant.sku || variant.id,
      item_name: variant.product?.title || variant.title,
      price: Number(variant.price?.amount) || undefined,
    }];
  }
  const checkout = d.checkout;
  if (checkout) {
    out.value = Number(checkout.totalPrice?.amount) || undefined;
    out.transaction_id = checkout.order?.id || checkout.token;
    out.items = (checkout.lineItems || []).map((li) => ({
      item_id: li.variant?.sku || li.variant?.id,
      item_name: li.title,
      quantity: li.quantity,
      price: Number(li.variant?.price?.amount) || undefined,
    }));
  }
  if (d.searchResult?.query) out.search_term = d.searchResult.query;
  return out;
}

// Config can live in app_settings.data (configurable in-app) or env vars.
// Cache for 60s so we don't hit the DB on every storefront event.
let _cfg = null, _cfgAt = 0;
async function loadConfig() {
  if (_cfg && Date.now() - _cfgAt < 60000) return _cfg;
  let data = {};
  try {
    const r = await query(`SELECT data FROM app_settings WHERE id = 1`);
    data = r.rows[0]?.data || {};
  } catch (_) {}
  _cfg = {
    enabled: data.tracking_enabled !== false,
    ga4: { measurementId: data.ga4_measurement_id, apiSecret: data.ga4_api_secret },
    meta: { pixelId: data.meta_pixel_id, capiToken: data.meta_capi_token, testCode: data.meta_test_code },
  };
  _cfgAt = Date.now();
  return _cfg;
}
// Let the settings route bust the cache after a save.
function invalidateConfig() { _cfg = null; }

router.post('/', async (req, res) => {
  const { name, clientId, event, context } = req.body || {};
  if (!name) return res.status(400).json({ ok: false });

  const cfg = await loadConfig();
  if (!cfg.enabled) return res.json({ ok: true, skipped: 'disabled' });

  const params = extractParams(event);
  const eventId = event?.id || event?.clientId || `${name}-${Date.now()}`;

  // Fan out — each is a no-op if its provider isn't configured.
  await Promise.allSettled([
    GA4_NAME[name] && sendGA4([{ name: GA4_NAME[name], params }], clientId, cfg.ga4),
    META_NAME[name] && sendMeta(META_NAME[name], { customData: params, eventId, sourceUrl: context?.url }, cfg.meta),
  ]);

  res.json({ ok: true });
});

// Health/ping for the pixel setup screen.
router.get('/', (req, res) => res.json({ ok: true }));

module.exports = router;
module.exports.invalidateConfig = invalidateConfig;
