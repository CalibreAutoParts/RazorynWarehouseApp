// lib/review-requests.js — "How did we do?" emails.
//
// Once an order has arrived, ask the customer for a review on Trustpilot and/or
// Google (+ optional "rate the part" links to the product pages). Replaces the
// review emails the SendWILL app used to send.
//
// Who:   website (Shopify) orders, plus direct cash/bank/card sales when switched on.
//        Never eBay / OnBuy buyers — marketplace rules forbid off-platform contact.
// When:  N days after delivery (carrier tracking / Shopify "Delivered"), N days
//        after collection (picked up), or — if neither is ever confirmed —
//        `fallbackDays` after dispatch. Only between sendFrom–sendTo UK time.
// Once:  one email per order; one per customer per 60 days; never to anyone who
//        clicked the opt-out link, and never for cancelled / refunded orders.
//
// Settings live in app_settings.data.reviewRequests (Settings → Review requests).
const crypto = require('crypto');
const { query } = require('../db');
const brand = require('./brand');

const DAY = 86400000;
const LOOKBACK_DAYS = 30;          // ignore orders whose arrival is older than this
const PER_CUSTOMER_DAYS = 60;      // at most one request per email address in this window
const MAX_ATTEMPTS = 3;            // give up on an address after 3 failed sends
const DIRECT_CHANNELS = ['direct_cash', 'direct_bank', 'direct_card'];

function defaults() {
  return {
    enabled: false,
    trustpilotUrl: brand.domain ? `https://uk.trustpilot.com/evaluate/${brand.domain}` : '',
    googleUrl: '',
    daysAfterDelivery: 1,
    daysAfterCollection: 1,
    fallbackDays: 10,
    includeDirect: true,
    askProductReviews: brand.code === 'razoryn',
    sendFrom: 9,
    sendTo: 20,
  };
}

const intIn = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};
const httpsUrl = v => {
  const s = String(v || '').trim();
  if (!s) return '';
  try { const u = new URL(s); return u.protocol === 'https:' ? u.toString() : ''; } catch (_) { return ''; }
};

// Merge stored settings over the defaults, clamping every value.
function normalise(raw = {}) {
  const d = defaults();
  const r = raw || {};
  const out = {
    enabled: !!r.enabled,
    trustpilotUrl: r.trustpilotUrl === undefined ? d.trustpilotUrl : httpsUrl(r.trustpilotUrl),
    googleUrl: httpsUrl(r.googleUrl),
    daysAfterDelivery: intIn(r.daysAfterDelivery, 0, 30, d.daysAfterDelivery),
    daysAfterCollection: intIn(r.daysAfterCollection, 0, 30, d.daysAfterCollection),
    fallbackDays: intIn(r.fallbackDays, 1, 30, d.fallbackDays),
    includeDirect: r.includeDirect === undefined ? d.includeDirect : !!r.includeDirect,
    askProductReviews: r.askProductReviews === undefined ? d.askProductReviews : !!r.askProductReviews,
    sendFrom: intIn(r.sendFrom, 0, 23, d.sendFrom),
    sendTo: intIn(r.sendTo, 1, 24, d.sendTo),
  };
  if (out.sendTo <= out.sendFrom) { out.sendFrom = d.sendFrom; out.sendTo = d.sendTo; }
  return out;
}

async function getConfig() {
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  return normalise(d.reviewRequests);
}

async function saveConfig(patch) {
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = normalise({ ...(cur.reviewRequests || {}), ...(patch || {}) });
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, reviewRequests: next })]);
  return next;
}

let _schemaReady = false;
async function ensureSchema() {
  if (_schemaReady) return;
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle TEXT`);   // normally added by routes/settings.js
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS review_request_state TEXT`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS review_request_attempts INTEGER NOT NULL DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS sales_review_request_idx ON sales (lower(customer_email)) WHERE review_request_state = 'sent'`);
  await query(`CREATE TABLE IF NOT EXISTS review_optouts (
    email      TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _schemaReady = true;
}

// ── Opt-out links ──────────────────────────────────────────────────────────
function secret() {
  return process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me';
}
function signEmail(email) {
  return crypto.createHmac('sha256', secret()).update(`review-optout:${String(email).trim().toLowerCase()}`)
    .digest('base64url').slice(0, 24);
}
function verifyEmail(email, sig) {
  const want = signEmail(email);
  const got = String(sig || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function optoutUrl(email) {
  const { publicBaseUrl } = require('./invoice-links');
  const e = Buffer.from(String(email).trim().toLowerCase()).toString('base64url');
  return `${publicBaseUrl()}/api/review-requests/optout?e=${e}&t=${signEmail(email)}`;
}
function decodeOptoutEmail(e) {
  try { return Buffer.from(String(e || ''), 'base64url').toString('utf8').trim().toLowerCase(); } catch (_) { return ''; }
}

// ── When is a sale due? (pure — unit-tested) ───────────────────────────────
// info = Shopify delivery state for a website order (from getOrdersForReview).
// Returns { due, reason: 'collected'|'delivered'|'no_delivery_scan', since, at } or { skip }.
function reviewTiming(sale, info, cfg, now = new Date()) {
  if (info && info.cancelled) return { skip: 'cancelled' };
  if (['cancelled', 'refunded'].includes(sale.status)) return { skip: sale.status };
  const t = v => (v ? new Date(v) : null);
  const collectedAt = t(sale.collected_at) || t(info && info.pickedUpAt);
  const deliveredAt = t(sale.delivered_at) || t(info && info.deliveredAt);
  const dispatchedAt = t(sale.dispatched_at);
  let reason, since, wait;
  if (collectedAt) { reason = 'collected'; since = collectedAt; wait = cfg.daysAfterCollection; }
  else if (deliveredAt) { reason = 'delivered'; since = deliveredAt; wait = cfg.daysAfterDelivery; }
  else if (dispatchedAt) { reason = 'no_delivery_scan'; since = dispatchedAt; wait = cfg.fallbackDays; }
  else return { due: false, reason: 'not_sent_yet' };
  if (now - since > LOOKBACK_DAYS * DAY) return { skip: 'too_old', since };
  const at = new Date(since.getTime() + wait * DAY);
  return { due: at <= now, reason, since, at };
}

function londonHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(now);
  return parseInt(h, 10) || 0;
}
function inSendWindow(cfg, now = new Date()) {
  const h = londonHour(now);
  return h >= cfg.sendFrom && h < cfg.sendTo;
}

// ── Email (pure — unit-tested) ─────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstNameOf(name) {
  const f = String(name || '').trim().split(/\s+/)[0] || '';
  if (!f || /[@\d]/.test(f) || f.length > 20) return '';
  // "barry" / "BARRY" → "Barry"; leave mixed case ("McDonald", "Mary-Jane") alone.
  if (f === f.toLowerCase() || f === f.toUpperCase()) return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
  return f;
}
function productUrl(item) {
  if (item.url) return item.url;
  if (item.handle && brand.domain) return `https://${brand.domain}/products/${item.handle}`;
  return null;
}
function reviewLink(url) {
  return url + (url.includes('?') ? '&' : '?') + 'review=1#rz-reviews';
}
function button(href, label, bg) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700;font-size:15px;margin:0 8px 10px 0">${label}</a>`;
}

/**
 * @param {{ firstName?:string, orderRef:string, items:Array<{title,qty,url?,handle?,image?}>,
 *           reason:string, cfg:object, optout:string, company?:object }} o
 * @returns {{ subject:string, html:string }}
 */
function buildReviewEmail({ firstName, orderRef, items = [], reason, cfg, optout, company = {} }) {
  const name = brand.name || 'Razoryn e-Parts';
  const accent = brand.primaryColor || '#c8202d';
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hi,';
  const parts = items.filter(i => i && i.title && !/^(shipping|delivery|postage|carriage)\b/i.test(i.title));
  const what = parts.length > 1 ? 'your parts' : 'your part';   // titles are long + often CAPS — they're listed below
  const opener = reason === 'collected'
    ? `Thanks for collecting your order <strong>${esc(orderRef)}</strong> from us. We hope ${what} fitted first time.`
    : `Thanks for ordering from ${esc(name)}. Your order <strong>${esc(orderRef)}</strong> should be with you by now, and we hope ${what} fitted first time.`;

  const buttons = [
    cfg.trustpilotUrl ? button(cfg.trustpilotUrl, '&#9733; Review us on Trustpilot', '#00b67a') : '',
    cfg.googleUrl ? button(cfg.googleUrl, 'Review us on Google', '#1a73e8') : '',
  ].join('');

  const rate = cfg.askProductReviews
    ? parts.map(i => ({ ...i, link: productUrl(i) })).filter(i => i.link).slice(0, 6)
    : [];
  const rateBlock = rate.length ? `
      <p style="margin:22px 0 8px;font-weight:700">Rate the part${rate.length > 1 ? 's' : ''} you bought</p>
      <p style="margin:0 0 10px;font-size:14px;color:#555">A quick star rating helps other drivers pick the right part.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
        ${rate.map(i => `<tr>
          <td style="padding:8px 10px 8px 0;border-top:1px solid #eee;width:56px;vertical-align:middle">${i.image
            ? `<img src="${esc(i.image)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #eee">`
            : ''}</td>
          <td style="padding:8px 0;border-top:1px solid #eee;font-size:14px;vertical-align:middle">${esc(i.title)}<br>
            <a href="${esc(reviewLink(i.link))}" style="color:${accent};font-weight:700;text-decoration:none">&#9734;&#9734;&#9734;&#9734;&#9734; Rate this part &rarr;</a></td>
        </tr>`).join('')}
      </table>` : '';

  const contact = company.company_phone ? ` or call ${esc(company.company_phone)}` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.5">
    <div style="border-top:4px solid ${accent};padding:18px 4px 6px"><div style="font-weight:800;font-size:20px;letter-spacing:-.01em">${esc(name)}</div></div>
    <div style="padding:6px 4px">
      <h2 style="font-size:20px;margin:10px 0">How did we do?</h2>
      <p style="margin:6px 0">${hi}</p>
      <p style="margin:6px 0">${opener}</p>
      <p style="margin:12px 0 16px">Could you spare a minute to leave us a review? It makes a real difference to an independent parts business like ours, and it helps other drivers find parts they can trust.</p>
      ${buttons}
      ${rateBlock}
      <p style="margin:22px 0 0;font-size:14px;color:#555">Something not right with your order? Just reply to this email${contact} and we'll put it right.</p>
    </div>
    <div style="border-top:1px solid #eee;margin-top:20px;padding-top:12px;font-size:12px;color:#888">
      ${esc(name)}${brand.domain ? ' · ' + esc(brand.domain) : ''}<br>
      We only ask once per order. <a href="${esc(optout)}" style="color:#888">Don't send me review requests</a>
    </div>
  </div>`;
  const subject = `${firstName ? `${firstName}, how` : 'How'} did we do? Your ${name} order ${orderRef}`;
  return { subject, html };
}

// ── Runner ─────────────────────────────────────────────────────────────────
function saleRef(sale, info) {
  return (info && info.name) || sale.order_number || sale.invoice_number || sale.payment_reference || `#${sale.id}`;
}

async function directItems(saleId) {
  const r = await query(`
    SELECT si.title, si.qty, p.shopify_handle AS handle
      FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1 ORDER BY si.id`, [saleId]);
  return r.rows;
}

async function candidates(cfg, { limit = 500 } = {}) {
  const channels = ['shopify', ...(cfg.includeDirect ? DIRECT_CHANNELS : [])];
  const r = await query(`
    SELECT s.* FROM sales s
     WHERE s.is_estimate = false
       AND s.review_requested_at IS NULL
       AND COALESCE(s.customer_email, '') LIKE '%@%'
       AND s.customer_email !~* '@members\\.ebay\\.'
       AND s.status NOT IN ('cancelled', 'refunded')
       AND s.channel = ANY($1)
       AND (s.dispatched_at IS NOT NULL OR s.collected_at IS NOT NULL)
       AND COALESCE(s.collected_at, s.delivered_at, s.dispatched_at) >= now() - ($2 || ' days')::interval
     ORDER BY COALESCE(s.collected_at, s.delivered_at, s.dispatched_at) ASC
     LIMIT $3`, [channels, String(LOOKBACK_DAYS), limit]);
  return r.rows;
}

async function mark(saleId, state, { final = true } = {}) {
  if (final) {
    await query(`UPDATE sales SET review_requested_at = now(), review_request_state = $2 WHERE id = $1`, [saleId, state]);
  } else {
    await query(`UPDATE sales SET review_request_attempts = review_request_attempts + 1, review_request_state = $2,
                   review_requested_at = CASE WHEN review_request_attempts + 1 >= $3 THEN now() ELSE NULL END
                 WHERE id = $1`, [saleId, state, MAX_ATTEMPTS]);
  }
}

/**
 * Send every review request that's due.
 * @param {{ dryRun?:boolean, force?:boolean, limit?:number }} opts
 *   dryRun — work out who would be emailed, send nothing, change nothing.
 *   force  — ignore the on/off switch and the send-hours window (admin "Run now").
 */
async function runReviewRequests({ dryRun = false, force = false, limit = 25 } = {}) {
  await ensureSchema();
  const cfg = await getConfig();
  if (!cfg.enabled && !force && !dryRun) return { skipped: 'disabled', sent: 0 };
  if (!cfg.trustpilotUrl && !cfg.googleUrl) return { skipped: 'no_review_links', sent: 0 };
  if (!force && !dryRun && !inSendWindow(cfg)) return { skipped: 'outside_send_hours', sent: 0 };
  const email = require('../services/email');
  if (!dryRun && !email.isConfigured()) return { skipped: 'email_not_configured', sent: 0 };

  const rows = await candidates(cfg);
  const shopifyIds = rows.filter(s => s.channel === 'shopify' && s.external_order_id).map(s => s.external_order_id);
  let infos = new Map();
  if (shopifyIds.length) {
    try { infos = await require('../services/shopify').getOrdersForReview(shopifyIds); }
    catch (e) { console.warn('[review-requests] shopify lookup failed:', e.message); return { error: e.message, sent: 0 }; }
  }
  const optouts = new Set((await query(`SELECT email FROM review_optouts`)).rows.map(r => r.email));
  let company = {};
  try { company = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {}; } catch (_) {}

  const out = { checked: rows.length, sent: 0, skipped: 0, failed: 0, waiting: 0, due: [] };
  const emailedThisRun = new Set();
  for (const sale of rows) {
    if (out.sent + out.failed >= limit) break;
    const info = sale.channel === 'shopify' ? infos.get(String(sale.external_order_id)) : null;
    const timing = reviewTiming(sale, info, cfg);
    const to = String(sale.customer_email).trim().toLowerCase();
    if (timing.skip) {
      if (!dryRun) await mark(sale.id, `skipped_${timing.skip}`);
      out.skipped++; continue;
    }
    if (!timing.due) { out.waiting++; continue; }
    let skip = null;
    if (optouts.has(to)) skip = 'skipped_optout';
    else if (emailedThisRun.has(to)) skip = 'skipped_recent';
    else {
      const recent = await query(`SELECT 1 FROM sales WHERE lower(customer_email) = $1 AND review_request_state = 'sent'
                                    AND review_requested_at > now() - ($2 || ' days')::interval LIMIT 1`,
        [to, String(PER_CUSTOMER_DAYS)]);
      if (recent.rows.length) skip = 'skipped_recent';
    }
    if (skip) { if (!dryRun) await mark(sale.id, skip); out.skipped++; continue; }

    const items = info ? info.items : await directItems(sale.id);
    const built = buildReviewEmail({
      firstName: (info && info.firstName) ? firstNameOf(info.firstName) : firstNameOf(sale.customer_name),
      orderRef: saleRef(sale, info), items, reason: timing.reason, cfg, optout: optoutUrl(to), company,
    });
    out.due.push({ saleId: sale.id, order: saleRef(sale, info), email: to, reason: timing.reason, since: timing.since });
    if (dryRun) { emailedThisRun.add(to); continue; }
    const r = await email.sendEmail({ to, subject: built.subject, html: built.html, replyTo: company.company_email || undefined });
    if (r.ok) { await mark(sale.id, 'sent'); out.sent++; emailedThisRun.add(to); }
    else { await mark(sale.id, 'failed', { final: false }); out.failed++; console.warn('[review-requests] send failed', sale.id, r.error); }
  }
  return out;
}

// Sample email for the Settings preview / "send me a test".
function sampleEmail(cfg, to) {
  return buildReviewEmail({
    firstName: 'Sam', orderRef: '#TEST1001', reason: 'delivered', cfg,
    items: [{ title: 'Example part — front left headlight', qty: 1, handle: null, url: brand.domain ? `https://${brand.domain}` : null }],
    optout: optoutUrl(to || 'test@example.com'),
  });
}

async function stats() {
  await ensureSchema();
  const r = await query(`
    SELECT
      COUNT(*) FILTER (WHERE review_request_state = 'sent' AND review_requested_at > now() - INTERVAL '30 days') AS sent30,
      COUNT(*) FILTER (WHERE review_request_state = 'sent') AS sent_all,
      COUNT(*) FILTER (WHERE review_request_state LIKE 'skipped_%' AND review_requested_at > now() - INTERVAL '30 days') AS skipped30,
      COUNT(*) FILTER (WHERE review_request_state = 'failed') AS failed
    FROM sales WHERE review_request_state IS NOT NULL`);
  const recent = await query(`
    SELECT id, channel, order_number, invoice_number, customer_name, review_requested_at, review_request_state
      FROM sales WHERE review_requested_at IS NOT NULL
     ORDER BY review_requested_at DESC LIMIT 25`);
  const optouts = (await query(`SELECT COUNT(*)::int AS n FROM review_optouts`)).rows[0].n;
  const s = r.rows[0] || {};
  return {
    sent30: +s.sent30 || 0, sentAll: +s.sent_all || 0, skipped30: +s.skipped30 || 0, failed: +s.failed || 0,
    optouts, recent: recent.rows,
  };
}

async function optOut(email) {
  await ensureSchema();
  await query(`INSERT INTO review_optouts (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [String(email).trim().toLowerCase()]);
}

module.exports = {
  defaults, normalise, getConfig, saveConfig, ensureSchema,
  reviewTiming, inSendWindow, londonHour, buildReviewEmail, firstNameOf, sampleEmail,
  runReviewRequests, stats, optOut, optoutUrl, signEmail, verifyEmail, decodeOptoutEmail,
};
