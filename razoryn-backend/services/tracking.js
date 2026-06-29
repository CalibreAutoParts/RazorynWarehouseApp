// services/tracking.js — direct carrier tracking lookups (Royal Mail, FedEx, DHL).
//
// Each provider is gated on its own env vars and is a SAFE NO-OP when not
// configured, so the app runs fine until the owner adds keys in Railway. eBay
// doesn't expose delivery status to sellers, so we read it from the couriers
// ourselves for the carriers that have an API. Evri / Proovia / Dropfleet have no
// usable API here and stay manual (one-click "Delivered" in the hub).
//
// Env vars:
//   Royal Mail (Tracking API, business account):
//     ROYALMAIL_CLIENT_ID, ROYALMAIL_CLIENT_SECRET
//   FedEx (Track API, OAuth client-credentials):
//     FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET   (optional FEDEX_API_BASE)
//   DHL (Shipment Tracking - Unified):
//     DHL_API_KEY
//
// lookup(carrier, trackingNumber) → { state, deliveredAt, detail } | null
//   state: 'delivered' | 'exception' | 'in_transit' | null (unknown/unsupported)
const axios = require('axios');

const SUPPORTED = new Set(['Royal Mail', 'FedEx', 'DHL']);
function supports(carrier) {
  if (!SUPPORTED.has(carrier)) return false;
  if (carrier === 'Royal Mail') return !!(process.env.ROYALMAIL_CLIENT_ID && process.env.ROYALMAIL_CLIENT_SECRET);
  if (carrier === 'FedEx') return !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET);
  if (carrier === 'DHL') return !!process.env.DHL_API_KEY;
  return false;
}
function anyConfigured() { return ['Royal Mail', 'FedEx', 'DHL'].some(supports); }

// Heuristic: turn a free-text carrier status into our normalized state. Defensive
// because each carrier words things differently and APIs change.
function classify(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/delivered|delivery completed|signed for|collected by customer/.test(t)) return 'delivered';
  if (/exception|failed|unable to deliver|return to sender|held|problem|delayed|investigation|lost|damaged|refused/.test(t)) return 'exception';
  if (/transit|on its way|out for delivery|received|accepted|dispatched|processed|en route|pre-?transit/.test(t)) return 'in_transit';
  return null;
}

// ---------- Royal Mail ----------
async function lookupRoyalMail(tn) {
  const r = await axios.get(`https://api.royalmail.net/mailpieces/v2/${encodeURIComponent(tn)}/events`, {
    headers: {
      'X-IBM-Client-Id': process.env.ROYALMAIL_CLIENT_ID,
      'X-IBM-Client-Secret': process.env.ROYALMAIL_CLIENT_SECRET,
      'X-Accept': 'application/json', Accept: 'application/json',
    }, timeout: 15000,
  });
  const mp = (r.data?.mailPieces) || {};
  const summary = mp.summary || {};
  const state = classify(summary.statusDescription || summary.lastEventName || summary.lastEventCode);
  let deliveredAt = null;
  if (state === 'delivered') {
    const ev = (mp.events || []).find(e => /delivered/i.test(e.eventName || e.eventCode || ''));
    deliveredAt = ev?.eventDateTime || summary.lastEventDateTime || null;
  }
  return { state, deliveredAt, detail: summary.statusDescription || null };
}

// ---------- FedEx ----------
let _fedexTok = null, _fedexExp = 0;
async function fedexToken() {
  if (_fedexTok && Date.now() < _fedexExp) return _fedexTok;
  const base = process.env.FEDEX_API_BASE || 'https://apis.fedex.com';
  const r = await axios.post(`${base}/oauth/token`, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.FEDEX_CLIENT_ID, client_secret: process.env.FEDEX_CLIENT_SECRET,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  _fedexTok = r.data.access_token;
  _fedexExp = Date.now() + ((r.data.expires_in || 3600) - 60) * 1000;
  return _fedexTok;
}
async function lookupFedex(tn) {
  const base = process.env.FEDEX_API_BASE || 'https://apis.fedex.com';
  const tok = await fedexToken();
  const r = await axios.post(`${base}/track/v1/trackingnumbers`, {
    includeDetailedScans: false,
    trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }],
  }, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_GB' }, timeout: 15000 });
  const tr = r.data?.output?.completeTrackResults?.[0]?.trackResults?.[0] || {};
  const code = tr.latestStatusDetail?.code;          // 'DL' delivered, 'DE' exception, etc.
  let state = code === 'DL' ? 'delivered' : code === 'DE' ? 'exception' : classify(tr.latestStatusDetail?.statusByLocale || tr.latestStatusDetail?.description);
  let deliveredAt = null;
  if (state === 'delivered') deliveredAt = (tr.dateAndTimes || []).find(d => /DELIVERY/i.test(d.type))?.dateTime || null;
  return { state, deliveredAt, detail: tr.latestStatusDetail?.statusByLocale || null };
}

// ---------- DHL ----------
async function lookupDhl(tn) {
  const r = await axios.get('https://api-eu.dhl.com/track/shipments', {
    params: { trackingNumber: tn },
    headers: { 'DHL-API-Key': process.env.DHL_API_KEY, Accept: 'application/json' }, timeout: 15000,
  });
  const sh = r.data?.shipments?.[0] || {};
  const sc = (sh.status?.statusCode || '').toLowerCase();   // 'pre-transit'|'transit'|'delivered'|'failure'|'unknown'
  let state = sc === 'delivered' ? 'delivered' : sc === 'failure' ? 'exception' : (sc === 'transit' || sc === 'pre-transit') ? 'in_transit' : classify(sh.status?.description);
  const deliveredAt = state === 'delivered' ? (sh.status?.timestamp || null) : null;
  return { state, deliveredAt, detail: sh.status?.description || null };
}

// Public: look up one parcel. Returns null when the carrier is unsupported/not
// configured, or on any API error (best-effort — never throws).
async function lookup(carrier, trackingNumber) {
  if (!trackingNumber || !supports(carrier)) return null;
  try {
    if (carrier === 'Royal Mail') return await lookupRoyalMail(trackingNumber);
    if (carrier === 'FedEx') return await lookupFedex(trackingNumber);
    if (carrier === 'DHL') return await lookupDhl(trackingNumber);
  } catch (e) {
    console.warn(`[tracking] ${carrier} ${trackingNumber} lookup failed:`, e.response?.status || e.message);
  }
  return null;
}

module.exports = { lookup, supports, anyConfigured, classify, SUPPORTED };
