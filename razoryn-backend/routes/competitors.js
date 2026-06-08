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
router.post('/:id/scan', requireAdmin, async (req, res) => {
  try {
    const summary = await monitor.scanCompetitor(Number(req.params.id));
    await audit(req, 'competitor.scan', 'competitor', req.params.id, summary);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/competitors/scan — scan all active competitors now.
router.post('/scan', requireAdmin, async (req, res) => {
  try {
    const result = await monitor.scanAll();
    await audit(req, 'competitor.scanAll', null, null, { competitors: result.competitors, alerts: result.alerts });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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
