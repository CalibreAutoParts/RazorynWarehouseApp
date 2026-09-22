// routes/ai.js — Claude automation: settings, usage, and the review queue
// where AI suggestions (category moves, specifics fills) are approved,
// corrected or rejected. Every decision is recorded as feedback the prompts
// learn from. Admin-only: these actions revise LIVE listings.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const ai = require('../services/ai');
const ebay = require('../services/ebay');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/ai/config — settings + key status + usage in one call.
router.get('/config', async (req, res) => {
  const cfg = await ai.getAiConfig();
  let usage = { today: [], last30d: [] };
  try { usage = await ai.usageSummary(); } catch (_) {}
  let pending = 0;
  try {
    await ai.ensureTables();
    pending = parseInt((await query(`SELECT COUNT(*) AS n FROM ai_suggestions WHERE status = 'pending'`)).rows[0]?.n) || 0;
  } catch (_) {}
  res.json({ configured: ai.isConfigured(), config: cfg, usage, pendingSuggestions: pending });
});

// POST /api/ai/config — save settings (partial patch).
router.post('/config', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.mode) patch.mode = b.mode === 'auto' ? 'auto' : 'review';
    if (b.autoThreshold !== undefined) patch.autoThreshold = Math.max(0.5, Math.min(1, parseFloat(b.autoThreshold) || 0.85));
    if (b.bulkModel) patch.bulkModel = String(b.bulkModel);
    if (b.smartModel) patch.smartModel = String(b.smartModel);
    if (b.escalate !== undefined) patch.escalate = !!b.escalate;
    if (b.dailyTokenBudget !== undefined) patch.dailyTokenBudget = Math.max(0, parseInt(b.dailyTokenBudget) || 0);
    if (b.nightly) patch.nightly = { enabled: !!b.nightly.enabled, hourUK: Math.max(0, Math.min(23, parseInt(b.nightly.hourUK) || 3)) };
    if (b.guidance !== undefined) patch.guidance = String(b.guidance).slice(0, 8000);
    const cfg = await ai.saveAiConfig(patch);
    await audit(req, 'ai_config', null, null, { enabled: cfg.enabled, mode: cfg.mode });
    res.json({ ok: true, config: cfg });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// POST /api/ai/test — tiny round-trip to prove the key + model work.
router.post('/test', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'not_configured', message: 'Set ANTHROPIC_API_KEY in Railway variables and redeploy.' });
  try {
    const out = await ai.callClaude({ kind: 'test', user: 'Reply with ONLY this JSON: {"ok":true}', maxTokens: 30 });
    res.json({ ok: !!(out.json && out.json.ok), model: out.model, usage: out.usage });
  } catch (e) { res.status(502).json({ error: e.code || 'api_error', message: e.message }); }
});

// GET /api/ai/suggestions?status=pending — the review queue.
router.get('/suggestions', async (req, res) => {
  await ai.ensureTables();
  const status = req.query.status || 'pending';
  const { rows } = await query(
    `SELECT * FROM ai_suggestions WHERE status = $1 ORDER BY confidence DESC NULLS LAST, created_at DESC LIMIT 200`, [status]);
  res.json({ suggestions: rows });
});

// Apply one suggestion to the LIVE listing. kind 'category' → move the
// category; kind 'specifics' → merge the proposed values into the FULL live
// set (ReviseItem replaces specifics wholesale, so partial sends would wipe).
async function applySuggestion(s, payloadOverride) {
  const payload = payloadOverride || s.payload || {};
  if (s.kind === 'category') {
    const categoryId = String(payload.categoryId || '');
    if (!categoryId) throw new Error('no categoryId in suggestion');
    const r = await ebay.reviseItem(s.ebay_item_id, { categoryId, call: 'ReviseFixedPriceItem' }, s.store_code);
    if (s.product_id) {
      try { await query(`UPDATE products SET ebay_category_id = $1 WHERE id = $2`, [categoryId, s.product_id]); } catch (_) {}
    }
    return { ok: true, categoryId, warnings: r.warnings };
  }
  if (s.kind === 'specifics') {
    const proposed = Array.isArray(payload.specifics) ? payload.specifics.filter(x => x && x.name && x.value) : [];
    if (!proposed.length) throw new Error('no specifics in suggestion');
    const det = await ebay.getItemDetails(s.ebay_item_id, s.store_code);
    const byName = new Map();
    for (const sp of (det.specifics || [])) {
      const val = Array.isArray(sp.values) ? sp.values.join(', ') : (sp.value || '');
      if (sp.name && val) byName.set(sp.name.toLowerCase(), { name: sp.name, value: val });
    }
    for (const sp of proposed) byName.set(sp.name.toLowerCase(), { name: sp.name, value: sp.value });
    const full = [...byName.values()];
    const r = await ebay.reviseItem(s.ebay_item_id, { itemSpecifics: full }, s.store_code);
    return { ok: true, sent: full.length, added: proposed.map(p => p.name), warnings: r.warnings };
  }
  throw new Error('unknown suggestion kind: ' + s.kind);
}

// POST /api/ai/suggestions/:id/approve { payload? } — payload = the human's
// corrected version (recorded as 'edited' feedback so the model learns).
router.post('/suggestions/:id/approve', async (req, res) => {
  await ai.ensureTables();
  const { rows } = await query(`SELECT * FROM ai_suggestions WHERE id = $1`, [req.params.id]);
  const s = rows[0];
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.status !== 'pending') return res.status(409).json({ error: 'already_resolved', status: s.status });
  const edited = req.body && req.body.payload && JSON.stringify(req.body.payload) !== JSON.stringify(s.payload);
  try {
    const result = await applySuggestion(s, edited ? req.body.payload : null);
    await query(`UPDATE ai_suggestions SET status = $2, resolved_by = $3, resolved_at = now(), applied_result = $4::jsonb WHERE id = $1`,
      [s.id, edited ? 'edited' : 'approved', req.user.id, JSON.stringify(result)]);
    await ai.recordFeedback(s.kind, s.context, s.payload, edited ? 'edited' : 'accepted', edited ? req.body.payload : null);
    await audit(req, 'ai_suggestion_approve', 'ai_suggestion', s.id, { kind: s.kind, itemId: s.ebay_item_id, edited });
    res.json({ ok: true, result });
  } catch (e) {
    // Leave it pending with the error visible so it can be retried or rejected.
    await query(`UPDATE ai_suggestions SET applied_result = $2::jsonb WHERE id = $1`,
      [s.id, JSON.stringify({ error: e.message })]).catch(() => {});
    res.status(502).json({ error: 'apply_failed', message: e.message });
  }
});

// POST /api/ai/suggestions/:id/reject { reason? }
router.post('/suggestions/:id/reject', async (req, res) => {
  await ai.ensureTables();
  const { rows } = await query(`SELECT * FROM ai_suggestions WHERE id = $1`, [req.params.id]);
  const s = rows[0];
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.status !== 'pending') return res.status(409).json({ error: 'already_resolved', status: s.status });
  await query(`UPDATE ai_suggestions SET status = 'rejected', resolved_by = $2, resolved_at = now() WHERE id = $1`, [s.id, req.user.id]);
  await ai.recordFeedback(s.kind, s.context, s.payload, 'rejected',
    req.body?.reason ? { rejectReason: String(req.body.reason).slice(0, 300) } : null);
  await audit(req, 'ai_suggestion_reject', 'ai_suggestion', s.id, { kind: s.kind, itemId: s.ebay_item_id });
  res.json({ ok: true });
});

// POST /api/ai/learn — distil recent approve/correct/reject decisions into
// standing rules appended to the guidance (auto-learned section).
router.post('/learn', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'not_configured' });
  try {
    const r = await ai.learnFromFeedback();
    await audit(req, 'ai_learn', null, null, { learned: r.learned });
    res.json(r);
  } catch (e) { res.status(502).json({ error: e.code || 'api_error', message: e.message }); }
});

module.exports = router;
