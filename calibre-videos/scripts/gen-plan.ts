/**
 * Generates the content/posting plan from the catalog:
 *   out/catalog.json       — full machine-readable catalog
 *   out/posting-plan.csv   — every asset with caption + hashtags + filename
 *   out/schedule.csv       — a ~5-videos/day upload schedule (balanced mix)
 *
 * Run: npx tsx scripts/gen-plan.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATALOG_SUMMARY, type CatalogEntry } from '../src/data/catalog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });

const csvCell = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const fileFor = (e: CatalogEntry) => (e.kind === 'still' ? `stills/${e.id}.png` : `videos/${e.id}.mp4`);

// 1. catalog.json
fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(CATALOG, null, 2));

// 2. posting-plan.csv
const planHeader = ['file', 'id', 'kind', 'type', 'audience', 'series', 'duration_s', 'dimensions', 'caption', 'hashtags'];
const planRows = CATALOG.map((e) =>
  [
    fileFor(e),
    e.id,
    e.kind,
    e.meta.type,
    e.meta.audience,
    e.meta.series ?? '',
    (e.durationInFrames / e.fps).toFixed(1),
    `${e.width}x${e.height}`,
    e.meta.caption,
    e.meta.hashtags,
  ]
    .map(csvCell)
    .join(','),
);
fs.writeFileSync(path.join(outDir, 'posting-plan.csv'), [planHeader.map(csvCell).join(','), ...planRows].join('\n'));

// 3. schedule.csv — 5 videos/day, interleaved across templates so each day
//    has a varied mix (ad, story, ugc, comparison, etc.).
const videos = CATALOG.filter((e) => e.kind === 'video');
const byTemplate = new Map<string, CatalogEntry[]>();
for (const v of videos) {
  if (!byTemplate.has(v.template)) byTemplate.set(v.template, []);
  byTemplate.get(v.template)!.push(v);
}
// round-robin draw from each template bucket
const buckets = [...byTemplate.values()];
const ordered: CatalogEntry[] = [];
let remaining = videos.length;
let bi = 0;
while (remaining > 0) {
  const bucket = buckets[bi % buckets.length];
  const next = bucket.shift();
  if (next) {
    ordered.push(next);
    remaining -= 1;
  }
  bi += 1;
  if (buckets.every((b) => b.length === 0)) break;
}

const PER_DAY = 5;
const start = new Date('2026-06-10T00:00:00Z');
const slots = ['08:00', '12:00', '15:00', '18:00', '20:00'];
const schedHeader = ['date', 'time', 'platform', 'file', 'type', 'caption', 'hashtags'];
const schedRows: string[] = [];
ordered.forEach((e, i) => {
  const day = Math.floor(i / PER_DAY);
  const slot = i % PER_DAY;
  const d = new Date(start.getTime() + day * 86400000);
  const date = d.toISOString().slice(0, 10);
  schedRows.push(
    [date, slots[slot], 'TikTok + Instagram Reels', fileFor(e), e.meta.type, e.meta.caption, e.meta.hashtags]
      .map(csvCell)
      .join(','),
  );
});
fs.writeFileSync(path.join(outDir, 'schedule.csv'), [schedHeader.map(csvCell).join(','), ...schedRows].join('\n'));

// console summary
const stills = CATALOG.filter((e) => e.kind === 'still').length;
console.log('Calibre catalog generated:');
console.log(`  total assets : ${CATALOG.length}  (${videos.length} videos, ${stills} stills)`);
console.log('  by template  :');
Object.entries(CATALOG_SUMMARY)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`     ${k.padEnd(16)} ${v}`));
console.log(`  schedule      : ${Math.ceil(videos.length / PER_DAY)} days at ${PER_DAY} videos/day`);
console.log(`\n  → out/catalog.json, out/posting-plan.csv, out/schedule.csv`);
