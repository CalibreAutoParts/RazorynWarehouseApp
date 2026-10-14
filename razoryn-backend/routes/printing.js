// routes/printing.js — auto-printed 6x4 packing slips, one per item line.
//
// How it works end-to-end:
//   • Every NEW order — whatever created it (eBay/Shopify sync, a cash or
//     bank invoice typed at the counter, a phone order entered from a laptop
//     at home) — lands in the sales table. A scanner here notices sales the
//     queue hasn't seen and enqueues one print job per order.
//   • The PRINT STATION page (left open on the warehouse PC that has the
//     label printer) polls the queue. The SERVER decides when jobs release:
//     master toggle, per-channel toggles, batch interval ("print every N
//     hours"), and quiet hours ("don't print 10pm–7am"). Outside the window
//     jobs just wait — a PC that was asleep prints everything pending the
//     moment it wakes and the tab resumes.
//   • Labels render at exactly 4in × 6in, one label per item line, numbered
//     "1 / 3" across the order, with the buyer, channel, part number, piece
//     count and the product's LOCATION — what the packer needs to find it.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      labels INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      printed_at TIMESTAMPTZ
    )`);
    _ready = true;
  } catch (e) { console.warn('[printing] migration:', e.message); }
}

const DEFAULT_CFG = {
  enabled: false,
  channels: { ebay: true, shopify: true, bank: true, cash: true, card: true },
  everyMins: 0,          // 0 = release as soon as the station asks
  quietFrom: null,       // hour 0-23, e.g. 22  (null = no quiet hours)
  quietTo: null,         // hour 0-23, e.g. 7
  lastReleaseAt: null,
  enabledAt: null,
};
async function getCfg() {
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  return { ...DEFAULT_CFG, ...(d.printing || {}), channels: { ...DEFAULT_CFG.channels, ...((d.printing || {}).channels || {}) } };
}
async function saveCfg(cfg) {
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify({ ...cur, printing: cfg })]);
}

// 'ebay_em'/'ebay_cl' → ebay · 'shopify' → shopify · direct_* → bank/cash/card
function channelKey(ch) {
  if (/^ebay/.test(ch || '')) return 'ebay';
  if (ch === 'shopify') return 'shopify';
  if (ch === 'direct_cash') return 'cash';
  if (ch === 'direct_card') return 'card';
  return 'bank';
}
const CHANNEL_LABEL = { ebay: 'EBAY', shopify: 'SHOPIFY', bank: 'BANK TRANSFER', cash: 'CASH', card: 'CARD' };

function inQuietHours(cfg, now = new Date()) {
  if (cfg.quietFrom == null || cfg.quietTo == null || cfg.quietFrom === cfg.quietTo) return false;
  const h = now.getHours();
  // 22 → 7 crosses midnight; 13 → 15 doesn't.
  return cfg.quietFrom > cfg.quietTo ? (h >= cfg.quietFrom || h < cfg.quietTo) : (h >= cfg.quietFrom && h < cfg.quietTo);
}

// Enqueue any order the queue hasn't seen yet. occurred_at > enabledAt keeps
// history from flooding out the moment the feature is switched on.
async function enqueueNewSales(cfg) {
  if (!cfg.enabled || !cfg.enabledAt) return;
  const enabledChannels = Object.entries(cfg.channels).filter(([, v]) => v).map(([k]) => k);
  if (!enabledChannels.length) return;
  const { rows } = await query(`
    SELECT s.id, s.channel FROM sales s
     WHERE s.is_estimate = false
       AND COALESCE(s.status, '') NOT IN ('cancelled', 'refunded')
       AND s.occurred_at > $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.sale_id = s.id)
     ORDER BY s.occurred_at LIMIT 200`, [cfg.enabledAt]);
  for (const s of rows) {
    if (!enabledChannels.includes(channelKey(s.channel))) continue;
    await query(`INSERT INTO print_jobs (sale_id) VALUES ($1) ON CONFLICT (sale_id) DO NOTHING`, [s.id]);
  }
}

async function jobLabelData(jobIds) {
  if (!jobIds.length) return [];
  const { rows: jobs } = await query(`
    SELECT j.id AS job_id, s.* FROM print_jobs j JOIN sales s ON s.id = j.sale_id
     WHERE j.id = ANY($1) ORDER BY s.occurred_at`, [jobIds]);
  const out = [];
  for (const s of jobs) {
    const { rows: items } = await query(`
      SELECT si.*, l.code AS loc_code, l.name AS loc_name, p.location_note
        FROM sale_items si
        LEFT JOIN products p ON lower(p.sku) = lower(si.sku)
        LEFT JOIN locations l ON l.id = p.location_id
       WHERE si.sale_id = $1 ORDER BY si.id`, [s.id]);
    out.push({
      jobId: s.job_id, saleId: s.id,
      ref: s.invoice_number || s.payment_reference || s.external_order_id || ('#' + s.id),
      channel: channelKey(s.channel),
      customer: s.customer_name || '—',
      paid: s.is_paid !== false,
      date: s.occurred_at,
      items: items.map(i => ({
        title: i.title || i.sku || 'Item', sku: i.sku || '',
        qty: parseInt(i.qty) || 1,
        loc: [i.loc_code, i.loc_name].filter(Boolean).join(' · '),
        locNote: i.location_note || '',
      })),
    });
  }
  return out;
}

// ── Settings ───────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    await ensureTables();
    const cfg = await getCfg();
    const pending = parseInt((await query(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE status = 'queued'`)).rows[0].n) || 0;
    const recent = (await query(`
      SELECT j.id, j.printed_at, s.invoice_number, s.customer_name, s.channel
        FROM print_jobs j JOIN sales s ON s.id = j.sale_id
       WHERE j.status = 'printed' ORDER BY j.printed_at DESC LIMIT 10`)).rows;
    res.json({ ...cfg, isAdmin: req.user.role === 'admin', pending, quietNow: inQuietHours(cfg), recent });
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});
router.post('/settings', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const b = req.body || {};
    const cfg = await getCfg();
    if (b.enabled !== undefined) {
      cfg.enabled = !!b.enabled;
      // Stamp the switch-on moment so only orders from NOW ON print.
      if (cfg.enabled && !cfg.enabledAt) cfg.enabledAt = new Date().toISOString();
      if (cfg.enabled && b.resetFrom === 'now') cfg.enabledAt = new Date().toISOString();
    }
    if (b.channels) for (const k of Object.keys(DEFAULT_CFG.channels)) if (b.channels[k] !== undefined) cfg.channels[k] = !!b.channels[k];
    if (b.everyMins !== undefined) cfg.everyMins = Math.max(0, parseInt(b.everyMins) || 0);
    if (b.quietFrom !== undefined) cfg.quietFrom = b.quietFrom === '' || b.quietFrom == null ? null : Math.min(23, Math.max(0, parseInt(b.quietFrom)));
    if (b.quietTo !== undefined) cfg.quietTo = b.quietTo === '' || b.quietTo == null ? null : Math.min(23, Math.max(0, parseInt(b.quietTo)));
    await saveCfg(cfg);
    await audit(req, 'printing_settings', null, null, { enabled: cfg.enabled, everyMins: cfg.everyMins });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// ── The queue (polled by the print station) ───────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    await ensureTables();
    const cfg = await getCfg();
    await enqueueNewSales(cfg);
    const pending = (await query(`SELECT id FROM print_jobs WHERE status = 'queued' ORDER BY id`)).rows.map(r => r.id);
    const quiet = inQuietHours(cfg);
    let holdUntil = null;
    if (cfg.everyMins > 0 && cfg.lastReleaseAt) {
      const next = new Date(new Date(cfg.lastReleaseAt).getTime() + cfg.everyMins * 60000);
      if (next > new Date()) holdUntil = next.toISOString();
    }
    const allowed = cfg.enabled && !quiet && !holdUntil && pending.length > 0;
    if (!allowed) {
      return res.json({ allowed: false, pending: pending.length, quietNow: quiet, holdUntil, enabled: cfg.enabled, jobs: [] });
    }
    cfg.lastReleaseAt = new Date().toISOString();
    await saveCfg(cfg);
    const jobs = await jobLabelData(pending.slice(0, 40));
    res.json({ allowed: true, pending: pending.length, jobs, enabled: true, quietNow: false, holdUntil: null });
  } catch (e) {
    console.error('[printing] queue failed:', (e && e.stack) || e);
    res.status(500).json({ error: 'queue_failed', message: e.message });
  }
});
router.post('/jobs/:id(\\d+)/printed', async (req, res) => {
  await ensureTables();
  await query(`UPDATE print_jobs SET status = 'printed', printed_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});
router.post('/jobs/:id(\\d+)/requeue', async (req, res) => {
  await ensureTables();
  await query(`UPDATE print_jobs SET status = 'queued', printed_at = NULL WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ── The labels themselves: exact 4in × 6in pages, one per item line ───────
function labelPagesHtml(orders, { autoPrint = false } = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pages = [];
  for (const o of orders) {
    const total = o.items.length;
    const pieces = o.items.reduce((a, i) => a + i.qty, 0);
    o.items.forEach((it, idx) => {
      pages.push(`<div class="label">
        <div class="head">
          <span class="ch">${esc(CHANNEL_LABEL[o.channel] || o.channel.toUpperCase())}</span>
          <span class="ref">${esc(o.ref)}</span>
        </div>
        ${o.paid ? '' : '<div class="unpaid">⚠ NOT PAID YET — prepare, hold for payment</div>'}
        <div class="buyer"><span class="k">BUYER</span>${esc(o.customer)}</div>
        <div class="item">${esc(it.title)}</div>
        <div class="sku">${esc(it.sku)}</div>
        <div class="row">
          <div class="loc"><span class="k">LOCATION</span><div class="locv">${esc(it.loc || '—')}</div>${it.locNote ? `<div class="locn">${esc(it.locNote)}</div>` : ''}</div>
          <div class="qty"><span class="k">PIECES</span><div class="qn">${it.qty}</div></div>
        </div>
        <div class="foot">
          <span class="num">LABEL ${idx + 1} / ${total}</span>
          <span>order: ${total} item${total === 1 ? '' : 's'} · ${pieces} piece${pieces === 1 ? '' : 's'}</span>
          <span>${new Date(o.date).toLocaleDateString('en-GB')}</span>
        </div>
      </div>`);
    });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Packing labels</title><style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; }
  html, body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
  .label { width: 4in; height: 6in; padding: 0.14in; display: flex; flex-direction: column; page-break-after: always; overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .ch { background: #000; color: #fff; font-weight: 900; font-size: 15pt; padding: 3pt 8pt; letter-spacing: .5pt; }
  .ref { font-weight: 800; font-size: 13pt; font-family: ui-monospace, Consolas, monospace; }
  .unpaid { border: 2pt solid #000; text-align: center; font-weight: 900; font-size: 10pt; padding: 2pt; margin-top: 4pt; }
  .k { display: block; font-size: 7pt; font-weight: 700; letter-spacing: 1pt; color: #444; }
  .buyer { margin-top: 6pt; font-size: 15pt; font-weight: 800; border-bottom: 1.5pt solid #000; padding-bottom: 4pt; }
  .item { margin-top: 6pt; font-size: 16.5pt; font-weight: 800; line-height: 1.15; max-height: 1.45in; overflow: hidden; }
  .sku { font-family: ui-monospace, Consolas, monospace; font-size: 12pt; margin-top: 3pt; }
  .row { display: flex; gap: 8pt; margin-top: auto; align-items: stretch; }
  .loc { flex: 1; border: 1.5pt solid #000; padding: 4pt 6pt; min-height: 0.9in; }
  .locv { font-size: 14pt; font-weight: 900; margin-top: 1pt; }
  .locn { font-size: 9.5pt; margin-top: 2pt; }
  .qty { width: 1.05in; border: 1.5pt solid #000; padding: 4pt 6pt; text-align: center; }
  .qn { font-size: 30pt; font-weight: 900; line-height: 1; margin-top: 2pt; }
  .foot { display: flex; justify-content: space-between; align-items: baseline; gap: 4pt; margin-top: 6pt; font-size: 8.5pt; }
  .num { font-size: 13pt; font-weight: 900; }
  </style></head><body>${pages.join('')}${autoPrint ? '<script>window.onload = () => setTimeout(() => window.print(), 250);<' + '/script>' : ''}</body></html>`;
}
router.get('/labels', async (req, res) => {
  try {
    await ensureTables();
    const ids = String(req.query.jobs || '').split(',').map(x => parseInt(x)).filter(Boolean).slice(0, 60);
    if (!ids.length) return res.status(400).send('jobs required');
    const orders = await jobLabelData(ids);
    res.type('html').send(labelPagesHtml(orders, { autoPrint: req.query.print === '1' }));
  } catch (e) { res.status(500).send('Labels failed: ' + e.message); }
});
// A sample label so printer alignment can be checked without a real order.
router.get('/labels/test', async (req, res) => {
  res.type('html').send(labelPagesHtml([{
    jobId: 0, saleId: 0, ref: 'TEST-0001', channel: 'ebay', customer: 'Test Buyer', paid: true, date: new Date().toISOString(),
    items: [
      { title: 'Peugeot 208 2024-2026 Front Bumper Main Grille with Cover (Black)', sku: '9855774880', qty: 1, loc: 'A3 · Front panels', locNote: '3rd shelf, behind the door' },
      { title: 'VW Polo Headlight RH', sku: '6C1941006', qty: 2, loc: 'B1 · Lighting', locNote: '' },
    ],
  }], { autoPrint: req.query.print === '1' }));
});

module.exports = router;
