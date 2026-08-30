// routes/competitors.js — competitor price & listing monitoring API.
//
// Reads are gated by the 'competitors' permission (admins bypass). Config changes
// and manual scans are admin-only and audited. Alerts are surfaced from the
// shared notifications table (related_type='competitor_listing').
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const monitor = require('../services/competitor-monitor');
const market = require('../services/market-analysis');
const ebay = require('../services/ebay');

const router = express.Router();
router.use(requireAuth);

const canRead = requirePermission('competitors');

// ---------- competitor list ----------

// GET /api/competitors — competitors with listing counts + last scan status.
router.get('/', canRead, async (req, res) => {
  const { rows } = await query(`
    SELECT c.*,
           COUNT(l.id) FILTER (WHERE l.available)                   AS active_listings,
           COUNT(m.id) FILTER (WHERE m.is_opportunity AND NOT m.dismissed) AS opportunities
      FROM competitors c
      LEFT JOIN competitor_listings l ON l.competitor_id = c.id
      LEFT JOIN competitor_match m    ON m.listing_id = l.id
     GROUP BY c.id
     ORDER BY c.active DESC, c.name`);
  res.json({ competitors: rows });
});

// GET /api/competitors/alerts — competitor notifications feed.
router.get('/alerts', canRead, async (req, res) => {
  const { rows } = await query(`
    SELECT * FROM notifications
     WHERE related_type = 'competitor_listing'
     ORDER BY created_at DESC
     LIMIT 100`);
  res.json({ alerts: rows });
});

// GET /api/competitors/compare?productId=&listingId=
// Side-by-side of OUR stock vs every competitor's matched listing (part number
// / title matches). Grouped per product with all competitors' offers ranked by
// delivered price, plus a per-competitor threat ranking. Includes our cost
// fields so the frontend can run the same margin maths as Costs & margins.
router.get('/compare', canRead, async (req, res) => {
  try {
    const where = [`m.product_id IS NOT NULL`, `m.dismissed = false`, `l.available = true`, `p.active = true`];
    const params = [];
    if (req.query.listingId) {
      // Resolve the listing → its product so the modal shows EVERY offer for that part.
      const pr = await query(`SELECT product_id FROM competitor_match WHERE listing_id = $1`, [req.query.listingId]);
      if (pr.rows[0]?.product_id) { params.push(pr.rows[0].product_id); where.push(`m.product_id = $${params.length}`); }
      else return res.json({ items: [], competitors: [] });
    } else if (req.query.productId) {
      params.push(req.query.productId); where.push(`m.product_id = $${params.length}`);
    }
    const { rows } = await query(`
      SELECT p.id AS product_id, p.sku, p.title AS our_title, p.part_number, p.image_url AS our_image,
             p.price_ebay, p.price_shopify, p.qty_on_hand,
             p.cost_price, p.landed_cost, p.large_panel, p.shipping_band, p.shipping_cost AS our_shipping_cost,
             p.postage_in_price, p.packaging_included, p.packaging_cost,
             l.id AS listing_id, l.title AS their_title, l.price AS their_price, l.currency,
             l.shipping_cost AS their_shipping, l.shipping_free, l.shipping_type, l.url, l.image_url AS their_image,
             l.last_seen_at,
             m.match_type, m.confidence,
             c.id AS competitor_id, c.name AS competitor_name, c.code AS competitor_code
        FROM competitor_match m
        JOIN competitor_listings l ON l.id = m.listing_id
        JOIN competitors c         ON c.id = l.competitor_id
        JOIN products p            ON p.id = m.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.title, l.price NULLS LAST
       LIMIT 3000`, params);

    const byProduct = new Map();
    for (const r of rows) {
      const price = r.their_price != null ? parseFloat(r.their_price) : null;
      const ship = r.shipping_free ? 0 : (r.their_shipping != null ? parseFloat(r.their_shipping) : null);
      const delivered = price != null ? +(price + (ship || 0)).toFixed(2) : null;
      if (!byProduct.has(r.product_id)) {
        byProduct.set(r.product_id, {
          productId: r.product_id, sku: r.sku, title: r.our_title, partNumber: r.part_number,
          image: r.our_image, priceEbay: r.price_ebay != null ? parseFloat(r.price_ebay) : null,
          priceShopify: r.price_shopify != null ? parseFloat(r.price_shopify) : null,
          qtyOnHand: r.qty_on_hand,
          costPrice: r.cost_price != null ? parseFloat(r.cost_price) : null,
          landedCost: r.landed_cost != null ? parseFloat(r.landed_cost) : null,
          largePanel: !!r.large_panel, shippingBand: r.shipping_band,
          shippingCost: r.our_shipping_cost != null ? parseFloat(r.our_shipping_cost) : null,
          postageInPrice: r.postage_in_price,
          packagingIncluded: r.packaging_included, packagingCost: r.packaging_cost != null ? parseFloat(r.packaging_cost) : null,
          offers: [],
        });
      }
      byProduct.get(r.product_id).offers.push({
        listingId: r.listing_id, competitorId: r.competitor_id, competitor: r.competitor_name, competitorCode: r.competitor_code,
        title: r.their_title, url: r.url, image: r.their_image,
        price, shipping: ship, shippingType: r.shipping_type, delivered,
        matchType: r.match_type, confidence: r.confidence != null ? parseFloat(r.confidence) : null,
        lastSeenAt: r.last_seen_at,
      });
    }

    const items = [...byProduct.values()];
    for (const it of items) {
      it.offers.sort((a, z) => (a.delivered == null) - (z.delivered == null) || (a.delivered ?? 0) - (z.delivered ?? 0));
      const cheapest = it.offers.find(o => o.delivered != null);
      it.cheapestDelivered = cheapest ? cheapest.delivered : null;
      it.delta = (it.priceEbay != null && it.cheapestDelivered != null) ? +(it.cheapestDelivered - it.priceEbay).toFixed(2) : null;
    }
    // Undercuts first (worst gap at the top), then the rest by title.
    items.sort((a, z) => {
      const au = a.delta != null && a.delta < 0, zu = z.delta != null && z.delta < 0;
      if (au !== zu) return au ? -1 : 1;
      if (au && zu) return a.delta - z.delta;
      return String(a.title).localeCompare(String(z.title));
    });

    // Per-competitor threat ranking across the matched set.
    const perComp = new Map();
    for (const it of items) {
      if (it.priceEbay == null) continue;
      for (const o of it.offers) {
        if (o.delivered == null) continue;
        if (!perComp.has(o.competitorId)) perComp.set(o.competitorId, { competitorId: o.competitorId, competitor: o.competitor, matched: 0, cheaper: 0, gapPctSum: 0 });
        const s = perComp.get(o.competitorId);
        s.matched++;
        if (o.delivered < it.priceEbay) s.cheaper++;
        s.gapPctSum += ((o.delivered - it.priceEbay) / it.priceEbay) * 100;
      }
    }
    const competitors = [...perComp.values()].map(s => ({
      ...s, avgGapPct: s.matched ? +(s.gapPctSum / s.matched).toFixed(1) : null, gapPctSum: undefined,
      cheaperPct: s.matched ? +((s.cheaper / s.matched) * 100).toFixed(0) : null,
    })).sort((a, z) => (z.cheaperPct ?? -1) - (a.cheaperPct ?? -1) || (a.avgGapPct ?? 0) - (z.avgGapPct ?? 0));
    competitors.forEach((c, i) => { c.rank = i + 1; });

    res.json({ items, competitors });
  } catch (e) { res.status(500).json({ error: 'compare_failed', message: e.message }); }
});

// POST /api/competitors/:id/rematch — re-run matching over the stored listings
// (no re-fetch). Runs in the background (9k listings take a few minutes);
// GET /api/competitors/rematch/status reports progress.
let _rematchStatus = { running: false };
router.post('/:id/rematch', requireAdmin, async (req, res) => {
  if (_rematchStatus.running) return res.status(409).json({ error: 'already_running', status: _rematchStatus });
  _rematchStatus = { running: true, competitorId: req.params.id, done: 0, total: 0, matched: 0, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true });
  (async () => {
    try {
      const monitor = require('../services/competitor-monitor');
      const r = await monitor.rematchCompetitor(req.params.id, _rematchStatus);
      _rematchStatus = { ..._rematchStatus, running: false, finishedAt: new Date().toISOString(), ...r };
    } catch (e) {
      console.error('[competitors] rematch failed:', e.message);
      _rematchStatus = { ..._rematchStatus, running: false, error: e.message };
    }
  })();
});
router.get('/rematch/status', canRead, (req, res) => res.json(_rematchStatus));

// GET /api/competitors/opportunities — parts/models they sell that we don't.
router.get('/opportunities', canRead, async (req, res) => {
  const { rows } = await query(`
    SELECT m.id AS match_id, m.confidence, m.dismissed, m.reviewed_at,
           l.id AS listing_id, l.title, l.url, l.price, l.currency, l.image_url,
           l.parsed_make, l.parsed_model, l.parsed_part_type, l.last_seen_at,
           c.name AS competitor_name, c.code AS competitor_code
      FROM competitor_match m
      JOIN competitor_listings l ON l.id = m.listing_id
      JOIN competitors c         ON c.id = l.competitor_id
     WHERE m.is_opportunity = true AND m.dismissed = false AND l.available = true
     ORDER BY l.last_seen_at DESC
     LIMIT 200`);
  res.json({ opportunities: rows });
});

// GET /api/competitors/listings/:listingId/history — price timeline.
router.get('/listings/:listingId/history', canRead, async (req, res) => {
  const { rows } = await query(
    `SELECT price, currency, observed_at
       FROM competitor_price_history
      WHERE listing_id = $1
      ORDER BY observed_at ASC`,
    [req.params.listingId]
  );
  res.json({ history: rows });
});

// GET /api/competitors/:id/listings?available=&matched=&opportunity=&q=
router.get('/:id/listings', canRead, async (req, res) => {
  const where = ['l.competitor_id = $1'];
  const params = [req.params.id];
  if (req.query.available === '1') where.push('l.available = true');
  if (req.query.matched === '1') where.push('m.product_id IS NOT NULL');
  if (req.query.opportunity === '1') where.push('m.is_opportunity = true');
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`l.title ILIKE $${params.length}`); }
  const { rows } = await query(`
    SELECT l.*,
           m.match_type, m.confidence, m.is_opportunity, m.product_id, m.dismissed, m.reviewed_at,
           p.sku AS our_sku, p.title AS our_title, p.price_ebay AS our_price_ebay, p.price_shopify AS our_price_shopify
      FROM competitor_listings l
      LEFT JOIN competitor_match m ON m.listing_id = l.id
      LEFT JOIN products p         ON p.id = m.product_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.last_seen_at DESC
     LIMIT 500`, params);
  res.json({ listings: rows });
});

// ---------- config (admin) ----------

// POST /api/competitors — add a competitor.
router.post('/', requireAdmin, async (req, res) => {
  const { name, code, source_type, ebay_username, website_url, config, notes, active } = req.body || {};
  if (!name || !code || !source_type) return res.status(400).json({ error: 'name, code and source_type are required' });
  if (!['ebay', 'website'].includes(source_type)) return res.status(400).json({ error: 'source_type must be ebay or website' });
  if (source_type === 'ebay' && !ebay_username) return res.status(400).json({ error: 'ebay_username required for eBay competitors' });
  try {
    const { rows } = await query(
      `INSERT INTO competitors (name, code, source_type, ebay_username, website_url, config, notes, active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}'::jsonb),$7,COALESCE($8,true))
       RETURNING *`,
      [name, code, source_type, ebay_username || null, website_url || null,
       config ? JSON.stringify(config) : null, notes || null, active]
    );
    await audit(req, 'competitor.create', 'competitor', rows[0].id, { code });
    res.json({ competitor: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'a competitor with that code already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/competitors/:id — update config.
router.put('/:id', requireAdmin, async (req, res) => {
  const fields = ['name', 'code', 'source_type', 'ebay_username', 'website_url', 'notes', 'active', 'config'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    params.push(f === 'config' ? JSON.stringify(req.body[f]) : req.body[f]);
    sets.push(`${f} = $${params.length}${f === 'config' ? '::jsonb' : ''}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE competitors SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'competitor.update', 'competitor', req.params.id, {});
  res.json({ competitor: rows[0] });
});

// DELETE /api/competitors/:id — remove a competitor (cascades listings/history/matches).
router.delete('/:id', requireAdmin, async (req, res) => {
  await query(`DELETE FROM competitors WHERE id = $1`, [req.params.id]);
  await audit(req, 'competitor.delete', 'competitor', req.params.id, {});
  res.json({ ok: true });
});

// ---------- manual scan (admin) ----------

// POST /api/competitors/:id/scan — scan one competitor now.
// Scans now run in the BACKGROUND: a 9k-listing seller takes minutes (50 Browse
// pages + per-listing matching), which would time the request out. The endpoint
// returns immediately; GET /scan/status reports progress/result.
let _scanStatus = { running: false };
router.post('/:id/scan', requireAdmin, async (req, res) => {
  if (_scanStatus.running) return res.status(409).json({ error: 'already_running', status: _scanStatus });
  _scanStatus = { running: true, scope: 'one', competitorId: req.params.id, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true });
  (async () => {
    try {
      const summary = await monitor.scanCompetitor(Number(req.params.id), _scanStatus);
      await audit(req, 'competitor.scan', 'competitor', req.params.id, summary);
      _scanStatus = { ..._scanStatus, running: false, finishedAt: new Date().toISOString(), summary };
    } catch (e) {
      console.error('[competitors] scan failed:', e.message);
      _scanStatus = { ..._scanStatus, running: false, error: e.message };
    }
  })();
});

// POST /api/competitors/scan — scan all active competitors now (background).
router.post('/scan', requireAdmin, async (req, res) => {
  if (_scanStatus.running) return res.status(409).json({ error: 'already_running', status: _scanStatus });
  _scanStatus = { running: true, scope: 'all', startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true });
  (async () => {
    try {
      const result = await monitor.scanAll(_scanStatus);
      await audit(req, 'competitor.scanAll', null, null, { competitors: result.competitors, alerts: result.alerts });
      _scanStatus = { ..._scanStatus, running: false, finishedAt: new Date().toISOString(), result };
    } catch (e) {
      console.error('[competitors] scanAll failed:', e.message);
      _scanStatus = { ..._scanStatus, running: false, error: e.message };
    }
  })();
});
router.get('/scan/status', canRead, (req, res) => res.json(_scanStatus));

// ---------- review an opportunity / match (admin) ----------

// POST /api/competitors/matches/:id/review { dismissed }
router.post('/matches/:id/review', requireAdmin, async (req, res) => {
  const dismissed = req.body && req.body.dismissed === true;
  const { rows } = await query(
    `UPDATE competitor_match
        SET reviewed_at = now(), reviewed_by = $2, dismissed = $3, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, req.user.id, dismissed]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'competitor.reviewMatch', 'competitor_match', req.params.id, { dismissed });
  res.json({ match: rows[0] });
});

// ---------- whole-market analysis & ranking ----------

// GET /api/competitors/products?q= — search our catalogue for the market picker.
router.get('/products', canRead, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const { rows } = await query(
    `SELECT id, sku, title, brand, model, part_number, price_ebay
       FROM products
      WHERE active = true AND (title ILIKE $1 OR sku ILIKE $1 OR part_number ILIKE $1)
      ORDER BY title LIMIT 25`, [q]
  );
  res.json({ products: rows });
});

// GET /api/competitors/market?productId= — live whole-eBay ranking for a part.
router.get('/market', canRead, async (req, res) => {
  const productId = Number(req.query.productId);
  if (!productId) return res.status(400).json({ error: 'productId required' });
  try {
    const data = await market.analyzeProductMarket(productId, { persist: true });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/competitors/market/:productId/history — saturation/rank over time.
router.get('/market/:productId/history', canRead, async (req, res) => {
  const { rows } = await query(
    `SELECT saturation_new, saturation_used, seller_count, min_delivered, median_delivered,
            our_delivered, our_rank, suggested_ad_rate, captured_at
       FROM product_market_snapshot
      WHERE product_id = $1
      ORDER BY captured_at ASC LIMIT 200`, [req.params.productId]
  );
  res.json({ history: rows });
});

// POST /api/competitors/market/:productId/promote { bidPercent } — apply OUR
// suggested fixed ad rate to the product's eBay listing via Promoted Listings.
router.post('/market/:productId/promote', requireAdmin, async (req, res) => {
  const bidPercent = parseFloat(req.body && req.body.bidPercent);
  if (!(bidPercent > 0)) return res.status(400).json({ error: 'bidPercent must be a positive number' });
  const p = (await query(
    `SELECT ebay_listing_id_em, ebay_listing_id_cl FROM products WHERE id = $1`, [req.params.productId]
  )).rows[0];
  if (!p) return res.status(404).json({ error: 'product not found' });
  const itemId = p.ebay_listing_id_em || p.ebay_listing_id_cl;
  if (!itemId) return res.status(400).json({ error: 'this product has no linked eBay listing to promote' });
  try {
    const r = await ebay.promoteListing(undefined, { itemId, bidPercent });
    await audit(req, 'competitor.promote', 'product', req.params.productId, { itemId, bidPercent });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
