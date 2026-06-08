// lib/vehicle.js — shared vehicle / part title parsing.
//
// Extracted from routes/listings.js so both the eBay listing flow and the
// competitor-monitor matcher (services/competitor-monitor.js) share ONE source
// of truth. parseVehicleFromTitle is kept byte-for-byte identical to the
// original so existing listing behaviour is unchanged; the extra helpers
// (PART_TYPES / extractPartType / extractPartNumber / normCode) are new and
// used only by the competitor matcher.

// Known UK car makes — matched conservatively against a title.
const VEHICLE_MAKES = ['Abarth','Alfa Romeo','Aston Martin','Audi','Bentley','BMW','Citroen','Citroën','Cupra','Dacia','DS','Ferrari','Fiat','Ford','Honda','Hyundai','Jaguar','Jeep','Kia','Lamborghini','Land Rover','Lexus','Maserati','Mazda','McLaren','Mercedes-Benz','Mercedes','MG','Mini','Mitsubishi','Nissan','Peugeot','Polestar','Porsche','Renault','Seat','Skoda','Škoda','Smart','SsangYong','Subaru','Suzuki','Tesla','Toyota','Vauxhall','Volkswagen','VW','Volvo'];

// Best-effort parse of vehicle Make / Model / Year(range) from a product title.
// Conservative — only emits a value when reasonably confident (make matched
// against the known list, etc.). Returns { make, model, year }.
function parseVehicleFromTitle(title) {
  const t = ' ' + String(title || '') + ' ';
  let make = null, makeRe = null;
  for (const m of VEHICLE_MAKES) {
    const re = new RegExp('\\b' + m.replace(/-/g, '[- ]?') + '\\b', 'i');
    if (re.test(t)) { make = (m === 'VW' ? 'Volkswagen' : m); makeRe = re; break; }
  }
  // Year range (2019-2024, 2019–2024, 2019 to 2024) else single year.
  let year = null;
  const range = t.match(/\b((?:19|20)\d{2})\s*(?:[-–]|to)\s*((?:19|20)\d{2})\b/i);
  if (range) year = `${range[1]}-${range[2]}`;
  else { const single = t.match(/\b((?:19|20)\d{2})\b/); if (single) year = single[1]; }
  // Model — the 1-2 tokens after the make, up to a year or a part-type keyword.
  let model = null;
  if (makeRe) {
    const after = t.split(makeRe)[1] || '';
    const stopIdx = after.search(/\b(?:19|20)\d{2}\b|\b(?:front|rear|left|right|lh|rh|bumper|bonnet|hood|headlight|headlamp|taillight|wing|fender|door|mirror|grille|grill|tailgate|panel|arch|spoiler|skirt|sill)\b/i);
    const seg = (stopIdx > 0 ? after.slice(0, stopIdx) : after).trim();
    const tokens = seg.split(/\s+/).filter(Boolean).slice(0, 2);
    if (tokens.length) model = tokens.join(' ');
  }
  return { make, model, year };
}

// Part types competitors commonly list. Multi-word entries come first so they
// win over their single-word components ("control arm" before "arm"). Used by
// the matcher to decide both shared-item matches and "new opportunity" gaps.
const PART_TYPES = [
  'control arm','radiator grille','quarter panel','slam panel','headlamp washer',
  'shock absorber','catalytic converter','anti roll bar','engine mount',
  'starter motor','air filter','oil filter','wing mirror','door mirror',
  'fog light','fog lamp','tail light','taillight','tail lamp','head light',
  'headlight','headlamp','brake disc','brake pad','ball joint','track rod',
  'coil spring','drive shaft','driveshaft','cv joint','boot lid',
  'wishbone','indicator','bumper','bonnet','hood','grille','grill','tailgate',
  'radiator','condenser','intercooler','windscreen','window','mirror','door',
  'wing','fender','panel','arch','spoiler','skirt','sill','splitter','diffuser',
  'valance','strut','hub','bearing','caliper','subframe','alternator','turbo',
  'turbocharger','exhaust','dpf','intake','clutch','flywheel','gearbox',
];

// Normalise a code to alphanumeric-uppercase, mirroring routes/listings.js and
// the sync resolver, so part numbers compare regardless of spacing/hyphenation.
function normCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Detect the part type in a free-text title. Returns the canonical PART_TYPES
// string (lowercase) or null.
function extractPartType(title) {
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  for (const p of PART_TYPES) {
    const re = new RegExp('\\b' + p.replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (re.test(t)) return p;
  }
  return null;
}

// Best-effort OEM part-number extraction from a free-text title. OEM codes are
// alphanumeric runs (often hyphenated) of >=5 chars containing at least one
// digit. Returns the NORMALISED code (alnum-only, uppercased), or null. This is
// only a hint: exact_part_number matching still requires it to equal one of our
// products' part_number/sku, so the occasional false positive harmlessly falls
// through to the make/model matcher.
function extractPartNumber(title) {
  const tokens = String(title || '').match(/\b[A-Z0-9][A-Z0-9-]{4,}\b/gi) || [];
  let best = null;
  for (const tok of tokens) {
    if (/^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/.test(tok)) continue; // year range
    const n = normCode(tok);
    if (n.length < 5) continue;
    if (!/[0-9]/.test(n)) continue;                 // must contain a digit
    if (/^(?:19|20)\d{2}$/.test(n)) continue;       // bare year
    if (/^[0-9]+$/.test(n) && n.length < 6) continue; // short pure number
    if (!best || n.length > best.length) best = n;   // prefer the longest code
  }
  return best;
}

// Matcher-oriented parse used by the competitor monitor. Builds on
// parseVehicleFromTitle but additionally recovers a "glued" make+model where the
// make runs straight into the model number — e.g. "MG4", "MG3", "MG5" — which
// the word-boundary make match in parseVehicleFromTitle deliberately misses.
// This is the exact shape the competitor matcher needs (make/model/partType/
// partNumber) and is kept separate so listing-side behaviour stays unchanged.
function parseForMatch(title) {
  const base = parseVehicleFromTitle(title);
  let { make, model, year } = base;
  if (!make) {
    const t = ' ' + String(title || '') + ' ';
    for (const m of VEHICLE_MAKES) {
      // Require the make to be immediately followed by a DIGIT, so this only
      // fires for genuinely glued model codes (MG4) and never on words like
      // "DSG" (no digit after DS).
      const re = new RegExp('\\b(' + m.replace(/-/g, '[- ]?') + ')(\\d\\w*)', 'i');
      const hit = t.match(re);
      if (hit) {
        make = (m === 'VW' ? 'Volkswagen' : m);
        model = hit[1].toUpperCase() + hit[2]; // e.g. "MG" + "4" -> "MG4"
        break;
      }
    }
  }
  return {
    make: make || null,
    model: model || null,
    year: year || null,
    partType: extractPartType(title),
    partNumber: extractPartNumber(title),
  };
}

module.exports = {
  VEHICLE_MAKES,
  parseVehicleFromTitle,
  parseForMatch,
  PART_TYPES,
  extractPartType,
  extractPartNumber,
  normCode,
};
