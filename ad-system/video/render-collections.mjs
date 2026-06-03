// Render every per-collection ad (col-*) + the RHD headlights ad in one pass.
// Bundles once (fast), then renders each composition to out/collections/<id>.mp4.
// Run: npm run render:collections   (needs internet for the product photos)
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, 'src', 'index.ts');
const outDir = path.join(dir, 'out', 'collections');
fs.mkdirSync(outDir, {recursive: true});

console.log('Bundling project…');
const serveUrl = await bundle({entryPoint: entry});
const comps = await getCompositions(serveUrl);
const targets = comps.filter((c) => c.id.startsWith('col-') || c.id === 'RhdHeadlights');
console.log(`Rendering ${targets.length} videos → out/collections/`);

let i = 0;
for (const c of targets) {
  i += 1;
  const file = path.join(outDir, `${c.id}.mp4`);
  process.stdout.write(`[${i}/${targets.length}] ${c.id} … `);
  await renderMedia({composition: c, serveUrl, codec: 'h264', outputLocation: file});
  console.log('✓');
}
console.log(`\nDone. ${targets.length} MP4s in ${outDir}`);
