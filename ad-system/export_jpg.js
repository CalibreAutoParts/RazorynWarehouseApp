/* Direct HTML → JPEG exporter for Razoryn ads.
 *
 * Renders each .post straight from the HTML with headless Chrome — pixel-identical
 * to the browser, NO PDF step (so nothing in the design shifts). Output is a flat
 * 1080×1350 frame at 2× (2160×2700) JPEG, quality 92.
 *
 * Usage:
 *   node export_jpg.js                      # every promo-*.html + showcases
 *   node export_jpg.js razoryn-03-*.html    # specific file(s)
 *   FORMAT=png node export_jpg.js           # PNG instead (transparent-safe)
 *
 * Run on a machine with normal internet so the Shopify product photos load.
 * Output: ad-system/export/<basename>_<scheme>.<ext>
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const SCHEMES = ['white', 'red', 'navy'];
const FORMAT = (process.env.FORMAT || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
const EXT = FORMAT === 'png' ? 'png' : 'jpg';

(async () => {
  const dir = __dirname;
  let files = process.argv.slice(2);
  if (!files.length) {
    files = fs.readdirSync(dir)
      .filter(f => f.startsWith('promo-') && f.endsWith('.html'))
      .map(f => path.join(dir, f));
  }
  const out = path.join(dir, 'export'); fs.mkdirSync(out, { recursive: true });
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
    for (let i = 0; i < posts.length; i++) {
      const name = `${base}_${SCHEMES[i] || i}.${EXT}`;
      const opts = { path: path.join(out, name), type: FORMAT };
      if (FORMAT === 'jpeg') opts.quality = 92;
      await posts[i].screenshot(opts);
      n++;
    }
    console.log('exported', base, '→', posts.length, EXT.toUpperCase());
  }
  await browser.close();
  console.log(`\nDone: ${n} ${EXT.toUpperCase()} files in ad-system/export/`);
})();
