// scripts/test-listing-copy.js — website listing copy + catalogue optimiser rules,
// no database or network:   node scripts/test-listing-copy.js
const assert = require('assert');
const lc = require('../lib/listing-copy');
const cc = require('../lib/catalog-copy');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
console.log('listing-copy');

t('titles split into vehicle, years and part; caps tidied, codes kept', () => {
  assert.deepStrictEqual(lc.parseTitle('KIA PICANTO GT LINE MK3 2023-2026 Rear Right Brake Light Lamp'),
    { vehicle: 'Kia Picanto GT Line MK3', years: '2023–2026', part: 'Rear Right Brake Light Lamp' });
  assert.strictEqual(lc.parseTitle('VW Golf MK8 2021 - 2024 Left Headlamp Housing').vehicle, 'VW Golf MK8');
  assert.strictEqual(lc.parseTitle('Seatbelt Height Adjuster Bracket').vehicle, '');
  assert.strictEqual(lc.tidyCase('HONDA HRV HR-V'), 'Honda HRV HR-V');
});
t('eBay-template and empty descriptions are replaced; good ones kept', () => {
  assert.ok(lc.needsNewDescription(''));
  assert.ok(lc.needsNewDescription('<p>eBay\'s compatibility list is a guide only</p>'));
  assert.ok(lc.needsNewDescription('… You might be interested in Peugeot 208 £249.99'));
  assert.ok(!lc.needsNewDescription('Brand-new front right headlight for the Kia Picanto, 2024–2026. OE reference 92102-G6500 — send us your reg for a free fitment check.'));
});
t('description: facts from the listing, no eBay wording or prices, HTML-safe', () => {
  const h = lc.buildDescriptionHtml({ title: 'Hyundai Tucson 2022-2026 Primed Front Left Door Shell <x>', partNumber: '76003-N9000', tags: 'LP, Hyundai' });
  assert.ok(h.includes('<strong>Hyundai Tucson</strong> (2022–2026)'));
  assert.ok(h.includes('76003-N9000'));
  assert.ok(/primed, ready for painting/i.test(h) && /don't paint panels/.test(h));
  assert.ok(h.includes('passenger side / N/S'));
  assert.ok(/Large panel/.test(h) && /returned only if faulty/.test(h), 'large-panel delivery + returns');
  assert.ok(!/eBay|£\d+\.\d\d|PayPal/.test(h));
  assert.ok(h.includes('&lt;x&gt;') && !h.includes('<x>'));
  const s = lc.buildDescriptionHtml({ title: 'Kia Picanto 2017-2024 Front Right Fog Light', partNumber: '92202-G6000' });
  assert.ok(/30-day returns/.test(s) && /Free UK delivery over £50/.test(s) && /O\/S/.test(s));
});
t('product types: specific car-part names before generic ones', () => {
  const cases = {
    'Hyundai Tucson Front Bumper Lower Grille': 'Grille', 'Tucson Front Left Wheel Arch Trim Garnish': 'Wheel Arch Trim',
    'Toyota Yaris Rear Parcel Shelf': 'Parcel Shelf', 'Peugeot 208 Rear Right Brake Lamp Light': 'Tail Light',
    'Skoda Octavia Primed Front Left Wing Fender': 'Wing', 'Hyundai i20 Primed Front Bumper Skin': 'Front Bumper',
    'Peugeot 3008 Front Left Day Running Lamp DRL': 'Daytime Running Light', 'Ioniq 5 Front Left Wheel Arch Splash Guard': 'Wheel Arch Liner',
  };
  for (const [title, type] of Object.entries(cases)) assert.strictEqual(lc.productTypeFor(title), type, title);
});
t('optimiser plan: only what is missing or wrong', () => {
  const good = { title: 'Kia Picanto 2024-2026 Front Right Headlight', productType: 'Headlight',
    descriptionHtml: 'Brand-new front right headlight for the Kia Picanto, 2024–2026. OE reference 92102-G6500 — send us your reg for a free fitment check.',
    category: { fullName: 'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Lighting > Headlights' },
    seo: { title: 'x', description: 'y' }, tags: [] };
  assert.strictEqual(cc.planChanges(good), null);
  const ebay = { ...good, productType: '', descriptionHtml: '<p>eBay listing … You might be interested in</p>', category: null, seo: { title: '', description: '' } };
  const plan = cc.planChanges(ebay);
  assert.ok(plan.descriptionHtml && plan.backupHtml.includes('eBay'));
  assert.strictEqual(plan.productType, 'Headlight');
  assert.strictEqual(plan.categoryQuery, 'Headlights');
  assert.ok(plan.seo.title && plan.seo.description);
  assert.ok(!cc.planChanges({ ...ebay, backup: { id: 'b' } }).backupHtml, 'backup written only once');
});
console.log(`${n} passed`);
process.exit(0);
