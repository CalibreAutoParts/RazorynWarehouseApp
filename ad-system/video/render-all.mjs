// Render EVERY composition once (bundles a single time) into organised folders:
//   collection ads → out/collections/<slug>/showcase.mp4 | deal.mp4
//   everything else → out/promos/<id>.mp4
// Run: npm run render:all      (needs internet for the product photos)
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (...p) => path.join(dir, 'out', ...p);

function target(id) {
  if (id.startsWith('tiktok-')) return out('tiktok', `${id.slice(7)}.mp4`);
  if (id === 'TikTokDeal') return out('tiktok', 'all.mp4');
  if (id.startsWith('col-')) {
    const m = id.slice(4);
    const deal = m.endsWith('-deal');
    const slug = deal ? m.slice(0, -5) : m;
    return out('collections', slug, `${deal ? 'deal' : 'showcase'}.mp4`);
  }
  return out('promos', `${id}.mp4`);
}

console.log('Bundling…');
const serveUrl = await bundle({entryPoint: path.join(dir, 'src', 'index.ts')});
const comps = await getCompositions(serveUrl);
console.log(`Rendering ${comps.length} videos → out/`);
let i = 0;
for (const c of comps) {
  i += 1;
  const file = target(c.id);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  process.stdout.write(`[${i}/${comps.length}] ${c.id} … `);
  await renderMedia({composition: c, serveUrl, codec: 'h264', crf: 18, jpegQuality: 100, outputLocation: file});
  console.log('✓');
}
console.log(`\nDone. Videos organised under out/collections/<slug>/ and out/promos/`);
