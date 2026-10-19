// lib/order-sheet.js — supplier order lists: our template, any supplier's
// own layout, and a per-supplier memory of how their sheets are laid out.
//
// Core columns (always present on our template, always looked for on theirs):
//   Photo · Name · Part Number · Supplier Number · Price · Quantity · Total · CBM
// Everything else — make/model, carton size, colour, carton qty, whatever a
// supplier adds — is either mapped to a known field or KEPT as labelled
// extra info on the line (never thrown away).
//
// Reading order for a column layout:
//   1. our own template (marker cell)          → exact, instant
//   2. a SAVED format for this supplier        → exact, instant
//   3. built-in header rules                   → covers the usual names
//   4. Claude (headers + sample rows)          → fills gaps, labels extras
// Whatever was decided (and any correction made on the review screen) is
// saved against the supplier, so their next list reads instantly.
const XLSX = require('xlsx');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');

const TEMPLATE_MARKER = 'WAREHOUSE HUB ORDER LIST v1';

// Canonical fields a column can map to.
const FIELDS = {
  photo: 'Photo', title: 'Name', partNumber: 'Part Number', supplierSku: 'Supplier Number',
  unitPrice: 'Price (per unit)', qty: 'Quantity', total: 'Total (line)', cbm: 'CBM (line)',
  make: 'Make', model: 'Model', year: 'Year', remark: 'Remark',
  lengthCm: 'Carton length (cm)', widthCm: 'Carton width (cm)', heightCm: 'Carton height (cm)', weightKg: 'Weight (kg)',
  cartons: 'Cartons',
};
const CORE = ['photo', 'title', 'partNumber', 'supplierSku', 'unitPrice', 'qty', 'total', 'cbm'];

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const normCode = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const normHead = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── Built-in header rules (tested on real supplier sheets) ────────────────
const RULES = [
  ['photo', (h) => /\b(photo|picture|pic|image|img|图片|照片)\b/.test(h)],
  ['total', (h) => /\b(total|amount|line total|subtotal|金额)\b/.test(h) && !/\b(qty|quantity|cbm|weight|ctn|carton|kg)\b/.test(h)],
  ['cbm', (h) => /\b(cbm|m3|volume|体积)\b/.test(h)],
  ['partNumber', (h) => /\b(oem|oe|oe no|oem no|oe number|part number|part no|pn)\b/.test(h) && !/\b(factory|supplier|item no|lw)\b/.test(h)],
  ['supplierSku', (h) => /\b(supplier number|supplier no|supplier code|factory no|factory code|item no|item code|lw no|our no|art no|货号)\b/.test(h)],
  ['title', (h) => /\b(name|description|product|item name|label name|品名)\b/.test(h) && !/\b(supplier|company)\b/.test(h)],
  ['make', (h) => /^(make|brand|car brand)$/.test(h)],
  ['model', (h) => /^(model|car model|vehicle)$/.test(h)],
  ['year', (h) => /^year/.test(h)],
  ['qty', (h) => /\b(qty|quantity|pcs|数量)\b/.test(h) && !/\b(ctn|carton|per|box)\b/.test(h)],
  ['cartons', (h) => /\b(ctns?|cartons?)\b/.test(h) && !/\b(size|meas|dim|l|w|h)\b/.test(h)],
  ['unitPrice', (h) => (/\b(price|unit price|unit cost|单价)\b/.test(h)) && !/\btotal\b/.test(h)],
  ['remark', (h) => /\b(remark|remarks|note|notes|备注)\b/.test(h)],
  ['lengthCm', (h) => /^(carton )?(l|length)( cm)?$/.test(h)],
  ['widthCm', (h) => /^(carton )?(w|width)( cm)?$/.test(h)],
  ['heightCm', (h) => /^(carton )?(h|height)( cm)?$/.test(h)],
  ['weightKg', (h) => /\b(weight|kg|gw|nw)\b/.test(h) && !/\btotal\b/.test(h)],
];
function ruleMap(headerCells) {
  const map = {}; // field -> col
  headerCells.forEach((raw, i) => {
    const h = normHead(raw);
    if (!h) return;
    for (const [field, test] of RULES) {
      if (map[field] === undefined && test(h)) { map[field] = i; return; }
    }
  });
  return map;
}
function mapScore(map) {
  let s = 0;
  for (const k of ['partNumber', 'supplierSku', 'title', 'qty', 'unitPrice']) if (map[k] !== undefined) s++;
  for (const k of ['total', 'cbm', 'photo']) if (map[k] !== undefined) s += 0.5;
  return s;
}
const signatureOf = (headers) => crypto.createHash('sha1').update(headers.map(normHead).filter(Boolean).join('|')).digest('hex').slice(0, 16);

// ── Saved per-supplier formats ─────────────────────────────────────────────
let _ready = false;
async function ensureTables() {
  if (_ready) return;
  await query(`CREATE TABLE IF NOT EXISTS supplier_sheet_formats (
    id SERIAL PRIMARY KEY,
    supplier TEXT,
    supplier_norm TEXT,
    signature TEXT NOT NULL,
    headers JSONB NOT NULL,          -- header texts as they appear
    mapping JSONB NOT NULL,          -- field -> header text
    extras JSONB,                    -- header text -> label for kept extra columns
    source TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (supplier_norm, signature)
  )`);
  _ready = true;
}
async function savedFormats(supplier) {
  await ensureTables();
  const sn = normHead(supplier || '');
  const { rows } = await query(
    `SELECT * FROM supplier_sheet_formats ${sn ? 'WHERE supplier_norm = $1 OR supplier_norm = \'\'' : ''} ORDER BY updated_at DESC LIMIT 200`,
    sn ? [sn] : []);
  return rows;
}
async function saveFormat({ supplier, headers, mapping, extras, source }) {
  await ensureTables();
  const sig = signatureOf(headers);
  await query(`
    INSERT INTO supplier_sheet_formats (supplier, supplier_norm, signature, headers, mapping, extras, source, uses)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,1)
    ON CONFLICT (supplier_norm, signature) DO UPDATE
       SET supplier = EXCLUDED.supplier, headers = EXCLUDED.headers, mapping = EXCLUDED.mapping,
           extras = EXCLUDED.extras, source = EXCLUDED.source,
           uses = supplier_sheet_formats.uses + 1, updated_at = now()`,
    [supplier || null, normHead(supplier || ''), sig, JSON.stringify(headers), JSON.stringify(mapping), JSON.stringify(extras || {}), source || 'manual']);
  return sig;
}

// Does a saved format fit this header row? Match by header TEXT so columns
// moving around between orders doesn't break it.
function applySaved(fmt, headerCells) {
  const heads = headerCells.map(normHead);
  const map = {};
  let hits = 0, want = 0;
  for (const [field, headText] of Object.entries(fmt.mapping || {})) {
    want++;
    const i = heads.indexOf(normHead(headText));
    if (i >= 0) { map[field] = i; hits++; }
  }
  return want && hits / want >= 0.7 ? map : null;
}

// ── Embedded photos ────────────────────────────────────────────────────────
// Excel anchors pictures to cells via drawings; WPS (very common with Chinese
// suppliers) uses DISPIMG("ID_…") cell formulas + xl/cellimages.xml. Both are
// pulled out and keyed by sheet + row.
function zipGet(z, p) {
  const i = z.FullPaths.findIndex(f => f.endsWith('/' + p));
  return i >= 0 ? z.FileIndex[i].content : null;
}
const txt = (b) => (b ? Buffer.from(b).toString('utf8') : '');
function relsMap(xml) {
  const m = {};
  for (const r of xml.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) m[r[1]] = r[2];
  for (const r of xml.matchAll(/<Relationship\b[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) if (!m[r[2]]) m[r[2]] = r[1];
  return m;
}
const resolvePath = (base, target) => path.posix.normalize(path.posix.join(path.posix.dirname(base), target)).replace(/^\//, '');

function extractImages(buffer, wb, uploadDir) {
  const out = {}; // sheetName -> { rowIndex0: url }
  let z;
  try { z = XLSX.CFB.read(buffer, { type: 'buffer' }); } catch (_) { return out; }
  const dir = path.join(uploadDir, 'supplier-photos');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const save = (bytes, ext) => {
    if (!bytes) return null;
    const b = Buffer.from(bytes);
    const name = crypto.createHash('sha1').update(b).digest('hex').slice(0, 20) + '.' + (ext || 'png');
    const p = path.join(dir, name);
    try { if (!fs.existsSync(p)) fs.writeFileSync(p, b); } catch (_) { return null; }
    return '/uploads/supplier-photos/' + name;
  };
  const wbRels = relsMap(txt(zipGet(z, 'xl/_rels/workbook.xml.rels')));
  const wbXml = txt(zipGet(z, 'xl/workbook.xml'));
  // WPS cell images: name → media path
  const cellImg = {};
  const ciXml = txt(zipGet(z, 'xl/cellimages.xml'));
  if (ciXml) {
    const ciRels = relsMap(txt(zipGet(z, 'xl/_rels/cellimages.xml.rels')));
    for (const m of ciXml.matchAll(/<xdr:pic>[\s\S]*?name="([^"]+)"[\s\S]*?r:embed="([^"]+)"[\s\S]*?<\/xdr:pic>/g)) {
      if (ciRels[m[2]]) cellImg[m[1]] = resolvePath('xl/cellimages.xml', ciRels[m[2]]);
    }
  }
  for (const s of wbXml.matchAll(/<sheet\b[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const sheetName = s[1].replace(/&amp;/g, '&');
    const target = wbRels[s[2]]; if (!target) continue;
    const sheetPath = resolvePath('xl/workbook.xml', target);
    const rows = out[sheetName] = {};
    // Drawing-anchored pictures
    const sRels = relsMap(txt(zipGet(z, sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'))));
    for (const rel of Object.values(sRels).filter(t => /drawing/.test(t))) {
      const dPath = resolvePath(sheetPath, rel);
      const dXml = txt(zipGet(z, dPath));
      const dRels = relsMap(txt(zipGet(z, dPath.replace(/([^/]+)$/, '_rels/$1.rels'))));
      for (const a of dXml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g)) {
        const row = a[0].match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
        const emb = a[0].match(/r:embed="([^"]+)"/);
        if (!row || !emb || !dRels[emb[1]]) continue;
        const media = resolvePath(dPath, dRels[emb[1]]);
        const url = save(zipGet(z, media), (media.split('.').pop() || 'png').toLowerCase());
        if (url && rows[+row[1]] == null) rows[+row[1]] = url;
      }
    }
    // WPS DISPIMG formulas
    const ws = wb.Sheets[sheetName];
    if (ws && Object.keys(cellImg).length) {
      for (const [addr, cell] of Object.entries(ws)) {
        if (addr[0] === '!' || !cell) continue;
        const f = String(cell.f || cell.v || '');
        const m = f.match(/DISPIMG\(\s*"([^"]+)"/i);
        if (!m || !cellImg[m[1]]) continue;
        const r = XLSX.utils.decode_cell(addr).r;
        const url = save(zipGet(z, cellImg[m[1]]), (cellImg[m[1]].split('.').pop() || 'png').toLowerCase());
        if (url && rows[r] == null) rows[r] = url;
      }
    }
  }
  return out;
}

// ── Lines from a mapped sheet ──────────────────────────────────────────────
function buildLines(rows, headerIdx, map, extras, photos, rowOffset) {
  const lines = [];
  const header = rows[headerIdx] || [];
  const mappedCols = new Set(Object.values(map));
  const extraCols = header.map((h, i) => ({ i, h: clean(h) }))
    .filter(x => x.h && !mappedCols.has(x.i) && !(extras && extras.__ignore && extras.__ignore.includes(normHead(x.h))));
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (f) => map[f] !== undefined ? clean(row[map[f]]) : '';
    const qty = Math.round(num(cell('qty')) ?? NaN);
    const partNumber = cell('partNumber'), supplierSku = cell('supplierSku'), title = cell('title');
    if (!Number.isInteger(qty) || qty <= 0) continue;                 // totals/footer/blank rows
    if (!partNumber && !supplierSku && !title) continue;
    if (/^(total|sum|grand total|合计)/i.test(title)) continue;
    const unitPrice = num(cell('unitPrice'));
    const total = num(cell('total'));
    let dims = ['lengthCm', 'widthCm', 'heightCm'].map(f => num(cell(f)));
    if (dims.every(d => d != null && d > 0 && d < 10)) dims = dims.map(d => +(d * 100).toFixed(1)); // metres → cm
    const photoCell = cell('photo');
    const absRow = r + (rowOffset || 0);
    const photo = /^https?:\/\//i.test(photoCell) ? photoCell : (photos && photos[absRow]) || null;
    const ext = {};
    for (const x of extraCols) {
      const v = clean(row[x.i]);
      if (v) ext[(extras && extras[x.h]) || x.h] = v;
    }
    const expected = unitPrice != null ? +(unitPrice * qty).toFixed(2) : null;
    lines.push({
      row: absRow + 1,
      photo, title: title || null, partNumber: partNumber || null, supplierSku: supplierSku || null,
      unitPrice: unitPrice != null && unitPrice > 0 ? unitPrice : null, qty,
      total: total != null && total > 0 ? total : expected,
      totalMismatch: !!(total != null && expected != null && Math.abs(total - expected) > Math.max(0.5, expected * 0.01)),
      cbm: num(cell('cbm')),
      make: cell('make') || null, model: cell('model') || null, year: cell('year') || null,
      remark: cell('remark') || null, cartons: num(cell('cartons')),
      lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], weightKg: num(cell('weightKg')),
      extras: ext,
    });
  }
  return lines;
}

// Find the header row + mapping for one sheet. Returns null if no table.
function locateTable(rows, saved) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = rows[r] || [];
    // 1. our own template
    if (cells.some(c => clean(c).toUpperCase() === TEMPLATE_MARKER.toUpperCase())) {
      const hr = r + 1;
      const map = ruleMap(rows[hr] || []);
      return { headerIdx: hr, map, source: 'template', format: null };
    }
    // 2. a saved supplier format
    for (const f of saved || []) {
      const map = applySaved(f, cells);
      if (map) return { headerIdx: r, map, source: 'saved', format: f };
    }
    // 3. built-in rules
    const map = ruleMap(cells);
    const score = mapScore(map);
    if (score >= 2 && (!best || score > best.score)) best = { headerIdx: r, map, score, source: 'rules', format: null };
  }
  return best;
}

// ── Our template (download) ────────────────────────────────────────────────
function buildTemplate({ supplier = '', currency = 'CNY' } = {}) {
  const head = ['Photo', 'Name', 'Part Number', 'Supplier Number', 'Price', 'Quantity', 'Total', 'CBM',
    'Make', 'Model', 'Year', 'Carton L (cm)', 'Carton W (cm)', 'Carton H (cm)', 'Weight (kg)', 'Remark'];
  const aoa = [
    ['ORDER LIST'],
    ['Supplier:', supplier, '', 'Order no:', ''],
    ['Date:', new Date().toISOString().slice(0, 10), '', 'Currency:', currency],
    ['Incoterms (FOB / EXW):', ''],
    ['Paste a picture into the Photo cell (or an image link). Total = Price × Quantity. CBM = cubic metres for the WHOLE line. Add ANY extra columns to the right of Remark — the warehouse app reads them.'],
    [TEMPLATE_MARKER],
    head,
  ];
  const firstData = aoa.length + 1; // 1-based row of the first line
  const blank = 30;
  for (let i = 0; i < blank; i++) aoa.push(['', '', '', '', '', '', '', '']);
  const lastData = firstData + blank - 1;
  aoa.push(['', 'TOTAL', '', '', '', '', '', '']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = firstData; r <= lastData; r++) {
    ws['G' + r] = { t: 'n', f: `IF(AND(E${r}<>"",F${r}<>""),E${r}*F${r},"")` };
  }
  const tr = lastData + 1;
  ws['F' + tr] = { t: 'n', f: `SUM(F${firstData}:F${lastData})` };
  ws['G' + tr] = { t: 'n', f: `SUM(G${firstData}:G${lastData})` };
  ws['H' + tr] = { t: 'n', f: `SUM(H${firstData}:H${lastData})` };
  ws['!cols'] = [12, 38, 18, 18, 10, 10, 12, 8, 12, 14, 10, 12, 12, 12, 11, 24].map(w => ({ wch: w }));
  ws['!rows'] = Array.from({ length: tr }, (_, i) => (i >= firstData - 1 && i < lastData ? { hpt: 60 } : {}));
  const guide = XLSX.utils.aoa_to_sheet([
    ['How to fill in this order list'],
    [],
    ['Always fill in', 'Photo, Name, Part Number, Supplier Number, Price, Quantity, Total, CBM'],
    ['Photo', 'Paste the picture into the cell (Insert → Picture → Place in cell), or put an image link.'],
    ['Part Number', 'The OEM / OE number of the part.'],
    ['Supplier Number', 'Your own (supplier) code for the item.'],
    ['Price', 'Price per ONE piece, in the currency at the top.'],
    ['Total', 'Price × Quantity (filled automatically).'],
    ['CBM', 'Cubic metres for the WHOLE line (all cartons of this item).'],
    [],
    ['Extra columns', 'You can add any extra columns (colour, carton quantity, material, HS code…) to the right of Remark. Keep one item per row and the header in row 7.'],
    ['Do not', 'change the words in the header row, merge cells in the table, or put totals inside the item rows.'],
  ]);
  guide['!cols'] = [{ wch: 18 }, { wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Order list');
  XLSX.utils.book_append_sheet(wb, guide, 'How to fill in');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  FIELDS, CORE, TEMPLATE_MARKER, clean, normCode, normHead, num,
  ruleMap, mapScore, signatureOf, ensureTables, savedFormats, saveFormat, applySaved,
  extractImages, buildLines, locateTable, buildTemplate,
};
