// services/competitor-monitor.js — competitor price & listing monitoring.
//
// Mirrors services/sync.js. For each configured competitor:
//   fetch listings (via a source adapter) → parse make/model/part → upsert the
//   current snapshot → append a price-history row WHEN the price changes → match
//   each listing against our catalogue → raise alerts (reusing the notifications
//   table + web push). Designed to be safe to run on a schedule: one competitor
//   failing never aborts the others, and the very first scan of a competitor
//   never fires alerts (everything is "new" then).
const { query } = require('../db');
const push = require('./push');
const sources = require('./competitor-sources');
const { parseForMatch } = require('../lib/vehicle');

const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const UNDERCUT_PCT = () => num(process.env.COMPETITOR_UNDERCUT_PCT, 5);
const DROP_PCT = () => num(process.env.COMPETITOR_DROP_PCT, 10);
const NEW_ITEM_MAX = () => Math.max(0, parseInt(process.env.COMPETITOR_NEW_ITEM_MAX || '10', 10) || 0);

const cents = (v) => (v == null ? null : Math.round(Number(v) * 100));
const samePrice = (a, b) => cents(a) === cents(b);

// ---------- matching ----------

// Decide the best match for a competitor listing. Returns the match row fields:
//   { product_id, match_type, confidence, is_opportunity }
async function computeMatch(listing) {
  // 1. Exact part number (normalised) against our part_number OR sku.
  if (listing.parsed_part_number) {
    const r = await query(
      `SELECT id FROM products
         WHERE active = true
           AND ( REGEXP_REPLACE(UPPER(COALESCE(part_number,'')), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(sku), '[^A-Z0-9]', '', 'g') = $1 )
         LIMIT 1`,
      [listing.parsed_part_number]
    );
    if (r.rows[0]) return { product_id: r.rows[0].id, match_type: 'exact_part_number', confidence: 1.0, is_opportunity: false };
  }

  // 2. Make + part-type (model boosts confidence). Practical matcher for body parts.
  if (listing.parsed_make && listing.parsed_part_type) {
    const r = await query(
      `SELECT id,
              (model ILIKE $2) AS model_hit
         FROM products
        WHERE active = true
          AND brand ILIKE $1
          AND title ILIKE $3
        ORDER BY (model ILIKE $2) DESC
        LIMIT 1`,
      [listing.parsed_make, `%${listing.parsed_model || ''}%`, `%${listing.parsed_part_type}%`]
    );
    if (r.rows[0]) {
      const conf = (listing.parsed_model && r.rows[0].model_hit) ? 0.8 : 0.6;
      return { product_id: r.rows[0].id, match_type: 'make_model_parttype', confidence: conf, is_opportunity: false };
    }
  }

  // 3. Fuzzy title similarity (pg_trgm) among products sharing the make.
  if (listing.parsed_make && listing.title) {
    const r = await query(
      `SELECT id, similarity(LOWER(title), LOWER($1)) AS sim
         FROM products
        WHERE active = true AND brand ILIKE $2
        ORDER BY sim DESC
        LIMIT 1`,
      [listing.title, listing.parsed_make]
    );
    if (r.rows[0] && Number(r.rows[0].sim) >= 0.45) {
      return { product_id: r.rows[0].id, match_type: 'fuzzy', confidence: Number(r.rows[0].sim), is_opportunity: false };
    }
  }

  // 4. No match → opportunity (a part/model they sell that we don't).
  return { product_id: null, match_type: 'none', confidence: 0, is_opportunity: true };
}

async function upsertMatch(listingId, m) {
  await query(
    `INSERT INTO competitor_match (listing_id, product_id, match_type, confidence, is_opportunity)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (listing_id) DO UPDATE
        SET product_id     = EXCLUDED.product_id,
            match_type     = EXCLUDED.match_type,
            confidence     = EXCLUDED.confidence,
            is_opportunity = EXCLUDED.is_opportunity,
            updated_at     = now()`,
    [listingId, m.product_id, m.match_type, m.confidence, m.is_opportunity]
  );
}

// Is this opportunity worth a notification? Only when we already sell the make
// but NOT that part-type for it (e.g. "MG4 wishbone" when we list MG4 parts but
// no wishbones). Bare/unparseable opportunities are tracked but not alerted.
async function isNotifiableOpportunity(listing) {
  if (!listing.parsed_make || !listing.parsed_part_type) return false;
  const haveMake = await query(
    `SELECT 1 FROM products WHERE active = true AND brand ILIKE $1 LIMIT 1`,
    [listing.parsed_make]
  );
  if (!haveMake.rows.length) return false; // not a make we deal in — skip the noise
  const haveType = await query(
    `SELECT 1 FROM products WHERE active = true AND brand ILIKE $1 AND title ILIKE $2 LIMIT 1`,
    [listing.parsed_make, `%${listing.parsed_part_type}%`]
  );
  return haveType.rows.length === 0;
}

// ---------- alerts (reuse notifications + push) ----------

async function notify({ type, title, body, severity, listingId, tag }) {
  await query(
    `INSERT INTO notifications (type, title, body, severity, related_type, related_id)
     VALUES ($1,$2,$3,$4,'competitor_listing',$5)`,
    [type, title, body, severity, listingId]
  );
  push.sendToAll({ title, body, url: '/', tag: tag || `${type}-${listingId}`, category: type }).catch(() => {});
}

async function hasUnread(type, listingId) {
  const r = await query(
    `SELECT 1 FROM notifications
      WHERE type = $1 AND related_id = $2 AND related_type = 'competitor_listing' AND read_at IS NULL
      LIMIT 1`,
    [type, listingId]
  );
  return r.rows.length > 0;
}

// ---------- scan one competitor ----------

async function scanCompetitor(competitorId) {
  const c = (await query(`SELECT * FROM competitors WHERE id = $1`, [competitorId])).rows[0];
  if (!c) throw new Error(`competitor ${competitorId} not found`);

  const firstScan = !c.last_scanned_at;
  const summary = { competitor: c.code, listings: 0, priceChanges: 0, alerts: 0, opportunities: 0 };

  let items;
  try {
    const adapter = sources.getAdapter(c);
    items = await adapter.fetchListings(c);
  } catch (e) {
    await query(
      `UPDATE competitors SET last_scanned_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [competitorId, String(e.message).slice(0, 500)]
    );
    summary.error = e.message;
    return summary;
  }

  const seenExternalIds = [];
  let newItemAlerts = 0;
  const newItemCap = NEW_ITEM_MAX();

  for (const it of items) {
    if (!it.external_id || !it.title) continue;
    seenExternalIds.push(String(it.external_id));

    const parsed = parseForMatch(it.title);
    const price = it.price != null ? Number(it.price) : null;
    const currency = it.currency || 'GBP';

    const existing = (await query(
      `SELECT id, price FROM competitor_listings WHERE competitor_id = $1 AND external_id = $2`,
      [competitorId, String(it.external_id)]
    )).rows[0];

    let listingId, priceChanged = false, oldPrice = null, isNew = false;

    if (!existing) {
      isNew = true;
      const ins = await query(
        `INSERT INTO competitor_listings
           (competitor_id, external_id, url, title, price, currency, image_url,
            shipping_cost, shipping_type, shipping_free, condition, condition_id, seller_username,
            parsed_make, parsed_model, parsed_part_type, parsed_part_number,
            available, last_seen_at, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,now(),$18)
         RETURNING id`,
        [competitorId, String(it.external_id), it.url || null, it.title, price, currency,
         it.image_url || null, it.shipping_cost ?? null, it.shipping_type || null, !!it.shipping_free,
         it.condition || null, it.condition_id || null, it.seller_username || null,
         parsed.make, parsed.model, parsed.partType, parsed.partNumber,
         it.raw ? JSON.stringify(it.raw) : null]
      );
      listingId = ins.rows[0].id;
      if (price != null) {
        await query(
          `INSERT INTO competitor_price_history (listing_id, price, currency) VALUES ($1,$2,$3)`,
          [listingId, price, currency]
        );
      }
    } else {
      listingId = existing.id;
      oldPrice = existing.price != null ? Number(existing.price) : null;
      priceChanged = price != null && !samePrice(oldPrice, price);
      await query(
        `UPDATE competitor_listings SET
            url = $3, title = $4, price = $5, currency = $6, image_url = $7,
            shipping_cost = $8, shipping_type = $9, shipping_free = $10,
            condition = $11, condition_id = $12, seller_username = $13,
            parsed_make = $14, parsed_model = $15, parsed_part_type = $16, parsed_part_number = $17,
            available = true, last_seen_at = now(),
            last_price_change_at = CASE WHEN $18 THEN now() ELSE last_price_change_at END,
            raw = $19
          WHERE id = $1 AND competitor_id = $2`,
        [listingId, competitorId, it.url || null, it.title, price, currency, it.image_url || null,
         it.shipping_cost ?? null, it.shipping_type || null, !!it.shipping_free,
         it.condition || null, it.condition_id || null, it.seller_username || null,
         parsed.make, parsed.model, parsed.partType, parsed.partNumber, priceChanged,
         it.raw ? JSON.stringify(it.raw) : null]
      );
      if (priceChanged) {
        await query(
          `INSERT INTO competitor_price_history (listing_id, price, currency) VALUES ($1,$2,$3)`,
          [listingId, price, currency]
        );
        summary.priceChanges++;
      }
    }

    // Recompute the match for new and price-changed listings (and any listing
    // that has no match row yet, so a re-scan after a catalogue change re-links).
    const listingRow = {
      id: listingId, title: it.title, parsed_make: parsed.make, parsed_model: parsed.model,
      parsed_part_type: parsed.partType, parsed_part_number: parsed.partNumber,
    };
    let match = null;
    if (isNew || priceChanged) {
      match = await computeMatch(listingRow);
      await upsertMatch(listingId, match);
    } else {
      const haveMatch = await query(`SELECT 1 FROM competitor_match WHERE listing_id = $1`, [listingId]);
      if (!haveMatch.rows.length) { match = await computeMatch(listingRow); await upsertMatch(listingId, match); }
    }
    if (match && match.is_opportunity) summary.opportunities++;

    if (firstScan) continue; // first scan: populate only, no alerts

    // ---- alerting ----
    if (match && match.product_id && (match.match_type === 'exact_part_number' || match.match_type === 'make_model_parttype')) {
      const prod = (await query(
        `SELECT sku, title, price_ebay, price_shopify FROM products WHERE id = $1`, [match.product_id]
      )).rows[0];
      const ourPrice = prod ? (prod.price_ebay != null ? Number(prod.price_ebay) : (prod.price_shopify != null ? Number(prod.price_shopify) : null)) : null;

      // Undercut: competitor's DELIVERED price (item + shipping) meaningfully
      // below us (same currency only). Shipping is surfaced in the alert body.
      const delivered = price != null ? price + (it.shipping_free ? 0 : Number(it.shipping_cost || 0)) : null;
      const shipLabel = it.shipping_free ? 'free P&P'
        : (it.shipping_type === 'collection' ? 'collection only'
          : (it.shipping_type === 'calculated' ? 'P&P calculated'
            : (it.shipping_cost != null ? `+£${Number(it.shipping_cost).toFixed(2)} P&P` : 'P&P n/a')));
      if (delivered != null && ourPrice != null && currency === 'GBP') {
        const threshold = ourPrice * (1 - UNDERCUT_PCT() / 100);
        if (delivered <= threshold && !(await hasUnread('competitor_undercut', listingId))) {
          await notify({
            type: 'competitor_undercut', severity: 'warn', listingId,
            title: `Undercut: ${c.name} — £${delivered.toFixed(2)} delivered`,
            body: `${it.title} is £${price.toFixed(2)} (${shipLabel}) vs our £${ourPrice.toFixed(2)} (${prod.sku})`,
          });
          summary.alerts++;
        }
      }
      // Price drop: an existing matched listing fell sharply.
      if (priceChanged && oldPrice != null && price != null && oldPrice > 0) {
        const dropPct = ((oldPrice - price) / oldPrice) * 100;
        if (dropPct >= DROP_PCT()) {
          await notify({
            type: 'competitor_price_drop', severity: 'info', listingId,
            title: `Price drop: ${c.name} −${dropPct.toFixed(0)}%`,
            body: `${it.title} £${oldPrice.toFixed(2)} → £${price.toFixed(2)}`,
            tag: `competitor_price_drop-${listingId}-${cents(price)}`,
          });
          summary.alerts++;
        }
      }
    }

    // New opportunity: a part/model they list that we don't stock (refined rule).
    if (isNew && match && match.is_opportunity && newItemAlerts < newItemCap) {
      if (await isNotifiableOpportunity(listingRow)) {
        await notify({
          type: 'competitor_new_item', severity: 'info', listingId,
          title: `New: ${c.name} lists ${parsed.make} ${parsed.partType}`,
          body: it.title + (price != null ? ` — £${price.toFixed(2)}` : ''),
        });
        newItemAlerts++;
        summary.alerts++;
      }
    }
  }

  // Mark listings that dropped out of this scan as unavailable.
  await query(
    `UPDATE competitor_listings
        SET available = false
      WHERE competitor_id = $1 AND available = true AND external_id <> ALL($2::text[])`,
    [competitorId, seenExternalIds]
  );

  summary.listings = seenExternalIds.length;
  await query(
    `UPDATE competitors SET last_scanned_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
    [competitorId]
  );
  return summary;
}

// ---------- scan all active competitors ----------

async function scanAll() {
  const { rows } = await query(`SELECT id, code FROM competitors WHERE active = true ORDER BY id`);
  const result = { competitors: 0, listings: 0, priceChanges: 0, alerts: 0, opportunities: 0, perCompetitor: [] };
  for (const c of rows) {
    try {
      const s = await scanCompetitor(c.id);
      result.competitors++;
      result.listings += s.listings || 0;
      result.priceChanges += s.priceChanges || 0;
      result.alerts += s.alerts || 0;
      result.opportunities += s.opportunities || 0;
      result.perCompetitor.push(s);
    } catch (e) {
      result.perCompetitor.push({ competitor: c.code, error: e.message });
    }
  }
  return result;
}

module.exports = { scanCompetitor, scanAll, computeMatch };
