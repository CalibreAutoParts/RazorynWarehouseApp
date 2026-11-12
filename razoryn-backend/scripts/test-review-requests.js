// scripts/test-review-requests.js — checks the review-request timing + email rules
// without a database or network:   node scripts/test-review-requests.js
const assert = require('assert');
const rr = require('../lib/review-requests');

const DAY = 86400000;
const now = new Date('2026-11-12T12:00:00Z');
const ago = d => new Date(now - d * DAY).toISOString();
const cfg = rr.normalise({ enabled: true, googleUrl: 'https://g.page/r/X/review' });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

console.log('review-requests');
t('delivered: waits a day, then due', () => {
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(3) }, { deliveredAt: ago(0.5) }, cfg, now).due, false);
  const r = rr.reviewTiming({ dispatched_at: ago(3) }, { deliveredAt: ago(1.1) }, cfg, now);
  assert.strictEqual(r.due, true); assert.strictEqual(r.reason, 'delivered');
});
t('carrier delivered_at on the sale counts too', () => {
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(3), delivered_at: ago(2) }, null, cfg, now).reason, 'delivered');
});
t('collected (warehouse or Shopify pick-up) beats delivered', () => {
  assert.strictEqual(rr.reviewTiming({ collected_at: ago(2) }, null, cfg, now).reason, 'collected');
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(2) }, { pickedUpAt: ago(2) }, cfg, now).reason, 'collected');
});
t('no delivery scan: due 10 days after dispatch', () => {
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(9) }, {}, cfg, now).due, false);
  const r = rr.reviewTiming({ dispatched_at: ago(10.1) }, {}, cfg, now);
  assert.strictEqual(r.due, true); assert.strictEqual(r.reason, 'no_delivery_scan');
});
t('cancelled / refunded / too old are skipped', () => {
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(12) }, { cancelled: true }, cfg, now).skip, 'cancelled');
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(12), status: 'refunded' }, null, cfg, now).skip, 'refunded');
  assert.strictEqual(rr.reviewTiming({ dispatched_at: ago(31) }, null, cfg, now).skip, 'too_old');
});
t('settings are clamped and links must be https', () => {
  const c = rr.normalise({ fallbackDays: 99, daysAfterDelivery: -3, trustpilotUrl: 'http://x', googleUrl: 'javascript:alert(1)', sendFrom: 22, sendTo: 6 });
  assert.strictEqual(c.fallbackDays, 10); assert.strictEqual(c.daysAfterDelivery, 1);
  assert.strictEqual(c.trustpilotUrl, ''); assert.strictEqual(c.googleUrl, '');
  assert.strictEqual(c.sendFrom, 9); assert.strictEqual(c.sendTo, 20);
});
t('send window follows UK time (GMT and BST)', () => {
  assert.strictEqual(rr.inSendWindow(cfg, new Date('2026-11-12T08:30:00Z')), false);
  assert.strictEqual(rr.inSendWindow(cfg, new Date('2026-11-12T09:30:00Z')), true);
  assert.strictEqual(rr.inSendWindow(cfg, new Date('2026-07-12T08:30:00Z')), true);   // 09:30 BST
  assert.strictEqual(rr.inSendWindow(cfg, new Date('2026-07-12T19:30:00Z')), false);  // 20:30 BST
});
t('first names', () => {
  assert.strictEqual(rr.firstNameOf('BARRY KEMPTON'), 'Barry');
  assert.strictEqual(rr.firstNameOf('mcDonald'), 'mcDonald');
  assert.strictEqual(rr.firstNameOf('jo@x.com'), '');
  assert.strictEqual(rr.firstNameOf(''), '');
});
t('email: both buttons, rate-this-part links, opt-out, no shipping line, escaped', () => {
  const { subject, html } = rr.buildReviewEmail({
    firstName: 'Sam', orderRef: '#REP1', reason: 'delivered', cfg, optout: 'https://w/optout?e=a&t=b',
    items: [{ title: 'Grille <b>', url: 'https://shop/products/grille' }, { title: 'Shipping', url: 'https://shop/x' }],
  });
  assert.ok(subject.startsWith('Sam, how did we do?') && subject.includes('#REP1'));
  assert.ok(html.includes('trustpilot.com') && html.includes('https://g.page/r/X/review'));
  assert.ok(html.includes('https://shop/products/grille?review=1#rz-reviews'));
  assert.ok(!html.includes('https://shop/x?review=1'));
  assert.ok(html.includes('Grille &lt;b&gt;') && !html.includes('Grille <b>'));
  assert.ok(html.includes('https://w/optout?e=a&amp;t=b'));
});
t('email: collection wording; no product links when switched off', () => {
  const { html } = rr.buildReviewEmail({ orderRef: 'R', reason: 'collected', cfg: { ...cfg, askProductReviews: false },
    optout: 'https://w', items: [{ title: 'Grille', url: 'https://shop/products/grille' }] });
  assert.ok(html.includes('Thanks for collecting your order'));
  assert.ok(!html.includes('review=1'));
});
t('opt-out tokens', () => {
  const sig = rr.signEmail('A@b.com');
  assert.ok(rr.verifyEmail('a@b.com', sig));
  assert.ok(!rr.verifyEmail('c@b.com', sig));
  const u = new URL(rr.optoutUrl('a@b.com'));
  assert.strictEqual(rr.decodeOptoutEmail(u.searchParams.get('e')), 'a@b.com');
  assert.ok(rr.verifyEmail('a@b.com', u.searchParams.get('t')));
});
console.log(`${n} passed`);
process.exit(0);
