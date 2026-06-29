// lib/dispatch-emails.js — customer emails sent from the dispatch hub.
// Pure HTML builders (no DB/network) so routes/dispatch.js can compose + send via
// services/email.js. Used for direct (bank/card) orders only — eBay/Shopify buyers
// are emailed by the marketplace itself.
const brand = require('./brand');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function ref(sale) {
  return sale.invoice_number || sale.payment_reference || sale.order_number || ('#' + sale.id);
}
function itemsList(items) {
  return (items || []).map(i => `<li style="margin:2px 0">${esc(i.title)}${i.qty > 1 ? ` &times;${i.qty}` : ''}</li>`).join('');
}
function shell(inner, accent) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    <div style="border-top:4px solid ${accent};padding:18px 4px 6px"><div style="font-weight:800;font-size:20px;letter-spacing:-.01em">${esc(brand.name || 'Razoryn')}</div></div>
    ${inner}
    <div style="border-top:1px solid #eee;margin-top:18px;padding-top:12px;font-size:12px;color:#888">${esc(brand.name || 'Razoryn')}${brand.domain ? ' · ' + esc(brand.domain) : ''}</div>
  </div>`;
}

// "Your order is on its way" — for a posted (delivery) order.
function buildDispatchEmail({ sale, items, trackingUrl, carrier, company }) {
  const accent = brand.primaryColor || '#c8202d';
  const trackBtn = trackingUrl
    ? `<a href="${esc(trackingUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;margin-top:6px">Track your parcel</a>`
    : '';
  const trackLine = sale.tracking_number
    ? `<p style="margin:10px 0 4px">Carrier: <strong>${esc(carrier || sale.carrier)}</strong><br>Tracking number: <strong>${esc(sale.tracking_number)}</strong></p>${trackingUrl ? '' : `<p style="font-size:13px;color:#666;margin:2px 0">Enter the tracking number on the courier's website to follow your parcel.</p>`}`
    : `<p style="margin:10px 0;color:#666">Sent via <strong>${esc(carrier || sale.carrier)}</strong>.</p>`;
  const inner = `
    <div style="padding:6px 4px">
      <h2 style="font-size:18px;margin:10px 0">Your order is on its way 📦</h2>
      <p style="margin:6px 0">Hi ${esc(sale.customer_name || 'there')}, your order <strong>${esc(ref(sale))}</strong> has been dispatched.</p>
      <ul style="padding-left:18px;margin:8px 0;font-size:14px">${itemsList(items)}</ul>
      ${trackLine}
      ${trackBtn}
      <p style="font-size:13px;color:#666;margin:16px 0 0">Any questions, just reply to this email${company?.company_phone ? ` or call ${esc(company.company_phone)}` : ''}.</p>
    </div>`;
  return { subject: `Your order ${ref(sale)} has been dispatched — ${brand.name || 'Razoryn'}`, html: shell(inner, accent) };
}

// "Ready to collect" — for a collection order.
function buildCollectionEmail({ sale, items, company }) {
  const accent = brand.primaryColor || '#c8202d';
  const addr = company?.company_address ? esc(company.company_address).replace(/\n/g, '<br>') : '';
  const inner = `
    <div style="padding:6px 4px">
      <h2 style="font-size:18px;margin:10px 0">Your order is ready to collect ✅</h2>
      <p style="margin:6px 0">Hi ${esc(sale.customer_name || 'there')}, your order <strong>${esc(ref(sale))}</strong> is packed and ready for collection.</p>
      <ul style="padding-left:18px;margin:8px 0;font-size:14px">${itemsList(items)}</ul>
      ${addr ? `<p style="margin:12px 0 2px"><strong>Collect from:</strong><br>${addr}</p>` : ''}
      ${company?.company_phone ? `<p style="font-size:13px;color:#666;margin:6px 0">Please bring your order reference. Call ${esc(company.company_phone)} if you need directions or to arrange a time.</p>` : ''}
    </div>`;
  return { subject: `Your order ${ref(sale)} is ready to collect — ${brand.name || 'Razoryn'}`, html: shell(inner, accent) };
}

module.exports = { buildDispatchEmail, buildCollectionEmail };
