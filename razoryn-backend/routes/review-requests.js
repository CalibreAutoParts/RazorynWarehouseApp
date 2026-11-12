// routes/review-requests.js — "How did we do?" review emails (lib/review-requests.js).
//
//   GET  /api/review-requests            admin: settings + stats + recent sends
//   POST /api/review-requests            admin: save settings
//   POST /api/review-requests/run        admin: { dryRun } — who's due / send now
//   POST /api/review-requests/test       admin: email a sample to yourself
//   POST /api/review-requests/preview    admin: the sample email { subject, html } for the form values
//   GET  /api/review-requests/optout     PUBLIC: the link at the bottom of every email
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const rr = require('../lib/review-requests');
const brand = require('../lib/brand');

const router = express.Router();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── PUBLIC: opt out of review emails ────────────────────────────────────────
router.get('/optout', async (req, res) => {
  const email = rr.decodeOptoutEmail(req.query.e);
  const ok = email && rr.verifyEmail(email, req.query.t);
  if (ok) {
    try { await rr.optOut(email); } catch (e) { console.warn('[review-requests] optout:', e.message); }
  }
  const name = esc(brand.name || 'Razoryn e-Parts');
  res.set('Content-Type', 'text/html; charset=utf-8').status(ok ? 200 : 400).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${name}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1a1a1a;line-height:1.5">
<div style="border-top:4px solid ${esc(brand.primaryColor || '#c8202d')};padding-top:16px;font-weight:800;font-size:20px">${name}</div>
${ok
    ? `<h1 style="font-size:20px">You're unsubscribed from review requests</h1>
<p>We won't ask <strong>${esc(email)}</strong> for reviews again. You'll still get the emails about your orders (confirmations, dispatch and collection).</p>`
    : `<h1 style="font-size:20px">That link didn't work</h1>
<p>Please reply to any email from us and we'll take you off the list.</p>`}
${brand.domain ? `<p><a href="https://${esc(brand.domain)}" style="color:${esc(brand.primaryColor || '#c8202d')}">Back to ${esc(brand.domain)}</a></p>` : ''}
</body></html>`);
});

// ── ADMIN ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = require('../services/email');
    const [config, stats] = await Promise.all([rr.getConfig(), rr.stats()]);
    res.json({ config, stats, emailConfigured: email.isConfigured() });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['enabled', 'trustpilotUrl', 'googleUrl', 'daysAfterDelivery', 'daysAfterCollection',
      'fallbackDays', 'includeDirect', 'askProductReviews', 'sendFrom', 'sendTo']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    const bad = ['trustpilotUrl', 'googleUrl'].filter(k => patch[k] && !/^https:\/\//i.test(String(patch[k]).trim()));
    if (bad.length) return res.status(400).json({ error: 'bad_url', message: 'Review links must start with https://' });
    const merged = rr.normalise({ ...(await rr.getConfig()), ...patch });
    if (merged.enabled && !merged.trustpilotUrl && !merged.googleUrl) {
      return res.status(400).json({ error: 'no_links', message: 'Add a Trustpilot or Google review link before switching on.' });
    }
    const config = await rr.saveConfig(patch);
    await audit(req, 'review_requests_config', null, null, { enabled: config.enabled });
    res.json({ ok: true, config });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

router.post('/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const out = await rr.runReviewRequests({ dryRun, force: true });
    if (!dryRun) await audit(req, 'review_requests_run', null, null, { sent: out.sent, failed: out.failed });
    res.json({ ok: true, dryRun, ...out });
  } catch (e) { res.status(500).json({ error: 'run_failed', message: e.message }); }
});

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const to = String(req.body?.to || req.user?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'no_email', message: 'No email address to send the test to.' });
    const cfg = await rr.getConfig();
    if (!cfg.trustpilotUrl && !cfg.googleUrl) return res.status(400).json({ error: 'no_links', message: 'Add a Trustpilot or Google review link first.' });
    const built = rr.sampleEmail(cfg, to);
    const out = await require('../services/email').sendEmail({ to, subject: '[TEST] ' + built.subject, html: built.html });
    if (!out.ok) return res.status(502).json({ error: 'send_failed', message: out.message || out.error });
    res.json({ ok: true, to });
  } catch (e) { res.status(500).json({ error: 'test_failed', message: e.message }); }
});

// Body = the (unsaved) form values, so the preview matches what's on screen.
router.post('/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cfg = rr.normalise({ ...(await rr.getConfig()), ...(req.body || {}) });
    res.json(rr.sampleEmail(cfg, req.user?.email));
  } catch (e) { res.status(500).json({ error: 'preview_failed', message: e.message }); }
});

module.exports = router;
