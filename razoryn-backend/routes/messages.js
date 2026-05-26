// routes/messages.js — Customer message templates + send endpoints.
//
// One unified interface for messaging customers across three channels:
//   • Email   — via Resend (already configured for invoice emails)
//   • eBay    — via Trading API AddMemberMessageAAQToPartner
//   • WhatsApp — frontend-only `wa.me/<phone>?text=<text>` link
//                (no API send — opens the user's WhatsApp app or web)
//
// The pre-built templates handle 90% of common situations. Staff can edit the
// rendered text before sending, and a "Custom" template provides a blank canvas.
// Variable interpolation happens server-side via renderTemplate() so the same
// substitution logic is used for previews and sends.

const express = require('express');
const axios = require('axios');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// ──────────────────────────────────────────────────────────────────────────
// Built-in templates — seeded into the DB on first run. Once seeded, staff
// can edit subject/body or add their own custom ones via Settings → Message
// templates. Built-ins cannot be deleted (only "reset to default" restores
// them); custom ones can.
//
// Variables supported in subject + body:
//   {customer_name}, {first_name}
//   {invoice}, {payment_reference}, {order_number}
//   {total}, {subtotal}
//   {tracking_number}, {carrier}, {tracking_url}
//   {item_first}, {item_count}, {item_count_extra}
//   {company_name}, {company_phone}, {company_website}, {company_email}
//   {review_url}   ← Trustpilot or Google review URL, from settings
// ──────────────────────────────────────────────────────────────────────────
const BUILTIN_TEMPLATES = [
  {
    key: 'custom',
    label: 'Custom (blank)',
    subject: '',
    body: '',
    defaultChannel: 'email',
  },
  {
    key: 'order_received',
    label: 'Order received — acknowledgement',
    subject: 'Order {invoice} received — {company_name}',
    body:
`Hi {first_name},

Thanks for your order {invoice}. We've received it and are picking it now.

Your order: {item_first}{item_count_extra}
Total: {total}

We'll send a tracking number as soon as it's dispatched. If you need anything in the meantime, just reply to this message.

Thanks,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'dispatched',
    label: 'Dispatched — tracking notification',
    subject: 'Your order {invoice} is on its way',
    body:
`Hi {first_name},

Your order {invoice} has been dispatched with {carrier}.

Tracking number: {tracking_number}
Track your parcel: {tracking_url}

Item: {item_first}

If you have any issues, just reply to this message.

Thanks,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'ready_to_collect',
    label: 'Ready for collection (cash order)',
    subject: 'Order {invoice} ready for collection',
    body:
`Hi {first_name},

Your order {invoice} is ready to collect.

Item: {item_first}
Total to pay on collection: {total}

We're open Mon–Fri 9am–5pm. Please bring this reference: {payment_reference}.

See you soon,
{company_name}
{company_phone}`,
    defaultChannel: 'whatsapp',
  },
  {
    key: 'fitment_confirm',
    label: 'Fitment confirmation request',
    subject: 'Quick fitment check — {invoice}',
    body:
`Hi {first_name},

Before we dispatch order {invoice}, could you double-check the part fits your vehicle?

Please confirm:
• Your vehicle make, model and year
• Your existing part number (if you have it) — usually printed on the part

This avoids the hassle of returns later. As soon as you reply, we'll get it boxed and posted.

Thanks,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'out_of_stock',
    label: 'Out of stock — apology + offer',
    subject: 'About your order {invoice}',
    body:
`Hi {first_name},

Apologies — we've just discovered the {item_first} from your order {invoice} isn't actually in stock. The listing was incorrect on our end and we're really sorry.

Two options:
1) Full refund — processed within 24 hours
2) We source it from our supplier network — usually 3–5 working days

Let us know which you'd prefer and we'll sort it straight away.

Sorry again for the inconvenience,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'delivery_delay',
    label: 'Delivery delay — heads-up',
    subject: 'Update on your order {invoice}',
    body:
`Hi {first_name},

Quick heads-up that your order {invoice} is running slightly behind schedule. The courier has flagged a delay, but it's still on its way to you.

Tracking: {tracking_url}

We'll keep an eye on it and let you know as soon as it's out for delivery. Apologies for the wait.

Thanks for your patience,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'proforma_chase',
    label: 'Pro-forma payment chase',
    subject: 'Pro-forma invoice {invoice} — awaiting payment',
    body:
`Hi {first_name},

Just a friendly reminder about your pro-forma invoice {invoice} for {total}.

Once payment lands we'll ship the part the same working day. Bank details are on the pro-forma, please quote reference {payment_reference}.

Let me know if you'd like to pay another way or need any further information.

Thanks,
{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'refund_processed',
    label: 'Refund processed',
    subject: 'Refund processed — order {invoice}',
    body:
`Hi {first_name},

Your refund for order {invoice} has been processed today. It usually takes 3–5 working days to appear in your account depending on your bank.

Amount refunded: {total}

Thanks for shopping with us — hope to see you again soon.

{company_name}`,
    defaultChannel: 'email',
  },
  {
    key: 'feedback_request',
    label: 'Feedback / review request',
    subject: 'How was your experience with {company_name}?',
    body:
`Hi {first_name},

Thanks again for your recent order with us — hope the part fitted well.

If you've got a spare minute, would you mind leaving us a review? It really helps small businesses like ours, and helps other customers find us:

{review_url}

If anything wasn't quite right, please reply to this message first — we'd love a chance to put it right before you score us.

Thanks,
{company_name}`,
    defaultChannel: 'email',
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Build the variable-substitution context for a given sale.
// Defensively pulls each value — every variable has a sensible fallback so
// templates don't render with "undefined" if the sale lacks some field.
// ──────────────────────────────────────────────────────────────────────────
async function buildContext(sale, items, company) {
  const fmt = (n) => '\u00A3' + parseFloat(n || 0).toFixed(2);
  // Extract first name from customer_name — best effort.
  // "John Smith" → "John"; "M. O'Brien" → "M."; falls back to full name.
  const fullName = sale.customer_name || '';
  const firstName = fullName.split(/[\s,]+/)[0] || fullName || 'there';

  const firstItem = items[0]?.title || 'your item';
  const extraCount = Math.max(0, items.length - 1);
  const itemCountExtra = extraCount > 0 ? ` (+ ${extraCount} more)` : '';

  // Carrier tracking URL — same templates as routes/dispatch.js. Inline here
  // to avoid a circular require.
  const trackingTemplates = {
    'Royal Mail':   'https://www.royalmail.com/track-your-item#/tracking-results/{tracking}',
    'Parcelforce':  'https://www.parcelforce.com/portal/pw/track?trackNumber={tracking}',
    'DPD':          'https://www.dpd.co.uk/apps/tracking/?reference={tracking}',
    'Evri':         'https://www.evri.com/track/parcel/{tracking}',
    'UPS':          'https://www.ups.com/track?tracknum={tracking}',
    'DHL':          'https://www.dhl.com/gb-en/home/tracking.html?tracking-id={tracking}',
    'FedEx':        'https://www.fedex.com/fedextrack/?trknbr={tracking}',
    'Tuffnells':    'https://www.tuffnells.co.uk/track-a-parcel?consignment={tracking}',
    'Yodel':        'https://www.yodel.co.uk/tracking/{tracking}',
    'APC Overnight': 'https://apc-overnight.com/customers/tracking-customer-portal?jobref={tracking}',
  };
  const trackingUrl = sale.carrier && sale.tracking_number && trackingTemplates[sale.carrier]
    ? trackingTemplates[sale.carrier].replace('{tracking}', encodeURIComponent(sale.tracking_number))
    : (sale.tracking_number || '');

  return {
    customer_name: fullName || 'Customer',
    first_name: firstName,
    invoice: sale.invoice_number || sale.payment_reference || sale.external_order_id || `#${sale.id}`,
    payment_reference: sale.payment_reference || '',
    order_number: sale.order_number || sale.external_order_id || '',
    total: fmt(sale.total),
    subtotal: fmt(sale.subtotal),
    tracking_number: sale.tracking_number || '[no tracking yet]',
    carrier: sale.carrier || '[courier]',
    tracking_url: trackingUrl || '[no tracking URL]',
    item_first: firstItem,
    item_count: items.length,
    item_count_extra: itemCountExtra,
    company_name: company.company_name || 'our team',
    company_phone: company.company_phone || '',
    company_website: company.company_website || '',
    company_email: company.company_email || '',
    // Review URL: picks Trustpilot or Google based on the configured platform.
    // Falls back to whichever URL is filled in if the picked platform is empty.
    review_url:
      company.review_platform === 'google' && company.google_review_url ? company.google_review_url
      : company.review_platform === 'trustpilot' && company.trustpilot_url ? company.trustpilot_url
      : company.trustpilot_url || company.google_review_url || '[set review URL in settings]',
  };
}

// Substitute {variable} placeholders in a string.
// Unknown variables stay as-is so they're visible to staff before sending.
function renderTemplate(text, ctx) {
  if (!text) return '';
  return String(text).replace(/\{(\w+)\}/g, (m, key) => {
    return ctx[key] !== undefined && ctx[key] !== null ? String(ctx[key]) : m;
  });
}

async function getCompanySettings() {
  const r = await query('SELECT * FROM app_settings WHERE id = 1');
  return r.rows[0] || {};
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/messages/templates — list available templates
// GET /api/messages/templates/:saleId — list templates with the sale's context
//   pre-rendered for preview
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Self-healing migration: message_templates table.
// Seeded with the built-in templates on first run. After that, staff edits
// are persisted to the DB. Built-in templates can be edited but not deleted
// (only "reset to defaults" restores them); custom ones can be deleted.
// ──────────────────────────────────────────────────────────────────────────
let _migrationDone = false;
async function ensureTemplateTable() {
  if (_migrationDone) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id              SERIAL PRIMARY KEY,
        key             TEXT UNIQUE NOT NULL,
        label           TEXT NOT NULL,
        subject         TEXT NOT NULL DEFAULT '',
        body            TEXT NOT NULL DEFAULT '',
        default_channel TEXT NOT NULL DEFAULT 'email',
        is_builtin      BOOLEAN NOT NULL DEFAULT false,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Settings columns for the review URLs + default platform
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS trustpilot_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_review_url TEXT`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS review_platform TEXT DEFAULT 'trustpilot'`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_country_code TEXT DEFAULT '44'`);
    // Seed built-in templates if they don't exist. Update key + label + is_builtin
    // flag but DON'T overwrite subject/body — staff may have edited them.
    for (let i = 0; i < BUILTIN_TEMPLATES.length; i++) {
      const t = BUILTIN_TEMPLATES[i];
      await query(`
        INSERT INTO message_templates (key, label, subject, body, default_channel, is_builtin, sort_order)
        VALUES ($1, $2, $3, $4, $5, true, $6)
        ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, is_builtin = true
      `, [t.key, t.label, t.subject, t.body, t.defaultChannel, i]);
    }
    _migrationDone = true;
  } catch (e) {
    console.warn('[messages.js] migration warning:', e.message);
  }
}
ensureTemplateTable();

// Fetch all templates from DB, ordered by sort_order then key.
async function loadTemplates() {
  await ensureTemplateTable();
  const r = await query(`SELECT * FROM message_templates ORDER BY sort_order, key`);
  return r.rows.map(t => ({
    id: t.id,
    key: t.key,
    label: t.label,
    subject: t.subject || '',
    body: t.body || '',
    defaultChannel: t.default_channel || 'email',
    isBuiltin: !!t.is_builtin,
    sortOrder: t.sort_order || 0,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/messages/templates — list raw templates (for the settings editor)
// ──────────────────────────────────────────────────────────────────────────
router.get('/templates', requireAdmin, async (req, res) => {
  const templates = await loadTemplates();
  res.json({ templates });
});

// POST /api/messages/templates — create a new custom template
router.post('/templates', requireAdmin, async (req, res) => {
  await ensureTemplateTable();
  const b = req.body || {};
  const key = (b.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  if (!key) return res.status(400).json({ error: 'key_required' });
  const label = (b.label || '').trim() || 'Unnamed template';
  const subject = (b.subject || '').toString();
  const body = (b.body || '').toString();
  const defaultChannel = ['email','whatsapp','ebay'].includes(b.defaultChannel) ? b.defaultChannel : 'email';
  try {
    const r = await query(`
      INSERT INTO message_templates (key, label, subject, body, default_channel, is_builtin, sort_order, updated_at)
      VALUES ($1, $2, $3, $4, $5, false, 9999, now())
      RETURNING *
    `, [key, label, subject, body, defaultChannel]);
    await audit(req, 'create_template', null, null, { key });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'key_exists', message: 'A template with this key already exists.' });
    res.status(500).json({ error: 'create_failed', message: e.message });
  }
});

// PATCH /api/messages/templates/:id — update a template (built-in or custom)
router.patch('/templates/:id', requireAdmin, async (req, res) => {
  await ensureTemplateTable();
  const b = req.body || {};
  const updates = [], params = [];
  const map = { label: 'label', subject: 'subject', body: 'body', defaultChannel: 'default_channel' };
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    params.push(b[k]);
    updates.push(`${col} = $${params.length}`);
  }
  if (!updates.length) return res.json({ ok: true, message: 'no_changes' });
  params.push(req.params.id);
  try {
    const r = await query(
      `UPDATE message_templates SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'update_template', null, null, { id: req.params.id, key: r.rows[0].key });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'update_failed', message: e.message });
  }
});

// DELETE /api/messages/templates/:id — delete a custom template (built-ins refuse)
router.delete('/templates/:id', requireAdmin, async (req, res) => {
  await ensureTemplateTable();
  const r = await query(`SELECT * FROM message_templates WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (r.rows[0].is_builtin) {
    return res.status(400).json({ error: 'builtin_cannot_be_deleted', message: 'Built-in templates cannot be deleted. Use Reset to restore the original subject/body.' });
  }
  await query(`DELETE FROM message_templates WHERE id = $1`, [req.params.id]);
  await audit(req, 'delete_template', null, null, { id: req.params.id, key: r.rows[0].key });
  res.json({ ok: true });
});

// POST /api/messages/templates/:id/reset — reset a built-in template to the seed
router.post('/templates/:id/reset', requireAdmin, async (req, res) => {
  await ensureTemplateTable();
  const r = await query(`SELECT * FROM message_templates WHERE id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (!r.rows[0].is_builtin) return res.status(400).json({ error: 'not_a_builtin' });
  const seed = BUILTIN_TEMPLATES.find(t => t.key === r.rows[0].key);
  if (!seed) return res.status(404).json({ error: 'no_seed_found' });
  const updated = await query(`
    UPDATE message_templates SET label = $1, subject = $2, body = $3, default_channel = $4, updated_at = now()
    WHERE id = $5 RETURNING *
  `, [seed.label, seed.subject, seed.body, seed.defaultChannel, req.params.id]);
  await audit(req, 'reset_template', null, null, { id: req.params.id, key: r.rows[0].key });
  res.json({ ok: true, template: updated.rows[0] });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/messages/templates-for-sale/:saleId
// Returns templates with subject + body rendered using this sale's context,
// plus channel-availability hints. Used by the "Message customer" modal.
// (Renamed from /templates/:saleId so the bare /templates endpoint can be
// used by the settings editor without ID confusion.)
// ──────────────────────────────────────────────────────────────────────────
router.get('/templates-for-sale/:saleId', requireAdmin, async (req, res) => {
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const sale = s.rows[0];
  const items = (await query(`SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`, [req.params.saleId])).rows;
  const company = await getCompanySettings();
  const ctx = await buildContext(sale, items, company);
  const allTemplates = await loadTemplates();

  // Render subject + body for each template using this sale's context. The UI
  // shows the rendered text immediately when staff picks a template — no extra
  // server round-trip.
  const templates = allTemplates.map(t => ({
    ...t,
    renderedSubject: renderTemplate(t.subject, ctx),
    renderedBody:    renderTemplate(t.body, ctx),
  }));

  // Channel-availability hints based on what the sale has on file.
  const channels = {
    email:    !!sale.customer_email,
    whatsapp: !!sale.customer_phone,
    ebay:     (sale.channel || '').startsWith('ebay_') && !!sale.external_order_id,
  };

  res.json({
    templates,
    channels,
    customer: {
      name: sale.customer_name || '',
      email: sale.customer_email || '',
      phone: sale.customer_phone || '',
    },
    context: ctx,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/messages/email/:saleId
// Body: { to?, subject, body, templateKey? }
//   `to` defaults to the sale's customer_email; staff can override.
// ──────────────────────────────────────────────────────────────────────────
router.post('/email/:saleId', requireAdmin, async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'email_not_configured',
      message: 'Set RESEND_API_KEY env var. Sign up at resend.com (free tier: 3000/month).',
    });
  }
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'sale_not_found' });
  const sale = s.rows[0];

  const to = (req.body.to || sale.customer_email || '').trim();
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: 'invalid_email', message: 'Provide a valid email address.' });

  const subject = (req.body.subject || '').trim();
  const body    = (req.body.body || '').trim();
  if (!subject) return res.status(400).json({ error: 'subject_required' });
  if (!body)    return res.status(400).json({ error: 'body_required' });

  // Convert plain-text body to safe HTML — preserve line breaks, no rich formatting
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" style="color:#1a5dbf">${url}</a>`);
  const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">
${linkify(escape(body)).replace(/\n/g, '<br>')}
</div>`;

  const brand = require('../lib/brand');
  const fromEmail = process.env.WAREHOUSE_FROM_EMAIL || `noreply@${brand.domain}`;

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${brand.name} <${fromEmail}>`,
      to: [to],
      subject,
      html: htmlBody,
      text: body,  // plain-text fallback for non-HTML clients
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    await audit(req, 'send_message_email', 'sale', sale.id, {
      to, templateKey: req.body.templateKey || 'custom', resend_id: r.data?.id,
    });
    res.json({ ok: true, channel: 'email', to, id: r.data?.id });
  } catch (e) {
    console.error('[messages.email]', e.response?.data || e.message);
    res.status(500).json({ error: 'send_failed', message: e.response?.data?.message || e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/messages/ebay/:saleId
// Body: { body, subject?, templateKey? }
// Sends an "Ask a question to seller/partner" style message via Trading API.
// Looks up the eBay ItemID from mirror_links (via first sale_item's SKU).
// ──────────────────────────────────────────────────────────────────────────
router.post('/ebay/:saleId', requireAdmin, async (req, res) => {
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'sale_not_found' });
  const sale = s.rows[0];
  if (!(sale.channel || '').startsWith('ebay_')) {
    return res.status(400).json({ error: 'not_an_ebay_order' });
  }
  if (!sale.external_order_id) return res.status(400).json({ error: 'no_ebay_order_id' });

  const body = (req.body.body || '').trim();
  const subject = (req.body.subject || '').trim() || 'Update on your order';
  if (!body) return res.status(400).json({ error: 'body_required' });

  // Look up the buyer's eBay UserID via GetOrders (we don't store it locally).
  // Also need the ItemID for AddMemberMessageAAQToPartner — pulled from mirror_links.
  const ebay = require('../services/ebay');
  const brand = require('../lib/brand');
  const store = brand.stores.find(s => s.channelCode === sale.channel);
  if (!store) return res.status(400).json({ error: 'store_not_mapped', channel: sale.channel });

  // Try to find an ItemID for the sale.
  const firstItem = (await query(`SELECT sku FROM sale_items WHERE sale_id = $1 ORDER BY id LIMIT 1`, [req.params.saleId])).rows[0];
  let itemId = null;
  if (firstItem?.sku) {
    const link = await query(`SELECT ebay_item_id FROM mirror_links WHERE LOWER(sku) = LOWER($1) AND ebay_item_id IS NOT NULL LIMIT 1`, [firstItem.sku]);
    itemId = link.rows[0]?.ebay_item_id || null;
  }

  // Get the buyer ID from the order via Fulfillment API (more reliable than trying
  // to extract it from a recent-orders cache).
  let buyerUserId = null;
  try {
    const od = await ebay.getOrderDetail(sale.external_order_id, store.code);
    buyerUserId = od?.buyer?.username || null;
  } catch (e) {
    return res.status(502).json({
      error: 'order_lookup_failed',
      message: `Couldn't fetch order from eBay to find the buyer's user ID. Usually means the eBay tokens for this store have expired or lack the sell.fulfillment scope. Original error: ${e.message}`,
    });
  }
  if (!buyerUserId) return res.status(400).json({
    error: 'no_buyer_userid',
    message: `eBay returned the order but no buyer username. This can happen for very old orders or once eBay has anonymised the buyer identity (~30 days after the order). Use WhatsApp or email instead if you have those.`,
  });
  if (!itemId) return res.status(400).json({
    error: 'no_item_id_link',
    message: `No eBay ItemID is linked for any SKU in this order. Open Listing Mirror in the sidebar and click "🔗 Force match all" so the warehouse can link your SKUs to live eBay listings, then retry.`,
  });

  // AddMemberMessageAAQToPartner — sends an "Ask a question" style member message
  // from the seller to the buyer about a specific listing/transaction.
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const bodyInner = `
    <ItemID>${itemId}</ItemID>
    <MemberMessage>
      <Subject>${xmlEscape(subject).slice(0, 200)}</Subject>
      <Body>${xmlEscape(body).slice(0, 2000)}</Body>
      <QuestionType>General</QuestionType>
      <RecipientID>${xmlEscape(buyerUserId)}</RecipientID>
    </MemberMessage>`;

  try {
    // Pull tradingCall via service for consistency with other Trading API calls.
    const ebayFull = require('../services/ebay');
    // tradingCall isn't exported directly — we use the public dumpOrderXml/etc
    // patterns. For AddMemberMessageAAQToPartner specifically we need direct access;
    // call through completeSale's lower-level path isn't right either. Inline the
    // call using axios + the existing token/store machinery.
    // This is a controlled call duplicating the tradingCall pattern from services/ebay.js.
    const axiosLib = require('axios');
    const TRADING_BASE = 'https://api.ebay.com/ws/api.dll';
    const storeRes = brand.getStore(store.code);
    const authToken = storeRes?.token || null;
    let headers, xml;
    const callName = 'AddMemberMessageAAQToPartner';
    if (authToken) {
      headers = {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '3',
        'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
        'X-EBAY-API-APP-NAME': process.env.EBAY_CLIENT_ID || '',
        'X-EBAY-API-CERT-NAME': process.env.EBAY_CLIENT_SECRET || '',
      };
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${authToken}</eBayAuthToken></RequesterCredentials>
  ${bodyInner}
</${callName}Request>`;
    } else {
      const token = await ebayFull.getAccessToken();
      headers = {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': process.env.EBAY_SITE_ID || '3',
        'X-EBAY-API-IAF-TOKEN': token,
      };
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${bodyInner}
</${callName}Request>`;
    }
    const r = await axiosLib.post(TRADING_BASE, xml, { headers, timeout: 30000 });
    const xmlResp = r.data || '';
    // Check Ack
    const ackMatch = xmlResp.match(/<Ack>([^<]+)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';
    if (ack === 'Failure') {
      const codeMatch = xmlResp.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
      const msgMatch  = xmlResp.match(/<ShortMessage>([^<]+)<\/ShortMessage>/) || xmlResp.match(/<LongMessage>([^<]+)<\/LongMessage>/);
      throw new Error(`eBay ${ack} [${codeMatch?.[1] || 'unknown'}]: ${msgMatch?.[1] || 'no detail'}`);
    }
    await audit(req, 'send_message_ebay', 'sale', sale.id, {
      itemId, recipient: buyerUserId, templateKey: req.body.templateKey || 'custom', ack,
    });
    res.json({ ok: true, channel: 'ebay', ack, itemId, recipient: buyerUserId });
  } catch (e) {
    console.error('[messages.ebay]', e.message);
    res.status(500).json({ error: 'send_failed', message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/messages/whatsapp-link/:saleId?body=...
// Returns a wa.me URL the frontend can open. We do this server-side so the
// phone-number-normalisation logic is shared. WhatsApp doesn't have a send-API
// from a non-Business account, so the workflow is "open in WhatsApp Web/app
// with the message pre-filled, staff hits send manually".
//
// Normalisation strategy — order matters:
//   1. Starts with "+"   → already E.164, strip the "+" and use as-is
//   2. Starts with "00"  → international prefix (EU/UK convention) → strip
//   3. Starts with "0"   → local format → strip leading 0, prepend default
//                          country code from settings (default "44" for UK)
//   4. Otherwise         → assume already-international, use as-is
// ──────────────────────────────────────────────────────────────────────────
router.get('/whatsapp-link/:saleId', requireAdmin, async (req, res) => {
  const s = await query(`SELECT customer_phone FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const phone = (s.rows[0].customer_phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'no_phone' });

  // Look up the default country code from settings. Used only as a last resort
  // when the phone starts with a single "0" (local format).
  const settings = await query('SELECT default_country_code FROM app_settings WHERE id = 1');
  const defaultCC = (settings.rows[0]?.default_country_code || '44').replace(/[^\d]/g, '');

  // Strip everything except digits and a single leading "+"
  let raw = phone.trim();
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/[^\d]/g, '');

  let normalised;
  if (hasPlus) {
    // E.164 input — keep as-is (just drop the +)
    normalised = digits;
  } else if (digits.startsWith('00')) {
    // International prefix — drop the 00
    normalised = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length >= 10) {
    // Looks like local format (e.g. UK 07494589542). Drop the leading 0,
    // prepend the configured default country code.
    normalised = defaultCC + digits.slice(1);
  } else {
    // Already in international form (e.g. eBay/Shopify may return "447494...")
    normalised = digits;
  }

  const text = (req.query.body || '').toString();
  const link = `https://wa.me/${normalised}` + (text ? `?text=${encodeURIComponent(text)}` : '');
  res.json({ ok: true, link, normalisedPhone: normalised, original: phone });
});

module.exports = router;
module.exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES;
module.exports.buildContext = buildContext;
module.exports.renderTemplate = renderTemplate;
