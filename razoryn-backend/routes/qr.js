// routes/qr.js — QR dynamic redirects + scan tracking (marketing ads)
//
// Two routers are exported:
//   • goRouter   — PUBLIC. Mounted at /go (before the SPA fallback) so customers
//                  scanning a printed/posted code hit /go/:code, get logged, and are
//                  302-redirected to the real destination with UTM tags appended.
//   • apiRouter  — ADMIN. Mounted at /api/qr. Register codes (the ad builders emit
//                  data/qr-links-*.json), list them, and read scan stats.
//
// Why a redirect at all: a QR pointing straight at the product page can't be counted
// (a scan just opens a browser). Routing through /go/:code lets us count every scan
// AND repoint a printed code later without reprinting. Conversion rate then comes
// from Shopify analytics via utm_content=<code>.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const SITE_URL = (process.env.SITE_URL || 'https://www.razoryn.co.uk').replace(/\/+$/, '');
const KINDS = ['product', 'collection', 'site', 'promo'];

// ---------------------------------------------------------------------------
// PUBLIC: GET /go/:code  → log scan, redirect to target with UTMs
// ---------------------------------------------------------------------------
const goRouter = express.Router();

function withUtm(target, link, code) {
  let u;
  try { u = new URL(target); } catch { return target; }
  // Respect UTMs already baked into target_url; only fill what's missing.
  if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'qr');
  if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', (link && link.kind) || 'qr');
  if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', (link && link.utm_campaign) || code);
  if (!u.searchParams.has('utm_content')) u.searchParams.set('utm_content', code);
  return u.toString();
}

goRouter.get('/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  let link = null;
  try {
    const { rows } = await query(
      'SELECT * FROM qr_links WHERE code = $1 AND active', [code]);
    link = rows[0] || null;
  } catch (e) {
    // DB down or table not migrated yet — fail open to the storefront.
    console.warn('[qr] lookup failed, redirecting to site:', e.message);
  }

  const target = link ? link.target_url : SITE_URL;

  // Best-effort scan log — never block or fail the redirect on a logging error.
  // (Don't await: the customer should be redirected instantly.)
  query(
    `INSERT INTO qr_scans (code, user_agent, referer, ip) VALUES ($1, $2, $3, $4)`,
    [code, req.get('user-agent') || null, req.get('referer') || null, req.ip || null]
  ).catch((e) => console.warn('[qr] scan log failed:', e.message));

  // 302 (not 301) so the redirect is never cached — every scan reaches us.
  res.redirect(302, withUtm(target, link, code));
});

// ---------------------------------------------------------------------------
// ADMIN: /api/qr/*
// ---------------------------------------------------------------------------
const apiRouter = express.Router();
apiRouter.use(requireAuth, requireAdmin);

// GET /api/qr/links — all codes with lifetime + windowed scan counts
apiRouter.get('/links', async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const { rows } = await query(`
    SELECT l.*,
           COUNT(s.id)::int AS scans_total,
           COUNT(s.id) FILTER (WHERE s.scanned_at > now() - ($1 || ' days')::interval)::int AS scans_window,
           MAX(s.scanned_at) AS last_scan
    FROM qr_links l
    LEFT JOIN qr_scans s ON s.code = l.code
    GROUP BY l.code
    ORDER BY scans_total DESC, l.code
  `, [String(days)]);
  res.json({ links: rows, window_days: days });
});

// GET /api/qr/stats — totals + daily series + top codes
apiRouter.get('/stats', async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const [totals, daily, top] = await Promise.all([
    query(`SELECT COUNT(*)::int AS scans, COUNT(DISTINCT code)::int AS codes_scanned
           FROM qr_scans WHERE scanned_at > now() - ($1 || ' days')::interval`, [String(days)]),
    query(`SELECT date_trunc('day', scanned_at)::date AS day, COUNT(*)::int AS scans
           FROM qr_scans WHERE scanned_at > now() - ($1 || ' days')::interval
           GROUP BY 1 ORDER BY 1`, [String(days)]),
    query(`SELECT s.code, l.label, l.kind, COUNT(*)::int AS scans
           FROM qr_scans s LEFT JOIN qr_links l ON l.code = s.code
           WHERE s.scanned_at > now() - ($1 || ' days')::interval
           GROUP BY s.code, l.label, l.kind ORDER BY scans DESC LIMIT 25`, [String(days)]),
  ]);
  res.json({ window_days: days, totals: totals.rows[0], daily: daily.rows, top: top.rows });
});

function normLink(b) {
  const code = String(b.code || '').trim();
  const target_url = String(b.target_url || '').trim();
  if (!code || !target_url) return null;
  const kind = KINDS.includes(b.kind) ? b.kind : 'product';
  return {
    code, target_url, kind,
    label: b.label ? String(b.label) : null,
    utm_campaign: b.utm_campaign ? String(b.utm_campaign) : null,
    active: b.active === undefined ? true : !!b.active,
  };
}

async function upsertLink(l) {
  await query(`
    INSERT INTO qr_links (code, target_url, kind, label, utm_campaign, active)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (code) DO UPDATE SET
      target_url = EXCLUDED.target_url, kind = EXCLUDED.kind,
      label = EXCLUDED.label, utm_campaign = EXCLUDED.utm_campaign,
      active = EXCLUDED.active
  `, [l.code, l.target_url, l.kind, l.label, l.utm_campaign, l.active]);
}

// POST /api/qr/links — upsert a single code
apiRouter.post('/links', async (req, res) => {
  const l = normLink(req.body || {});
  if (!l) return res.status(400).json({ error: 'code_and_target_required' });
  await upsertLink(l);
  await audit(req, 'qr_link_upsert', 'qr_link', l.code, { kind: l.kind });
  res.json({ ok: true, link: l });
});

// POST /api/qr/import — bulk upsert (paste a generator's qr-links-*.json array,
// or {links:[...]}). Idempotent: re-importing just refreshes targets.
apiRouter.post('/import', async (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : (req.body && req.body.links) || [];
  if (!Array.isArray(arr) || !arr.length) return res.status(400).json({ error: 'links_array_required' });
  let ok = 0; const skipped = [];
  for (const raw of arr) {
    const l = normLink(raw);
    if (!l) { skipped.push(raw && raw.code); continue; }
    await upsertLink(l); ok++;
  }
  await audit(req, 'qr_link_import', 'qr_link', null, { imported: ok, skipped: skipped.length });
  res.json({ ok: true, imported: ok, skipped });
});

// DELETE /api/qr/links/:code — deactivate (keeps scan history)
apiRouter.delete('/links/:code', async (req, res) => {
  const { rowCount } = await query(
    'UPDATE qr_links SET active = false WHERE code = $1', [req.params.code]);
  await audit(req, 'qr_link_deactivate', 'qr_link', req.params.code);
  res.json({ ok: true, deactivated: rowCount });
});

module.exports = { goRouter, apiRouter };
