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
// status=resolved returns recent approved/edited/rejected (the history feed).
router.get('/suggestions', async (req, res) => {
  await ai.ensureTables();
  const status = req.query.status || 'pending';
  let rows;
  if (status === 'resolved') {
    ({ rows } = await query(
      `SELECT * FROM ai_suggestions WHERE status IN ('approved','edited','rejected')
        ORDER BY resolved_at DESC NULLS LAST LIMIT 50`));
  } else {
    ({ rows } = await query(
      `SELECT * FROM ai_suggestions WHERE status = $1 ORDER BY confidence DESC NULLS LAST, created_at DESC LIMIT 200`, [status]));
  }
  res.json({ suggestions: rows });
});

// ── Apply helpers shared by the review queue and the auto-apply paths ──────

// Set a product's part number (warehouse master + the storefront metafield).
async function applyPartNumber(productId, partNumber) {
  await query(`UPDATE products SET part_number = $1, updated_at = now() WHERE id = $2`, [partNumber, productId]);
  try {
    const shopify = require('../services/shopify');
    const pr = await query(`SELECT shopify_product_id FROM products WHERE id = $1`, [productId]);
    const sid = pr.rows[0]?.shopify_product_id;
    if (sid && shopify.isConfigured() && shopify.setPartNumberMetafield) {
      await shopify.setPartNumberMetafield(sid, partNumber);
    }
  } catch (_) { /* metafield push is best-effort */ }
  return { ok: true, partNumber };
}

// Push a new eBay (anchor) price to every channel — same behaviour as the
// bulk-price tool: eBay revised on every linked listing, Shopify derived via
// the configured % (skipped when the product's price is locked), warehouse
// master updated last.
async function applyPriceToProduct(productId, newEbay) {
  const pr = await query(`SELECT id, shopify_product_id, price_locked FROM products WHERE id = $1`, [productId]);
  const p = pr.rows[0];
  if (!p) throw new Error('product not found');
  const sr = await query(`SELECT price_link_pct, bank_transfer_pct FROM app_settings WHERE id = 1`);
  const s = sr.rows[0] || {};
  const pct = s.price_link_pct != null ? parseFloat(s.price_link_pct)
    : (s.bank_transfer_pct != null ? parseFloat(s.bank_transfer_pct) : 10);
  const newShopify = +(newEbay * (1 - pct / 100)).toFixed(2);
  const out = { ok: true, price: newEbay, shopifyPrice: newShopify, ebay: [], shopify: null };
  if (p.shopify_product_id) {
    const links = await query(`SELECT ebay_item_id, store_code FROM mirror_links WHERE shopify_product_id::text = $1`, [String(p.shopify_product_id)]);
    for (const l of links.rows) {
      try { await ebay.reviseItem(l.ebay_item_id, { price: newEbay }, l.store_code); out.ebay.push({ itemId: l.ebay_item_id, ok: true }); }
      catch (e) { out.ebay.push({ itemId: l.ebay_item_id, error: e.message }); }
    }
    try {
      const shopify = require('../services/shopify');
      if (!p.price_locked && shopify.isConfigured()) {
        await shopify.setVariantPrice(String(p.shopify_product_id), newShopify);
        out.shopify = 'ok';
      } else out.shopify = p.price_locked ? 'locked' : 'not_configured';
    } catch (e) { out.shopify = 'error: ' + e.message; }
  }
  if (p.price_locked) await query(`UPDATE products SET price_ebay = $1, updated_at = now() WHERE id = $2`, [newEbay, productId]);
  else await query(`UPDATE products SET price_ebay = $1, price_shopify = $2, updated_at = now() WHERE id = $3`, [newEbay, newShopify, productId]);
  const anyEbayErr = out.ebay.find(x => x.error);
  if (anyEbayErr && !out.ebay.find(x => x.ok)) throw new Error('eBay price push failed: ' + anyEbayErr.error);
  return out;
}

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
  if (s.kind === 'part_number') {
    const pn = String(payload.partNumber || '').trim();
    // A mismatch flag with no proposed number is review-only: approving it just
    // acknowledges the flag (recorded as feedback) without touching the product.
    if (!pn) return { ok: true, acknowledged: true };
    if (!s.product_id) throw new Error('suggestion has no linked product');
    return await applyPartNumber(s.product_id, pn);
  }
  if (s.kind === 'pricing') {
    const price = parseFloat(payload.price);
    if (!(price > 0)) throw new Error('no valid price in suggestion');
    if (!s.product_id) throw new Error('suggestion has no linked product');
    // Guard: even a human-edited price never goes below the recorded floor.
    const floor = parseFloat((s.payload || {}).floor);
    if (isFinite(floor) && floor > 0 && price < floor) throw new Error(`£${price.toFixed(2)} is below the cost floor (£${floor.toFixed(2)})`);
    return await applyPriceToProduct(s.product_id, price);
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

async function aiScanNotify(title, body, severity) {
  try {
    await query(`INSERT INTO notifications (type, title, body, severity, related_type, related_id)
                 VALUES ('ai_scan', $1, $2, $3, NULL, NULL)`, [title, body, severity || 'info']);
  } catch (_) {}
}

// ──────────────────────────────────────────────────────────────────────────
// AI SCAN 1: part numbers (inventory) — batches every active product through
// Claude with the house SKU convention. Finds:
//   • missing part numbers that are clearly sitting in the SKU  → "set"
//     (auto-applied in auto mode at/above the confidence threshold)
//   • part numbers that don't match what's being listed (a headlight carrying
//     a bumper's number) → "mismatch", ALWAYS put aside for review
// ──────────────────────────────────────────────────────────────────────────
let _pnScan = { state: 'idle', total: 0, done: 0, flagged: 0, autoApplied: 0, queued: 0, errors: 0, budgetStopped: false, startedAt: null, finishedAt: null };

async function runPartNumberScan(trigger = 'manual') {
  if (_pnScan.state === 'running') return { ok: true, alreadyRunning: true };
  if (!ai.isConfigured()) return { error: 'ai_not_configured' };
  const cfg = await ai.getAiConfig();
  if (!cfg.enabled) return { error: 'ai_disabled' };
  const { rows } = await query(`SELECT id, sku, title, part_number FROM products WHERE active = true ORDER BY id`);
  if (!rows.length) return { error: 'no_products' };
  _pnScan = { state: 'running', total: rows.length, done: 0, flagged: 0, autoApplied: 0, queued: 0, errors: 0, budgetStopped: false, startedAt: Date.now(), finishedAt: null, trigger };
  setImmediate(async () => {
    const BATCH = 20;
    const auto = cfg.mode === 'auto';
    const thr = cfg.autoThreshold || 0.85;
    for (let i = 0; i < rows.length; i += BATCH) {
      if (_pnScan.state !== 'running') break;
      const batch = rows.slice(i, i + BATCH);
      try {
        const verdicts = await ai.partNumberBatch(batch);
        for (const v of verdicts) {
          const p = batch.find(x => x.id === v.id);
          if (!p || v.verdict === 'ok') continue;
          _pnScan.flagged++;
          const context = { sku: p.sku, title: p.title, partNumber: p.part_number || null, verdict: v.verdict };
          if (v.verdict === 'set' && v.partNumber && auto && v.confidence >= thr) {
            try { await applyPartNumber(p.id, v.partNumber); _pnScan.autoApplied++; continue; }
            catch (_) { /* fall through to queue */ }
          }
          await ai.queueSuggestion({
            kind: 'part_number', productId: p.id, title: p.title,
            payload: { partNumber: v.partNumber || null, sku: p.sku, currentPartNumber: p.part_number || null, issue: v.verdict },
            context, confidence: v.confidence, reason: v.reason,
          });
          _pnScan.queued++;
        }
      } catch (e) {
        if (e.code === 'budget') { _pnScan.budgetStopped = true; break; }
        _pnScan.errors++;
      }
      _pnScan.done = Math.min(rows.length, i + BATCH);
      await new Promise(r2 => setTimeout(r2, 250));
    }
    if (_pnScan.state === 'running') { _pnScan.state = 'done'; _pnScan.done = _pnScan.budgetStopped ? _pnScan.done : _pnScan.total; }
    _pnScan.finishedAt = Date.now();
    if (trigger === 'nightly') {
      await aiScanNotify('Nightly part-number check finished',
        `${_pnScan.done} of ${_pnScan.total} products checked — ${_pnScan.flagged} flagged` +
        (_pnScan.autoApplied ? `, ${_pnScan.autoApplied} fixed automatically` : '') +
        (_pnScan.queued ? `, ${_pnScan.queued} waiting in the AI tab` : '') +
        (_pnScan.budgetStopped ? '. Stopped early: daily token budget reached.' : '.'),
        _pnScan.queued ? 'warn' : 'info');
    }
  });
  return { ok: true, started: true, total: rows.length };
}

router.post('/scan/part-numbers', async (req, res) => {
  const r = await runPartNumberScan('manual');
  if (r.error) return res.status(400).json(r);
  if (r.started) await audit(req, 'ai_pn_scan', null, null, { total: r.total });
  res.json(r);
});
router.get('/scan/part-numbers/status', (req, res) => res.json(_pnScan));
router.post('/scan/part-numbers/cancel', (req, res) => {
  if (_pnScan.state === 'running') { _pnScan.state = 'cancelled'; _pnScan.finishedAt = Date.now(); }
  res.json({ ok: true, state: _pnScan.state });
});

// ──────────────────────────────────────────────────────────────────────────
// AI SCAN 2: pricing & margins vs competitors — for every product with live
// competitor matches, the maths is computed in code (cost floor, breakeven,
// competitor delivered prices) and Claude makes the judgement call: keep or
// set a new price. Prices are clamped to the floor server-side either way.
// Auto mode applies confident changes (never on price-locked products);
// everything else queues in the AI tab.
// ──────────────────────────────────────────────────────────────────────────
const { computeFloor, resolveCostSettings } = require('../lib/pricing-floor');
let _priceScan = { state: 'idle', total: 0, done: 0, fine: 0, flagged: 0, autoApplied: 0, queued: 0, errors: 0, budgetStopped: false, startedAt: null, finishedAt: null };

async function runPricingScan(trigger = 'manual') {
  if (_priceScan.state === 'running') return { ok: true, alreadyRunning: true };
  if (!ai.isConfigured()) return { error: 'ai_not_configured' };
  const cfg = await ai.getAiConfig();
  if (!cfg.enabled) return { error: 'ai_disabled' };
  // Live competitor listings matched to our products.
  const { rows: comps } = await query(`
    SELECT cm.product_id, cl.price, cl.shipping_cost, cl.shipping_free, c.name AS competitor, cm.match_type, cm.confidence
      FROM competitor_match cm
      JOIN competitor_listings cl ON cl.id = cm.listing_id
      JOIN competitors c ON c.id = cl.competitor_id
     WHERE cm.product_id IS NOT NULL AND cm.dismissed = false
       AND cl.available = true AND cl.price IS NOT NULL`);
  const byProduct = new Map();
  for (const r of comps) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({
      competitor: r.competitor,
      delivered: +(parseFloat(r.price) + (r.shipping_free ? 0 : (parseFloat(r.shipping_cost) || 0))).toFixed(2),
      matchType: r.match_type,
    });
  }
  const ids = [...byProduct.keys()];
  if (!ids.length) return { error: 'no_competitor_matches', message: 'No live competitor matches yet — run a competitor scan first.' };
  const { rows: prods } = await query(`
    SELECT p.id, p.sku, p.title, p.part_number, p.price_ebay, p.qty_on_hand, p.price_locked,
           p.cost_price, p.landed_cost, p.large_panel, p.shipping_band, p.shipping_cost, p.postage_in_price,
           shc.shared_cost, shc.shared_landed
      FROM products p
      LEFT JOIN LATERAL (
        SELECT p2.cost_price AS shared_cost, p2.landed_cost AS shared_landed
          FROM products p2
         WHERE p.cost_price IS NULL AND p2.id <> p.id AND p2.active = true AND p2.cost_price IS NOT NULL
           AND ((p.stock_group_id IS NOT NULL AND p2.stock_group_id = p.stock_group_id)
             OR (p.part_number IS NOT NULL AND p.part_number <> '' AND p2.part_number IS NOT NULL AND p2.part_number <> ''
                 AND UPPER(REGEXP_REPLACE(p2.part_number, '[^A-Za-z0-9]', '', 'g')) = UPPER(REGEXP_REPLACE(p.part_number, '[^A-Za-z0-9]', '', 'g'))))
         ORDER BY p2.updated_at DESC NULLS LAST LIMIT 1
      ) shc ON true
     WHERE p.id = ANY($1) AND p.active = true AND p.price_ebay IS NOT NULL`, [ids]);
  const sRow = (await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {};
  const S = resolveCostSettings(sRow);
  _priceScan = { state: 'running', total: prods.length, done: 0, fine: 0, flagged: 0, autoApplied: 0, queued: 0, errors: 0, budgetStopped: false, startedAt: Date.now(), finishedAt: null, trigger };
  setImmediate(async () => {
    const auto = cfg.mode === 'auto';
    const thr = cfg.autoThreshold || 0.85;
    for (const p of prods) {
      if (_priceScan.state !== 'running') break;
      try {
        const cur = parseFloat(p.price_ebay);
        const competitors = (byProduct.get(p.id) || []).sort((a, b) => a.delivered - b.delivered).slice(0, 8);
        let floor = null;
        try {
          const f = computeFloor({
            costPrice: p.cost_price != null ? parseFloat(p.cost_price) : (p.shared_cost != null ? parseFloat(p.shared_cost) : null),
            landedCost: p.landed_cost != null ? parseFloat(p.landed_cost) : (p.shared_landed != null ? parseFloat(p.shared_landed) : null),
            isLarge: !!p.large_panel, band: p.shipping_band, shippingCost: p.shipping_cost,
            postageInPrice: p.postage_in_price, channel: 'ebay', settings: S,
          });
          if (f && f.feasible) floor = f;
        } catch (_) {}
        const cheapest = competitors.length ? competitors[0].delivered : null;
        // Prefilter — no decision worth tokens: within 2% of the cheapest
        // competitor AND not under the floor.
        const underFloor = floor && cur < floor.floor;
        const meaningfulGap = cheapest != null && Math.abs(cur - cheapest) / cur >= 0.02;
        if (!underFloor && !meaningfulGap) { _priceScan.fine++; _priceScan.done++; continue; }

        const verdict = await ai.pricingVerdict({
          title: p.title, sku: p.sku, partNumber: p.part_number, currentPrice: cur, qty: p.qty_on_hand,
          floor: floor ? floor.floor : null, breakeven: floor ? floor.breakeven : null,
          competitors,
        });
        if (!verdict || verdict.action === 'keep' || verdict.price == null) { _priceScan.fine++; _priceScan.done++; continue; }
        let price = verdict.price;
        let clamped = false;
        if (floor && price < floor.floor) { price = floor.floor; clamped = true; }
        if (Math.abs(price - cur) < 0.01) { _priceScan.fine++; _priceScan.done++; continue; }
        _priceScan.flagged++;
        const context = { title: p.title, sku: p.sku, currentPrice: cur, floor: floor ? floor.floor : null, competitors };
        if (auto && verdict.confidence >= thr && !p.price_locked) {
          try { await applyPriceToProduct(p.id, price); _priceScan.autoApplied++; _priceScan.done++; continue; }
          catch (_) { /* fall through to queue */ }
        }
        await ai.queueSuggestion({
          kind: 'pricing', productId: p.id, title: p.title,
          payload: { price, currentPrice: cur, floor: floor ? floor.floor : null, clamped, locked: !!p.price_locked },
          context, confidence: verdict.confidence, reason: verdict.reason + (clamped ? ' (clamped to the cost floor)' : ''),
        });
        _priceScan.queued++;
      } catch (e) {
        if (e.code === 'budget') { _priceScan.budgetStopped = true; break; }
        _priceScan.errors++;
      }
      _priceScan.done++;
      await new Promise(r2 => setTimeout(r2, 200));
    }
    if (_priceScan.state === 'running') _priceScan.state = 'done';
    _priceScan.finishedAt = Date.now();
    if (trigger === 'nightly') {
      await aiScanNotify('Nightly pricing review finished',
        `${_priceScan.done} of ${_priceScan.total} matched products reviewed — ${_priceScan.fine} fine, ${_priceScan.flagged} price changes suggested` +
        (_priceScan.autoApplied ? `, ${_priceScan.autoApplied} applied automatically` : '') +
        (_priceScan.queued ? `, ${_priceScan.queued} waiting in the AI tab` : '') +
        (_priceScan.budgetStopped ? '. Stopped early: daily token budget reached.' : '.'),
        _priceScan.queued ? 'warn' : 'info');
    }
  });
  return { ok: true, started: true, total: prods.length };
}

router.post('/scan/pricing', async (req, res) => {
  const r = await runPricingScan('manual');
  if (r.error) return res.status(400).json(r);
  if (r.started) await audit(req, 'ai_pricing_scan', null, null, { total: r.total });
  res.json(r);
});
router.get('/scan/pricing/status', (req, res) => res.json(_priceScan));
router.post('/scan/pricing/cancel', (req, res) => {
  if (_priceScan.state === 'running') { _priceScan.state = 'cancelled'; _priceScan.finishedAt = Date.now(); }
  res.json({ ok: true, state: _priceScan.state });
});

router.runPartNumberScan = runPartNumberScan;
router.runPricingScan = runPricingScan;
module.exports = router;
