// routes/supplier-import.js — upload a supplier's invoice / packing list
// (.xlsx) and turn it into reviewable incoming-stock lines.
//
// Suppliers all send roughly the same table wearing different clothes: a
// header block (company, invoice no.) then columns like OEM / PART NUMBER,
// their own code (FACTORY NO. / LW NO. / <name> Part NO.), a description,
// qty, unit price (RMB), sometimes make/model/year and carton dims. This
// parser finds the header row by scoring keyword matches, maps the columns to
// canonical fields, extracts the lines, and matches each line against OUR
// catalogue by (in priority order):
//   1. part number  2. sub/alternate part numbers  3. remembered SUPPLIER SKUs
//   4. our SKU / barcode
// Multiple hits on one code come back as candidates — the review screen makes
// the human confirm fitment BEFORE anything is pushed (a shared OEM code can
// belong to a different make/model listing, or to a skin vs a full assembly).
// Nothing is written here; the confirmed lines go through /api/incoming/bulk.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const lowHead = (v) => clean(v).toLowerCase();

// Column classifiers — tested against the real sheets from five suppliers.
const COL = {
  oem: (h) => /\b(oem|oe ?\d?|oe number|oem no)\b/.test(h) || h === 'part number' || h === 'pn',
  supplierSku: (h) => (/\b(factory no|item no|lw no)\b/.test(h) || /part no/.test(h) || /\bno\.?$/.test(h))
    && !/\b(oem|oe|invoice|order|carton|ctn|account)\b/.test(h),
  title: (h) => /\b(description|label name|product name)\b/.test(h) || /^name\s?\d?$/.test(h),
  make: (h) => /^(make|brand)$/.test(h),
  model: (h) => /^model$/.test(h),
  year: (h) => /^year/.test(h),
  qty: (h) => /\b(qty|quantity)\b/.test(h) && !/\/|ctn|carton|per/.test(h),
  price: (h) => (/\bprice\b/.test(h) || /unit cost/.test(h)) && !/total/.test(h),
  remark: (h) => /remark/.test(h),
  dim: (h) => /^[lwh]$/.test(h) || /l\s*\*\s*w\s*\*\s*h/.test(h),
  weight: (h) => /weight/.test(h) && !/total/.test(h),
};

function mapHeaderRow(cells) {
  const map = {};
  const dims = [];
  cells.forEach((raw, i) => {
    const h = lowHead(raw);
    if (!h) return;
    if (map.oem === undefined && COL.oem(h)) { map.oem = i; return; }
    if (map.title === undefined && COL.title(h)) { map.title = i; return; }
    if (map.make === undefined && COL.make(h)) { map.make = i; return; }
    if (map.model === undefined && COL.model(h)) { map.model = i; return; }
    if (map.year === undefined && COL.year(h)) { map.year = i; return; }
    if (map.qty === undefined && COL.qty(h)) { map.qty = i; return; }
    if (map.price === undefined && COL.price(h)) { map.price = i; return; }
    if (map.remark === undefined && COL.remark(h)) { map.remark = i; return; }
    if (COL.dim(h) && dims.length < 3) { dims.push(i); return; }
    if (map.weight === undefined && COL.weight(h)) { map.weight = i; return; }
    if (map.supplierSku === undefined && COL.supplierSku(h)) { map.supplierSku = i; return; }
  });
  if (dims.length) map.dims = dims;
  return map;
}

function headerScore(map) {
  let s = 0;
  for (const k of ['oem', 'supplierSku', 'title', 'qty', 'price']) if (map[k] !== undefined) s++;
  for (const k of ['make', 'model', 'year']) if (map[k] !== undefined) s += 0.5;
  return s;
}

function parseSheet(rows) {
  // Find the best header row in the first 40 rows.
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const map = mapHeaderRow(rows[r] || []);
    const score = headerScore(map);
    if (score >= 2 && (!best || score > best.score)) best = { r, map, score };
  }
  if (!best) return { lines: [] };
  const { r, map } = best;
  const lines = [];
  for (let i = r + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const cell = (idx) => idx !== undefined ? clean(row[idx]) : '';
    const qty = parseInt(String(cell(map.qty)).replace(/[^0-9]/g, ''), 10);
    const partNumber = cell(map.oem);
    const supplierSku = cell(map.supplierSku);
    const title = cell(map.title);
    if (!Number.isInteger(qty) || qty <= 0) continue;             // totals/footer/blank rows
    if (!partNumber && !supplierSku && !title) continue;
    const price = map.price !== undefined ? parseFloat(String(row[map.price]).replace(/[^\d.]/g, '')) : NaN;
    // Carton dims: metres on some packing lists (1.2 × 0.6), cm on others (200 × 50).
    let dims = (map.dims || []).map(di => parseFloat(row[di])).filter(Number.isFinite);
    if (dims.length === 3 && dims.every(d => d > 0 && d < 10)) dims = dims.map(d => +(d * 100).toFixed(1));
    const weight = map.weight !== undefined ? parseFloat(row[map.weight]) : NaN;
    lines.push({
      row: i + 1,
      partNumber: partNumber || null,
      supplierSku: supplierSku || null,
      title: title || null,
      make: cell(map.make) || null,
      model: cell(map.model) || null,
      year: cell(map.year) || null,
      qty,
      unitPrice: Number.isFinite(price) && price > 0 ? price : null,
      lengthCm: dims[0] ?? null, widthCm: dims[1] ?? null, heightCm: dims[2] ?? null,
      weightKg: Number.isFinite(weight) && weight > 0 ? weight : null,
      remark: cell(map.remark) || null,
    });
  }
  return { lines, headerRow: r + 1 };
}

// Guess supplier name + invoice number from the header junk above the table.
function guessMeta(sheets) {
  let supplier = null, invoice = null;
  for (const rows of sheets) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      for (const cellRaw of (rows[r] || [])) {
        const c = clean(cellRaw);
        if (!c) continue;
        if (!supplier) {
          const m = c.match(/([A-Z][A-Za-z&., ]{4,60}(?:CO\.?,? ?LTD\.?|COMPANY|LTD|AUTO ?PARTS[A-Za-z ,.]*|INDUSTRY [A-Za-z ,.]*))/i);
          if (m) supplier = clean(m[1]).replace(/[.,\s]+$/, '');
        }
        if (!invoice) {
          // Tolerant of supplier typos ("INVOCIE NO."), full-width colons, etc.
          const m = c.match(/\bINV\w{0,6}\s*(?:NO|NUMBER)\b[.\s:：]*([A-Za-z0-9-]{3,25})/i);
          if (m) invoice = m[1];
        }
      }
    }
  }
  return { supplier, invoice };
}

// POST /api/supplier-import/parse — multipart file → parsed + matched lines.
router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    let wb;
    try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); }
    catch (e) { return res.status(400).json({ error: 'unreadable_file', message: 'Could not read that file — is it a real .xlsx/.xls?' }); }

    const sheetRows = wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }));
    const parsedSheets = sheetRows.map((rows, i) => ({ name: wb.SheetNames[i], ...parseSheet(rows) }))
      .filter(s => s.lines.length);
    if (!parsedSheets.length) return res.status(422).json({ error: 'no_lines_found', message: 'Couldn\'t find a parts table in this file — no header row with part number / qty columns.' });

    // Primary sheet = the one with the most usable lines (prefer priced ones on
    // a tie). Any OTHER parsed sheet enriches by part number — e.g. a PI sheet
    // for prices + a PL packing sheet for carton dims in the same workbook.
    parsedSheets.sort((a, z) => z.lines.length - a.lines.length
      || z.lines.filter(l => l.unitPrice != null).length - a.lines.filter(l => l.unitPrice != null).length);
    const primary = parsedSheets[0];
    const enrich = new Map();
    for (const s of parsedSheets.slice(1)) {
      for (const l of s.lines) {
        const k = norm(l.partNumber || l.supplierSku);
        if (k && !enrich.has(k)) enrich.set(k, l);
      }
    }
    for (const l of primary.lines) {
      const e = enrich.get(norm(l.partNumber || l.supplierSku));
      if (!e) continue;
      for (const f of ['make', 'model', 'year', 'lengthCm', 'widthCm', 'heightCm', 'weightKg', 'unitPrice', 'title', 'supplierSku']) {
        if ((l[f] == null || l[f] === '') && e[f] != null) l[f] = e[f];
      }
    }

    // ── Match against our catalogue ──
    const codes = [...new Set(primary.lines.flatMap(l => [norm(l.partNumber), norm(l.supplierSku)]).filter(c => c && c.length >= 4))];
    const candMap = new Map();   // code -> [{productId, via, ...}]
    if (codes.length) {
      const addCands = (rows2) => {
        for (const r2 of rows2) {
          if (!candMap.has(r2.code)) candMap.set(r2.code, []);
          const arr = candMap.get(r2.code);
          if (!arr.some(x => x.productId === r2.id && x.via === r2.via)) {
            arr.push({ productId: r2.id, sku: r2.sku, title: r2.title, brand: r2.brand, model: r2.model,
                       stockGroupId: r2.stock_group_id, via: r2.via, supplierName: r2.supplier_name || null });
          }
        }
      };
      addCands((await query(`
        WITH codes AS (SELECT UNNEST($1::text[]) AS code)
        SELECT c.code, p.id, p.sku, p.title, p.brand, p.model, p.stock_group_id,
               CASE WHEN REGEXP_REPLACE(UPPER(COALESCE(p.part_number,'')), '[^A-Z0-9]', '', 'g') = c.code THEN 'part_number'
                    WHEN REGEXP_REPLACE(UPPER(p.sku), '[^A-Z0-9]', '', 'g') = c.code THEN 'our_sku'
                    ELSE 'barcode' END AS via
        FROM codes c JOIN products p ON p.active = true AND (
          REGEXP_REPLACE(UPPER(COALESCE(p.part_number,'')), '[^A-Z0-9]', '', 'g') = c.code
          OR REGEXP_REPLACE(UPPER(p.sku), '[^A-Z0-9]', '', 'g') = c.code
          OR REGEXP_REPLACE(UPPER(COALESCE(p.barcode,'')), '[^A-Z0-9]', '', 'g') = c.code)`, [codes])).rows);
      addCands((await query(`
        WITH codes AS (SELECT UNNEST($1::text[]) AS code)
        SELECT c.code, p.id, p.sku, p.title, p.brand, p.model, p.stock_group_id, 'sub_part_number' AS via
        FROM codes c
        JOIN product_part_numbers ppn ON REGEXP_REPLACE(UPPER(ppn.code), '[^A-Z0-9]', '', 'g') = c.code
        JOIN products p ON p.id = ppn.product_id AND p.active = true`, [codes])).rows.map(r2 => ({ ...r2, via: 'sub_part_number' })));
      try {
        addCands((await query(`
          WITH codes AS (SELECT UNNEST($1::text[]) AS code)
          SELECT c.code, p.id, p.sku, p.title, p.brand, p.model, p.stock_group_id, 'supplier_sku' AS via, s.name AS supplier_name
          FROM codes c
          JOIN product_suppliers ps ON REGEXP_REPLACE(UPPER(COALESCE(ps.supplier_sku,'')), '[^A-Z0-9]', '', 'g') = c.code
          JOIN suppliers s ON s.id = ps.supplier_id
          JOIN products p ON p.id = ps.product_id AND p.active = true`, [codes])).rows);
      } catch (_) { /* table may not exist yet */ }
    }

    const viaRank = { part_number: 0, sub_part_number: 1, supplier_sku: 2, our_sku: 3, barcode: 4 };
    for (const l of primary.lines) {
      const cands = [
        ...(candMap.get(norm(l.partNumber)) || []),
        ...(candMap.get(norm(l.supplierSku)) || []),
      ];
      // Dedupe by product, keep the strongest via; then flag fitment mismatches
      // (their line says one make/model, our listing says another — same part
      // shared across platforms, needs a human eye before it settles).
      const byId = new Map();
      for (const c of cands) {
        const cur = byId.get(c.productId);
        if (!cur || viaRank[c.via] < viaRank[cur.via]) byId.set(c.productId, c);
      }
      l.candidates = [...byId.values()].sort((a, z) => viaRank[a.via] - viaRank[z.via]).slice(0, 6).map(c => {
        const lineFit = norm((l.make || '') + (l.model || ''));
        const ourFit = norm((c.brand || '') + (c.model || ''));
        const fitMismatch = !!(lineFit && ourFit && !ourFit.includes(norm(l.model || l.make || '')) && !lineFit.includes(norm(c.model || c.brand || '')));
        return { ...c, fitMismatch };
      });
      l.autoProductId = l.candidates.length === 1 ? l.candidates[0].productId : null;
    }

    const meta = guessMeta(sheetRows);
    await audit(req, 'supplier_import_parse', null, null, { file: req.file.originalname, lines: primary.lines.length });
    res.json({
      ok: true,
      fileName: req.file.originalname,
      sheet: primary.name,
      supplierGuess: meta.supplier,
      invoiceGuess: meta.invoice,
      lines: primary.lines,
      matched: primary.lines.filter(l => l.candidates.length).length,
    });
  } catch (e) {
    console.error('[supplier-import]', e);
    res.status(500).json({ error: 'parse_failed', message: e.message });
  }
});

module.exports = router;
