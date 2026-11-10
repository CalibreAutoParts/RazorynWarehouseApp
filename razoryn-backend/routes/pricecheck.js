// routes/pricecheck.js — "Should we order it?" price checker (admin only).
//   POST /api/pricecheck/check   { partNumber, q?, used? } → market + our data
//   POST /api/pricecheck/save    { …the numbers the page worked out } → saved check
//   GET  /api/pricecheck/history ?q=
//   DELETE /api/pricecheck/:id
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const pc = require('../services/price-check');

const router = express.Router();
router.use(requireAuth, requireAdmin);

let _ready = null;
const ready = () => (_ready = _ready || pc.ensureSchema());

// eBay answers are cached for 30 min per search so re-opening a check (or a
// bulk list) doesn't spend API calls again.
const cache = new Map();
router.post('/check', async (req, res) => {
  const pn = String(req.body?.partNumber || '').trim().slice(0, 80);
  if (!pn) return res.status(400).json({ error: 'part_number_required', message: 'Enter a part number.' });
  const q = String(req.body?.q || '').trim().slice(0, 120) || undefined;
  const used = !!req.body?.used;
  const key = [pc.norm(pn), q || '', used].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000 && !req.body?.fresh) return res.json({ ...hit.result, cached: true });
  try {
    await ready();
    const result = await pc.check(pn, { q, used });
    const prev = (await query(`SELECT id, supplier, supplier_cost, currency, cost_gbp, postage, sell_price, qty, verdict, notes, created_at
        FROM price_checks WHERE upper(part_number) = upper($1) ORDER BY created_at DESC LIMIT 5`, [pn])).rows;
    result.previous = prev;
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    res.json(result);
  } catch (e) {
    const msg = String(e.message || e);
    res.status(502).json({ error: 'ebay_failed', message: /Browse|token|401|403/i.test(msg) ? 'eBay search failed — ' + msg : msg });
  }
});

router.post('/save', async (req, res) => {
  await ready();
  const b = req.body || {};
  const pn = String(b.partNumber || '').trim().slice(0, 80);
  if (!pn) return res.status(400).json({ error: 'part_number_required' });
  const n = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const r = (await query(`INSERT INTO price_checks (part_number, query, result, supplier, supplier_cost, currency, cost_gbp, postage, sell_price, qty, verdict, notes, created_by)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [pn, b.query || null, JSON.stringify(b.result || null), String(b.supplier || '').slice(0, 120) || null,
     n(b.supplierCost), String(b.currency || 'GBP').slice(0, 3), n(b.costGbp), n(b.postage), n(b.sellPrice),
     b.qty != null && b.qty !== '' ? parseInt(b.qty) || null : null, String(b.verdict || '').slice(0, 40) || null,
     String(b.notes || '').slice(0, 2000) || null, req.user.id])).rows[0];
  await audit(req, 'price_check_save', 'price_check', r.id, { partNumber: pn, verdict: r.verdict });
  res.json({ ok: true, check: r });
});

router.get('/history', async (req, res) => {
  await ready();
  const q = String(req.query.q || '').trim();
  const rows = (await query(`SELECT c.id, c.part_number, c.query, c.supplier, c.supplier_cost, c.currency, c.cost_gbp, c.postage, c.sell_price, c.qty,
        c.verdict, c.notes, c.created_at, u.name AS by_name,
        c.result->'market'->>'competition' AS competition, c.result->'market'->>'demand' AS demand,
        (c.result->'market'->'lowest'->>'total')::numeric AS lowest, (c.result->'market'->>'sellers')::int AS sellers,
        (c.result->'market'->>'perMonth')::numeric AS per_month, c.result->'market'->'items'->0->>'title' AS title
      FROM price_checks c LEFT JOIN users u ON u.id = c.created_by
     WHERE ($1 = '' OR c.part_number ILIKE '%' || $1 || '%' OR c.supplier ILIKE '%' || $1 || '%')
     ORDER BY c.created_at DESC LIMIT 300`, [q])).rows;
  res.json({ checks: rows });
});

router.get('/:id', async (req, res) => {
  await ready();
  const r = (await query(`SELECT * FROM price_checks WHERE id = $1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json({ check: r });
});

router.delete('/:id', async (req, res) => {
  await ready();
  await query(`DELETE FROM price_checks WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
