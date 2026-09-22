// services/ai.js — Claude API integration: the decision engine behind the
// automated scans (category verdicts, filling missing item specifics) plus the
// learning loop that improves those decisions from what the team accepts,
// corrects or rejects.
//
// Key design points:
//   • The API key lives ONLY in the ANTHROPIC_API_KEY env var (Railway) — never
//     in the DB and never sent to the browser.
//   • Every call is logged to ai_runs (model + token counts), and a daily token
//     budget (Settings) hard-stops spending: over budget → decisions are simply
//     skipped, never queued.
//   • Two-tier models: a cheap fast model for bulk scanning, escalating to the
//     smarter model only when the cheap one isn't confident — most listings are
//     obvious, so the smart model is reserved for the genuinely tricky ones.
//   • Learning: every human decision on an AI suggestion is stored in
//     ai_feedback. Recent examples are injected into prompts as few-shot
//     guidance, and "Learn from decisions" distils them into standing rules.
const axios = require('axios');
const { query } = require('../db');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Model tiers. Bulk = cheap + fast for thousands of routine verdicts; smart =
// escalation for low-confidence cases and for the "learn" distillation.
const DEFAULT_BULK_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_SMART_MODEL = 'claude-sonnet-5';

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// ── Tables ──────────────────────────────────────────────────────────────────
let _ready = false;
async function ensureTables() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS ai_runs (
      id            SERIAL PRIMARY KEY,
      kind          TEXT,
      model         TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      ok            BOOLEAN NOT NULL DEFAULT true,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS ai_runs_day_idx ON ai_runs (created_at)`);
    await query(`CREATE TABLE IF NOT EXISTS ai_suggestions (
      id           SERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,
      ebay_item_id TEXT,
      product_id   INTEGER,
      store_code   TEXT,
      title        TEXT,
      payload      JSONB NOT NULL,
      context      JSONB,
      confidence   NUMERIC(4,3),
      reason       TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      resolved_by  INTEGER,
      resolved_at  TIMESTAMPTZ,
      applied_result JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS ai_suggestions_status_idx ON ai_suggestions (status, created_at DESC)`);
    await query(`CREATE TABLE IF NOT EXISTS ai_feedback (
      id           SERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,
      context      JSONB,
      suggestion   JSONB,
      human_action TEXT NOT NULL,
      final        JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    _ready = true;
  } catch (e) { console.warn('[ai] migration:', e.message); }
}

// ── Config (app_settings.data.ai) ──────────────────────────────────────────
const AI_DEFAULTS = {
  enabled: false,
  mode: 'review',                 // 'review' = queue everything; 'auto' = apply confident fixes
  autoThreshold: 0.85,            // auto-apply at/above this confidence (auto mode)
  bulkModel: DEFAULT_BULK_MODEL,
  smartModel: DEFAULT_SMART_MODEL,
  escalate: true,                 // re-ask the smart model when bulk confidence < escalateBelow
  escalateBelow: 0.7,
  dailyTokenBudget: 2000000,      // input+output tokens per UK day
  nightly: { enabled: false, hourUK: 3 },
  guidance: '',                   // standing rules, editable + auto-learned
};
async function getAiConfig() {
  try {
    const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
    const cfg = { ...AI_DEFAULTS, ...(d.ai || {}) };
    cfg.nightly = { ...AI_DEFAULTS.nightly, ...(cfg.nightly || {}) };
    return cfg;
  } catch (_) { return { ...AI_DEFAULTS }; }
}
async function saveAiConfig(patch) {
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const next = { ...AI_DEFAULTS, ...(d.ai || {}), ...patch };
  if (patch && patch.nightly) next.nightly = { ...AI_DEFAULTS.nightly, ...(d.ai?.nightly || {}), ...patch.nightly };
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...d, ai: next })]);
  return next;
}

// ── Usage / budget ──────────────────────────────────────────────────────────
async function usedTokensToday() {
  await ensureTables();
  const r = await query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM ai_runs
      WHERE created_at >= (date_trunc('day', (now() AT TIME ZONE 'Europe/London')) AT TIME ZONE 'Europe/London')`);
  return parseInt(r.rows[0]?.t) || 0;
}
async function usageSummary() {
  await ensureTables();
  const today = await query(
    `SELECT model, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp, COUNT(*) AS calls
       FROM ai_runs
      WHERE created_at >= (date_trunc('day', (now() AT TIME ZONE 'Europe/London')) AT TIME ZONE 'Europe/London')
      GROUP BY model`);
  const month = await query(
    `SELECT model, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp, COUNT(*) AS calls
       FROM ai_runs WHERE created_at >= now() - interval '30 days' GROUP BY model`);
  const fold = rows => rows.map(r => ({ model: r.model, inputTokens: +r.inp, outputTokens: +r.outp, calls: +r.calls }));
  return { today: fold(today.rows), last30d: fold(month.rows) };
}

// ── Core call ───────────────────────────────────────────────────────────────
// Robust JSON extraction — models occasionally wrap JSON in prose or fences.
function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

async function callClaude({ kind, system, user, model, maxTokens = 700 }) {
  if (!isConfigured()) { const e = new Error('ai_not_configured'); e.code = 'not_configured'; throw e; }
  await ensureTables();
  const cfg = await getAiConfig();
  const used = await usedTokensToday();
  if (cfg.dailyTokenBudget > 0 && used >= cfg.dailyTokenBudget) {
    const e = new Error('daily_token_budget_reached'); e.code = 'budget'; throw e;
  }
  const useModel = model || cfg.bulkModel || DEFAULT_BULK_MODEL;
  try {
    const r = await axios.post(API_URL, {
      model: useModel,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: 'user', content: user }],
    }, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      timeout: 90000,
    });
    const usage = r.data?.usage || {};
    const text = (r.data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    await query(`INSERT INTO ai_runs (kind, model, input_tokens, output_tokens, ok) VALUES ($1,$2,$3,$4,true)`,
      [kind || null, useModel, usage.input_tokens || 0, usage.output_tokens || 0]).catch(() => {});
    return { text, json: extractJson(text), usage, model: useModel };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    await query(`INSERT INTO ai_runs (kind, model, ok, error) VALUES ($1,$2,false,$3)`,
      [kind || null, useModel, msg.slice(0, 500)]).catch(() => {});
    const err = new Error('Claude API: ' + msg); err.code = e.response?.status === 401 ? 'bad_key' : 'api_error';
    throw err;
  }
}

// ── Few-shot from team feedback ─────────────────────────────────────────────
// The team's past decisions on suggestions of the same kind, formatted so the
// model can imitate accepts and avoid repeating rejections/corrections.
async function fewShotBlock(kind, limit = 8) {
  await ensureTables();
  try {
    const { rows } = await query(
      `SELECT context, suggestion, human_action, final FROM ai_feedback
        WHERE kind = $1 ORDER BY created_at DESC LIMIT $2`, [kind, limit]);
    if (!rows.length) return '';
    const lines = rows.map((r, i) => {
      const ctx = JSON.stringify(r.context || {}).slice(0, 300);
      const sug = JSON.stringify(r.suggestion || {}).slice(0, 200);
      const fin = r.final ? JSON.stringify(r.final).slice(0, 200) : null;
      if (r.human_action === 'accepted') return `${i + 1}. INPUT ${ctx} → suggested ${sug} → team ACCEPTED`;
      if (r.human_action === 'edited') return `${i + 1}. INPUT ${ctx} → suggested ${sug} → team CORRECTED to ${fin}`;
      return `${i + 1}. INPUT ${ctx} → suggested ${sug} → team REJECTED${fin ? ' (kept ' + fin + ')' : ''}`;
    });
    return `\n\nRecent decisions by the team on similar cases — imitate what they accept, avoid what they reject or correct:\n${lines.join('\n')}`;
  } catch (_) { return ''; }
}

function baseSystem(guidance) {
  return `You are the listing-quality engine for a UK car-parts seller (eBay UK + Shopify). You make precise, conservative decisions about vehicle-part listings: categories, item specifics, fitment. Never invent facts you cannot infer from the given data — if unsure, say so with a low confidence. Reply with ONLY the requested JSON, no prose.`
    + (guidance && guidance.trim() ? `\n\nStanding rules from the team (always follow these):\n${guidance.trim()}` : '');
}

// ── Decision: which eBay category does this listing belong in? ─────────────
// candidates come from eBay's own taxonomy suggestions; the model picks the
// best one (or keeps the current) — it never invents a category ID.
async function categoryVerdict({ title, partNumber, specifics, current, candidates }) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('category');
  const user = `A live eBay UK listing may be in the wrong category (it was copied from a template).

Listing title: ${title}
Part number: ${partNumber || 'unknown'}
Item specifics: ${JSON.stringify((specifics || []).slice(0, 25))}
CURRENT category: ${JSON.stringify(current)}
CANDIDATE categories (from eBay's own suggester — you MUST choose the id from this list or the current one):
${JSON.stringify(candidates)}

Which category should this listing be in? Reply with ONLY this JSON:
{"categoryId":"<id from candidates or current>","keepCurrent":<true|false>,"confidence":<0..1>,"reason":"<one short sentence>"}`;
  let out = await callClaude({ kind: 'category', system, user, maxTokens: 300 });
  let v = out.json;
  // Escalate genuinely uncertain cases to the smarter model.
  if (cfg.escalate && v && typeof v.confidence === 'number' && v.confidence < (cfg.escalateBelow || 0.7)) {
    try {
      const out2 = await callClaude({ kind: 'category-escalated', system, user, model: cfg.smartModel, maxTokens: 300 });
      if (out2.json) { v = out2.json; v.escalated = true; }
    } catch (_) { /* keep the bulk verdict */ }
  }
  if (!v || !v.categoryId) return null;
  // Guard: only IDs we actually offered.
  const okIds = new Set([...(candidates || []).map(c => String(c.id)), current && current.id != null ? String(current.id) : null].filter(Boolean));
  if (!okIds.has(String(v.categoryId))) return null;
  return { categoryId: String(v.categoryId), keepCurrent: !!v.keepCurrent || String(v.categoryId) === String(current?.id || ''), confidence: Math.max(0, Math.min(1, +v.confidence || 0)), reason: String(v.reason || '').slice(0, 300), escalated: !!v.escalated };
}

// ── Decision: fill a listing's missing REQUIRED item specifics ─────────────
async function fillSpecifics({ title, partNumber, existing, required }) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('specifics');
  const user = `A live eBay UK car-part listing is missing required item specifics.

Listing title: ${title}
Part number: ${partNumber || 'unknown'}
Existing specifics: ${JSON.stringify((existing || []).slice(0, 25))}
MISSING required specifics (with eBay's allowed values where limited):
${JSON.stringify(required)}

Fill only what you can infer confidently from the title/part number/existing specifics (e.g. Brand→"Unbranded" for aftermarket, Make/Model/Placement from the title, "Manufacturer Part Number"→the part number). Use an allowed value when a list is given. OMIT anything you cannot infer — never guess colours, materials or years that aren't in the data. Reply with ONLY this JSON:
{"specifics":[{"name":"...","value":"..."}],"confidence":<0..1>,"reason":"<one short sentence>"}`;
  const out = await callClaude({ kind: 'specifics', system, user, maxTokens: 600 });
  const v = out.json;
  if (!v || !Array.isArray(v.specifics)) return null;
  const wanted = new Set((required || []).map(r => String(r.name || r).toLowerCase()));
  const specifics = v.specifics
    .filter(s => s && s.name && s.value != null && String(s.value).trim() !== '' && wanted.has(String(s.name).toLowerCase()))
    .map(s => ({ name: String(s.name), value: String(s.value).slice(0, 65) }));
  if (!specifics.length) return null;
  return { specifics, confidence: Math.max(0, Math.min(1, +v.confidence || 0)), reason: String(v.reason || '').slice(0, 300) };
}

// ── Decision: part-number sanity for a BATCH of products ───────────────────
// House convention: the SKU's root IS the part number (suffixes like "-2008"
// or an appended word mark shared-pool variants). Two jobs per item:
//   1. missing part number that's clearly derivable from the SKU → "set"
//   2. part number that doesn't belong to the part TYPE being listed (a
//      headlight listing carrying a bumper's number) → "mismatch" for review
async function partNumberBatch(items) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('part_number');
  const user = `Check the part numbers on these car-part listings. House rules:
- The SKU's ROOT is normally the part number: SKUs are the part number plus an optional variant suffix (e.g. "7450B289-2008") or an appended word (e.g. "9820422880CITROEN").
- Every listing's part number must genuinely belong to the part TYPE in its title — a headlight listing must carry a headlight part number, not a bumper's or a grille's. Use your knowledge of OEM/aftermarket numbering and cross-check against the SKU.
For each item give a verdict:
- "ok" — part number present, consistent with the SKU root and plausible for the item type.
- "set" — part number missing but clearly derivable from the SKU: give partNumber.
- "mismatch" — the part number looks wrong for what is being listed, or contradicts the SKU root: explain in reason, and give partNumber ONLY when the correct one is clearly derivable (otherwise null — a human will review).
Items:
${JSON.stringify(items.map(i => ({ id: i.id, sku: i.sku, partNumber: i.part_number || null, title: i.title })))}
Reply with ONLY: {"items":[{"id":<id>,"verdict":"ok"|"set"|"mismatch","partNumber":"..."|null,"confidence":<0..1>,"reason":"<short>"}]}`;
  const out = await callClaude({ kind: 'part_number', system, user, maxTokens: 1800 });
  const ids = new Set(items.map(i => i.id));
  return (out.json && Array.isArray(out.json.items) ? out.json.items : [])
    .filter(v => v && ids.has(v.id))
    .map(v => ({
      id: v.id,
      verdict: ['ok', 'set', 'mismatch'].includes(v.verdict) ? v.verdict : 'ok',
      partNumber: v.partNumber ? String(v.partNumber).trim().slice(0, 60) : null,
      confidence: Math.max(0, Math.min(1, +v.confidence || 0)),
      reason: String(v.reason || '').slice(0, 300),
    }));
}

// ── Decision: what should this listing's price be? ─────────────────────────
// The maths (cost floor, breakeven, competitor delivered prices) is computed in
// code and handed over — the model only makes the judgement call. The caller
// clamps the answer to the floor regardless, so the model can never underprice.
async function pricingVerdict(ctx) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('pricing');
  const user = `Decide the right eBay price for our car-part listing.
Our listing: ${JSON.stringify({ title: ctx.title, sku: ctx.sku, partNumber: ctx.partNumber, currentPrice: ctx.currentPrice, qtyInStock: ctx.qty })}
Cost floor — NEVER price below this: £${ctx.floor != null ? ctx.floor : 'unknown'} (breakeven £${ctx.breakeven != null ? ctx.breakeven : 'unknown'}, floor includes our target margin)
Competitor listings matched to the SAME part (delivered = item price + postage):
${JSON.stringify(ctx.competitors)}
Rules: undercut sensibly but do not race to the bottom; never go below the floor; a gap under ~2% is not worth a change ("keep"); with no meaningful competition price for margin, not down.
Reply with ONLY: {"action":"keep"|"set","price":<number|null>,"confidence":<0..1>,"reason":"<one short sentence>"}`;
  const out = await callClaude({ kind: 'pricing', system, user, maxTokens: 250 });
  const v = out.json;
  if (!v || !v.action) return null;
  const set = v.action === 'set' && v.price != null && isFinite(+v.price) && +v.price > 0;
  return {
    action: set ? 'set' : 'keep',
    price: set ? +(+v.price).toFixed(2) : null,
    confidence: Math.max(0, Math.min(1, +v.confidence || 0)),
    reason: String(v.reason || '').slice(0, 300),
  };
}

// ── Learning: distil recent feedback into standing rules ──────────────────
// Reads the recent feedback log and asks the smart model to write/refresh the
// auto-learned section of the guidance (the hand-written part is untouched).
const LEARNED_MARK = '— Learned rules (auto) —';
async function learnFromFeedback() {
  await ensureTables();
  const cfg = await getAiConfig();
  const { rows } = await query(`SELECT kind, context, suggestion, human_action, final, created_at FROM ai_feedback ORDER BY created_at DESC LIMIT 200`);
  if (!rows.length) return { learned: false, message: 'No feedback recorded yet — approve or reject some AI suggestions first.' };
  const manual = String(cfg.guidance || '').split(LEARNED_MARK)[0].trim();
  const log = rows.map(r =>
    `[${r.kind}] ${JSON.stringify(r.context || {}).slice(0, 250)} | suggested ${JSON.stringify(r.suggestion || {}).slice(0, 150)} | ${r.human_action}${r.final ? ' → ' + JSON.stringify(r.final).slice(0, 150) : ''}`
  ).join('\n');
  const out = await callClaude({
    kind: 'learn',
    model: cfg.smartModel,
    maxTokens: 800,
    system: 'You distil a team\'s decisions on AI listing suggestions into short, general standing rules for future automated decisions. Output ONLY the rules, one per line, each starting with "- ". Rules must be general patterns (not one-off facts), max 12 rules. Do not repeat rules already in the existing hand-written guidance.',
    user: `Existing hand-written guidance:\n${manual || '(none)'}\n\nDecision log (most recent first):\n${log}`,
  });
  const learned = String(out.text || '').trim();
  if (!learned) return { learned: false, message: 'The model produced no rules.' };
  const guidance = (manual ? manual + '\n\n' : '') + LEARNED_MARK + '\n' + learned;
  await saveAiConfig({ guidance });
  return { learned: true, rules: learned, feedbackCount: rows.length };
}

// ── Feedback capture ────────────────────────────────────────────────────────
async function recordFeedback(kind, context, suggestion, humanAction, final) {
  await ensureTables();
  try {
    await query(`INSERT INTO ai_feedback (kind, context, suggestion, human_action, final) VALUES ($1,$2::jsonb,$3::jsonb,$4,$5::jsonb)`,
      [kind, JSON.stringify(context || {}), JSON.stringify(suggestion || {}), humanAction, final ? JSON.stringify(final) : null]);
  } catch (e) { console.warn('[ai] feedback:', e.message); }
}

// ── Suggestion queue helpers (used by the audit + the review endpoints) ────
async function queueSuggestion({ kind, ebayItemId, productId, storeCode, title, payload, context, confidence, reason }) {
  await ensureTables();
  // One pending suggestion per (kind, item/product) — a re-scan refreshes it.
  if (ebayItemId) {
    await query(`DELETE FROM ai_suggestions WHERE kind = $1 AND ebay_item_id = $2 AND status = 'pending'`, [kind, String(ebayItemId)]).catch(() => {});
  } else if (productId) {
    await query(`DELETE FROM ai_suggestions WHERE kind = $1 AND product_id = $2 AND status = 'pending'`, [kind, productId]).catch(() => {});
  }
  const { rows } = await query(
    `INSERT INTO ai_suggestions (kind, ebay_item_id, product_id, store_code, title, payload, context, confidence, reason)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING id`,
    [kind, ebayItemId ? String(ebayItemId) : null, productId || null, storeCode || null, title || null,
     JSON.stringify(payload || {}), JSON.stringify(context || {}), confidence != null ? confidence : null, reason || null]);
  return rows[0].id;
}

module.exports = {
  isConfigured,
  ensureTables,
  getAiConfig,
  saveAiConfig,
  usedTokensToday,
  usageSummary,
  callClaude,
  categoryVerdict,
  fillSpecifics,
  partNumberBatch,
  pricingVerdict,
  learnFromFeedback,
  recordFeedback,
  queueSuggestion,
  DEFAULT_BULK_MODEL,
  DEFAULT_SMART_MODEL,
};
