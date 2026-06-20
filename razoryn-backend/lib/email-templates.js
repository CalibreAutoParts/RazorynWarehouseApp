// lib/email-templates.js — selectable covering-message templates for invoice
// emails. Admins pick one when sending (e.g. a plain note for a private buyer, a
// trade pitch for a business, a DropFleet direct-delivery offer for local/major-
// city orders). Templates are editable in Settings; these are the seeded
// defaults. The brand signature is added automatically — templates are just the
// message body. Placeholders: {customer} {brand} {ref} {doc} {website}.

const DEFAULT_TEMPLATES = [
  {
    key: 'standard',
    name: 'Standard (private / retail)',
    body:
`Hi {customer},

Please find your {doc}{ref} from {brand} attached below. If you have any questions, just reply to this email.

Thank you for your order.`,
  },
  {
    key: 'trade',
    name: 'Trade / business',
    body:
`Hi {customer},

Please find your {doc}{ref} from {brand} below.

As a business customer you can order direct from {website} for better-than-marketplace prices and exclusive trade rates on regular or bulk orders. Reply to this email and we'll set up a trade account for you.

Thank you for your business.`,
  },
  {
    key: 'dropfleet',
    name: 'Local / major city — direct delivery (DropFleet)',
    body:
`Hi {customer},

Please find your {doc}{ref} from {brand} below.

For larger orders in your area we can deliver directly through our sister courier company, DropFleet — often faster and cheaper than standard shipping. Just reply to this email to arrange a direct delivery.

Thank you for your order.`,
  },
  {
    key: 'ebay_convert',
    name: 'eBay buyer — buy direct & save',
    body:
`Hi {customer},

Thanks for your order — your {doc}{ref} from {brand} is below.

Did you know you can buy direct from {website}? You'll get better prices than the marketplace, faster service, and access to exclusive trade benefits on regular or bulk orders. Reply to this email to set up a trade account.

Thank you again for your order.`,
  },
  {
    key: 'none',
    name: 'Invoice only (no message)',
    body: '',
  },
];

function parseTemplates(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) && a.length ? a : null; }
  catch { return null; }
}

// Returns the saved templates (from app_settings.invoice_email_templates) or the
// defaults. Always guarantees the 'none' option is present.
async function getEmailTemplates(query) {
  let templates = DEFAULT_TEMPLATES;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS invoice_email_templates TEXT`);
    const r = await query(`SELECT invoice_email_templates FROM app_settings WHERE id = 1`);
    const saved = parseTemplates(r.rows[0]?.invoice_email_templates);
    if (saved) templates = saved;
  } catch (e) { /* fall back to defaults */ }
  if (!templates.some(t => t.key === 'none')) templates = [...templates, { key: 'none', name: 'Invoice only (no message)', body: '' }];
  return templates;
}

// Pick a sensible default template for a sale's channel.
function defaultKeyForSale(sale) {
  const ch = (sale && sale.channel) || '';
  if (ch.startsWith('ebay')) return 'ebay_convert';
  return 'standard';
}

module.exports = { DEFAULT_TEMPLATES, getEmailTemplates, defaultKeyForSale };
