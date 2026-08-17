// services/fcm.js — native Android push via Firebase Cloud Messaging (HTTP v1).
//
// The Capacitor app registers for push, gets an FCM device token, and posts it to
// /api/devices/register (stored in fcm_tokens). Whenever the app fires an OS
// notification (services/push.js sendToAll), we ALSO push it here so the native
// app gets it even when closed — real Android push, not web push.
//
// Configuration (all inert until set — no Firebase, no native push, no errors):
//   FIREBASE_SERVICE_ACCOUNT  — the service-account JSON (as a single-line string)
//                               downloaded from Firebase console. Must contain
//                               project_id, client_email, private_key.
// We mint an OAuth2 access token from the service account with Node crypto (no
// extra dependency) and call the FCM v1 REST API directly with axios.
const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../db');

let _sa = undefined;          // parsed service account (null once we know it's absent)
let _token = null, _tokenExp = 0;
let _ready = false;

function serviceAccount() {
  if (_sa !== undefined) return _sa;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { _sa = null; return _sa; }
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (j.project_id && j.client_email && j.private_key) {
      // Env vars often escape newlines in the private key — restore them.
      j.private_key = String(j.private_key).replace(/\\n/g, '\n');
      _sa = j;
    } else { _sa = null; }
  } catch (e) { console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT parse failed:', e.message); _sa = null; }
  return _sa;
}

function isConfigured() { return !!serviceAccount(); }

// The device registry (app_devices) is owned by routes/devices.js; we only read
// push tokens from it here.
async function ensureTable() {
  if (_ready) return;
  await query(`CREATE TABLE IF NOT EXISTS app_devices (
    device_id   TEXT PRIMARY KEY,
    user_id     INTEGER,
    platform    TEXT,
    model       TEXT,
    app_version TEXT,
    push_token  TEXT,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ready = true;
}

// Mint (and cache) an OAuth2 access token for the FCM scope from the service
// account, using a signed JWT bearer grant.
async function getAccessToken() {
  const sa = serviceAccount();
  if (!sa) throw new Error('fcm_not_configured');
  const now = Math.floor(Date.now() / 1000);
  if (_token && now < _tokenExp - 60) return _token;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const resp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  _token = resp.data.access_token;
  _tokenExp = now + (resp.data.expires_in || 3600);
  return _token;
}

// Send one notification to every registered device that has a push token. Clears
// tokens FCM reports as unregistered (keeps the device row for activity tracking).
// Never throws — push is auxiliary to the in-app notification.
async function sendToAll({ title, body, url, category } = {}) {
  try {
    if (!isConfigured()) return { sent: 0, skipped: 'fcm_not_configured' };
    await ensureTable();
    const sa = serviceAccount();
    const { rows } = await query(`SELECT device_id, push_token FROM app_devices WHERE push_token IS NOT NULL`);
    if (!rows.length) return { sent: 0, total: 0 };
    const accessToken = await getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
    let sent = 0;
    for (const r of rows) {
      const message = {
        message: {
          token: r.push_token,
          notification: { title: title || 'Warehouse Hub', body: body || '' },
          data: { url: String(url || '/'), category: String(category || '') },
          android: { priority: 'HIGH', notification: { default_sound: true } },
        },
      };
      try {
        await axios.post(endpoint, message, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        });
        sent++;
      } catch (e) {
        const status = e.response?.status;
        const errCode = e.response?.data?.error?.status;
        // 404 NOT_FOUND / UNREGISTERED / invalid token → clear it (keep the device).
        if (status === 404 || errCode === 'NOT_FOUND' || errCode === 'UNREGISTERED' || errCode === 'INVALID_ARGUMENT') {
          await query(`UPDATE app_devices SET push_token = NULL WHERE device_id = $1`, [r.device_id]).catch(() => {});
        }
      }
    }
    return { sent, total: rows.length };
  } catch (e) {
    console.warn('[fcm] sendToAll failed:', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { isConfigured, ensureTable, sendToAll };
