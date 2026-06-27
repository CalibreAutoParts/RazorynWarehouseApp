// lib/preorder.js — shared formatting for pre-listed / pre-order products.
//
// A pre-listed product is created BEFORE its stock arrives. On Shopify we (a) tag
// it `preorder`, (b) keep it selling at 0 stock (inventory_policy 'continue'), and
// (c) bake a "Pre-order — ships ~DATE" notice into the TITLE and DESCRIPTION so it
// shows regardless of the storefront theme. When the stock lands we reverse all of
// this. These helpers are pure (no DB / no network) and idempotent so the create
// path and the revert path stay perfectly in sync.

const PREORDER_TAG = 'preorder';

// The notice we splice into the title/description. The regex below must match
// whatever this produces so stripping is exact.
//   title:  "Pre-order — ships ~12 Aug 2026 — <real title>"
//   body:   "<p><strong>Pre-order — ships ~12 Aug 2026.</strong> ...</p><real body>"
const TITLE_PREFIX_RE = /^Pre-order — ships ~[^—]*— /;
const BODY_NOTICE_RE = /^<p><strong>Pre-order — ships[^<]*<\/strong>[^<]*<\/p>/;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Format an ETA (Date | ISO string | yyyy-mm-dd) as "12 Aug 2026". Returns '' if
// unparseable so callers degrade to a generic notice.
function formatEta(eta) {
  if (!eta) return '';
  const d = (eta instanceof Date) ? eta : new Date(String(eta).length === 10 ? `${eta}T00:00:00Z` : eta);
  if (isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "Pre-order — ships ~12 Aug 2026 — " (or "Pre-order — ships soon — " with no ETA).
function titleNotice(eta) {
  const f = formatEta(eta);
  return f ? `Pre-order — ships ~${f} — ` : `Pre-order — ships soon — `;
}

function addTitleNotice(title, eta) {
  return titleNotice(eta) + stripTitleNotice(title);
}
function stripTitleNotice(title) {
  return String(title || '').replace(TITLE_PREFIX_RE, '');
}

function bodyNotice(eta) {
  const f = formatEta(eta);
  const msg = f
    ? `Pre-order — ships ~${f}. Order now to reserve yours; we'll dispatch as soon as stock arrives.`
    : `Pre-order — ships soon. Order now to reserve yours; we'll dispatch as soon as stock arrives.`;
  return `<p><strong>${msg}</strong></p>`;
}

function addBodyNotice(body, eta) {
  return bodyNotice(eta) + stripBodyNotice(body);
}
function stripBodyNotice(body) {
  return String(body || '').replace(BODY_NOTICE_RE, '');
}

// A short, storefront-ready note for the Shopify metafield (custom.preorder_ships_note)
// so the theme snippet can print it directly without Liquid date formatting.
//   "Ships ~12 Aug 2026"  (or "Ships soon" with no ETA).
function shipsNote(eta) {
  const f = formatEta(eta);
  return f ? `Ships ~${f}` : 'Ships soon';
}

// Add/remove the `preorder` tag from a comma-separated Shopify tags string.
function addPreorderTag(tagsCsv) {
  const tags = String(tagsCsv || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!tags.some(t => t.toLowerCase() === PREORDER_TAG)) tags.push(PREORDER_TAG);
  return tags.join(', ');
}
function removePreorderTag(tagsCsv) {
  return String(tagsCsv || '')
    .split(',').map(t => t.trim()).filter(Boolean)
    .filter(t => t.toLowerCase() !== PREORDER_TAG)
    .join(', ');
}

module.exports = {
  PREORDER_TAG,
  formatEta,
  titleNotice, addTitleNotice, stripTitleNotice,
  bodyNotice, addBodyNotice, stripBodyNotice,
  shipsNote,
  addPreorderTag, removePreorderTag,
};
