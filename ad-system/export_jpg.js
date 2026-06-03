/* Direct HTML → JPEG exporter for Razoryn ads.
 *
 * Renders each .post straight from the HTML with headless Chrome — pixel-identical
 * to the browser, NO PDF step (so nothing in the design shifts). Output is a flat
 * 1080×1350 frame at 2× (2160×2700) JPEG, quality 92.
 *
 * Usage:
 *   node export_jpg.js                      # EVERY ad (promos, showcases, listings)
 *   node export_jpg.js razoryn-03-*.html    # specific file(s)
 *   FORMAT=png node export_jpg.js           # PNG instead (transparent-safe)
 *
 * Run on a machine with normal internet so the Shopify product photos load.
 * Output: ad-system/export/<basename>_<scheme>.<ext>
 */
// Portable Playwright resolve: local install first, then a global fallback.
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  catch (e2) {
    console.error('Playwright not found. Run:  npm install  (then: npx playwright install chromium)');
    process.exit(1);
  }
}
const fs = require('fs'); const path = require('path');
const SCHEMES = ['white', 'red', 'navy'];
const FORMAT = (process.env.FORMAT || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
const EXT = FORMAT === 'png' ? 'png' : 'jpg';

(async () => {
  const dir = __dirname;
  let files = process.argv.slice(2);
  if (!files.length) {
    // default: every ad — promos, showcases and collection listings
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.html') && (f.startsWith('promo-') || f.startsWith('razoryn-')))
      .map(f => path.join(dir, f));
  }
  const out = path.join(dir, 'export'); fs.mkdirSync(out, { recursive: true });
  // organise output into folders: collections/<slug>, showcases/<slug>, promos/<name>
  const groupOf = (base) => {
    if (base.startsWith('razoryn-')) return path.join('collections', base.replace(/^razoryn-\d+-/, ''));
    if (base.startsWith('promo-showcase-')) return path.join('showcases', base.replace(/^promo-showcase-\d+-/, ''));
    if (base.startsWith('promo-')) return path.join('promos', base.replace(/^promo-/, ''));
    return '';
  };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 2 });
  let n = 0;
  for (const f of files) {
    await page.goto('file://' + path.resolve(f), { waitUntil: 'networkidle', timeout: 90000 });
    await page.addStyleTag({ content: 'body{padding:0!important;background:#fff!important}h1,.ph2,.cap{display:none!important}.group{gap:0!important}.stage{width:1080px!important;max-width:none!important}' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const posts = await page.$$('.post');
    const base = path.basename(f, '.html');
    const groupDir = path.join(out, groupOf(base));
    fs.mkdirSync(groupDir, { recursive: true });
    for (let i = 0; i < posts.length; i++) {
      const name = `${base}_${SCHEMES[i] || i}.${EXT}`;
      const opts = { path: path.join(groupDir, name), type: FORMAT };
      if (FORMAT === 'jpeg') opts.quality = 92;
      await posts[i].screenshot(opts);
      n++;
    }
    console.log('exported', base, '→', posts.length, EXT.toUpperCase());
  }
  await browser.close();
  console.log(`\nDone: ${n} ${EXT.toUpperCase()} files in ad-system/export/`);
})();
