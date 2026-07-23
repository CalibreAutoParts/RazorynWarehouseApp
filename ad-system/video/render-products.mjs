// Render the single-product Instagram Reels → out/products/<id>.mp4
// Run: npm run render:products
// Needs internet (fetches the product photos from the Shopify CDN at render time).
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
console.log('Bundling…');
const serveUrl = await bundle({entryPoint: path.join(dir, 'src', 'index.ts')});
const comps = (await getCompositions(serveUrl)).filter((c) => c.id.startsWith('product-'));
console.log(`Rendering ${comps.length} product Reels → out/products/`);
let i = 0;
for (const c of comps) {
  i += 1;
  const file = path.join(dir, 'out', 'products', `${c.id.slice('product-'.length)}.mp4`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  process.stdout.write(`[${i}/${comps.length}] ${c.id} … `);
  await renderMedia({composition: c, serveUrl, codec: 'h264', crf: 18, jpegQuality: 100, outputLocation: file});
  console.log('✓');
}
console.log('\nDone → out/products/  (upload these .mp4 files to Instagram as Reels)');
