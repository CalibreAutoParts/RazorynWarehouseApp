// lib/ebay-live.js — which eBay item numbers are LIVE on each account.
//
// mirror_links can keep item numbers of listings that have ended (ended and
// relisted on eBay under a new number, ended for being out of stock…). Anything
// that links to a listing — the "You might be interested in" cards in a
// description — must only use live ones. The list is refreshed from eBay
// (GetMyeBaySelling ActiveList) every few hours; while an account has no list
// yet, nothing is filtered.
//
// The same sweep re-links parts whose listing was relisted under a new number
// (exact SKU match, see routes/listings rematchStore), so stock, price and edits
// keep reaching the live listing.
const { query } = require('../db');

let _schema = false;
async function ensureSchema() {
  if (_schema) return;
  await query(`CREATE TABLE IF NOT EXISTS ebay_live_items (
    store_code TEXT NOT NULL, ebay_item_id TEXT NOT NULL, sku TEXT, seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_code, ebay_item_id))`);
  await query(`CREATE TABLE IF NOT EXISTS ebay_live_refresh (store_code TEXT PRIMARY KEY, refreshed_at TIMESTAMPTZ NOT NULL, count INTEGER)`);
  _schema = true;
}

async function hasList(storeCode) {
  try {
    await ensureSchema();
    const r = (await query(`SELECT count FROM ebay_live_refresh WHERE store_code = $1 AND refreshed_at > now() - interval '3 days'`, [storeCode])).rows[0];
    return !!(r && r.count > 0);
  } catch (_) { return false; }
}

async function refresh(storeCode) {
  await ensureSchema();
  const ebay = require('../services/ebay');
  const live = await ebay.getActiveListings(storeCode);
  if (!live.length) return { store: storeCode, live: 0 };   // empty / failed read — keep the old list
  const ids = live.map(l => String(l.itemId)), skus = live.map(l => l.sku ? String(l.sku) : null);
  await query(`INSERT INTO ebay_live_items (store_code, ebay_item_id, sku, seen_at)
      SELECT $1, i, s, now() FROM unnest($2::text[], $3::text[]) AS t(i, s)
      ON CONFLICT (store_code, ebay_item_id) DO UPDATE SET sku = EXCLUDED.sku, seen_at = now()`, [storeCode, ids, skus]);
  await query(`DELETE FROM ebay_live_items WHERE store_code = $1 AND NOT (ebay_item_id = ANY($2::text[]))`, [storeCode, ids]);
  await query(`INSERT INTO ebay_live_refresh (store_code, refreshed_at, count) VALUES ($1, now(), $2)
      ON CONFLICT (store_code) DO UPDATE SET refreshed_at = now(), count = $2`, [storeCode, ids.length]);
  return { store: storeCode, live: ids.length, items: live };
}

// Every connected account: refresh the live list, then re-link relisted parts.
async function sweep() {
  const ebay = require('../services/ebay');
  const out = [];
  for (const s of ebay.listStores().filter(x => x.hasToken && !x.disabled)) {
    try {
      const { items, ...r } = await refresh(s.code);
      if (r.live) {
        const m = await require('../routes/listings').rematchStore(s.code, { preview: false, live: items });
        r.relinked = m.relinked; r.linked = m.linked; r.conflicts = m.conflicts.length;
      }
      out.push(r);
    } catch (e) { out.push({ store: s.code, error: e.message }); }
  }
  return out;
}

module.exports = { ensureSchema, hasList, refresh, sweep };
