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

async function callClaude({ kind, system, user, model, maxTokens = 700, images, documents, timeoutMs }) {
  if (!isConfigured()) { const e = new Error('ai_not_configured'); e.code = 'not_configured'; throw e; }
  await ensureTables();
  const cfg = await getAiConfig();
  const used = await usedTokensToday();
  if (cfg.dailyTokenBudget > 0 && used >= cfg.dailyTokenBudget) {
    const e = new Error('daily_token_budget_reached'); e.code = 'budget'; throw e;
  }
  const useModel = model || cfg.bulkModel || DEFAULT_BULK_MODEL;
  // Vision: image URLs become image content blocks ahead of the text (the
  // listing-audit scan sends the product photo so the model can check the
  // part in the picture against the part number and title). PDFs (bank
  // statements) go in as base64 document blocks the same way.
  let content = user;
  const imgs = (images || []).filter(u => /^https:\/\//.test(String(u))).slice(0, 3);
  const docs = (documents || []).filter(d => d && d.base64).slice(0, 2);
  if (imgs.length || docs.length) {
    content = [
      ...docs.map(d => ({ type: 'document', source: { type: 'base64', media_type: d.mediaType || 'application/pdf', data: d.base64 } })),
      ...imgs.map(u => ({ type: 'image', source: { type: 'url', url: u } })),
      { type: 'text', text: user },
    ];
  }
  try {
    const r = await axios.post(API_URL, {
      model: useModel,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: 'user', content }],
    }, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      timeout: timeoutMs || 90000,
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

// ── Deep listing audit — one multimodal call per listing ───────────────────
// Four jobs at once (so each listing costs ONE call):
//   1. Part-number truth check against the PHOTO and the title — and when
//      something's off, say WHERE the mistake is: title, photo or part number.
//   2. Superseded / regional / reference part numbers (e.g. Nissan region
//      codes: same part + fitment, different code per market).
//   3. eBay item specifics per the house rules (origin China, house brand,
//      position, PN + superseded + reference, "Fit for" Make/Model as two
//      separate specifics, vehicle model code like BC3 / AS33, trim when
//      derivable from the part number).
//   4. Shopify SEO: title/meta description within limits + search tags.
async function listingAudit(ctx) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('listing_opt', 5);
  const hasPhoto = !!(ctx.imageUrls && ctx.imageUrls.length);
  const user = `Audit and optimise this car-part listing.${hasPhoto ? ' The listing photo(s) are attached — LOOK at them.' : ' (No photo available — skip photo checks.)'}

Listing: ${JSON.stringify({ title: ctx.title, sku: ctx.sku, partNumber: ctx.partNumber, knownAlternates: ctx.altNumbers || [], position: ctx.position || null, currentEbaySpecifics: (ctx.ebaySpecifics || []).slice(0, 25) })}
House brand: "${ctx.brandName}"

TASKS — reply with ONLY this JSON (omit nothing, use nulls/empty arrays where unknown):
{
 "partNumberCheck": {
   "verdict": "ok"|"mismatch"|"unsure",
   "faultIn": "title"|"photo"|"part_number"|null,   // where the mistake is when things disagree
   "correctPartNumber": "..."|null,                  // only when clearly derivable
   "proposedFix": {                                  // the ready-to-apply correction, when one exists
     "title": "..."|null,                            // corrected listing title (max 80 chars) — ONLY when the title is the fault
     "specifics": [{"name":"...","value":"..."}]     // ONLY the specifics whose CURRENT value is wrong (wrong side, typo'd number…)
   },
   "confidence": <0..1>, "reason": "<short>"
 },
 "altNumbers": {                                     // ONLY numbers you genuinely know — never invent
   "superseded": ["..."],                            // newer numbers replacing this one
   "regional": ["..."],                              // region-specific codes for the SAME part+fitment
   "reference": ["..."],                             // other OE/OEM cross-reference numbers
   "confidence": <0..1>, "reason": "<short>"
 },
 "ebaySpecifics": [{"name":"...","value":"..."} | {"name":"...","values":["...","..."]}],  // full recommended set; use "values" (array) for multi-value specifics like reference numbers
 "shopify": {
   "seoTitle": "<max 60 chars, keyword-led>",
   "seoDescription": "<max 155 chars, readable, includes part number + fitment>",
   "tags": ["..."]                                   // 5-12 search tags (make, model, part type, PN, codes)
 },
 "confidence": <0..1>, "reason": "<one short sentence>"
}

RULES for partNumberCheck: the part in the PHOTO must be the part TYPE the title says, and the part number must belong to that part and vehicle. If the photo shows a different part than the title → faultIn "photo" or "title" (whichever is more likely wrong given the part number). If title and photo agree but the number belongs to something else → faultIn "part_number". correctPartNumber MUST be null when the stored part number is already right (fault in title/photo) or when you can't derive the right one — NEVER echo back the same number as a "correction". A wrong number inside the eBay specifics (while the stored one is right) is faultIn "part_number" with the specifics named in the reason, AND the corrected entry in proposedFix.specifics.
RULES for proposedFix: give the correction ready to apply. Title fault → proposedFix.title: keep the existing title's shape (make, model, years, part name, part number) and change ONLY what's wrong (e.g. the side, or the part name). Wrong values in the current eBay specifics (side, position, a typo'd number) → the corrected entries in proposedFix.specifics. A photo fault has no auto-fix — leave proposedFix empty.

NAMING RULE (titles + SEO everywhere): use what a CUSTOMER calls the part — the popular search term — not the technically pedantic name. A mirror mounted on the door is still a "Wing Mirror"; a bonnet is not an "engine hood panel". A title using a popular synonym for the same part is CORRECT, not a mismatch — only flag a title that names a genuinely different part, side or position.

RULES for ebaySpecifics:
- "Country/Region of Manufacture": "China" unless the data clearly says otherwise.
- "Brand": "${ctx.brandName}".
- "Placement on Vehicle": from position/title (e.g. "Front, Left").
- "Manufacturer Part Number": the part number in the MANUFACTURER'S OWN layout (Hyundai/Kia: 5-5 with a hyphen "86595-BE000"; Stellantis (Peugeot/Citroën/Vauxhall/Fiat): digits grouped with spaces "98 362 310 80"; follow each maker's convention).
- "Reference OE/OEM Number": a "values" ARRAY carrying EVERY way buyers type the number — the hyphenated form, the compact no-separator form ("86595BE000"), the spaced form — plus the known alternates in their forms. Buyers search all of these; each form is its own value (never one long joined string). "Superseded Part Number": from altNumbers.superseded.
- "Make": value MUST start with "Fit for " (e.g. "Fit for Hyundai"), and "Model": value MUST start with "Fit for " (e.g. "Fit for i20") — TWO separate specifics.
- "Vehicle Model Code": the chassis/generation code when known (e.g. Hyundai i20 new shape = "BC3", MG HS new shape = "AS33") — key for telling similar parts apart.
- "Trim": ONLY when the part number pins it to a specific trim level.
- Keep every existing specific that is still correct; correct wrong ones; values max 65 chars.`;
  const out = await callClaude({ kind: 'listing_opt', system, user, maxTokens: 1100, images: ctx.imageUrls });
  const v = out.json;
  if (!v) return null;
  const clamp = (x) => Math.max(0, Math.min(1, +x || 0));
  const strArr = (a) => (Array.isArray(a) ? a.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : []);
  const pn = v.partNumberCheck || {};
  const alt = v.altNumbers || {};
  const specifics = (Array.isArray(v.ebaySpecifics) ? v.ebaySpecifics : [])
    .map(s => {
      if (!s || !s.name) return null;
      // Multi-value specifics (e.g. every typed form of a part number) keep
      // their values as an ARRAY — eBay caps each value at 65 chars.
      if (Array.isArray(s.values)) {
        const vals = s.values.map(x => String(x).trim().slice(0, 65)).filter(Boolean).slice(0, 25);
        return vals.length ? (vals.length > 1 ? { name: String(s.name).slice(0, 65), values: vals } : { name: String(s.name).slice(0, 65), value: vals[0] }) : null;
      }
      if (s.value == null || String(s.value).trim() === '') return null;
      return { name: String(s.name).slice(0, 65), value: String(s.value).slice(0, 65) };
    })
    .filter(Boolean)
    .slice(0, 30);
  const shop = v.shopify || {};
  return {
    partNumberCheck: {
      verdict: ['ok', 'mismatch', 'unsure'].includes(pn.verdict) ? pn.verdict : 'unsure',
      faultIn: ['title', 'photo', 'part_number'].includes(pn.faultIn) ? pn.faultIn : null,
      correctPartNumber: pn.correctPartNumber ? String(pn.correctPartNumber).trim().slice(0, 60) : null,
      fix: {
        title: pn.proposedFix?.title ? String(pn.proposedFix.title).trim().slice(0, 80) : null,
        specifics: (Array.isArray(pn.proposedFix?.specifics) ? pn.proposedFix.specifics : [])
          .filter(x => x && x.name && x.value != null && String(x.value).trim() !== '')
          .map(x => ({ name: String(x.name).slice(0, 65), value: String(x.value).slice(0, 65) }))
          .slice(0, 10),
      },
      confidence: clamp(pn.confidence), reason: String(pn.reason || '').slice(0, 300),
    },
    altNumbers: {
      superseded: strArr(alt.superseded), regional: strArr(alt.regional), reference: strArr(alt.reference),
      confidence: clamp(alt.confidence), reason: String(alt.reason || '').slice(0, 300),
    },
    ebaySpecifics: specifics,
    shopify: {
      seoTitle: shop.seoTitle ? String(shop.seoTitle).slice(0, 70) : null,
      seoDescription: shop.seoDescription ? String(shop.seoDescription).slice(0, 170) : null,
      tags: strArr(shop.tags),
    },
    confidence: clamp(v.confidence), reason: String(v.reason || '').slice(0, 300),
  };
}

// ── Manual alternate-number verification ───────────────────────────────────
// The team finds candidate numbers themselves (supplier sheets, Google) —
// this is the "623106PA0B same as 62310-6PA0A?" check, in-house: given our
// listing and a candidate number, is it genuinely the SAME part + fitment?
// Uses the SMART model (one interactive call, quality matters) and the photo.
async function verifyAltNumber(ctx) {
  const cfg = await getAiConfig();
  const system = baseSystem(cfg.guidance) + await fewShotBlock('alt_check', 5);
  const user = `A team member wants to add an extra part number to one of our car-part listings. Verify it before it goes live.

Our listing: ${JSON.stringify({ title: ctx.title, sku: ctx.sku, partNumber: ctx.partNumber, knownAlternates: ctx.altNumbers || [] })}
Candidate number to verify: "${ctx.candidate}"

Is the candidate genuinely the SAME part and fitment as our part number for this vehicle? Consider:
- superseded / updated revisions (often a letter or digit change at the end, e.g. 62310-6PA0A → 62310-6PA0B)
- regional codes for the same part (different market, identical part + fitment)
- compact vs hyphenated vs spaced forms of the SAME number (that counts as the same)
- and the ways it can be WRONG: the other side (LH vs RH), a different trim level, a different generation/facelift, or a different vehicle entirely.
Reply with ONLY this JSON:
{"same": true|false, "unsure": true|false, "relationship": "superseded"|"regional"|"alternative"|"same_number"|"unrelated", "confidence": <0..1>, "reason": "<one or two short sentences>", "differences": "<ONLY when not the same: what differs — wrong side / trim / generation / vehicle>"|null}`;
  const out = await callClaude({ kind: 'alt_check', system, user, model: cfg.smartModel, maxTokens: 350, images: ctx.imageUrls });
  const v = out.json;
  if (!v) return null;
  return {
    same: v.same === true && v.unsure !== true,
    unsure: v.unsure === true,
    relationship: ['superseded', 'regional', 'alternative', 'same_number', 'unrelated'].includes(v.relationship) ? v.relationship : (v.same ? 'alternative' : 'unrelated'),
    confidence: Math.max(0, Math.min(1, +v.confidence || 0)),
    reason: String(v.reason || '').slice(0, 400),
    differences: v.differences ? String(v.differences).slice(0, 300) : null,
  };
}

// ── Bank statement parsing (the Books / VAT workspace) ─────────────────────
// PDF: Claude reads the document. CSV/Excel export: the rows are parsed
// DETERMINISTICALLY in code (exact, any size — a 3-month export with
// hundreds of lines would overflow a model transcription), and Claude is
// only asked two small questions: which column is which, and what category
// each line is (batched).
// source: legacy base64 string, or { pdfBase64 } or { csvText, filename? }.
async function parseBankStatement(source, ctx = {}) {
  const cfg = await getAiConfig();
  const src = typeof source === 'string' ? { pdfBase64: source } : (source || {});
  if (src.csvText) return parseBankCsv(src, ctx, cfg);
  // Big PDFs (a from-account-opening statement can run 60+ pages / 1000+
  // rows) overflow a single model response — split into page chunks, parse
  // each, and stitch the transactions back together.
  const chunks = await splitPdfForParsing(src.pdfBase64);
  if (chunks && chunks.length > 1) return parseBankPdfChunks(chunks, ctx, cfg);
  const user = `Read this UK business bank statement PDF carefully and extract EVERYTHING.

${ctx.hint ? 'Context from the user: ' + ctx.hint + '\n' : ''}FIRST check what this document actually is: if it is NOT a bank account statement but a MARKETPLACE or payment-processor statement (eBay managed payments, Shopify payouts, PayPal, Amazon, Stripe…), set "notABankStatement": true, say what it is in notes, and return an empty transactions list — it belongs in the marketplace uploader, not the bank one. A business CREDIT CARD export (e.g. Capital on Tap) IS fine here — treat it like a bank account.

Otherwise identify the BANK or card provider (Monzo, Wise, Mettle, ANNA Money, Barclays, Starling, Tide, HSBC, Lloyds, NatWest, Santander, Revolut, Capital on Tap…), the account holder / business name, the statement period, and EVERY transaction in order. Money in and money out must be separate positive numbers. Dates in YYYY-MM-DD.

For each transaction also give your best first guess:
- type: "sale_receipt" (a customer paying us), "payout" (a marketplace paying out — eBay, Shopify, PayPal, Stripe...), "supplier" (stock purchase), "shipping" (couriers: DPD, Evri, Royal Mail, UPS, FedEx, DHL…), "rent", "utilities", "software" (subscriptions/SaaS/eBay+Shopify fees), "food", "office" (office supplies), "fuel", "bank_fees", "wages", "tax_hmrc", "transfer" (between own accounts/pots — INCLUDING repayments to the business credit card, e.g. paying the Capital on Tap bill: the real expenses are the card's own lines, so the repayment must be "transfer" or they'd count twice), "refund" (money we refunded out), "sundry", "other"
- payoutPlatform: "ebay"|"shopify"|"paypal"|"stripe"|null (only for type "payout")
- vatLikely: true if this outgoing almost certainly carries reclaimable UK VAT (standard-rated supplier/shipping/software/office), false otherwise (wages, HMRC, transfers, bank fees, most food…).

Reply with ONLY this JSON:
{"notABankStatement":false,"bank":"...","accountName":"...","sortCodeOrIban":"...or null","periodStart":"YYYY-MM-DD","periodEnd":"YYYY-MM-DD","currency":"GBP",
 "transactions":[{"date":"YYYY-MM-DD","description":"...","moneyIn":<number|0>,"moneyOut":<number|0>,"balance":<number|null>,"type":"...","payoutPlatform":null,"vatLikely":false,"counterparty":"<who, cleaned up>"}],
 "confidence":<0..1>,"notes":"<anything odd: pages unreadable, truncated, totals not matching>"}
Do not invent transactions; if part of the statement is unreadable say so in notes.`;
  const out = await callClaude({
    kind: 'bank_statement', system: 'You are a meticulous UK bookkeeper. You extract bank statements exactly as printed — every line, correct amounts, no inventions. Reply with ONLY JSON.',
    user, model: cfg.smartModel, maxTokens: 16000, timeoutMs: 540000,
    documents: src.pdfBase64 ? [{ base64: src.pdfBase64, mediaType: 'application/pdf' }] : undefined,
  });
  const v = out.json;
  if (!v || !Array.isArray(v.transactions)) return null;
  const num = (x) => { const n = parseFloat(x); return isFinite(n) ? +n.toFixed(2) : 0; };
  return {
    notABankStatement: v.notABankStatement === true,
    bank: String(v.bank || 'Unknown').slice(0, 60),
    accountName: v.accountName ? String(v.accountName).slice(0, 120) : null,
    sortCodeOrIban: v.sortCodeOrIban ? String(v.sortCodeOrIban).slice(0, 60) : null,
    periodStart: v.periodStart || null, periodEnd: v.periodEnd || null,
    currency: String(v.currency || 'GBP').slice(0, 6),
    confidence: Math.max(0, Math.min(1, +v.confidence || 0)),
    notes: v.notes ? String(v.notes).slice(0, 500) : null,
    transactions: v.transactions
      .filter(t => t && t.date && (num(t.moneyIn) > 0 || num(t.moneyOut) > 0))
      .map(t => ({
        date: String(t.date).slice(0, 10),
        description: String(t.description || '').slice(0, 300),
        moneyIn: num(t.moneyIn), moneyOut: num(t.moneyOut),
        balance: t.balance != null && isFinite(parseFloat(t.balance)) ? +parseFloat(t.balance).toFixed(2) : null,
        type: String(t.type || 'other').slice(0, 30),
        payoutPlatform: t.payoutPlatform ? String(t.payoutPlatform).slice(0, 20) : null,
        vatLikely: !!t.vatLikely,
        counterparty: t.counterparty ? String(t.counterparty).slice(0, 120) : null,
      }))
      .slice(0, 2000),
  };
}

// CSV/Excel export pipeline: deterministic row parsing + two small AI calls.
async function parseBankCsv(src, ctx, cfg) {
  const { parseCsv, findHeaderRow, buildTransactions } = require('../lib/csv-bank');
  const rows = parseCsv(String(src.csvText));
  if (rows.length < 2) return null;
  const headerIdx = findHeaderRow(rows);
  const header = rows[headerIdx];
  const sample = rows.slice(headerIdx + 1, headerIdx + 13);
  // Small question 1: which column is which? (headers + a sample, tiny call)
  const mapOut = await callClaude({
    kind: 'bank_csv_map',
    system: 'You map bank-export CSV columns. Reply with ONLY JSON.',
    model: cfg.smartModel, maxTokens: 500,
    user: `This is a UK business bank/credit-card CSV export${src.filename ? ' (file: ' + src.filename + ')' : ''}.${ctx.hint ? ' Context: ' + ctx.hint : ''}
Header row (0-based column indexes): ${JSON.stringify(header)}
Sample data rows: ${JSON.stringify(sample)}

If this is NOT a bank/credit-card export but a marketplace statement (eBay, Shopify payouts, PayPal…), set "notABankStatement": true.
Otherwise identify the columns. amountMode "signed" = one amount column (positive in / negative out); "split" = separate money-in and money-out columns.
Reply ONLY: {"notABankStatement":false,"bank":"Mettle|Wise|ANNA Money|Capital on Tap|…","accountName":"...or null","dateCol":<i>,"dateFormat":"DD/MM/YYYY|MM/DD/YYYY|YYYY-MM-DD|D MMM YYYY","descriptionCols":[<i>,...],"amountMode":"signed"|"split","amountCol":<i|null>,"inCol":<i|null>,"outCol":<i|null>,"balanceCol":<i|null>,"counterpartyCol":<i|null>,"receiptFileCol":<i|null — the column holding attached receipt/invoice FILE NAMES like "Mettle-Receipt-2026-….pdf" or "Mettle-INV-148-2026-05-20.pdf">,"currency":"GBP","notes":"..."}`,
  });
  const map = mapOut.json;
  if (!map) return null;
  if (map.notABankStatement) {
    return { notABankStatement: true, bank: 'Unknown', accountName: null, sortCodeOrIban: null, periodStart: null, periodEnd: null, currency: 'GBP', confidence: 0.9, notes: map.notes || 'marketplace statement', transactions: [] };
  }
  // Exact build from EVERY row — no model output limits involved.
  const txs = buildTransactions(rows, headerIdx, map).slice(0, 5000);
  if (!txs.length) return { notABankStatement: false, bank: map.bank || 'Unknown', accountName: map.accountName || null, sortCodeOrIban: null, periodStart: null, periodEnd: null, currency: map.currency || 'GBP', confidence: 0.3, notes: 'No parsable rows found with the detected columns (' + (map.notes || '') + ')', transactions: [] };
  // Small question 2 (batched): categorise each line. Failures fall back to
  // 'other' — the data itself is already exact.
  for (let i = 0; i < txs.length; i += 80) {
    const chunk = txs.slice(i, i + 80);
    try {
      const catOut = await callClaude({
        kind: 'bank_csv_categorise',
        system: 'You categorise UK business bank transactions. Reply with ONLY JSON.',
        model: cfg.bulkModel, maxTokens: 4000,
        user: `Categorise these bank lines. Types: "sale_receipt" (customer paying us), "payout" (marketplace payout — eBay/Shopify/PayPal/Stripe), "supplier" (stock purchase), "shipping" (couriers), "rent", "utilities", "software", "food", "office", "fuel", "bank_fees", "wages", "tax_hmrc", "transfer" (between own accounts — INCLUDING repayments to a business credit card like Capital on Tap), "refund", "sundry", "other".
Also: payoutPlatform ("ebay"|"shopify"|"paypal"|"stripe"|null) for payouts, and vatLikely=true when the outgoing almost certainly carries reclaimable UK VAT (supplier/shipping/software/office), false otherwise (wages, HMRC, transfers, bank fees, overseas suppliers, most food).
Lines: ${JSON.stringify(chunk.map((t, j) => ({ i: j, date: t.date, description: t.description, in: t.moneyIn, out: t.moneyOut })))}
Reply ONLY: {"items":[{"i":0,"type":"...","payoutPlatform":null,"vatLikely":false}]}`,
      });
      for (const it of (catOut.json?.items || [])) {
        const t = chunk[it.i];
        if (!t) continue;
        t.type = String(it.type || 'other').slice(0, 30);
        t.payoutPlatform = it.payoutPlatform ? String(it.payoutPlatform).slice(0, 20) : null;
        t.vatLikely = !!it.vatLikely;
      }
    } catch (_) { /* budget/API hiccup — lines keep defaults */ }
    for (const t of chunk) { if (!t.type) { t.type = 'other'; t.payoutPlatform = null; t.vatLikely = false; } }
  }
  const dates = txs.map(t => t.date).sort();
  return {
    notABankStatement: false,
    bank: String(map.bank || 'Unknown').slice(0, 60),
    accountName: map.accountName ? String(map.accountName).slice(0, 120) : null,
    sortCodeOrIban: null,
    periodStart: dates[0] || null, periodEnd: dates[dates.length - 1] || null,
    currency: String(map.currency || 'GBP').slice(0, 6),
    confidence: 0.98,
    notes: 'CSV parsed exactly in code (' + txs.length + ' rows); Claude mapped the columns' + (map.notes ? ' — ' + String(map.notes).slice(0, 200) : ''),
    transactions: txs,
  };
}

// Split a long statement PDF into page chunks (pdf-lib). Returns null for
// PDFs small enough to parse in one go, or when pdf-lib isn't installed yet.
async function splitPdfForParsing(pdfBase64, maxPages = 15, chunkPages = 12) {
  let PDFDocument;
  try { ({ PDFDocument } = require('pdf-lib')); } catch (_) { return null; }
  try {
    const srcDoc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'), { ignoreEncryption: true });
    const n = srcDoc.getPageCount();
    if (n <= maxPages) return null;
    const chunks = [];
    for (let start = 0; start < n; start += chunkPages) {
      const end = Math.min(n, start + chunkPages);
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
      for (const p of pages) doc.addPage(p);
      chunks.push({ base64: Buffer.from(await doc.save()).toString('base64'), from: start + 1, to: end, total: n });
    }
    return chunks;
  } catch (e) { console.warn('[ai] pdf split failed:', e.message); return null; }
}

// Chunked large-PDF statement parse: each page-range is extracted with the
// same schema, two chunks in flight at a time, transactions stitched in
// order. Bank/account identity comes from part 1.
async function parseBankPdfChunks(chunks, ctx, cfg) {
  const num = (x) => { const n = parseFloat(x); return isFinite(n) ? +n.toFixed(2) : 0; };
  const oneChunk = async (i) => {
    const c = chunks[i];
    const user = `This is PART ${i + 1} of ${chunks.length} (pages ${c.from}–${c.to} of ${c.total}) of ONE long UK business bank statement.${ctx.hint ? ' Context: ' + ctx.hint : ''}
${i === 0 ? 'FIRST check what this document is: a MARKETPLACE/payment-processor statement (eBay, Shopify, PayPal…) sets "notABankStatement": true with empty transactions. A business credit card (e.g. Capital on Tap) is fine. Identify the BANK, account holder and period.\n' : 'The bank and account were identified from part 1 — just extract this part’s rows.\n'}Extract EVERY transaction row visible on THESE pages exactly as printed (money in / money out as separate positive numbers, dates YYYY-MM-DD). Skip summary/carried-forward lines. For each row also guess: type ("sale_receipt","payout","supplier","shipping","rent","utilities","software","food","office","fuel","bank_fees","wages","tax_hmrc","transfer" — including repayments to a business credit card,"refund","sundry","other"), payoutPlatform ("ebay"|"shopify"|"paypal"|"stripe"|null), vatLikely (true only for UK-VAT-bearing outgoings), counterparty.
Reply ONLY: {"notABankStatement":false,"bank":"...","accountName":"...","sortCodeOrIban":null,"periodStart":null,"periodEnd":null,"currency":"GBP","transactions":[{"date":"YYYY-MM-DD","description":"...","moneyIn":0,"moneyOut":0,"balance":null,"type":"other","payoutPlatform":null,"vatLikely":false,"counterparty":null}],"confidence":<0..1>,"notes":"..."}`;
    const out = await callClaude({
      kind: 'bank_statement', system: 'You are a meticulous UK bookkeeper. You extract bank statements exactly as printed — every line, correct amounts, no inventions. Reply with ONLY JSON.',
      user, model: cfg.smartModel, maxTokens: 16000, timeoutMs: 420000,
      documents: [{ base64: c.base64, mediaType: 'application/pdf' }],
    });
    return out.json;
  };
  const parts = new Array(chunks.length);
  let next = 0;
  const worker = async () => { while (next < chunks.length) { const i = next++; try { parts[i] = await oneChunk(i); } catch (e) { parts[i] = { __error: e.message }; } } };
  await Promise.all([worker(), worker()]);   // two in flight
  const first = parts[0];
  if (!first) return null;
  if (first.notABankStatement) {
    return { notABankStatement: true, bank: 'Unknown', accountName: null, sortCodeOrIban: null, periodStart: null, periodEnd: null, currency: 'GBP', confidence: 0.9, notes: first.notes || 'marketplace statement', transactions: [] };
  }
  const txs = [];
  const failedParts = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.__error || !Array.isArray(p.transactions)) { failedParts.push(`part ${i + 1}${p && p.__error ? ' (' + p.__error + ')' : ''}`); continue; }
    for (const t of p.transactions) {
      if (!t || !t.date || (num(t.moneyIn) <= 0 && num(t.moneyOut) <= 0)) continue;
      txs.push({
        date: String(t.date).slice(0, 10),
        description: String(t.description || '').slice(0, 300),
        moneyIn: Math.max(0, num(t.moneyIn)), moneyOut: Math.max(0, num(t.moneyOut)),
        balance: t.balance != null && isFinite(parseFloat(t.balance)) ? +parseFloat(t.balance).toFixed(2) : null,
        type: String(t.type || 'other').slice(0, 30),
        payoutPlatform: t.payoutPlatform ? String(t.payoutPlatform).slice(0, 20) : null,
        vatLikely: !!t.vatLikely,
        counterparty: t.counterparty ? String(t.counterparty).slice(0, 120) : null,
      });
    }
  }
  const dates = txs.map(t => t.date).sort();
  const confs = parts.filter(p => p && !p.__error).map(p => Math.max(0, Math.min(1, +p.confidence || 0)));
  return {
    notABankStatement: false,
    bank: String(first.bank || 'Unknown').slice(0, 60),
    accountName: first.accountName ? String(first.accountName).slice(0, 120) : null,
    sortCodeOrIban: first.sortCodeOrIban ? String(first.sortCodeOrIban).slice(0, 60) : null,
    periodStart: dates[0] || null, periodEnd: dates[dates.length - 1] || null,
    currency: String(first.currency || 'GBP').slice(0, 6),
    confidence: confs.length ? Math.min(...confs) : 0,
    notes: `Long statement parsed in ${chunks.length} parts (${chunks[0].total} pages)` +
      (failedParts.length ? ` — ⚠ ${failedParts.join(', ')} FAILED: those pages' transactions are missing, re-upload to retry.` : '.') +
      (first.notes ? ' ' + String(first.notes).slice(0, 200) : ''),
    transactions: txs.slice(0, 10000),
  };
}

// ── Marketplace statement parsing (eBay / Shopify monthly statements) ──────
// eBay pays out daily but reports monthly: gross sales minus fees, postage
// labels, advertising, refunds… = the (smaller) net that actually hits the
// bank. This pulls the payout list + the deduction breakdown so Books can
// check every payout landed and explain the difference.
async function parsePlatformStatement(pdfBase64, ctx = {}) {
  const cfg = await getAiConfig();
  const user = `Read this marketplace/payments statement PDF (eBay monthly financial statement, Shopify payouts statement, or similar) carefully.

${ctx.hint ? 'Context from the user: ' + ctx.hint + '\n' : ''}Extract:
1. The platform (ebay, shopify, paypal, stripe…), the statement period (these are usually MONTHLY statements), currency.
2. The SUMMARY money flow: the OPENING BALANCE (funds carried over from the previous month, not yet paid out at the start of the period), gross sales/orders total, refunds given, selling fees (FVF + fixed), postage/shipping labels bought, advertising/promoted-listings charges, any other deductions or charges, the total actually PAID OUT during the period, and the CLOSING BALANCE (funds still pending at the end, carried into next month). Opening + gross − deductions − paid out = closing; say in notes if the statement's own numbers don't add up.
3. EVERY individual payout listed, with its date, payout id/reference (e.g. "P*7693951408" — keep it exactly as printed) and amount.
NOTE: eBay issues TWO statement variants. The FULL statement lists every payout and itemised transactions; the SUMMARY-ONLY version has only aggregated category totals and NO payout list. If this is the summary-only version, return "payouts": [] and say "summary-only statement — no payout list" in notes (never invent payouts from totals).

Reply with ONLY this JSON:
{"platform":"ebay"|"shopify"|"paypal"|"stripe"|"other","periodStart":"YYYY-MM-DD","periodEnd":"YYYY-MM-DD","currency":"GBP",
 "summary":{"openingBalance":<n, signed>,"grossSales":<n>,"refunds":<n>,"fees":<n>,"postageLabels":<n>,"advertising":<n>,"otherDeductions":<n>,"netPayouts":<n>,"closingBalance":<n, signed>},
 "payouts":[{"date":"YYYY-MM-DD","payoutId":"...","amount":<n>}],
 "confidence":<0..1>,"notes":"<anything odd: unreadable pages, totals not adding up>"}
Do not invent numbers; if a summary line isn't on the statement use 0 and say so in notes.`;
  const out = await callClaude({
    kind: 'platform_statement',
    system: 'You are a meticulous UK bookkeeper. You extract marketplace statements exactly as printed — every payout, correct amounts, no inventions. Reply with ONLY JSON.',
    user, model: cfg.smartModel, maxTokens: 16000, timeoutMs: 540000,
    documents: [{ base64: pdfBase64, mediaType: 'application/pdf' }],
  });
  const v = out.json;
  if (!v) return null;
  const num = (x) => { const n = parseFloat(x); return isFinite(n) ? +Math.abs(n).toFixed(2) : 0; };
  const signed = (x) => { const n = parseFloat(x); return isFinite(n) ? +n.toFixed(2) : 0; };
  const s = v.summary || {};
  return {
    platform: ['ebay', 'shopify', 'paypal', 'stripe'].includes(v.platform) ? v.platform : 'other',
    periodStart: v.periodStart || null, periodEnd: v.periodEnd || null,
    currency: String(v.currency || 'GBP').slice(0, 6),
    summary: {
      openingBalance: signed(s.openingBalance), closingBalance: signed(s.closingBalance),
      grossSales: num(s.grossSales), refunds: num(s.refunds), fees: num(s.fees),
      postageLabels: num(s.postageLabels), advertising: num(s.advertising),
      otherDeductions: num(s.otherDeductions), netPayouts: num(s.netPayouts),
    },
    payouts: (Array.isArray(v.payouts) ? v.payouts : [])
      .filter(p => p && p.date && isFinite(parseFloat(p.amount)))
      .map(p => ({ date: String(p.date).slice(0, 10), payoutId: p.payoutId ? String(p.payoutId).slice(0, 60) : null, amount: num(p.amount) }))
      .slice(0, 500),
    confidence: Math.max(0, Math.min(1, +v.confidence || 0)),
    notes: v.notes ? String(v.notes).slice(0, 500) : null,
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
  listingAudit,
  verifyAltNumber,
  parseBankStatement,
  parsePlatformStatement,
  learnFromFeedback,
  recordFeedback,
  queueSuggestion,
  DEFAULT_BULK_MODEL,
  DEFAULT_SMART_MODEL,
};
