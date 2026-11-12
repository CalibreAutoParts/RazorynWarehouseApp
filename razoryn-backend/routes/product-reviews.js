// routes/product-reviews.js — our own product reviews (lib/product-reviews.js).
//
//   POST /api/product-reviews                PUBLIC (CORS): the product-page "Write a review" form
//   GET  /api/product-reviews?status=…        admin: list + counts
//   POST /api/product-reviews/:id/moderate    admin: { action: publish | hide | delete | reply, reply? }
//   POST /api/product-reviews/import          admin: { judgeme: true } or { csv: "<file text>" }
//   POST /api/product-reviews/republish       admin: rewrite every product's reviews + stars on Shopify
//   GET|POST /api/product-reviews/settings    admin: { autoPublishVerified }
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const pr = require('../lib/product-reviews');

const router = express.Router();

// ── PUBLIC: submit a review ─────────────────────────────────────────────────
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
const submitLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'rate_limited', message: 'Too many reviews from here — please try again later.' },
});
router.options('/', cors);
router.post('/', cors, submitLimit, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true, status: 'pending' });   // honeypot: bots fill every field
    const out = await pr.submitReview(b, { ip: req.ip });
    if (!out.ok) return res.status(out.error === 'product_not_found' ? 404 : 400).json(out);
    res.json({ ok: true, status: out.status, verified: out.verified });
  } catch (e) {
    console.error('[product-reviews] submit:', e.message);
    res.status(500).json({ ok: false, error: 'submit_failed', message: 'Sorry — that didn’t send. Please try again.' });
  }
});

// ── ADMIN ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = ['pending', 'published', 'hidden', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const [data, settings] = await Promise.all([pr.list({ status, limit: parseInt(req.query.limit, 10) || 100 }), pr.getSettings()]);
    res.json({ ...data, settings });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

router.post('/:id/moderate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const out = await pr.moderate(id, String(req.body?.action || ''), { userId: req.user?.id, reply: req.body?.reply });
    if (!out.ok) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    await audit(req, 'product_review_' + req.body.action, 'product_review', id, null);
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'moderate_failed', message: e.message }); }
});

router.post('/import', requireAuth, requireAdmin, async (req, res) => {
  try {
    let out;
    if (req.body?.judgeme) out = await pr.importJudgeMe();
    else if (req.body?.csv) {
      const rows = pr.parseCsv(req.body.csv);
      if (!rows.length) return res.status(400).json({ error: 'empty_csv', message: 'No rows found in that file.' });
      out = await pr.importRows(rows, 'import:csv');
    } else return res.status(400).json({ error: 'nothing_to_import' });
    if (out.error) return res.status(400).json(out);
    await audit(req, 'product_reviews_import', null, null, out);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: 'import_failed', message: e.message }); }
});

router.post('/republish', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await pr.republishAll()) }); }
  catch (e) { res.status(500).json({ error: 'republish_failed', message: e.message }); }
});

router.get('/settings', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await pr.getSettings()); } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});
router.post('/settings', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ ok: true, settings: await pr.saveSettings({ autoPublishVerified: req.body?.autoPublishVerified }) }); }
  catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

module.exports = router;
