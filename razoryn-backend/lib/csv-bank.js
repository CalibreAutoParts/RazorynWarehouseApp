// lib/csv-bank.js — deterministic CSV handling for bank exports.
//
// The CSV is the bank's exact data, so the transactions are built HERE, in
// code, from every row — Claude is only asked two small questions: "which
// column is which?" (headers + a sample) and "what category is each line?"
// (batched). That way a 3-month export with hundreds of rows parses exactly,
// with no model output limits in the way.

// RFC-4180-ish parser: quoted fields, embedded commas/newlines, "" escapes.
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row); row = []; };
  const d = delimiter || detectDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === d) push();
    else if (c === '\n') { push(); endRow(); }
    else if (c === '\r') { /* swallow */ }
    else field += c;
  }
  push(); endRow();
  return rows;
}
function detectDelimiter(text) {
  const head = text.slice(0, 2000);
  const counts = [[',', (head.match(/,/g) || []).length], [';', (head.match(/;/g) || []).length], ['\t', (head.match(/\t/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// Banks sometimes prepend preamble lines — the header row is the first row
// where several cells look like column names.
function findHeaderRow(rows) {
  const namey = /date|amount|description|detail|balance|money|paid|credit|debit|reference|counterparty|name|type|category|payee|merchant/i;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hits = rows[i].filter(c => namey.test(String(c))).length;
    if (hits >= 2) return i;
  }
  return 0;
}

// "£1,234.56", "1.234,56", "(45.00)", "-45.00" → number. Returns null when
// the cell isn't a money value.
function parseMoney(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()£$€\s]/g, '').replace(/^-/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{2})$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,56
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
// Convert a cell to YYYY-MM-DD using the AI-identified format as a hint, with
// sturdy fallbacks (UK day-first).
function toIsoDate(raw, formatHint) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                       // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);        // numeric d/m/y or m/d/y
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (parseInt(y) > 70 ? '19' : '20') + y;
    const mdFirst = /^M/i.test(String(formatHint || ''));
    const day = mdFirst ? b : a, mon = mdFirst ? a : b;
    if (parseInt(mon) > 12 && parseInt(day) <= 12) return `${y}-${String(day).padStart(2, '0')}-${String(mon).padStart(2, '0')}`;
    return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{2,4})/);        // 12 Jul 2026
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = m[3]; if (y.length === 2) y = '20' + y;
    if (mon) return `${y}-${mon}-${String(m[1]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Build exact transactions from every data row using the AI column mapping.
// mapping: { dateCol, dateFormat, descriptionCols:[...], amountMode:'signed'|'split',
//            amountCol, inCol, outCol, balanceCol, counterpartyCol }
function buildTransactions(rows, headerIdx, mapping) {
  const out = [];
  const cell = (r, i) => (i == null || i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim());
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const date = toIsoDate(cell(r, mapping.dateCol), mapping.dateFormat);
    if (!date) continue;                                            // totals/blank rows
    let moneyIn = 0, moneyOut = 0;
    if (mapping.amountMode === 'split') {
      moneyIn = Math.abs(parseMoney(cell(r, mapping.inCol)) || 0);
      moneyOut = Math.abs(parseMoney(cell(r, mapping.outCol)) || 0);
    } else {
      const amt = parseMoney(cell(r, mapping.amountCol));
      if (amt == null) continue;
      if (amt >= 0) moneyIn = amt; else moneyOut = -amt;
    }
    if (!moneyIn && !moneyOut) continue;
    const description = (mapping.descriptionCols || []).map(c => cell(r, c)).filter(Boolean).join(' · ').slice(0, 300);
    const balance = mapping.balanceCol != null ? parseMoney(cell(r, mapping.balanceCol)) : null;
    out.push({
      date, description,
      moneyIn: +moneyIn.toFixed(2), moneyOut: +moneyOut.toFixed(2),
      balance: balance != null ? +balance.toFixed(2) : null,
      counterparty: mapping.counterpartyCol != null ? cell(r, mapping.counterpartyCol).slice(0, 120) || null : null,
    });
  }
  return out;
}

module.exports = { parseCsv, findHeaderRow, buildTransactions, toIsoDate, parseMoney };
