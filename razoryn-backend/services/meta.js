// services/meta.js — Meta Conversions API (server-side event delivery).
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api
// event_id is passed through so Meta dedupes against the browser pixel.
const axios = require('axios');
const API_VERSION = 'v19.0';

function isConfigured(cfg = {}) {
  return !!((cfg.pixelId || process.env.META_PIXEL_ID) &&
            (cfg.capiToken || process.env.META_CAPI_TOKEN));
}

/**
 * @param {string} eventName  Meta standard name (PageView, ViewContent, AddToCart, InitiateCheckout, Purchase, Search)
 * @param {{customData?:object, eventId?:string, sourceUrl?:string, userData?:object}} opts
 * @param {{pixelId?:string, capiToken?:string, testCode?:string}} cfg
 */
async function sendMeta(eventName, opts = {}, cfg = {}) {
  const pixel = cfg.pixelId || process.env.META_PIXEL_ID;
  const token = cfg.capiToken || process.env.META_CAPI_TOKEN;
  if (!pixel || !token || !eventName) return false;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: opts.eventId,
      event_source_url: opts.sourceUrl,
      user_data: opts.userData || {},
      custom_data: opts.customData || {},
    }],
  };
  const testCode = cfg.testCode || process.env.META_TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = testCode;

  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${pixel}/events?access_token=${token}`,
      payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    return true;
  } catch (e) {
    console.error('[meta] send failed:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

module.exports = { sendMeta, isConfigured, validateMeta };

// Validate Pixel ID + token WITHOUT sending an event: fetch the pixel/dataset
// object. A valid pair returns { id, name }; a bad token/pixel returns an error.
async function validateMeta(cfg = {}) {
  const pixel = cfg.pixelId || process.env.META_PIXEL_ID;
  const token = cfg.capiToken || process.env.META_CAPI_TOKEN;
  if (!pixel || !token) return { configured: false };
  try {
    const r = await axios.get(`https://graph.facebook.com/${API_VERSION}/${pixel}`, {
      params: { fields: 'id,name', access_token: token }, timeout: 8000,
    });
    return { configured: true, ok: !!r.data?.id, name: r.data?.name, pixelId: r.data?.id };
  } catch (e) {
    return { configured: true, ok: false, error: e.response?.data?.error?.message || e.message };
  }
}
