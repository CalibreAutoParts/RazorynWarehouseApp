// routes/watched.js — Watched listings: parts a logged-in storefront customer
// keeps coming back to, and one-off discount codes to nudge the sale.
//
// PUBLIC (storefront; CORS open; every request is signed):
//   POST /api/watched/view          product-page view beacon from the theme
//   GET  /api/watched/mine          the customer's live offers (product page + My account)
//   GET/POST /api/watched/unsubscribe   opt out of offer emails (link in every email)
// The theme signs each request with t = HMAC-SHA256(`${customerId}|${email}`), computed
// in Liquid with the shared watch key (shop metafield razoryn.watch_key, or the
// VIEW_TRACK_SECRET env var), so only the logged-in customer's own pages can produce
// it. The theme only sends views for customers who accept marketing emails and whose
// cookie choice allows marketing.
//
// STAFF: GET /api/watched · GET/PUT /api/watched/settings · POST /api/watched/offers ·
//        DELETE /api/watched/offers/:id
// SWEEP: runWatchedSweep() (server.js cron) — prunes old views and, when auto-send
//        is switched on, offers each customer their hottest watched part.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const shopify = require('../services/shopify');
const { sendEmail, isConfigured: emailConfigured } = require('../services/email');
const brand = require('../lib/brand');

const router = express.Router();
const STRONG_SOURCES = ['partno', 'direct'];   // searched the part number, or came straight to the URL
const SOURCES = ['partno', 'direct', 'search', 'external', 'browse'];

// ── Tables ──────────────────────────────────────────────────────────────────
let _ready = null;
function ensureTables() {
  if (!_ready) {
    _ready = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS watched_views (
        customer_id     TEXT NOT NULL,
        product_id      TEXT NOT NULL,
        email           TEXT,
        first_name      TEXT,
        handle          TEXT,
        title           TEXT,
        visits          INTEGER NOT NULL DEFAULT 1,   -- separate visits, 30+ min apart
        direct_visits   INTEGER NOT NULL DEFAULT 0,   -- found by part number / direct link
        last_source     TEXT,
        first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
        auto_skip_until TIMESTAMPTZ,
        PRIMARY KEY (customer_id, product_id)
      )`);
      await query(`CREATE INDEX IF NOT EXISTS watched_views_last_seen_idx ON watched_views (last_seen)`);
      await query(`CREATE TABLE IF NOT EXISTS watched_offers (
        id             SERIAL PRIMARY KEY,
        customer_id    TEXT NOT NULL,
        product_id     TEXT NOT NULL,
        email          TEXT,
        product_title  TEXT,
        product_handle TEXT,
        code           TEXT NOT NULL UNIQUE,
        percent        NUMERIC(5,2) NOT NULL,
        discount_gid   TEXT,
        expires_at     TIMESTAMPTZ NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by     TEXT,
        emailed_at     TIMESTAMPTZ,
        email_error    TEXT,
        cancelled_at   TIMESTAMPTZ
      )`);
      await query(`CREATE INDEX IF NOT EXISTS watched_offers_customer_idx ON watched_offers (customer_id, product_id)`);
      await query(`CREATE TABLE IF NOT EXISTS watched_optouts (
        customer_id TEXT PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await query(`CREATE TABLE IF NOT EXISTS watched_settings (
        id            INTEGER PRIMARY KEY DEFAULT 1,
        auto_send     BOOLEAN NOT NULL DEFAULT false,
        percent       NUMERIC(5,2) NOT NULL DEFAULT 5,
        valid_hours   INTEGER NOT NULL DEFAULT 72,
        min_visits    INTEGER NOT NULL DEFAULT 3,
        include_trade BOOLEAN NOT NULL DEFAULT false,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await query(`INSERT INTO watched_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
    })().catch(e => { _ready = null; throw e; });
  }
  return _ready;
}
ensureTables().catch(e => console.warn('[watched] ensureTables:', e.message));

async function getSettings() {
  await ensureTables();
  return (await query(`SELECT * FROM watched_settings WHERE id = 1`)).rows[0];
}

// ── Signing ─────────────────────────────────────────────────────────────────
let _key = null, _keyCheckedAt = 0;
async function watchKey() {
  if (process.env.VIEW_TRACK_SECRET) return process.env.VIEW_TRACK_SECRET;
  // Re-read every 6h once found; retry every 5 min while missing.
  const age = Date.now() - _keyCheckedAt;
  if ((_key && age < 6 * 3600e3) || (!_key && age < 5 * 60e3)) return _key;
  _keyCheckedAt = Date.now();
  try {
    const v = await shopify.getShopMetafieldValue('razoryn', 'watch_key');
    if (v && v.length >= 32) _key = v;
  } catch (e) { console.warn('[watched] watch key lookup failed:', e.message); }
  return _key;
}

function signFor(key, customerId, email) {
  return crypto.createHmac('sha256', key).update(`${customerId}|${email}`).digest('hex');
}

async function verifyCustomer(c, e, t) {
  if (!/^\d{1,20}$/.test(String(c || '')) || !e || !t) return false;
  const key = await watchKey();
  if (!key) return false;
  const want = Buffer.from(signFor(key, String(c), String(e)));
  const got = Buffer.from(String(t));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function storefrontBase() {
  return `https://${String(brand.domain || 'razoryn.co.uk').replace(/^https?:\/\//, '')}`;
}
function publicBase() {
  return (process.env.PUBLIC_BASE_URL || `https://warehouse.${brand.domain || 'razoryn.co.uk'}`).replace(/\/$/, '');
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ── PUBLIC (storefront) ─────────────────────────────────────────────────────
const publicCors = (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};
const publicLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 150, standardHeaders: true, legacyHeaders: false });

// The theme posts with navigator.sendBeacon (text/plain, so no CORS preflight).
router.post('/view', publicCors, publicLimit, express.text({ type: 'text/plain', limit: '4kb' }), async (req, res) => {
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
    b = b || {};
    const c = String(b.c || ''), e = String(b.e || '').trim();
    if (!(await verifyCustomer(c, e, b.t))) return res.status(204).end();
    const p = String(b.p || '');
    if (!/^\d{1,20}$/.test(p)) return res.status(204).end();
    const src = SOURCES.includes(b.s) ? b.s : 'browse';
    const strong = STRONG_SOURCES.includes(src) ? 1 : 0;
    await ensureTables();
    await query(`
      INSERT INTO watched_views (customer_id, product_id, email, first_name, handle, title, visits, direct_visits, last_source)
      VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
      ON CONFLICT (customer_id, product_id) DO UPDATE SET
        visits = watched_views.visits
          + CASE WHEN watched_views.last_seen < now() - interval '30 minutes' THEN 1 ELSE 0 END,
        direct_visits = watched_views.direct_visits
          + CASE WHEN $7 = 1 AND (watched_views.last_seen < now() - interval '30 minutes'
                                  OR watched_views.last_source NOT IN ('partno', 'direct')) THEN 1 ELSE 0 END,
        email = EXCLUDED.email, first_name = EXCLUDED.first_name,
        handle = COALESCE(EXCLUDED.handle, watched_views.handle),
        title = COALESCE(EXCLUDED.title, watched_views.title),
        last_source = EXCLUDED.last_source, last_seen = now()`,
      [c, p, e.toLowerCase(), String(b.n || '').slice(0, 60) || null,
       String(b.h || '').slice(0, 255) || null, String(b.ti || '').slice(0, 255) || null, strong, src]);
    res.status(204).end();
  } catch (e) {
    console.warn('[watched] view failed:', e.message);
    res.status(204).end();
  }
});

// Live offers for the signed-in customer (not used, not expired, part not bought since).
router.get('/mine', publicCors, publicLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const { c, e, t } = req.query;
    if (!(await verifyCustomer(c, e, t))) return res.json({ offers: [] });
    await ensureTables();
    const r = await query(`
      SELECT o.code, o.percent, o.product_id, o.product_handle, o.product_title, o.expires_at
        FROM watched_offers o
       WHERE o.customer_id = $1 AND o.cancelled_at IS NULL AND o.expires_at > now()
         AND NOT EXISTS (
           SELECT 1 FROM sales s
             JOIN sale_items si ON si.sale_id = s.id
             JOIN products pp ON pp.id = si.product_id
            WHERE lower(s.customer_email) = lower($2) AND pp.shopify_product_id = o.product_id
              AND s.occurred_at >= o.created_at)
       ORDER BY o.expires_at`, [String(c), String(e)]);
    res.json({
      offers: r.rows.map(o => ({
        code: o.code, percent: Number(o.percent), productId: o.product_id,
        handle: o.product_handle, title: o.product_title, expiresAt: o.expires_at,
        applyUrl: `/discount/${encodeURIComponent(o.code)}?redirect=${encodeURIComponent('/products/' + (o.product_handle || ''))}`,
      })),
    });
  } catch (err) {
    console.warn('[watched] mine failed:', err.message);
    res.json({ offers: [] });
  }
});

// Unsubscribe: GET shows a confirm button (so link scanners can't opt people out), POST records it.
const unsubPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#1a1a1a}
button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:6px;background:${esc(brand.primaryColor || '#c8202d')};color:#fff;cursor:pointer}</style></head>
<body><h1 style="font-size:1.4rem">${esc(title)}</h1>${body}</body></html>`;

router.get('/unsubscribe', publicLimit, async (req, res) => {
  const { c, e, t } = req.query;
  if (!(await verifyCustomer(c, e, t))) return res.status(404).type('html').send(unsubPage('Link not recognised', '<p>Please reply to the email and we\'ll stop these offers for you.</p>'));
  res.type('html').send(unsubPage('Stop part offers?', `<p>We'll stop emailing you discount offers on parts you've looked at. Order emails and invoices aren't affected.</p>
    <form method="post"><input type="hidden" name="c" value="${esc(c)}"><input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="t" value="${esc(t)}">
    <button type="submit">Unsubscribe from offers</button></form>`));
});

router.post('/unsubscribe', publicLimit, async (req, res) => {
  const { c, e, t } = req.body || {};
  if (!(await verifyCustomer(c, e, t))) return res.status(404).type('html').send(unsubPage('Link not recognised', '<p>Please reply to the email and we\'ll stop these offers for you.</p>'));
  await ensureTables();
  await query(`INSERT INTO watched_optouts (customer_id) VALUES ($1) ON CONFLICT DO NOTHING`, [String(c)]);
  res.type('html').send(unsubPage('You\'re unsubscribed', `<p>You won't get any more part offers from ${esc(brand.name || 'us')}.</p><p><a href="${storefrontBase()}">Back to the shop</a></p>`));
});

// ── Offer creation (staff + sweep) ──────────────────────────────────────────
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `RZ-${s}`;
}

const isTrade = (tags) => (tags || []).some(t => /^trade/i.test(String(t).trim()));

function offerEmailHtml({ firstName, product, code, percent, expiresAt, applyUrl, unsubUrl }) {
  const ends = new Date(expiresAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Europe/London' });
  const red = brand.primaryColor || '#c8202d';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <p>Hi${firstName ? ' ' + esc(firstName) : ''},</p>
  <p>We noticed you've been looking at this part — here's <strong>${percent}% off</strong> to help you decide.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e3e7ee;border-radius:8px;margin:16px 0"><tr>
    ${product.image ? `<td style="padding:12px;width:120px"><img src="${esc(product.image + (product.image.includes('?') ? '&' : '?') + 'width=240')}" alt="" width="110" style="display:block;border-radius:6px"></td>` : ''}
    <td style="padding:12px"><strong style="font-size:15px">${esc(product.title)}</strong>
      <p style="margin:8px 0 0;font-size:13px;color:#555">Your code: <strong style="font-size:16px;letter-spacing:.06em;color:#1a1a1a">${esc(code)}</strong><br>
      Single use, just for you — ends ${esc(ends)}.</p></td>
  </tr></table>
  <p><a href="${esc(applyUrl)}" style="display:inline-block;padding:12px 22px;background:${esc(red)};color:#fff;text-decoration:none;font-weight:bold;border-radius:6px">Get ${percent}% off now &rarr;</a></p>
  <p style="font-size:13px;color:#555">The code is applied automatically from that button. Order by 12pm Mon–Fri for same-day dispatch. Not sure it fits? Reply with your VIN and we'll check before you buy.</p>
  <p style="font-size:11px;color:#888;margin-top:28px">You're getting this because you subscribed to ${esc(brand.name || 'our')} emails. <a href="${esc(unsubUrl)}" style="color:#888">Stop part offers</a>.</p>
</div>`;
}

class OfferError extends Error {}

// Creates the Shopify code and records it; emails it when `email` is true.
// `auto` applies the sweep's stricter rules (consent, trade, opt-out).
async function createOffer({ customerId, productId, percent, hours, email = true, by = 'staff', auto = false, includeTrade = false }) {
  await ensureTables();
  customerId = String(customerId); productId = String(productId);
  percent = Math.round(Number(percent) * 100) / 100;
  hours = Math.round(Number(hours));
  if (!/^\d+$/.test(customerId) || !/^\d+$/.test(productId)) throw new OfferError('bad_ids');
  if (!(percent >= 1 && percent <= 30)) throw new OfferError('Discount must be between 1% and 30%.');
  if (!(hours >= 12 && hours <= 720)) throw new OfferError('Offer must last between 12 hours and 30 days.');

  const live = await query(`SELECT code FROM watched_offers WHERE customer_id = $1 AND product_id = $2
                              AND cancelled_at IS NULL AND expires_at > now() LIMIT 1`, [customerId, productId]);
  if (live.rows[0]) throw new OfferError(`This customer already has a live offer on this part (${live.rows[0].code}).`);
  const optedOut = (await query(`SELECT 1 FROM watched_optouts WHERE customer_id = $1`, [customerId])).rows.length > 0;
  if (email && optedOut) throw new OfferError('This customer unsubscribed from offer emails.');

  const cust = await shopify.getCustomerForOffer(customerId);
  if (!cust) throw new OfferError('Customer not found in Shopify.');
  if (email && !cust.email) throw new OfferError('Customer has no email address.');
  if (email && !cust.subscribed) throw new OfferError('Customer isn\'t subscribed to marketing emails — create the offer without emailing (it still shows on their account and the product page).');
  if (auto && !includeTrade && isTrade(cust.tags)) throw new OfferError('trade_customer');

  const product = await shopify.getProductForOffer(productId);
  if (!product || product.status !== 'ACTIVE') throw new OfferError('Product isn\'t active on the store.');

  const code = newCode();
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString();
  const discountGid = await shopify.createWatchedOfferCode({
    customerId, productId, code, percent, endsAt: expiresAt,
    title: `Watched listing offer ${code} – ${product.title}`.slice(0, 250),
  });
  const ins = await query(`INSERT INTO watched_offers
      (customer_id, product_id, email, product_title, product_handle, code, percent, discount_gid, expires_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [customerId, productId, cust.email, product.title, product.handle, code, percent, discountGid, expiresAt, by]);
  const offer = ins.rows[0];

  if (email) {
    const key = await watchKey();
    const sig = key ? signFor(key, customerId, String(cust.email).toLowerCase()) : '';
    const qs = `c=${customerId}&e=${encodeURIComponent(String(cust.email).toLowerCase())}&t=${sig}`;
    const applyUrl = `${storefrontBase()}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent('/products/' + product.handle)}`;
    const r = await sendEmail({
      to: cust.email,
      subject: `${percent}% off the ${product.title.length > 60 ? 'part' : product.title} you were looking at`,
      html: offerEmailHtml({ firstName: cust.firstName, product, code, percent, expiresAt, applyUrl, unsubUrl: `${publicBase()}/api/watched/unsubscribe?${qs}` }),
    });
    await query(`UPDATE watched_offers SET emailed_at = $2, email_error = $3 WHERE id = $1`,
      [offer.id, r.ok ? new Date() : null, r.ok ? null : (r.error || 'send_failed')]);
    offer.emailed_at = r.ok ? new Date() : null;
    offer.email_error = r.ok ? null : (r.error || 'send_failed');
  }
  return offer;
}

// ── STAFF ───────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const all = req.query.all === '1';
    const st = await getSettings();
    const r = await query(`
      SELECT v.customer_id, v.product_id, v.email, v.first_name, v.visits, v.direct_visits, v.last_source,
             v.first_seen, v.last_seen,
             COALESCE(p.title, v.title) AS product_title, COALESCE(p.shopify_handle, v.handle) AS product_handle,
             p.image_url, p.qty_on_hand,
             o.id AS offer_id, o.code AS offer_code, o.percent AS offer_percent, o.expires_at AS offer_expires,
             o.emailed_at AS offer_emailed, o.email_error AS offer_email_error, o.cancelled_at AS offer_cancelled,
             o.created_at AS offer_created,
             (oo.customer_id IS NOT NULL) AS opted_out,
             EXISTS (SELECT 1 FROM sales s
                       JOIN sale_items si ON si.sale_id = s.id
                       JOIN products pp ON pp.id = si.product_id
                      WHERE lower(s.customer_email) = lower(v.email) AND pp.shopify_product_id = v.product_id
                        AND s.occurred_at >= v.first_seen) AS purchased
        FROM watched_views v
        LEFT JOIN LATERAL (SELECT title, shopify_handle, image_url, qty_on_hand FROM products
                            WHERE shopify_product_id = v.product_id LIMIT 1) p ON true
        LEFT JOIN LATERAL (SELECT * FROM watched_offers
                            WHERE customer_id = v.customer_id AND product_id = v.product_id
                            ORDER BY created_at DESC LIMIT 1) o ON true
        LEFT JOIN watched_optouts oo ON oo.customer_id = v.customer_id
       WHERE v.last_seen > now() - interval '30 days'
         AND ($1::boolean OR v.visits >= 2 OR v.direct_visits >= 1)
       ORDER BY (v.visits + 2 * v.direct_visits) DESC, v.last_seen DESC
       LIMIT 300`, [all]);
    const minVisits = Number(st.min_visits) || 3;
    const rows = r.rows.map(x => ({
      ...x,
      hot: !x.purchased && (x.visits >= minVisits || (x.direct_visits >= 1 && x.visits >= 2)),
    }));
    const tracked = (await query(`SELECT count(DISTINCT customer_id)::int AS customers, count(*)::int AS pairs
                                    FROM watched_views WHERE last_seen > now() - interval '30 days'`)).rows[0];
    const offers = (await query(`SELECT count(*)::int AS sent,
                                        count(*) FILTER (WHERE cancelled_at IS NULL AND expires_at > now())::int AS live
                                   FROM watched_offers WHERE created_at > now() - interval '30 days'`)).rows[0];
    res.json({
      rows, settings: st, tracked, offers,
      status: { keyReady: !!(await watchKey()), emailReady: emailConfigured(), shopifyReady: shopify.isConfigured() },
    });
  } catch (e) {
    console.error('[watched] list failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/settings', requireAuth, requireAdmin, async (req, res) => {
  res.json(await getSettings());
});

router.put('/settings', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const cur = await getSettings();
  const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  const percent = Number(pick(b.percent, cur.percent));
  const hours = parseInt(pick(b.valid_hours, cur.valid_hours), 10);
  const minVisits = parseInt(pick(b.min_visits, cur.min_visits), 10);
  if (!(percent >= 1 && percent <= 30)) return res.status(400).json({ error: 'Discount must be between 1% and 30%.' });
  if (!(hours >= 12 && hours <= 720)) return res.status(400).json({ error: 'Offer must last between 12 hours and 30 days.' });
  if (!(minVisits >= 2 && minVisits <= 20)) return res.status(400).json({ error: 'Visits must be between 2 and 20.' });
  const r = await query(`UPDATE watched_settings SET auto_send = $1, percent = $2, valid_hours = $3, min_visits = $4,
                                include_trade = $5, updated_at = now() WHERE id = 1 RETURNING *`,
    [!!pick(b.auto_send, cur.auto_send), percent, hours, minVisits, !!pick(b.include_trade, cur.include_trade)]);
  res.json(r.rows[0]);
});

router.post('/offers', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const st = await getSettings();
    const offer = await createOffer({
      customerId: b.customerId, productId: b.productId,
      percent: b.percent != null ? b.percent : st.percent,
      hours: b.hours != null ? b.hours : st.valid_hours,
      email: b.email !== false,
      by: req.user?.name || req.user?.email || 'staff',
    });
    res.json({ ok: true, offer });
  } catch (e) {
    const msg = e instanceof OfferError ? e.message
      : /access denied|write_discounts|read_customers/i.test(e.message)
        ? 'Shopify refused — the Razoryn Warehouse app needs the write_discounts and read_customers scopes.'
        : e.message;
    res.status(e instanceof OfferError ? 400 : 502).json({ error: msg });
  }
});

router.delete('/offers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const r = await query(`SELECT * FROM watched_offers WHERE id = $1`, [parseInt(req.params.id, 10)]);
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: 'not_found' });
    if (o.discount_gid && !o.cancelled_at) {
      try { await shopify.deleteDiscountCode(o.discount_gid); }
      catch (e) { if (!/not exist|not found/i.test(e.message)) throw e; }
    }
    await query(`UPDATE watched_offers SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = $1`, [o.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Sweep ───────────────────────────────────────────────────────────────────
// Hourly. Always prunes views older than 90 days. With auto-send on, offers each
// customer (max one offer a week) their hottest part: enough visits, last seen
// 1h–7d ago, not bought since, no offer on it in the last 60 days.
async function runWatchedSweep({ limit = 20 } = {}) {
  await ensureTables();
  await query(`DELETE FROM watched_views WHERE last_seen < now() - interval '90 days'`);
  const st = await getSettings();
  if (!st.auto_send) return { skipped: 'auto_send_off' };
  if (!shopify.isConfigured() || !emailConfigured() || !(await watchKey())) return { skipped: 'not_configured' };

  const r = await query(`
    SELECT v.customer_id, v.product_id
      FROM watched_views v
     WHERE (v.visits >= $1 OR (v.direct_visits >= 1 AND v.visits >= 2))
       AND v.last_seen BETWEEN now() - interval '7 days' AND now() - interval '1 hour'
       AND (v.auto_skip_until IS NULL OR v.auto_skip_until < now())
       AND NOT EXISTS (SELECT 1 FROM watched_optouts oo WHERE oo.customer_id = v.customer_id)
       AND NOT EXISTS (SELECT 1 FROM watched_offers o WHERE o.customer_id = v.customer_id
                         AND (o.created_at > now() - interval '7 days'
                              OR (o.product_id = v.product_id AND o.created_at > now() - interval '60 days')))
       AND NOT EXISTS (SELECT 1 FROM sales s
                         JOIN sale_items si ON si.sale_id = s.id
                         JOIN products pp ON pp.id = si.product_id
                        WHERE lower(s.customer_email) = lower(v.email) AND pp.shopify_product_id = v.product_id
                          AND s.occurred_at >= v.first_seen)
     ORDER BY (v.visits + 2 * v.direct_visits) DESC, v.last_seen DESC
     LIMIT 200`, [Number(st.min_visits) || 3]);

  const done = new Set();
  let sent = 0, skipped = 0, failed = 0;
  for (const row of r.rows) {
    if (sent >= limit) break;
    if (done.has(row.customer_id)) continue;
    try {
      await createOffer({ customerId: row.customer_id, productId: row.product_id, percent: st.percent, hours: st.valid_hours,
                          email: true, by: 'auto', auto: true, includeTrade: st.include_trade });
      done.add(row.customer_id);
      sent++;
    } catch (e) {
      if (e instanceof OfferError) {
        // Not eligible right now (not subscribed, trade, inactive part…) — don't re-check for a week.
        await query(`UPDATE watched_views SET auto_skip_until = now() + interval '7 days' WHERE customer_id = $1 AND product_id = $2`,
          [row.customer_id, row.product_id]);
        skipped++;
      } else {
        failed++;
        console.warn('[watched] auto offer failed:', e.message);
        if (/access denied|scope/i.test(e.message)) break;
      }
    }
  }
  if (sent || failed) console.log(`[watched] auto offers: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { candidates: r.rows.length, sent, skipped, failed };
}

module.exports = router;
module.exports.runWatchedSweep = runWatchedSweep;
module.exports._test = { signFor, newCode, offerEmailHtml, isTrade };
