// services/email.js — tiny transactional-email helper (Resend).
// Extracted so multiple features (invoices, back-in-stock, etc.) send mail the
// same way. Mirrors the inline sender in routes/sales.js: same provider, same
// from-address convention. A safe no-op (returns false) when RESEND_API_KEY is
// not set, so callers never crash in dev / unconfigured deploys.
const axios = require('axios');
const brand = require('../lib/brand');

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

/**
 * @param {{to:string|string[], subject:string, html:string, from?:string, replyTo?:string}} opts
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function sendEmail({ to, subject, html, from, replyTo } = {}) {
  if (!isConfigured()) {
    console.warn('[email] RESEND_API_KEY not set — skipping send to', Array.isArray(to) ? to.join(',') : to);
    return { ok: false, error: 'email_not_configured' };
  }
  if (!to || !subject || !html) return { ok: false, error: 'missing_fields' };
  const fromEmail = from || process.env.WAREHOUSE_FROM_EMAIL || `noreply@${brand.domain || 'razoryn.co.uk'}`;
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${brand.name || 'Razoryn'} <${fromEmail}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }, {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
    return { ok: true, id: r.data?.id };
  } catch (e) {
    console.error('[email] send failed:', e.response?.data?.message || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

module.exports = { sendEmail, isConfigured };
