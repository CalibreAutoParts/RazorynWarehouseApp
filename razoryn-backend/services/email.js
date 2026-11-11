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
 * @param {{to:string|string[], subject:string, html:string, from?:string, replyTo?:string,
 *          attachments?: Array<{filename:string, content:string}>}} opts
 *        attachments[].content = base64 (Resend's format).
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function sendEmail({ to, subject, html, from, replyTo, attachments } = {}) {
  if (!isConfigured()) {
    console.warn('[email] RESEND_API_KEY not set — skipping send to', Array.isArray(to) ? to.join(',') : to);
    return { ok: false, error: 'email_not_configured' };
  }
  if (!to || !subject || !html) return { ok: false, error: 'missing_fields' };
  // eBay buyers' relay addresses (…@members.ebay.com / .co.uk): eBay reads that
  // mail and treats off-eBay contact (trade-account invites, offers…) as a
  // policy breach. Never email them — talk to eBay buyers through eBay messages.
  const list = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
  const relay = list.filter(x => /@members\.ebay\.[a-z.]+>?$/i.test(x));
  if (relay.length) {
    console.warn('[email] blocked — eBay relay address:', relay.join(','));
    if (relay.length === list.length) return { ok: false, error: 'ebay_relay_blocked', message: "That's an eBay buyer's relay address — eBay reads those emails. Message them on eBay instead." };
    to = list.filter(x => !relay.includes(x));
  }
  const fromEmail = from || process.env.WAREHOUSE_FROM_EMAIL || `noreply@${brand.domain || 'razoryn.co.uk'}`;
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${brand.name || 'Razoryn'} <${fromEmail}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
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
