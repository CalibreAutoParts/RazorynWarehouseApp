// services/ga4.js — GA4 Measurement Protocol (server-side event delivery).
// Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4
// Resilient to ad-blockers / cookie loss because events are sent from the server.
const axios = require('axios');
const ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function isConfigured(cfg = {}) {
  return !!((cfg.measurementId || process.env.GA4_MEASUREMENT_ID) &&
            (cfg.apiSecret || process.env.GA4_API_SECRET));
}

/**
 * @param {Array<{name:string, params:object}>} events
 * @param {string} clientId  stable per-browser id from the pixel
 * @param {{measurementId?:string, apiSecret?:string}} cfg  optional in-app overrides
 */
async function sendGA4(events, clientId, cfg = {}) {
  const id = cfg.measurementId || process.env.GA4_MEASUREMENT_ID;
  const secret = cfg.apiSecret || process.env.GA4_API_SECRET;
  if (!id || !secret || !events?.length) return false;
  try {
    await axios.post(`${ENDPOINT}?measurement_id=${id}&api_secret=${secret}`, {
      client_id: clientId || `${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
      events,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    return true;
  } catch (e) {
    console.error('[ga4] send failed:', e.response?.status || e.message);
    return false;
  }
}

module.exports = { sendGA4, isConfigured, validateGA4 };

// Validate credentials WITHOUT polluting reports: GA4's /debug endpoint checks an
// event and returns validationMessages (empty = valid) but doesn't record it.
async function validateGA4(cfg = {}) {
  const id = cfg.measurementId || process.env.GA4_MEASUREMENT_ID;
  const secret = cfg.apiSecret || process.env.GA4_API_SECRET;
  if (!id || !secret) return { configured: false };
  try {
    const r = await axios.post(
      `https://www.google-analytics.com/debug/mp/collect?measurement_id=${id}&api_secret=${secret}`,
      { client_id: `test.${Date.now()}`, events: [{ name: 'page_view', params: {} }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    const msgs = (r.data?.validationMessages || []).map(m => m.description || m.validationCode);
    return { configured: true, ok: msgs.length === 0, messages: msgs, measurementId: id };
  } catch (e) {
    return { configured: true, ok: false, messages: [e.response?.status ? `HTTP ${e.response.status}` : e.message] };
  }
}
