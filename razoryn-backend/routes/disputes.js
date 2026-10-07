// routes/disputes.js — Disputes, chargebacks & claims (admin-only).
//
// One place for every fight: PayPal disputes, eBay Money Back Guarantee
// cases, card chargebacks (Shopify), and direct-customer claims. Each case
// is self-contained — its own timeline of customer messages, our replies and
// evidence files, its own deadlines (reply-by / decision-due), its own AI
// battle plan. The AI advisor knows each platform's rules and UK consumer
// law, reads the evidence photos, and answers the questions that matter:
// can we win, is it worth it, can we lawfully charge the restocking fee and
// return postage, and exactly what to reply (calm version + firm version).
//
// Per-business policy (restocking %, return window, returns page URL, house
// rules like "VIN fitment warnings shown at product + checkout") lives in
// dispute_settings — each warehouse deployment (Razoryn / Calibre) keeps its
// own, so advice always reflects THIS shop's terms.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const DISPUTES_DIR = path.join(UPLOAD_DIR, 'disputes');
fs.mkdirSync(DISPUTES_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DISPUTES_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname || '').toLowerCase()),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS disputes (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'paypal',
      case_ref TEXT,
      sale_id INTEGER,
      order_ref TEXT,
      customer_name TEXT,
      customer_contact TEXT,
      item_desc TEXT,
      amount NUMERIC(12,2),
      disputed_amount NUMERIC(12,2),
      reason TEXT,
      customer_wants TEXT,
      vin_provided BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      opened_at DATE,
      reply_by DATE,
      decision_due DATE,
      resolved_at TIMESTAMPTZ,
      resolution TEXT,
      ai_assessment JSONB,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS dispute_events (
      id SERIAL PRIMARY KEY,
      dispute_id INTEGER REFERENCES disputes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'note',
      body TEXT,
      file_path TEXT,
      file_name TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS dispute_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      restocking_pct NUMERIC(5,2) NOT NULL DEFAULT 10,
      return_window_days INTEGER NOT NULL DEFAULT 30,
      returns_url TEXT,
      policy_notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`INSERT INTO dispute_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    _ready = true;
  } catch (e) { console.warn('[disputes] migration:', e.message); }
}

const STATUSES = ['active', 'needs_info', 'awaiting_decision', 'won', 'lost', 'settled', 'closed'];
const PLATFORMS = ['paypal', 'ebay', 'chargeback', 'website', 'direct'];

// ── Policy settings (per deployment = per business) ───────────────────────
router.get('/settings', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT * FROM dispute_settings WHERE id = 1`);
  res.json({ settings: r.rows[0] || {} });
});
router.patch('/settings', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  const sets = [], params = [];
  if (b.restockingPct !== undefined) { params.push(parseFloat(b.restockingPct) || 0); sets.push(`restocking_pct = $${params.length}`); }
  if (b.returnWindowDays !== undefined) { params.push(parseInt(b.returnWindowDays) || 30); sets.push(`return_window_days = $${params.length}`); }
  if (b.returnsUrl !== undefined) { params.push(b.returnsUrl ? String(b.returnsUrl).slice(0, 300) : null); sets.push(`returns_url = $${params.length}`); }
  if (b.policyNotes !== undefined) { params.push(b.policyNotes ? String(b.policyNotes).slice(0, 2000) : null); sets.push(`policy_notes = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  const r = await query(`UPDATE dispute_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`);
  await audit(req, 'dispute_settings', null, null, b);
  res.json({ settings: r.rows[0] });
});

// ── Order lookup (to link a case to a warehouse sale) ─────────────────────
router.get('/find-sale', async (req, res) => {
  await ensureTables();
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ sales: [] });
  const { rows } = await query(`
    SELECT id, invoice_number, customer_name, total, occurred_at, channel
      FROM sales
     WHERE is_estimate = false
       AND (invoice_number ILIKE $1 OR customer_name ILIKE $1)
     ORDER BY occurred_at DESC LIMIT 10`, ['%' + q + '%']);
  res.json({ sales: rows });
});

// ── Cases ──────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  await ensureTables();
  const { rows } = await query(`
    SELECT d.*,
           (SELECT COUNT(*)::int FROM dispute_events e WHERE e.dispute_id = d.id) AS event_count,
           (SELECT MAX(e.created_at) FROM dispute_events e WHERE e.dispute_id = d.id) AS last_event_at,
           s.invoice_number
      FROM disputes d
      LEFT JOIN sales s ON s.id = d.sale_id
     ORDER BY CASE WHEN d.status IN ('active','needs_info','awaiting_decision') THEN 0 ELSE 1 END,
              d.reply_by ASC NULLS LAST, d.created_at DESC
     LIMIT 300`);
  res.json({ disputes: rows });
});
router.post('/', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  const platform = PLATFORMS.includes(b.platform) ? b.platform : 'paypal';
  const r = await query(`
    INSERT INTO disputes (platform, case_ref, sale_id, order_ref, customer_name, customer_contact, item_desc,
                          amount, disputed_amount, reason, customer_wants, vin_provided, opened_at, reply_by, decision_due, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [platform, b.caseRef ? String(b.caseRef).slice(0, 80) : null,
     b.saleId ? parseInt(b.saleId) : null, b.orderRef ? String(b.orderRef).slice(0, 80) : null,
     b.customerName ? String(b.customerName).slice(0, 120) : null,
     b.customerContact ? String(b.customerContact).slice(0, 200) : null,
     b.itemDesc ? String(b.itemDesc).slice(0, 300) : null,
     b.amount != null && b.amount !== '' ? parseFloat(b.amount) : null,
     b.disputedAmount != null && b.disputedAmount !== '' ? parseFloat(b.disputedAmount) : null,
     b.reason ? String(b.reason).slice(0, 3000) : null,
     b.customerWants ? String(b.customerWants).slice(0, 300) : null,
     !!b.vinProvided, b.openedAt || null, b.replyBy || null, b.decisionDue || null, req.user.id]);
  await audit(req, 'dispute_create', 'dispute', r.rows[0].id, { platform, caseRef: b.caseRef });
  res.status(201).json({ dispute: r.rows[0] });
});
router.get('/:id(\\d+)', async (req, res) => {
  await ensureTables();
  const d = (await query(`SELECT d.*, s.invoice_number FROM disputes d LEFT JOIN sales s ON s.id = d.sale_id WHERE d.id = $1`, [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: 'not_found' });
  const ev = await query(`SELECT * FROM dispute_events WHERE dispute_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ dispute: d, events: ev.rows });
});
router.patch('/:id(\\d+)', async (req, res) => {
  await ensureTables();
  const b = req.body || {};
  const sets = [], params = [];
  const map = {
    case_ref: b.caseRef, order_ref: b.orderRef, customer_name: b.customerName, customer_contact: b.customerContact,
    item_desc: b.itemDesc, reason: b.reason, customer_wants: b.customerWants,
    amount: b.amount === '' ? null : b.amount, disputed_amount: b.disputedAmount === '' ? null : b.disputedAmount,
    vin_provided: b.vinProvided, sale_id: b.saleId === '' ? null : b.saleId,
    opened_at: b.openedAt === '' ? null : b.openedAt, reply_by: b.replyBy === '' ? null : b.replyBy,
    decision_due: b.decisionDue === '' ? null : b.decisionDue, resolution: b.resolution,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (b.status !== undefined && STATUSES.includes(b.status)) {
    params.push(b.status); sets.push(`status = $${params.length}`);
    // Terminal statuses stamp when + how it ended; reopening clears them.
    if (['won', 'lost', 'settled', 'closed'].includes(b.status)) sets.push(`resolved_at = COALESCE(resolved_at, now())`);
    else sets.push(`resolved_at = NULL`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = now()');
  params.push(req.params.id);
  const r = await query(`UPDATE disputes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (b.status !== undefined) {
    await query(`INSERT INTO dispute_events (dispute_id, kind, body, created_by) VALUES ($1,'status',$2,$3)`,
      [req.params.id, 'Status → ' + b.status + (b.resolution ? ' — ' + String(b.resolution).slice(0, 300) : ''), req.user.id]);
  }
  await audit(req, 'dispute_update', 'dispute', req.params.id, b);
  res.json({ dispute: r.rows[0] });
});
router.delete('/:id(\\d+)', async (req, res) => {
  await ensureTables();
  const ev = await query(`SELECT file_path FROM dispute_events WHERE dispute_id = $1 AND file_path IS NOT NULL`, [req.params.id]);
  await query(`DELETE FROM disputes WHERE id = $1`, [req.params.id]);
  for (const e of ev.rows) { try { fs.unlinkSync(path.join(UPLOAD_DIR, e.file_path)); } catch (_) {} }
  await audit(req, 'dispute_delete', 'dispute', req.params.id);
  res.json({ ok: true });
});

// ── Timeline events: notes, customer messages, our replies, evidence ──────
router.post('/:id(\\d+)/events', upload.array('files'), async (req, res) => {
  await ensureTables();
  const d = (await query(`SELECT id FROM disputes WHERE id = $1`, [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: 'not_found' });
  const kind = ['note', 'customer', 'reply', 'evidence'].includes(req.body.kind) ? req.body.kind : 'note';
  const body = req.body.body ? String(req.body.body).slice(0, 5000) : null;
  const made = [];
  if (req.files && req.files.length) {
    for (const f of req.files) {
      const rel = path.relative(UPLOAD_DIR, f.path);
      const r = await query(`INSERT INTO dispute_events (dispute_id, kind, body, file_path, file_name, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, kind === 'note' ? 'evidence' : kind, body, rel, String(f.originalname || 'file').slice(0, 200), req.user.id]);
      made.push(r.rows[0]);
    }
  } else if (body) {
    const r = await query(`INSERT INTO dispute_events (dispute_id, kind, body, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, kind, body, req.user.id]);
    made.push(r.rows[0]);
  } else {
    return res.status(400).json({ error: 'body_or_files_required' });
  }
  await query(`UPDATE disputes SET updated_at = now() WHERE id = $1`, [req.params.id]);
  await audit(req, 'dispute_event', 'dispute', req.params.id, { kind, files: (req.files || []).length });
  res.status(201).json({ events: made });
});
router.delete('/events/:eventId(\\d+)', async (req, res) => {
  await ensureTables();
  const r = await query(`DELETE FROM dispute_events WHERE id = $1 RETURNING file_path`, [req.params.eventId]);
  if (r.rows[0]?.file_path) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.rows[0].file_path)); } catch (_) {} }
  res.json({ ok: true });
});
router.get('/events/:eventId(\\d+)/file', async (req, res) => {
  await ensureTables();
  const r = await query(`SELECT file_path, file_name FROM dispute_events WHERE id = $1`, [req.params.eventId]);
  if (!r.rows[0] || !r.rows[0].file_path) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOAD_DIR, r.rows[0].file_path));
});

// ── AI battle plan ─────────────────────────────────────────────────────────
const IMG_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
router.post('/:id(\\d+)/analyze', async (req, res) => {
  try {
    await ensureTables();
    const ai = require('../services/ai');
    if (!ai.isConfigured()) return res.status(400).json({ error: 'ai_not_configured' });
    const d = (await query(`SELECT d.*, s.invoice_number FROM disputes d LEFT JOIN sales s ON s.id = d.sale_id WHERE d.id = $1`, [req.params.id])).rows[0];
    if (!d) return res.status(404).json({ error: 'not_found' });
    const events = (await query(`SELECT * FROM dispute_events WHERE dispute_id = $1 ORDER BY created_at`, [req.params.id])).rows;
    const settings = (await query(`SELECT * FROM dispute_settings WHERE id = 1`)).rows[0] || {};
    // Live returns page: policy as the CUSTOMER sees it — best effort only.
    let policyPageText = '';
    if (settings.returns_url) {
      try {
        const page = await axios.get(settings.returns_url, { timeout: 12000, maxContentLength: 2 * 1024 * 1024 });
        policyPageText = String(page.data || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
      } catch (_) {}
    }
    // Evidence photos (latest first, up to 5) go in as images.
    const images = [];
    for (const e of [...events].reverse()) {
      if (images.length >= 5 || !e.file_path) continue;
      const ext = path.extname(e.file_path).toLowerCase();
      if (!IMG_TYPES[ext]) continue;
      try {
        images.push({ base64: fs.readFileSync(path.join(UPLOAD_DIR, e.file_path)).toString('base64'), mediaType: IMG_TYPES[ext] });
      } catch (_) {}
    }
    const brand = require('../lib/brand');
    const assessment = await ai.disputeAdvisor({
      brand: brand.fullName || brand.name || '',
      platform: d.platform,
      policy: settings,
      policyPageText,
      caseData: {
        platform: d.platform, caseRef: d.case_ref, linkedInvoice: d.invoice_number || d.order_ref,
        customer: d.customer_name, item: d.item_desc,
        orderAmount: d.amount, disputedAmount: d.disputed_amount,
        customerClaim: d.reason, customerWants: d.customer_wants,
        customerProvidedVinForFitmentCheck: !!d.vin_provided,
        opened: d.opened_at, replyBy: d.reply_by, decisionDue: d.decision_due, status: d.status,
      },
      events,
    }, { images });
    if (!assessment) return res.status(502).json({ error: 'no_assessment', message: 'Claude didn’t return a usable assessment — try again.' });
    await query(`UPDATE disputes SET ai_assessment = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(assessment), d.id]);
    await query(`INSERT INTO dispute_events (dispute_id, kind, body, created_by) VALUES ($1,'ai',$2,$3)`,
      [d.id, `Analysed: ${assessment.winChance}% win chance, advice: ${assessment.worthIt}`, req.user.id]);
    res.json({ ok: true, assessment });
  } catch (e) {
    console.error('[disputes] analyze failed:', (e && e.stack) || e);
    res.status(502).json({ error: e.code || 'analyze_failed', message: e.message });
  }
});

module.exports = router;
