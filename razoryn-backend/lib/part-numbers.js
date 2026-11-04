// lib/part-numbers.js — every way a part number actually gets typed.
//
// Customers search "86595-BE000", "86595BE000" and Stellantis numbers as
// "98 362 310 80" or "9836231080" — so listings should carry ALL the forms:
// the manufacturer's own layout plus the hyphenated, compact and spaced
// variants people really type. Used to fill eBay's Reference OE/OEM Number
// and Interchange Part Number specifics (multi-value, one form per value).
function pnVariants(pn) {
  const raw = String(pn || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (v) => {
    v = String(v || '').trim();
    if (v && v.length <= 65 && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  push(raw);
  const compact = raw.replace(/[\s\-–.]+/g, '');
  push(compact);
  // Spaced layout typed with hyphens, and vice versa.
  if (/\s/.test(raw)) push(raw.replace(/\s+/g, '-'));
  if (/-/.test(raw)) push(raw.replace(/-+/g, ' '));
  // Stellantis (Peugeot / Citroën / Vauxhall / Fiat…): 10 digits written in
  // 2-3-3-2 groups — "9836231080" ⇄ "98 362 310 80".
  if (/^\d{10}$/.test(compact)) push(compact.replace(/^(\d{2})(\d{3})(\d{3})(\d{2})$/, '$1 $2 $3 $4'));
  // Hyundai / Kia: 10 alphanumerics split 5-5 with a hyphen — "86595BE000" ⇄ "86595-BE000".
  if (/^[A-Z0-9]{10}$/i.test(compact) && !/^\d{10}$/.test(compact)) push(compact.slice(0, 5) + '-' + compact.slice(5));
  return out;
}

// Variants for a main part number plus its alternates, deduped, capped so the
// eBay specific stays within sane value counts.
function allPnForms(mainPn, altCodes, { cap = 20 } = {}) {
  const seen = new Set();
  const out = [];
  for (const code of [mainPn, ...(altCodes || [])]) {
    for (const v of pnVariants(code)) {
      const k = v.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(v); }
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// Supplier codes are PRIVATE: kept for warehouse search, supplier orders and cost
// tracking, never sent to eBay / Shopify / trade customers / AI-written titles.
// Adds product_part_numbers.private and marks the codes that are supplier codes.
let _privReady = null;
function ensurePrivateCol() {
  if (!_privReady) _privReady = (async () => {
    const { query } = require('../db');
    await query(`CREATE TABLE IF NOT EXISTS product_part_numbers (id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, code TEXT NOT NULL, note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await query(`ALTER TABLE product_part_numbers ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT false`);
    // Supplier codes saved as alternates by older versions → private.
    await query(`UPDATE product_part_numbers ppn SET private = true
      WHERE private = false AND (note ~* ' code$'
        OR (to_regclass('product_suppliers') IS NOT NULL AND EXISTS (SELECT 1 FROM product_suppliers ps
              WHERE ps.product_id = ppn.product_id AND upper(trim(ps.supplier_sku)) = upper(trim(ppn.code))))
        OR (to_regclass('incoming_stock') IS NOT NULL AND EXISTS (SELECT 1 FROM incoming_stock i
              WHERE i.product_id = ppn.product_id AND upper(trim(i.supplier_sku)) = upper(trim(ppn.code)))))`).catch(e => console.warn('[part-numbers] mark private:', e.message));
  })().catch(e => { _privReady = null; console.warn('[part-numbers] private col:', e.message); });
  return _privReady;
}

module.exports = { pnVariants, allPnForms, ensurePrivateCol };
