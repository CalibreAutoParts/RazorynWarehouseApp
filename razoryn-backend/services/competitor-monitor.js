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
// ── Fit rules shared by the title matchers ────────────────────────────────
// Position tags from a title: side (L/R), upper/lower, front/rear.
function posTags(title) {
  const t = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const tag = (a, b) => (a && b) ? 'both' : a ? 1 : b ? 2 : null;
  return {
    side: tag(/ (left|lh|lhs|nearside|n s) /.test(t), / (right|rh|rhs|offside|o s) /.test(t)),
    ul: tag(/ upper /.test(t), / lower /.test(t)),
    fr: tag(/ front /.test(t), / rear /.test(t)),
  };
}
function posConflict(a, b) {
  return ['side', 'ul', 'fr'].some(k => a[k] && b[k] && a[k] !== 'both' && b[k] !== 'both' && a[k] !== b[k]);
}
// "2020-2025", "2021 - 2024", "2019" → [from, to]; null when absent.
function yearRange(str) {
  const m = String(str || '').match(/((?:19|20)\d{2})(?:\s*[-–\/]\s*((?:19|20)\d{2}|on|onwards|\+))?/i);
  if (!m) return null;
  const a = parseInt(m[1]);
  const b = m[2] && /^\d{4}$/.test(m[2]) ? parseInt(m[2]) : (m[2] ? 2100 : a);
  return [Math.min(a, b), Math.max(a, b)];
}
function yearsOverlap(listingYear, productTitle) {
  const a = yearRange(listingYear), b = yearRange(productTitle);
  if (!a || !b) return null;                 // unknown — neutral
  return a[0] <= b[1] && b[0] <= a[1];
}
// The BASE model must appear ("Juke" of "Juke F16", "Golf" of "Golf Mk8");
// generation codes are often left off our titles, so they only add score.
const wordRe = (w) => new RegExp('(^|[^a-z0-9])' + String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
function modelHit(listing, prod) {
  const m = String(listing.parsed_model || '').toLowerCase().trim();
  if (!m) return null;
  const base = m.split(/\s+/)[0];
  const hay = String(prod.model || '') + ' ' + String(prod.title || '');
  return wordRe(base).test(hay);
}
function fullModelHit(listing, prod) {
  const m = String(listing.parsed_model || '').toLowerCase().trim();
  return !!m && wordRe(m).test(String(prod.model || '') + ' ' + String(prod.title || ''));
}
// Same vehicle model (when the listing names one), years overlap (when both
// state years), and no left/right · upper/lower · front/rear contradiction.
function fitCompatible(listing, prod) {
  if (modelHit(listing, prod) === false) return false;
  if (yearsOverlap(listing.parsed_year || listing.title, prod.title) === false) return false;
  return !posConflict(posTags(listing.title), posTags(prod.title));
}
function pickBestCandidate(listing, cands) {
  const lw = new Set(String(listing.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  let best = null;
  for (const c of cands) {
    if (!fitCompatible(listing, c)) continue;
    let score = 0;
    if (modelHit(listing, c)) score += 50;
    if (fullModelHit(listing, c)) score += 10;
    if (yearsOverlap(listing.parsed_year || listing.title, c.title)) score += 20;
    const cw = String(c.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    score += Math.min(30, cw.filter(w => lw.has(w)).length * 4);   // shared words
    if (!best || score > best.score) best = { id: c.id, score };
  }
  if (!best) return null;
  return { id: best.id, confidence: Math.min(0.9, 0.5 + best.score / 200) };
}

async function computeMatch(listing) {
  // 1. Exact part number (normalised) against our part_number, SKU, OR any of
  //    the product's ALTERNATE part numbers (factory/country codes) — the same
  //    physical part often carries a different code in the competitor's title.
  if (listing.parsed_part_number) {
    const r = await query(
      `SELECT p.id FROM products p
         WHERE p.active = true
           AND ( REGEXP_REPLACE(UPPER(COALESCE(p.part_number,'')), '[^A-Z0-9]', '', 'g') = $1
              OR REGEXP_REPLACE(UPPER(p.sku), '[^A-Z0-9]', '', 'g') = $1
              OR EXISTS (SELECT 1 FROM product_part_numbers ppn
                          WHERE ppn.product_id = p.id
                            AND REGEXP_REPLACE(UPPER(ppn.code), '[^A-Z0-9]', '', 'g') = $1) )
         LIMIT 1`,
      [listing.parsed_part_number]
    );
    if (r.rows[0]) return { product_id: r.rows[0].id, match_type: 'exact_part_number', confidence: 1.0, is_opportunity: false };
  }

  // 1b. Our part numbers INSIDE their title — catches titles carrying several
  //     codes where the extractor picked a different token than ours.
  if (listing.title && listing.title.length >= 8) {
    const r = await query(
      `WITH t AS (SELECT REGEXP_REPLACE(UPPER($1), '[^A-Z0-9]', '', 'g') AS norm)
       SELECT p.id FROM products p, t
        WHERE p.active = true
          AND (
            (LENGTH(REGEXP_REPLACE(UPPER(COALESCE(p.part_number,'')), '[^A-Z0-9]', '', 'g')) >= 6
              AND t.norm LIKE '%' || REGEXP_REPLACE(UPPER(p.part_number), '[^A-Z0-9]', '', 'g') || '%')
            OR EXISTS (SELECT 1 FROM product_part_numbers ppn
                        WHERE ppn.product_id = p.id
                          AND LENGTH(REGEXP_REPLACE(UPPER(ppn.code), '[^A-Z0-9]', '', 'g')) >= 6
                          AND t.norm LIKE '%' || REGEXP_REPLACE(UPPER(ppn.code), '[^A-Z0-9]', '', 'g') || '%')
          )
        LIMIT 1`,
      [listing.title]
    );
    if (r.rows[0]) return { product_id: r.rows[0].id, match_type: 'part_number_in_title', confidence: 0.95, is_opportunity: false };
  }

  // 2. Make + part-type, SCORED — the model must match (in our model field OR
  //    our title, which is where it usually lives), years must overlap, and
  //    left/right · upper/lower · front/rear must not contradict. A Mokka
  //    grille must never link to our Corsa grille just because both are
  //    "Vauxhall … grille" — a model we don't stock is an opportunity.
  if (listing.parsed_make && listing.parsed_part_type) {
    const { rows: cands } = await query(
      `SELECT id, title, model FROM products
        WHERE active = true AND brand ILIKE $1
          AND regexp_replace(lower(title), '\\s+', '', 'g') LIKE '%' || $2 || '%'
        LIMIT 300`,
      [listing.parsed_make, String(listing.parsed_part_type).toLowerCase().replace(/\s+/g, '')]
    );
    const best = pickBestCandidate(listing, cands);
    if (best) {
      return { product_id: best.id, match_type: 'make_model_parttype', confidence: best.confidence, is_opportunity: false };
    }
    if (cands.length && listing.parsed_model) {
      // We sell that part type for this make, just not this model/fit.
      return { product_id: null, match_type: 'none', confidence: 0, is_opportunity: true };
    }
  }

  // 3. Fuzzy title similarity (pg_trgm) among products sharing the make.
  if (listing.parsed_make && listing.title) {
    const { rows } = await query(
      `SELECT id, title, model, similarity(LOWER(title), LOWER($1)) AS sim
         FROM products
        WHERE active = true AND brand ILIKE $2
        ORDER BY sim DESC
        LIMIT 5`,
      [listing.title, listing.parsed_make]
    );
    const ok = rows.find(r => Number(r.sim) >= 0.45 && fitCompatible(listing, r));
    if (ok) {
      return { product_id: ok.id, match_type: 'fuzzy', confidence: Number(ok.sim), is_opportunity: false };
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
  // Competitor prices are money → admins only (in-app + push).
  await require('../lib/notify').notifyEvent({
    type, title, body, severity, relatedType: 'competitor_listing', relatedId: listingId,
    audience: 'admin', url: '/#competitors', tag: tag || `${type}-${listingId}`,
  });
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

async function scanCompetitor(competitorId, status = {}) {
  await ensureAiCols();
  const c = (await query(`SELECT * FROM competitors WHERE id = $1`, [competitorId])).rows[0];
  if (!c) throw new Error(`competitor ${competitorId} not found`);

  const firstScan = !c.last_scanned_at;
  const summary = { competitor: c.code, listings: 0, priceChanges: 0, alerts: 0, opportunities: 0 };
  // Live progress for the UI's bar: 'fetching' while pulling pages from eBay
  // (no total known yet), then 'matching' with done/total counts.
  status.competitor = c.name || c.code; status.phase = 'fetching'; status.done = 0; status.total = null;

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
  status.phase = 'matching'; status.total = items.length;

  let itemErrors = 0, firstItemError = null;
  for (const it of items) {
    status.done = (status.done || 0) + 1;
    if (!it.external_id || !it.title) continue;
    seenExternalIds.push(String(it.external_id));
    // One bad listing (odd title, oversized field, matcher hiccup) must never
    // abort the other 8,000 — skip it, count it, report it.
    try {

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
      const haveMatch = await query(`SELECT product_id FROM competitor_match WHERE listing_id = $1`, [listingId]);
      if (!haveMatch.rows.length) { match = await computeMatch(listingRow); await upsertMatch(listingId, match); }
      // Part numbers first: an unmatched listing that CARRIES a part number
      // retries every scan — our catalogue grows constantly, so yesterday's
      // "no match" can be today's exact part-number link.
      else if (haveMatch.rows[0].product_id == null && parsed.partNumber) {
        match = await computeMatch(listingRow); await upsertMatch(listingId, match);
      }
    }
    if (match && match.is_opportunity) summary.opportunities++;

    if (firstScan) continue; // first scan: populate only, no alerts

    // ---- alerting ----
    if (match && match.product_id && (match.match_type === 'exact_part_number' || match.match_type === 'make_model_parttype')) {
      const prod = (await query(
        `SELECT sku, title, price_ebay, price_shopify FROM products WHERE id = $1`, [match.product_id]
      )).rows[0];
      const ourPrice = prod ? (prod.price_ebay != null ? Number(prod.price_ebay) : (prod.price_shopify != null ? Number(prod.price_shopify) : null)) : null;
      // Same part number ≠ same spec (complete bumper vs primed skin): only
      // alert on like-for-like. Suspects wait for Claude's photo check, which
      // raises the undercut itself once it confirms.
      let aiSame = null;
      try { await ensureAiCols(); aiSame = (await query(`SELECT ai_same FROM competitor_match WHERE listing_id = $1`, [listingId])).rows[0]?.ai_same ?? null; } catch (_) {}
      const lfl = likeForLike({ ourTitle: prod?.title, theirTitle: it.title, ourPrice, theirPrice: price != null ? price + (it.shipping_free ? 0 : Number(it.shipping_cost || 0)) : null, aiSame });
      if (lfl.ok !== true) continue;

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
    } catch (e) {
      itemErrors++;
      if (!firstItemError) firstItemError = `${String(it.external_id)}: ${e.message}`;
    }
  }
  summary.itemErrors = itemErrors;

  // Mark listings that dropped out of this scan as unavailable.
  await query(
    `UPDATE competitor_listings
        SET available = false
      WHERE competitor_id = $1 AND available = true AND external_id <> ALL($2::text[])`,
    [competitorId, seenExternalIds]
  );

  summary.listings = seenExternalIds.length;
  await query(
    `UPDATE competitors SET last_scanned_at = now(), last_status = $2, last_error = $3 WHERE id = $1`,
    [competitorId, 'ok', itemErrors ? `${itemErrors} listing(s) skipped — first: ${firstItemError}`.slice(0, 500) : null]
  );
  return summary;
}

// Any failure that escapes (DB down, adapter crash mid-way) is RECORDED on the
// competitor — before, it vanished and "last scan" silently stopped moving.
async function scanCompetitorSafe(competitorId, status = {}) {
  try { return await scanCompetitor(competitorId, status); }
  catch (e) {
    try {
      await query(`UPDATE competitors SET last_scanned_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [competitorId, String(e.message || e).slice(0, 500)]);
    } catch (_) {}
    throw e;
  }
}

// ---------- scan all active competitors ----------

// One scan run at a time — the 6-hourly cron and "Scan all now" used to
// overlap on the same competitors.
let _scanAllRunning = false;
function isScanAllRunning() { return _scanAllRunning; }
async function scanAll(status = {}) {
  if (_scanAllRunning) return { competitors: 0, skipped: 'already_running', perCompetitor: [] };
  _scanAllRunning = true;
  try { return await _scanAll(status); } finally { _scanAllRunning = false; }
}
async function _scanAll(status = {}) {
  // Stalest first: if a deploy/restart cuts a run short, the competitors that
  // missed out go FIRST next time instead of always losing to the same order.
  const { rows } = await query(`SELECT id, code FROM competitors WHERE active = true ORDER BY last_scanned_at ASC NULLS FIRST, id`);
  const result = { competitors: 0, listings: 0, priceChanges: 0, alerts: 0, opportunities: 0, perCompetitor: [] };
  status.ofCompetitors = rows.length;
  for (let ci = 0; ci < rows.length; ci++) {
    const c = rows[ci];
    status.competitorIndex = ci + 1;
    try {
      const s = await scanCompetitorSafe(c.id, status);
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
  // Fresh suspects (big gap, titles inconclusive) get Claude's photo check.
  try { result.aiVerified = await verifySuspects({ limit: 60 }); } catch (e) { console.warn('[competitors] verify:', e.message); }
  return result;
}

// Re-run matching over a competitor's STORED listings (no re-fetch) — the fast
// way to apply matcher upgrades or link up after the catalogue grows. Part
// numbers first (the user's priority order), then everything else; the status
// object is mutated live so an endpoint can report progress.
async function rematchCompetitor(competitorId, status = {}) {
  await ensureAiCols();
  const { rows } = await query(
    `SELECT id, title, parsed_make, parsed_model, parsed_part_type, parsed_part_number
       FROM competitor_listings
      WHERE competitor_id = $1 AND available = true
      ORDER BY (parsed_part_number IS NOT NULL) DESC, id`,
    [competitorId]);
  status.total = rows.length; status.done = 0; status.matched = 0;
  status.skipped = 0;
  for (const l of rows) {
    // One bad listing never aborts the whole re-match.
    try {
      const m = await computeMatch(l);
      await upsertMatch(l.id, m);
      if (m.product_id) status.matched++;
    } catch (e) {
      status.skipped++;
      if (!status.firstError) status.firstError = e.message;
    }
    status.done++;
  }
  return { total: rows.length, matched: status.matched, skipped: status.skipped, firstError: status.firstError || null };
}

// ── Like-for-like verification (title rules + Claude with photos) ─────────
let _aiCols = false;
async function ensureAiCols() {
  if (_aiCols) return;
  // The match-type whitelist predates 'part_number_in_title' (our part number
  // found inside their title) — every such match was rejected by the DB,
  // which used to abort whole competitor scans. Widen it once.
  try {
    await query(`ALTER TABLE competitor_match DROP CONSTRAINT IF EXISTS competitor_match_match_type_check`);
    await query(`ALTER TABLE competitor_match ADD CONSTRAINT competitor_match_match_type_check
                 CHECK (match_type IN ('exact_part_number','part_number_in_title','make_model_parttype','fuzzy','none'))`);
  } catch (e) { console.warn('[competitors] match_type constraint:', e.message); }
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_same BOOLEAN`);
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_reason TEXT`);
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_ours TEXT`);
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_theirs TEXT`);
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_checked_at TIMESTAMPTZ`);
  await query(`ALTER TABLE competitor_match ADD COLUMN IF NOT EXISTS ai_checked_price NUMERIC(10,2)`);
  _aiCols = true;
}
const deliveredOf = (l) => l.price != null ? +(Number(l.price) + (l.shipping_free ? 0 : Number(l.shipping_cost || 0))).toFixed(2) : null;

// Ask Claude about ONE match and store the verdict. Raises the undercut alert
// a title-only scan held back, once Claude confirms it's the same item.
async function aiVerifyMatch(listingId) {
  await ensureAiCols();
  const ai = require('./ai');
  if (!ai.isConfigured()) throw new Error('ai_not_configured');
  const r = (await query(`
    SELECT m.listing_id, m.product_id, l.title AS their_title, l.price, l.shipping_cost, l.shipping_free, l.image_url AS their_image,
           l.competitor_id, c.name AS competitor_name,
           p.title AS our_title, p.image_url AS our_image, p.sku, COALESCE(p.price_ebay, p.price_shopify) AS our_price
      FROM competitor_match m JOIN competitor_listings l ON l.id = m.listing_id
      JOIN competitors c ON c.id = l.competitor_id JOIN products p ON p.id = m.product_id
     WHERE m.listing_id = $1`, [listingId])).rows[0];
  if (!r) throw new Error('match_not_found');
  const delivered = deliveredOf(r);
  const v = await ai.compareCompetitorListing({
    our: { title: r.our_title, image: r.our_image, price: r.our_price },
    their: { title: r.their_title, image: r.their_image, price: delivered },
  });
  if (!v) throw new Error('no_verdict');
  await query(`UPDATE competitor_match SET ai_same = $2, ai_reason = $3, ai_ours = $4, ai_theirs = $5,
                      ai_checked_at = now(), ai_checked_price = $6, updated_at = now() WHERE listing_id = $1`,
    [listingId, v.sameItem, v.reason, v.oursIncludes, v.theirsIncludes, r.price]);
  if (v.sameItem && delivered != null && r.our_price != null && delivered <= Number(r.our_price) * (1 - UNDERCUT_PCT() / 100)
      && !(await hasUnread('competitor_undercut', listingId))) {
    await notify({
      type: 'competitor_undercut', severity: 'warn', listingId,
      title: `Undercut: ${r.competitor_name} — £${delivered.toFixed(2)} delivered`,
      body: `${r.their_title} vs our £${Number(r.our_price).toFixed(2)} (${r.sku}) — 🤖 verified same item`,
    });
  }
  return v;
}

// Background pass: every matched listing whose titles can't settle it and
// whose price gap is big gets Claude's look (title + photos). Re-checks when
// their price moves >15%. Clear title mismatches never cost an AI call.
let _verifyRunning = false;
async function verifySuspects({ limit = 60, status = {} } = {}) {
  if (_verifyRunning) return { skipped: 'already_running' };
  _verifyRunning = true;
  try {
    await ensureAiCols();
    const ai = require('./ai');
    if (!ai.isConfigured()) return { skipped: 'ai_not_configured' };
    const { specCheck } = require('../lib/spec-level');
    const { rows } = await query(`
      SELECT m.listing_id, l.title AS their_title, l.price, l.shipping_cost, l.shipping_free,
             p.title AS our_title, COALESCE(p.price_ebay, p.price_shopify) AS our_price, m.ai_checked_price, m.ai_checked_at
        FROM competitor_match m JOIN competitor_listings l ON l.id = m.listing_id
        JOIN products p ON p.id = m.product_id
       WHERE m.product_id IS NOT NULL AND m.dismissed = false AND l.available = true AND p.active = true
         AND (m.ai_checked_at IS NULL OR (l.price IS NOT NULL AND m.ai_checked_price IS NOT NULL
              AND ABS(l.price - m.ai_checked_price) > m.ai_checked_price * 0.15))
       ORDER BY m.ai_checked_at NULLS FIRST
       LIMIT 2000`);
    const todo = rows.filter(r => specCheck({ ourTitle: r.our_title, theirTitle: r.their_title, ourPrice: r.our_price, theirPrice: deliveredOf(r) }).suspect).slice(0, limit);
    status.total = todo.length; status.done = 0; status.same = 0; status.different = 0; status.errors = 0;
    for (const r of todo) {
      try {
        const v = await aiVerifyMatch(r.listing_id);
        if (v.sameItem) status.same++; else status.different++;
      } catch (e) {
        status.errors++;
        if (/budget|not_configured/.test(e.message)) break;   // stop cleanly at the daily AI budget
      }
      status.done++;
    }
    return { checked: status.done, same: status.same, different: status.different, errors: status.errors };
  } finally { _verifyRunning = false; }
}

// Is this match like-for-like? Claude's verdict wins; otherwise title rules
// (a clear mismatch excludes; a suspect is held until Claude has looked).
function likeForLike({ ourTitle, theirTitle, ourPrice, theirPrice, aiSame }) {
  const { specCheck } = require('../lib/spec-level');
  const sc = specCheck({ ourTitle, theirTitle, ourPrice, theirPrice });
  if (aiSame === true) return { ok: true, spec: sc, by: 'ai' };
  if (aiSame === false) return { ok: false, spec: sc, by: 'ai' };
  if (sc.mismatch) return { ok: false, spec: sc, by: 'title' };
  if (sc.suspect) return { ok: null, spec: sc, by: 'title' };   // unknown — awaiting Claude
  return { ok: true, spec: sc, by: 'title' };
}

module.exports = { scanCompetitor: scanCompetitorSafe, scanAll, isScanAllRunning, computeMatch, rematchCompetitor, verifySuspects, aiVerifyMatch, ensureAiCols, likeForLike };
