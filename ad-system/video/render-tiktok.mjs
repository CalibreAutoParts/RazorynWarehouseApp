// Render every TikTok deal (per-collection + the generic) -> out/tiktok/<slug>.mp4
// Run: npm run render:tiktok-all
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, 'out', 'tiktok');
fs.mkdirSync(outDir, {recursive: true});

console.log('Bundling…');
const serveUrl = await bundle({entryPoint: path.join(dir, 'src', 'index.ts')});
const comps = (await getCompositions(serveUrl)).filter((c) => c.id.startsWith('tiktok-') || c.id === 'TikTokDeal');
console.log(`Rendering ${comps.length} TikTok deals → out/tiktok/`);
let i = 0;
for (const c of comps) {
  i += 1;
  const name = c.id === 'TikTokDeal' ? 'all' : c.id.slice(7);
  const file = path.join(outDir, `${name}.mp4`);
  process.stdout.write(`[${i}/${comps.length}] ${name} … `);
  await renderMedia({composition: c, serveUrl, codec: 'h264', crf: 18, jpegQuality: 100, outputLocation: file});
  console.log('✓');
}
console.log(`\nDone → out/tiktok/`);
