// Render only the per-collection ads → out/collections/<slug>/{showcase,deal}.mp4
// Run: npm run render:collections
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
console.log('Bundling…');
const serveUrl = await bundle({entryPoint: path.join(dir, 'src', 'index.ts')});
const comps = (await getCompositions(serveUrl)).filter((c) => c.id.startsWith('col-'));
console.log(`Rendering ${comps.length} collection videos → out/collections/`);
let i = 0;
for (const c of comps) {
  i += 1;
  const m = c.id.slice(4);
  const deal = m.endsWith('-deal');
  const slug = deal ? m.slice(0, -5) : m;
  const file = path.join(dir, 'out', 'collections', slug, `${deal ? 'deal' : 'showcase'}.mp4`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  process.stdout.write(`[${i}/${comps.length}] ${c.id} … `);
  await renderMedia({composition: c, serveUrl, codec: 'h264', crf: 18, jpegQuality: 100, outputLocation: file});
  console.log('✓');
}
console.log('\nDone → out/collections/');
