/* High-res PNG exporter for Razoryn ads.
 * Renders each .post at full 1080x1350 (2x device scale = 2160x2700) — ready to post.
 * Usage: node export_png.js <file1.html> [file2.html ...]   (defaults to all promo-*.html)
 * Output: ad-system/export/<basename>_<scheme>.png
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
  catch (e2) { console.error('Playwright not found. Run:  npm install  (then: npx playwright install chromium)'); process.exit(1); } }
const fs = require('fs'); const path = require('path');
const SCHEMES = ['white','red','navy'];
(async () => {
  const dir = __dirname;
  let files = process.argv.slice(2);
  if (!files.length) files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && (f.startsWith('promo-')||f.startsWith('razoryn-'))).map(f => path.join(dir,f));
  const out = path.join(dir,'export'); fs.mkdirSync(out,{recursive:true});
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport:{width:1200,height:1500}, deviceScaleFactor:2 });
  for (const f of files) {
    await page.goto('file://'+path.resolve(f), { waitUntil:'networkidle', timeout:90000 });
    await page.addStyleTag({ content:'body{padding:0!important;background:#fff!important}.h1,.ph2,.cap,h1{display:none!important}.group{gap:0!important}.stage{width:1080px!important;max-width:none!important}' });
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(1200);
    const posts = await page.$$('.post');
    const base = path.basename(f,'.html');
    for (let i=0;i<posts.length;i++){
      const name = `${base}_${SCHEMES[i]||i}.png`;
      await posts[i].screenshot({ path: path.join(out,name) });
    }
    console.log('exported', base, '->', posts.length, 'PNG');
  }
  await browser.close();
})();
