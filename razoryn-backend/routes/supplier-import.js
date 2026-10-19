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

const OS = require('../lib/order-sheet');
const path = require('path');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

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
    try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: true }); }
    catch (e) { return res.status(400).json({ error: 'unreadable_file', message: 'Could not read that file — is it a real .xlsx/.xls?' }); }

    const sheetRows = wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }));
    const offsets = wb.SheetNames.map(n => { try { return XLSX.utils.decode_range(wb.Sheets[n]['!ref'] || 'A1').s.r; } catch (_) { return 0; } });
    const meta = guessMeta(sheetRows);
    const supplierHint = OS.clean(req.body?.supplier || '') || meta.supplier || '';
    // A mapping corrected on the review screen: { sheet, headerRow (1-based), mapping: field->col, extras: {header: label}, ignore: [header] }
    let override = null;
    try { override = req.body?.mapping ? JSON.parse(req.body.mapping) : null; } catch (_) {}
    const photos = OS.extractImages(req.file.buffer, wb, UPLOAD_DIR);
    const saved = await OS.savedFormats(supplierHint);

    const parsedSheets = [];
    wb.SheetNames.forEach((name, si) => {
      const rows = sheetRows[si];
      let loc;
      if (override && override.sheet === name && Number.isInteger(override.headerRow)) {
        loc = { headerIdx: override.headerRow - 1, map: override.mapping || {}, source: 'manual', format: null, extras: override.extras || {} };
      } else loc = OS.locateTable(rows, saved);
      if (!loc) return;
      parsedSheets.push({ name, si, rows, loc, offset: offsets[si] });
    });
    if (!parsedSheets.length) return res.status(422).json({ error: 'no_lines_found', message: 'Couldn\'t find a parts table in this file — no header row with part number / qty columns.' });

    // Lines per sheet (rules/saved/template/manual mapping first).
    const extrasFor = (sh) => {
      const ex = {};
      if (sh.loc.format && sh.loc.format.extras) Object.assign(ex, sh.loc.format.extras);
      if (override && override.sheet === sh.name && override.extras) Object.assign(ex, override.extras);
      if (override && override.sheet === sh.name && Array.isArray(override.ignore)) ex.__ignore = override.ignore.map(OS.normHead);
      return ex;
    };
    for (const sh of parsedSheets) {
      sh.lines = OS.buildLines(sh.rows, sh.loc.headerIdx, sh.loc.map, extrasFor(sh), photos[sh.name] || {}, sh.offset);
    }
    parsedSheets.sort((a, z) => z.lines.length - a.lines.length
      || z.lines.filter(l => l.unitPrice != null).length - a.lines.filter(l => l.unitPrice != null).length);
    const primary = parsedSheets[0];
    if (!primary.lines.length) return res.status(422).json({ error: 'no_lines_found', message: 'Found a header row but no item lines under it (each item needs a quantity).' });

    // New layout (built-in rules only)? Let Claude check the mapping, fill any
    // gaps and say what the extra columns are — then rebuild the lines.
    let aiNotes = null, currency = null;
    const headers = (primary.rows[primary.loc.headerIdx] || []).map(h => OS.clean(h));
    if (primary.loc.source === 'rules') {
      const unmapped = headers.filter((h, i) => h && !Object.values(primary.loc.map).includes(i));
      const missingCore = OS.CORE.filter(f => primary.loc.map[f] === undefined);
      const ai = require('../services/ai');
      if (ai.isConfigured() && (unmapped.length || missingCore.length)) {
        try {
          const sample = primary.rows.slice(primary.loc.headerIdx + 1, primary.loc.headerIdx + 9).map(r => (r || []).map(c => OS.clean(c).slice(0, 40)));
          const v = await ai.mapSupplierColumns({ headers, sampleRows: sample, supplier: supplierHint, known: primary.loc.map });
          if (v) {
            const merged = { ...primary.loc.map };
            for (const [f, c] of Object.entries(v.mapping)) {
              for (const k of Object.keys(merged)) if (merged[k] === c && k !== f) delete merged[k];   // one field per column
              merged[f] = c;
            }
            primary.loc.map = merged;
            primary.loc.source = 'ai';
            primary.loc.extras = Object.fromEntries(v.extras.filter(x => headers[x.col]).map(x => [headers[x.col], x.label]));
            aiNotes = v.notes; currency = v.currency;
            primary.lines = OS.buildLines(primary.rows, primary.loc.headerIdx, merged, primary.loc.extras, photos[primary.name] || {}, primary.offset);
          }
        } catch (e) { aiNotes = 'AI column check unavailable: ' + e.message; }
      }
    }

    // Any OTHER parsed sheet enriches by part number — e.g. a PI sheet for
    // prices + a PL packing sheet for carton dims/CBM in the same workbook.
    const enrich = new Map();
    for (const s2 of parsedSheets.slice(1)) {
      for (const l of s2.lines) {
        const k = norm(l.partNumber || l.supplierSku);
        if (k && !enrich.has(k)) enrich.set(k, l);
      }
    }
    for (const l of primary.lines) {
      const e = enrich.get(norm(l.partNumber || l.supplierSku));
      if (!e) continue;
      for (const f of ['make', 'model', 'year', 'lengthCm', 'widthCm', 'heightCm', 'weightKg', 'unitPrice', 'title', 'supplierSku', 'cbm', 'photo', 'cartons']) {
        if ((l[f] == null || l[f] === '') && e[f] != null) l[f] = e[f];
      }
      for (const [k, v] of Object.entries(e.extras || {})) if (!(k in l.extras)) l.extras[k] = v;
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

    await audit(req, 'supplier_import_parse', null, null, { file: req.file.originalname, lines: primary.lines.length, format: primary.loc.source });
    const sum = (f) => +primary.lines.reduce((a, l) => a + (Number(l[f]) || 0), 0).toFixed(3);
    res.json({
      ok: true,
      fileName: req.file.originalname,
      sheet: primary.name,
      supplierGuess: supplierHint || meta.supplier,
      invoiceGuess: meta.invoice,
      lines: primary.lines,
      matched: primary.lines.filter(l => l.candidates.length).length,
      totals: { qty: sum('qty'), total: sum('total'), cbm: sum('cbm'), mismatches: primary.lines.filter(l => l.totalMismatch).length },
      format: {
        source: primary.loc.source,                 // template | saved | rules | ai | manual
        savedFor: primary.loc.format ? primary.loc.format.supplier : null,
        sheet: primary.name, headerRow: primary.loc.headerIdx + 1,
        headers, mapping: primary.loc.map,
        extras: primary.loc.extras || (primary.loc.format && primary.loc.format.extras) || {},
        aiNotes, currency,
      },
      fields: OS.FIELDS, coreFields: OS.CORE,
    });
  } catch (e) {
    console.error('[supplier-import]', e);
    res.status(500).json({ error: 'parse_failed', message: e.message });
  }
});

// GET /api/supplier-import/template — our order list (.xlsx) to send suppliers.
router.get('/template', async (req, res) => {
  const buf = OS.buildTemplate({ supplier: OS.clean(req.query.supplier || ''), currency: OS.clean(req.query.currency || 'CNY') || 'CNY' });
  const name = 'Order-list' + (req.query.supplier ? '-' + OS.clean(req.query.supplier).replace(/[^A-Za-z0-9]+/g, '-') : '') + '.xlsx';
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
});
// POST /api/supplier-import/formats — remember a supplier's layout.
// { supplier, headers: [...], mapping: {field: col}, extras: {header: label}, source }
router.post('/formats', async (req, res) => {
  try {
    const b = req.body || {};
    const headers = Array.isArray(b.headers) ? b.headers.map(OS.clean) : [];
    if (!headers.length || !b.mapping) return res.status(400).json({ error: 'headers_and_mapping_required' });
    const mapping = {};
    for (const [f, c] of Object.entries(b.mapping)) if (OS.FIELDS[f] && Number.isInteger(c) && headers[c]) mapping[f] = headers[c];
    const sig = await OS.saveFormat({ supplier: OS.clean(b.supplier || ''), headers, mapping, extras: b.extras || {}, source: b.source || 'manual' });
    await audit(req, 'supplier_format_saved', null, null, { supplier: b.supplier, fields: Object.keys(mapping).length });
    res.json({ ok: true, signature: sig });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});
router.get('/formats', async (req, res) => {
  await OS.ensureTables();
  const { rows } = await query(`SELECT id, supplier, headers, mapping, extras, source, uses, updated_at FROM supplier_sheet_formats ORDER BY updated_at DESC LIMIT 200`);
  res.json({ formats: rows });
});
router.delete('/formats/:id', async (req, res) => {
  await OS.ensureTables();
  await query(`DELETE FROM supplier_sheet_formats WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
