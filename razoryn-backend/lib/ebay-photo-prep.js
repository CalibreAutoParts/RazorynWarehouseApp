// lib/ebay-photo-prep.js — make photos fill eBay's picture frame.
//
// eBay shows a photo as it is: a part sitting small in the middle of a big
// empty canvas (cut-out photos from the studio, padded thumbnails) shows small
// on the listing, while the website crops or zooms it. Before photos go to eBay
// each one is checked; one that has a wide empty border, or is small, is
// trimmed to the part, scaled up to a 1600 × 1600 square (eBay's largest) with
// a slim margin, and handed to eBay from a public link on this app. eBay takes
// its own copy when the listing is saved. Photos that already fill the frame go
// through untouched.
const axios = require('axios');
const crypto = require('crypto');
const { query } = require('../db');

const SIZE = 1600;           // eBay's largest picture size
const MARGIN = 0.04;         // slim border around the part
let _schema = false;
async function ensureSchema() {
  if (_schema) return;
  await query(`CREATE TABLE IF NOT EXISTS public_photos (token TEXT PRIMARY KEY, mime TEXT, data BYTEA, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS ebay_photo_prep (src_hash TEXT PRIMARY KEY, src TEXT, out_url TEXT, info JSONB, checked_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schema = true;
}

function publicBase() {
  const brandDomain = (() => { try { return require('./brand').domain || ''; } catch (_) { return ''; } })();
  const base = (process.env.PUBLIC_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')
    || (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).find(s => /^https:\/\//i.test(s))
    || (brandDomain ? 'https://warehouse.' + brandDomain.replace(/^https?:\/\//, '') : '')).replace(/\/+$/, '');
  try { return base ? new URL(base).origin : null; } catch (_) { return null; }
}

// eBay-hosted photo → its largest copy.
const biggest = u => String(u)
  .replace(/(\.ebayimg\.com\/.*\/)s-l\d+(\.\w+)/i, '$1s-l1600$2')
  .replace(/(\.ebayimg\.com\/.*\/)\$_\d+\.(jpe?g|png|webp)/i, '$1$$_57.$2');

// Look at one photo. → { fix: bool, reason, w, h, fill } + the reworked JPEG when fix.
async function analyse(buf) {
  const sharp = require('sharp');
  const base = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const w0 = meta.autoOrient?.width || meta.width, h0 = meta.autoOrient?.height || meta.height;
  if (!w0 || !h0) return { fix: false, reason: 'unreadable' };
  // Flatten transparency onto white, then find the part: trim the border that
  // matches the corner colour.
  const flat = await sharp(buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).toBuffer();
  const corner = (await sharp(flat).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer());
  const bg = { r: corner[0], g: corner[1], b: corner[2] };
  let trimmed, tw = w0, th = h0;
  try {
    const t = await sharp(flat).trim({ background: bg, threshold: 22 }).toBuffer({ resolveWithObject: true });
    trimmed = t.data; tw = t.info.width; th = t.info.height;
  } catch (_) { trimmed = flat; }
  const fill = Math.max(tw / w0, th / h0);            // how much of the frame the part spans
  const long = Math.max(w0, h0);
  const small = long < 1000;
  const padded = fill < 0.8;
  if (!small && !padded) return { fix: false, reason: 'ok', w: w0, h: h0, fill: +fill.toFixed(2) };
  const inner = Math.round(SIZE * (1 - 2 * MARGIN));
  const out = await sharp(trimmed)
    .resize({ width: inner, height: inner, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
    .toBuffer({ resolveWithObject: true });
  const padX = SIZE - out.info.width, padY = SIZE - out.info.height;
  const jpg = await sharp(out.data)
    .extend({ left: Math.floor(padX / 2), right: Math.ceil(padX / 2), top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2), background: bg })
    .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { fix: true, reason: padded ? 'empty_border' : 'small', w: w0, h: h0, fill: +fill.toFixed(2), jpg };
}

// One URL → the URL eBay should get (the original when it's fine or anything
// goes wrong — never block a listing over a photo).
async function prepareOne(src, base, { force = false } = {}) {
  const url = biggest(src);
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  if (!force) {
    const c = (await query(`SELECT out_url FROM ebay_photo_prep WHERE src_hash = $1 AND checked_at > now() - interval '60 days'`, [hash])).rows[0];
    if (c) return { url: c.out_url || src, fixed: !!c.out_url, cached: true };
  }
  let buf;
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000, maxContentLength: 20 * 1024 * 1024 });
    buf = Buffer.from(r.data);
  } catch (e) { return { url: src, fixed: false, error: 'download: ' + e.message }; }
  let a;
  try { a = await analyse(buf); } catch (e) { return { url: src, fixed: false, error: 'image: ' + e.message }; }
  let out = null;
  if (a.fix) {
    const token = crypto.randomBytes(18).toString('hex');
    await query(`INSERT INTO public_photos (token, mime, data) VALUES ($1, 'image/jpeg', $2)`, [token, a.jpg]);
    out = `${base}/public/photo/${token}.jpg`;
  }
  const { jpg, ...info } = a;
  await query(`INSERT INTO ebay_photo_prep (src_hash, src, out_url, info, checked_at) VALUES ($1, $2, $3, $4::jsonb, now())
      ON CONFLICT (src_hash) DO UPDATE SET out_url = EXCLUDED.out_url, info = EXCLUDED.info, checked_at = now()`, [hash, url, out, JSON.stringify(info)]);
  return { url: out || src, fixed: !!out, info };
}

// A listing's photo list → the list to send to eBay (same order).
async function prepare(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!list.length || process.env.EBAY_PHOTO_PREP === 'off') return list;
  const base = publicBase();
  try { require.resolve('sharp'); } catch (_) { return list; }
  if (!base) return list;
  try { await ensureSchema(); } catch (_) { return list; }
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      try { out[k] = (await prepareOne(list[k], base, opts)).url; } catch (_) { out[k] = list[k]; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

// Same, with what happened to each photo (for the "Fix photo size" report).
async function prepareReport(urls, opts = {}) {
  const base = publicBase();
  if (!base) throw new Error('no public address for this app (set PUBLIC_BASE_URL)');
  await ensureSchema();
  const res = [];
  for (const u of (urls || []).filter(Boolean)) res.push({ src: u, ...(await prepareOne(u, base, opts)) });
  return res;
}

// Served at /public/photo/:file (server.js). Kept 120 days — eBay has its own
// copy long before then.
async function serve(token) {
  await ensureSchema();
  return (await query(`SELECT mime, data FROM public_photos WHERE token = $1`, [token])).rows[0] || null;
}
async function cleanup() {
  await ensureSchema();
  await query(`DELETE FROM ebay_photo_prep WHERE out_url IS NOT NULL AND checked_at < now() - interval '120 days'`);
  await query(`DELETE FROM public_photos WHERE created_at < now() - interval '120 days'`);
}

// ─── Fix photos on listings that are already live ─────────────────────────
// Reads each listing's photos from eBay (GetItem), reworks the ones that need
// it and sends the set back (ReviseItem, photos only). A listing whose photos
// are all fine is left alone. Checked listings are remembered for 60 days so a
// re-run carries on where the last one stopped (eBay's daily GetItem limit).
async function fixListing(itemId, storeCode, { force = false } = {}) {
  const ebay = require('../services/ebay');
  await ensureSchema();
  await query(`CREATE TABLE IF NOT EXISTS ebay_photo_checked (store_code TEXT, ebay_item_id TEXT, fixed INTEGER, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (store_code, ebay_item_id))`);
  if (!force) {
    const done = (await query(`SELECT fixed FROM ebay_photo_checked WHERE store_code = $1 AND ebay_item_id = $2 AND checked_at > now() - interval '60 days'`, [storeCode || '', String(itemId)])).rows[0];
    if (done) return { itemId, storeCode, skipped: 'checked recently', fixed: done.fixed };
  }
  const det = await ebay.getItemDetails(itemId, storeCode);
  const urls = (det.pictureUrls || []).filter(Boolean);
  if (!urls.length) return { itemId, storeCode, photos: 0, fixed: 0 };
  const rep = await prepareReport(urls, { force });
  const fixed = rep.filter(r => r.fixed).length;
  if (fixed) await ebay.reviseItem(itemId, { pictureUrls: rep.map(r => r.url) }, storeCode);
  await query(`INSERT INTO ebay_photo_checked (store_code, ebay_item_id, fixed, checked_at) VALUES ($1, $2, $3, now())
      ON CONFLICT (store_code, ebay_item_id) DO UPDATE SET fixed = EXCLUDED.fixed, checked_at = now()`, [storeCode || '', String(itemId), fixed]);
  return { itemId, storeCode, photos: urls.length, fixed, errors: rep.filter(r => r.error).map(r => r.error) };
}

const job = { state: 'idle' };
// Every live listing (all accounts, or one) in the background.
function startFixAll({ storeCode = null, force = false } = {}) {
  if (job.state === 'running') return { alreadyRunning: true, ...job };
  Object.assign(job, { state: 'running', startedAt: Date.now(), finishedAt: null, total: 0, done: 0, listingsFixed: 0, photosFixed: 0, errors: 0, sampleError: null, stoppedReason: null });
  (async () => {
    const ebay = require('../services/ebay');
    try {
      const stores = ebay.listStores().filter(s => s.hasToken && !s.disabled && (!storeCode || s.code === storeCode));
      const items = [];
      for (const s of stores) {
        let rows = [];
        try { await require('./ebay-live').ensureSchema(); rows = (await query(`SELECT ebay_item_id FROM ebay_live_items WHERE store_code = $1`, [s.code])).rows; } catch (_) {}
        if (!rows.length) rows = (await query(`SELECT DISTINCT ebay_item_id FROM mirror_links WHERE store_code = $1`, [s.code]).catch(() => ({ rows: [] }))).rows;
        for (const r of rows) items.push({ itemId: String(r.ebay_item_id), store: s.code });
      }
      job.total = items.length;
      let reads = 0;
      const MAX_READS = parseInt(process.env.PHOTO_FIX_MAX_READS || '1500');   // leave eBay allowance for everything else
      for (const it of items) {
        if (job.state !== 'running') break;
        if (reads >= MAX_READS) { job.stoppedReason = `Checked ${MAX_READS} listings today (keeping eBay's daily allowance for the rest of the app) — press Fix again tomorrow and it carries on`; break; }
        try {
          const r = await fixListing(it.itemId, it.store, { force });
          if (!r.skipped) reads++;
          if (r.fixed && !r.skipped) { job.listingsFixed++; job.photosFixed += r.fixed; }
        } catch (e) {
          job.errors++; if (!job.sampleError) job.sampleError = e.message;
          if (ebay.isDailyLimitError(e)) { job.stoppedReason = "eBay's daily limit for reading listings is used up — press Fix again tomorrow and it carries on where it stopped"; break; }
        }
        job.done++;
      }
    } catch (e) { job.sampleError = e.message; }
    if (job.state === 'running') job.state = 'done';
    job.finishedAt = Date.now();
  })();
  return { started: true, ...job };
}
function fixAllStatus() { return { ...job }; }
function stopFixAll() { if (job.state === 'running') job.state = 'stopped'; return { ...job }; }

module.exports = { prepare, prepareReport, analyse, serve, cleanup, publicBase, ensureSchema, fixListing, startFixAll, fixAllStatus, stopFixAll };
