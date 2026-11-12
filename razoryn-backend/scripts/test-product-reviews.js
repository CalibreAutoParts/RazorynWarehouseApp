// scripts/test-product-reviews.js — product-review rules without a database or network:
//   node scripts/test-product-reviews.js
const assert = require('assert');
const pr = require('../lib/product-reviews');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const ok = { rating: 5, body: 'Fitted perfectly first time.', name: 'Sam', email: 'sam@example.com', productId: '123' };

console.log('product-reviews');
t('display names: first name + initial, never the email', () => {
  assert.strictEqual(pr.displayName('barry kempton'), 'Barry K.');
  assert.strictEqual(pr.displayName('m h hoffman'), 'M. H.');
  assert.strictEqual(pr.displayName('SAM'), 'Sam');
  assert.strictEqual(pr.displayName('Anonymous'), 'Anonymous');
  assert.strictEqual(pr.displayName(''), 'Customer');
});
t('submissions are validated', () => {
  assert.ok(pr.validateSubmission(ok).ok);
  assert.strictEqual(pr.validateSubmission({ ...ok, rating: 6 }).error, 'rating_required');
  assert.strictEqual(pr.validateSubmission({ ...ok, body: 'meh' }).error, 'review_too_short');
  assert.strictEqual(pr.validateSubmission({ ...ok, name: ' ' }).error, 'name_required');
  assert.strictEqual(pr.validateSubmission({ ...ok, email: '' }).error, 'email_required');
  assert.ok(pr.validateSubmission({ ...ok, email: '', token: '1.abc' }).ok, 'signed email link needs no email');
  assert.strictEqual(pr.validateSubmission({ ...ok, email: 'nope' }).error, 'bad_email');
  assert.strictEqual(pr.validateSubmission({ ...ok, body: 'buy at http://a.com or http://b.com' }).error, 'links_not_allowed');
  assert.strictEqual(pr.validateSubmission({ ...ok, productId: 'gid://shopify/Product/42' }).review.productId, '42');
});
t('signed buyer tokens', () => {
  const tok = pr.signSaleToken(57);
  assert.strictEqual(pr.verifySaleToken(tok), 57);
  assert.strictEqual(pr.verifySaleToken('58.' + tok.split('.')[1]), null);
  assert.strictEqual(pr.verifySaleToken('junk'), null);
});
t('product payload: newest first, only published, eBay kept separate, no emails', () => {
  const p = pr.buildProductPayload([
    { id: 1, rating: 5, body: 'a', author_name: 'Ann Lee', author_email: 'ann@x.com', status: 'published', created_at: '2026-01-01', verified: true },
    { id: 2, rating: 2, body: 'b', author_name: 'Bob', status: 'published', created_at: '2026-03-01', reply: 'Sorry' },
    { id: 3, rating: 1, body: 'c', author_name: 'Cy', status: 'hidden', created_at: '2026-04-01' },
  ], { ebay_sum: 18, ebay_count: 4 });
  assert.strictEqual(p.count, 2); assert.strictEqual(p.avg, 3.5);
  assert.strictEqual(p.ebay_count, 4); assert.strictEqual(p.ebay_avg, 4.5);
  assert.strictEqual(p.total_count, 6); assert.strictEqual(p.total_avg, 4.2);
  assert.deepStrictEqual(p.items.map(i => i.id), [2, 1]);
  assert.strictEqual(p.items[1].n, 'Ann L.'); assert.strictEqual(p.items[0].reply, 'Sorry');
  assert.ok(!JSON.stringify(p).includes('ann@x.com'));
});
t('import rows from other apps', () => {
  const m = pr.mapImportRow({ 'Product Handle': 'grille', 'Rating': '8', 'Review Content': 'Good', 'Reviewer Name': 'Jo', 'Status': 'unpublished', 'Review ID': '9' }, 'import:csv');
  assert.strictEqual(m.rating, 4); assert.strictEqual(m.handle, 'grille'); assert.strictEqual(m.hidden, true); assert.strictEqual(m.externalId, 'import:csv:9');
  assert.strictEqual(pr.mapImportRow({ product_url: 'https://x.co.uk/products/bonnet?v=1', stars: '5', body: 'Ok' }).handle, 'bonnet');
  assert.strictEqual(pr.mapImportRow({ rating: '', body: 'x' }).skip, 'no_rating');
  const jm = pr.rowsFromJudgeMe({ all_reviews: { reviews: [{ uuid: 'u1', rating: 3, body: 'fine', product_url: '/products/wing', verified_buyer: true, is_shop_review: false }] } });
  const mj = pr.mapImportRow(jm[0], 'import:judgeme');
  assert.strictEqual(mj.handle, 'wing'); assert.strictEqual(mj.verified, true); assert.strictEqual(mj.externalId, 'import:judgeme:u1');
  assert.strictEqual(mj.reply, null, 'a missing reply is not the text "null"');
  assert.strictEqual(pr.mapImportRow({ rating: 4, body: 'ok', reply: 'null', title: 'undefined' }).reply, null);
});
t('CSV parsing keeps quoted commas and line breaks', () => {
  const rows = pr.parseCsv('Rating,Review\n5,"Great, really\nsecond line"\n');
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].Review, 'Great, really\nsecond line');
});
console.log(`${n} passed`);
process.exit(0);
