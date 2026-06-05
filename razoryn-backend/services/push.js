// services/push.js — Web Push notifications to staff devices (phones/tablets).
//
// Notifications already live in the `notifications` table and show in-app. This
// also delivers them to the OS notification tray via the Web Push protocol, so
// staff see them even when the app isn't open.
//
// VAPID keys: read from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) when set,
// otherwise generated once and persisted in app_settings so push keeps working
// across restarts without any manual key setup.
const webpush = require('web-push');
const { query } = require('../db');

let _configured = false;
let _publicKey = null;

async function ensureSetup() {
  if (_configured) return _publicKey;
  await query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER,
    endpoint    TEXT UNIQUE NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS push_vapid_public TEXT`);
  await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS push_vapid_private TEXT`);
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  const { rows } = await query(`SELECT push_vapid_public, push_vapid_private FROM app_settings WHERE id = 1`);
  let pub = process.env.VAPID_PUBLIC_KEY || rows[0]?.push_vapid_public;
  let priv = process.env.VAPID_PRIVATE_KEY || rows[0]?.push_vapid_private;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    await query(`UPDATE app_settings SET push_vapid_public = $1, push_vapid_private = $2 WHERE id = 1`, [pub, priv]);
    console.log('[push] generated and stored new VAPID keys');
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@warehouse.local';
  webpush.setVapidDetails(subject, pub, priv);
  _publicKey = pub;
  _configured = true;
  return _publicKey;
}

async function getPublicKey() {
  try { return await ensureSetup(); } catch (e) { return null; }
}

async function saveSubscription(userId, sub, userAgent) {
  await ensureSetup();
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('invalid_subscription');
  }
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [userId || null, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null]
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

// Send a push to every subscribed device (best-effort). Dead subscriptions
// (404/410 Gone) are pruned automatically. Never throws — push is auxiliary to
// the in-app notification, so a failure must not break the caller.
async function sendToAll({ title, body, url, tag } = {}) {
  try {
    await ensureSetup();
    const { rows } = await query(`SELECT endpoint, p256dh, auth FROM push_subscriptions`);
    if (!rows.length) return { sent: 0, total: 0 };
    const payload = JSON.stringify({
      title: title || 'Warehouse Hub',
      body: body || '',
      url: url || '/',
      tag: tag || undefined,
    });
    let sent = 0;
    for (const s of rows) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]).catch(() => {});
        }
      }
    }
    return { sent, total: rows.length };
  } catch (e) {
    console.warn('[push] sendToAll failed:', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { ensureSetup, getPublicKey, saveSubscription, removeSubscription, sendToAll };
