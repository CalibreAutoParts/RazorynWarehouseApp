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
// Templates — the source of truth for staff-facing message content.
// Each template has:
//   key            — stable identifier used by the UI
//   label          — what staff see in the dropdown
//   subject        — email subject line (ignored for eBay/WhatsApp)
//   body           — message body, supports {variable} substitution
//   defaultChannel — pre-selects this channel when the template is picked
//
// Variables supported in subject + body:
//   {customer_name}, {first_name}
//   {invoice}, {payment_reference}, {order_number}
//   {total}, {subtotal}
//   {tracking_number}, {carrier}, {tracking_url}
//   {item_first}, {item_count}
//   {company_name}, {company_phone}, {company_website}, {company_email}
//
// Unsubstituted variables stay in the text so staff notice them before sending.
// ──────────────────────────────────────────────────────────────────────────
const TEMPLATES = [
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
router.get('/templates', requireAdmin, (req, res) => {
  res.json({ templates: TEMPLATES.map(t => ({ ...t })) });
});

router.get('/templates/:saleId', requireAdmin, async (req, res) => {
  const s = await query(`SELECT * FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const sale = s.rows[0];
  const items = (await query(`SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`, [req.params.saleId])).rows;
  const company = await getCompanySettings();
  const ctx = await buildContext(sale, items, company);

  // For each template, render subject + body so the UI can show a live preview
  // without having to round-trip on every dropdown selection.
  const templates = TEMPLATES.map(t => ({
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
    context: ctx,  // exposed so the UI can do client-side re-rendering on edits
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
    return res.status(502).json({ error: 'order_lookup_failed', message: e.message });
  }
  if (!buyerUserId) return res.status(400).json({ error: 'no_buyer_userid', message: 'Could not resolve the buyer\'s eBay user ID — try again or use a different channel.' });
  if (!itemId)      return res.status(400).json({ error: 'no_item_id_link', message: 'No eBay ItemID linked for any item in this order. Run "🔗 Force match all" in Listing Mirror first.' });

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
// ──────────────────────────────────────────────────────────────────────────
router.get('/whatsapp-link/:saleId', requireAdmin, async (req, res) => {
  const s = await query(`SELECT customer_phone FROM sales WHERE id = $1`, [req.params.saleId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not_found' });
  const phone = (s.rows[0].customer_phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'no_phone' });

  // Normalise to international format with no spaces / dashes / brackets.
  // UK numbers: "07494589542" → "447494589542"; "+44 7494 589542" → "447494589542"
  let normalised = phone.replace(/[^\d+]/g, '');
  if (normalised.startsWith('+')) normalised = normalised.slice(1);
  else if (normalised.startsWith('0')) normalised = '44' + normalised.slice(1);  // UK assumption

  const text = (req.query.body || '').toString();
  const link = `https://wa.me/${normalised}` + (text ? `?text=${encodeURIComponent(text)}` : '');
  res.json({ ok: true, link, normalisedPhone: normalised });
});

module.exports = router;
module.exports.TEMPLATES = TEMPLATES;
module.exports.buildContext = buildContext;
module.exports.renderTemplate = renderTemplate;
