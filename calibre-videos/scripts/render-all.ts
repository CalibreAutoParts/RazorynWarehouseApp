/**
 * Bulk renderer for the Calibre video factory.
 *
 * Bundles the project ONCE, then renders every catalog entry (or a filtered
 * subset) — videos to out/videos/<id>.mp4 and stills to out/stills/<id>.png.
 *
 * Usage:
 *   npx tsx scripts/render-all.ts                 # render everything
 *   npx tsx scripts/render-all.ts --sample        # one of each template (quick QA)
 *   npx tsx scripts/render-all.ts --only=ad,story # only ids starting ad/story
 *   npx tsx scripts/render-all.ts --kind=still    # only stills (photo/carousel)
 *   npx tsx scripts/render-all.ts --limit=50      # cap how many to render
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill, ensureBrowser } from '@remotion/renderer';
import { CATALOG, type CatalogEntry } from '../src/data/catalog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out');
const videosDir = path.join(outDir, 'videos');
const stillsDir = path.join(outDir, 'stills');
for (const d of [outDir, videosDir, stillsDir]) fs.mkdirSync(d, { recursive: true });

const argv = process.argv.slice(2);
const getFlag = (name: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

function selectEntries(): CatalogEntry[] {
  let list = [...CATALOG];
  const kind = getFlag('kind');
  if (kind) list = list.filter((e) => e.kind === kind);
  const only = getFlag('only');
  if (only) {
    const prefixes = only.split(',');
    list = list.filter((e) => prefixes.some((p) => e.id.startsWith(p)));
  }
  if (has('sample')) {
    // One representative of each template for fast quality checks.
    const seen = new Set<string>();
    list = list.filter((e) => {
      if (seen.has(e.template)) return false;
      seen.add(e.template);
      return true;
    });
  }
  const limit = getFlag('limit');
  if (limit) list = list.slice(0, parseInt(limit, 10));
  return list;
}

async function main() {
  const entries = selectEntries();
  console.log(`\nCalibre video factory — rendering ${entries.length} asset(s)\n`);
  await ensureBrowser();

  console.log('Bundling project (one time)…');
  const serveUrl = await bundle({
    entryPoint: path.join(root, 'src', 'index.ts'),
    onProgress: (p) => process.stdout.write(`\r  bundling ${p}%   `),
  });
  console.log('\nBundle ready.\n');

  // Keep concurrency modest so parallel tabs don't starve font loading, and
  // give delayRender the same generous budget the CLI config uses.
  const concurrency = Math.max(1, Math.min(os.cpus().length, 4));
  const timeoutInMilliseconds = 120000;
  let done = 0;
  const failures: { id: string; error: string }[] = [];
  const t0 = Date.now();

  for (const entry of entries) {
    try {
      const composition = await selectComposition({
        serveUrl,
        id: entry.id,
        inputProps: entry.props,
        timeoutInMilliseconds,
      });

      if (entry.kind === 'still') {
        const output = path.join(stillsDir, `${entry.id}.png`);
        // Capture at a settled frame so entrance animations have finished.
        await renderStill({ composition, serveUrl, output, inputProps: entry.props, overwrite: true, timeoutInMilliseconds, frame: 30 });
      } else {
        const output = path.join(videosDir, `${entry.id}.mp4`);
        await renderMedia({
          composition,
          serveUrl,
          codec: 'h264',
          crf: 18,
          outputLocation: output,
          inputProps: entry.props,
          concurrency,
          overwrite: true,
          timeoutInMilliseconds,
        });
      }
      done += 1;
      const pct = ((done / entries.length) * 100).toFixed(0);
      console.log(`  [${done}/${entries.length}] ${pct}%  ${entry.kind === 'still' ? '🖼 ' : '🎬'} ${entry.id}`);
    } catch (err) {
      failures.push({ id: entry.id, error: (err as Error).message });
      console.error(`  ✗ ${entry.id}: ${(err as Error).message}`);
    }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nDone: ${done}/${entries.length} rendered in ${mins} min.`);
  if (failures.length) {
    console.log(`Failures (${failures.length}):`);
    failures.forEach((fl) => console.log(`  - ${fl.id}: ${fl.error}`));
    process.exitCode = 1;
  }
  console.log(`\nVideos → ${videosDir}\nStills → ${stillsDir}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
