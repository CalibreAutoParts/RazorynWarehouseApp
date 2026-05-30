// lib/seo.js — Search-engine listing optimiser for vehicle-parts products.
//
// Pure, side-effect-free generation of clean Shopify SEO fields from a product's
// own data (title / make / model / year / part_number). Used by the SEO
// optimiser (preview + bulk apply). Kept dependency-free so it can be unit
// tested in isolation and reused server-side without hitting Shopify.
//
// What it produces per product:
//   pageTitle        ≤ 70 chars, ends with the brand name
//   metaDescription  ≤ 160 chars, consistent template (part no., brand, UK +
//                    Watford-area collection, part-type keyword)
//   handle           clean URL slug — make-model-position-parttype, no keyword
//                    stuffing, no part numbers
//   partType         canonical part-type label (e.g. "Fog Light")
//   categoryQuery    the Shopify taxonomy search term for that part type
//
// The brand name + collection blurb come from lib/brand.js so Calibre and
// Razoryn each get their own wording automatically.

// ── Part-type detection ─────────────────────────────────────────────────────
// Order matters: more specific phrases first so "fog light" wins over "light".
// Each entry: [canonical label, [regex alternates], shopify taxonomy search term]
// The search term is what we look up in Shopify's standard product taxonomy to
// get the correct category — chosen to match Shopify's own naming.
const PART_TYPES = [
  ['Fog Light',          [/\bfog\s?lights?\b/, /\bfog\s?lamps?\b/, /\bfoglights?\b/, /\bfoglamps?\b/], 'Fog Lights'],
  ['Headlight',          [/\bhead\s?lights?\b/, /\bhead\s?lamps?\b/, /\bheadlights?\b/, /\bheadlamps?\b/], 'Headlights'],
  ['Tail Light',         [/\btail\s?lights?\b/, /\brear\s?lights?\b/, /\btail\s?lamps?\b/, /\bbrake\s?lights?\b/], 'Tail Lights'],
  ['Indicator',          [/\bindicators?\b/, /\bturn\s?signals?\b/, /\brepeaters?\b/], 'Turn Signal Lights'],
  ['Front Bumper',       [/\bfront\s+bumpers?\b/], 'Bumpers'],
  ['Rear Bumper',        [/\brear\s+bumpers?\b/], 'Bumpers'],
  ['Bumper',             [/\bbumpers?\b/], 'Bumpers'],
  ['Bonnet',             [/\bbonnets?\b/, /\bhoods?\b/], 'Hoods'],
  // Door Mirror must come before Wing — "wing mirror" should not match "wing".
  ['Door Mirror',        [/\b(door|wing|side|electric|power)\s?mirrors?\b/, /\bmirrors?\b/], 'Car Mirrors'],
  ['Wing',               [/\bwings?\b/, /\bfenders?\b/], 'Fenders'],
  ['Grille',             [/\bgrilles?\b/, /\bgrills?\b/], 'Grilles'],
  ['Tailgate',           [/\btail\s?gates?\b/, /\bboot\s?lids?\b/], 'Tailgates'],
  ['Door',               [/\bdoors?\b/], 'Doors'],
  ['Radiator',           [/\bradiators?\b/], 'Radiators'],
  ['Wheel',              [/\balloys?\b/, /\bwheels?\b/, /\brims?\b/], 'Wheels'],
  ['Windscreen',         [/\bwind\s?screens?\b/, /\bwind\s?shields?\b/], 'Windshields'],
  ['Sensor',             [/\bsensors?\b/], 'Vehicle Sensors'],
  ['Wiring Loom',        [/\bwiring\s+looms?\b/, /\bharness(es)?\b/, /\blooms?\b/], 'Vehicle Wiring Harnesses'],
];

// Side / position keywords. Detected separately so they flow into the handle and
// title (e.g. "Front Right"). Front/Rear first, then Left/Right.
const POSITIONS = [
  ['Front', /\bfront\b/], ['Rear', /\brear\b/],
  ['Left', /\b(left|n\/?s|near\s?side|passenger\s?side)\b/],
  ['Right', /\b(right|o\/?s|off\s?side|driver\s?side)\b/],
];

function detectPartType(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  for (const [label, patterns, categoryQuery] of PART_TYPES) {
    if (patterns.some(re => re.test(t))) return { partType: label, categoryQuery };
  }
  return { partType: null, categoryQuery: null };
}

function detectPositions(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  const out = [];
  for (const [label, re] of POSITIONS) if (re.test(t)) out.push(label);
  return out; // e.g. ['Front','Right']
}

// Pull a year or year-range from text: "2016-2019" or "2018". Returns the raw
// string for display ("2016-2019") or '' if none found.
function detectYears(text) {
  const s = String(text || '');
  const range = s.match(/((?:19|20)\d{2})\s*[-–to]+\s*((?:19|20)\d{2})/);
  if (range) return `${range[1]}-${range[2]}`;
  const one = s.match(/\b((?:19|20)\d{2})\b/);
  return one ? one[1] : '';
}

// ── Slug helpers ────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumerics → single dash
    .replace(/^-+|-+$/g, '')        // trim leading/trailing dashes
    .replace(/-{2,}/g, '-');        // collapse repeats
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Main builder ────────────────────────────────────────────────────────────
// product: { title, brand (= vehicle make), model, part_number, sku }
// brandCfg: lib/brand.js object (name, collection area wording optional)
function buildSeo(product = {}, brandCfg = {}) {
  const sourceText = [product.title, product.brand, product.model].filter(Boolean).join(' ');
  const { partType, categoryQuery } = detectPartType(product.title || sourceText);
  const positions = detectPositions(product.title || sourceText);
  const years = detectYears(product.title || sourceText);

  const make = (product.brand || '').trim();
  const model = (product.model || '').trim();
  const partNo = (product.part_number || '').trim();
  const bizName = brandCfg.fullName || brandCfg.name || 'our store';

  // Human label for the part, e.g. "Front Right Fog Light". Drop any position
  // word already baked into the part type (e.g. partType "Front Bumper" should
  // not become "Front Front Bumper").
  const ptLower = (partType || '').toLowerCase();
  const labelPositions = positions.filter(p => !ptLower.includes(p.toLowerCase()));
  const partLabel = [...labelPositions, partType].filter(Boolean).join(' ') || 'Part';

  // Vehicle label, e.g. "KIA Niro 2016-2019"
  const vehicle = [make ? make.toUpperCase() : '', titleCase(model), years]
    .filter(Boolean).join(' ').trim();

  // ── Page title (≤70). "{Vehicle} {Part Label} | {Brand}" trimmed to fit.
  let pageTitle = [vehicle, partLabel].filter(Boolean).join(' ').trim() || (product.title || '').trim();
  const suffix = ` | ${brandCfg.name || bizName}`;
  if ((pageTitle + suffix).length <= 70) pageTitle = pageTitle + suffix;
  else if (pageTitle.length > 70) pageTitle = pageTitle.slice(0, 70).trim();

  // ── Meta description (≤160). One consistent template for every listing.
  const area = brandCfg.collectionArea || 'Watford, London & Hertfordshire';
  const partSentence = vehicle
    ? `${vehicle} ${partLabel}`
    : (product.title || partLabel);
  const pieces = [
    `${partSentence}${partNo ? ` (Part No. ${partNo})` : ''}.`,
    `Quality aftermarket parts from ${bizName}.`,
    `UK delivery & collection in ${area}.`,
  ];
  let metaDescription = pieces.join(' ');
  if (metaDescription.length > 160) {
    // Drop the area clause first, then the brand clause, to stay within 160.
    metaDescription = [pieces[0], pieces[1]].join(' ');
    if (metaDescription.length > 160) metaDescription = pieces[0];
    if (metaDescription.length > 160) metaDescription = metaDescription.slice(0, 157).trim() + '…';
  }

  // ── Handle: clean slug, no part numbers / no keyword stuffing.
  // make-model-years-position-parttype (whichever parts exist).
  const handleParts = [
    make, model, years,
    ...labelPositions.map(p => p.toLowerCase()),
    partType,
  ].filter(Boolean);
  let handle = slugify(handleParts.join(' '));
  if (!handle) handle = slugify(product.title || product.sku || '');

  return {
    pageTitle,
    metaDescription,
    handle,
    partType,
    positions,
    years,
    vehicle,
    categoryQuery,
  };
}

module.exports = {
  buildSeo,
  detectPartType,
  detectPositions,
  detectYears,
  slugify,
  PART_TYPES,
};
