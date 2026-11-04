// lib/shopify-category.js — pick the right Shopify product category for a car part.
//
// Shopify's taxonomy is American and covers everything (clothes, toys…). Matching
// an eBay category name straight against it goes wrong for UK car words:
// "Bonnet Panels" hit "Apparel > Headwear > Bonnets & Sleep Caps". So: translate
// UK → US car terms, and ONLY accept categories under "Vehicles & Parts".
const shopify = require('../services/shopify');

// Longest phrases first (applied in order, whole words, case-insensitive).
const UK_TO_US = [
  ['bonnet panels', 'hoods'], ['bonnet panel', 'hood'], ['bonnets', 'hoods'], ['bonnet', 'hood'],
  ['wing mirror covers', 'side view mirror covers'], ['wing mirror glass', 'side view mirror glass'], ['wing mirrors', 'side view mirrors'], ['wing mirror', 'side view mirror'],
  ['door mirrors', 'side view mirrors'], ['door mirror', 'side view mirror'],
  ['wings', 'fenders'], ['wing', 'fender'],
  ['boot lids', 'trunk lids'], ['boot lid', 'trunk lid'], ['boot', 'trunk'],
  ['windscreens', 'windshields'], ['windscreen', 'windshield'],
  ['number plates', 'license plates'], ['number plate', 'license plate'],
  ['sills', 'rocker panels'], ['sill', 'rocker panel'],
  ['wheel arch liners', 'fender liners'], ['arch liners', 'fender liners'], ['arch liner', 'fender liner'],
  ['indicators', 'turn signal lights'], ['indicator', 'turn signal light'],
  ['headlamps', 'headlights'], ['headlamp', 'headlight'], ['rear lights', 'tail lights'], ['rear light', 'tail light'],
  ['scuttle panels', 'cowl panels'], ['scuttle panel', 'cowl panel'],
  ['tyres', 'tires'], ['tyre', 'tire'], ['petrol', 'gas'],
];
function toUS(name) {
  let s = ' ' + String(name || '').toLowerCase() + ' ';
  for (const [uk, us] of UK_TO_US) s = s.replace(new RegExp(`\\b${uk.replace(/ /g, '\\s+')}\\b`, 'g'), us);
  return s.trim().replace(/\s+/g, ' ');
}
const isVehicle = (full) => /^vehicles\s*&\s*parts/i.test(String(full || ''));
const leaf = (full) => String(full || '').split(/[>›]/).pop().trim().toLowerCase();
const singular = (w) => w.replace(/ies$/, 'y').replace(/s$/, '');

// Best Vehicles & Parts category for a part / eBay category name, or null.
async function vehicleCategoryFor(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const us = toUS(raw);
  const tries = [...new Set([us, singular(us), raw])].filter(t => t.length >= 2);
  for (const t of tries) {
    const cats = (await shopify.searchTaxonomyCategories(t)).filter(c => isVehicle(c.fullName));
    if (!cats.length) continue;
    const want = [t, singular(t)];
    const exact = cats.find(c => want.includes(leaf(c.fullName)) || want.includes(singular(leaf(c.fullName))));
    const c = exact || cats[0];
    return { id: c.id, name: c.fullName, via: t, exact: !!exact };
  }
  // Last resort: the body-parts branch, never something outside vehicles.
  const body = (await shopify.searchTaxonomyCategories('Motor Vehicle Frame & Body Parts')).filter(c => isVehicle(c.fullName));
  const parent = body.find(c => leaf(c.fullName) === 'motor vehicle frame & body parts') || body.find(c => leaf(c.fullName) === 'motor vehicle parts');
  return parent ? { id: parent.id, name: parent.fullName, via: 'fallback', exact: false } : null;
}

module.exports = { toUS, isVehicle, vehicleCategoryFor };
