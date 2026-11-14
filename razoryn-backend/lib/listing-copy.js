// lib/listing-copy.js — website product descriptions (Shopify body_html).
//
// The website, the Shop app and AI shopping agents (ChatGPT, Copilot…) all read
// the Shopify description. eBay's styled listing HTML is wrong there ("eBay's
// compatibility list…", "message us", related-item cards with stale prices,
// mixed 14/30-day returns), so the website gets its own clean, factual copy built
// from the product's own data: title (vehicle, years, part), part number(s),
// position, finish, large-panel flag. Pure — no DB or network — so it can be
// unit-tested and used anywhere (new listings, restyles, the catalogue optimiser).
const brandLib = require('./brand');
const seo = require('./seo');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Descriptions that came from the eBay template (or are empty) get replaced.
function needsNewDescription(html) {
  const s = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 40) return true;
  return /\beBay\b|You might be interested in|Message us your reg|Fits make\s/i.test(s);
}

// "KIA PICANTO GT LINE" → "Kia Picanto GT Line"; codes (MK3, i20, NX4, C-HR, VW) stay.
const KEEP_UPPER = new Set(['GT', 'GTI', 'VW', 'MG', 'BMW', 'DS', 'LED', 'DRL', 'PDC', 'ABS', 'SUV', 'EV', 'UK', 'OE', 'OEM', 'HID', 'RS', 'ST', 'GTD', 'TDI', 'TSI', 'SE', 'SEL', 'AMG', 'SEAT']);
const COMMON3 = new Set(['KIA', 'FOR', 'AND', 'THE', 'SET', 'KIT', 'TOW', 'CAP', 'BAR', 'TOP', 'LID', 'CAR', 'VAN', 'NEW', 'ARM', 'BOX', 'PIN', 'RED', 'ONE', 'TWO', 'OFF', 'OUT', 'LOW', 'AIR', 'OIL', 'FAN', 'HUB', 'NUT']);
function tidyWord(part) {
  const m = part.match(/^([^A-Za-z0-9]*)([A-Za-z0-9.]*)([^A-Za-z0-9]*)$/);
  if (!m) return part;
  const [, pre, core, post] = m;
  if (!/^[A-Za-z]+$/.test(core)) return part;                 // has digits → a code (MK3, i20, NX4), keep
  if (KEEP_UPPER.has(core.toUpperCase()) && core === core.toUpperCase()) return part;
  if (core !== core.toUpperCase() || core.length <= 2) return part; // mixed case, or short caps code (NS, ZS)
  // 3-letter capitals are usually model codes (HRV, CRV, GLA) — except plain words.
  if (core.length === 3 && !COMMON3.has(core)) return part;
  return pre + core.charAt(0) + core.slice(1).toLowerCase() + post;
}
function tidyCase(text) {
  return String(text || '').split(/(\s+)/).map(word => word.split('-').map(tidyWord).join('-')).join('');
}
// Part names read as ordinary words in a sentence: "Rear Right Brake Light" → "rear right brake light".
function lowerPhrase(text) {
  return String(text || '').split(/(\s+)/).map(w => {
    const core = w.replace(/[^A-Za-z]/g, '');
    if (!core || /\d/.test(w) || (KEEP_UPPER.has(core.toUpperCase()) && core === core.toUpperCase())) return w;
    return w.toLowerCase();
  }).join('');
}

// Split "Hyundai Kona SX2 2023-2026 Front Bumper Skin (Smooth)" into its parts.
function parseTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*\(?((?:19|20)\d{2})\s*(?:[-–]|to)\s*((?:19|20)\d{2}|on|onwards|\+)?\)?\s*(.*)$/i);
  if (m && m[1] && m[4]) {
    const to = m[3] && /^\d/.test(m[3]) ? m[3] : '';
    return { vehicle: tidyCase(m[1].replace(/[-–,]\s*$/, '').trim()), years: to ? `${m[2]}–${to}` : `${m[2]} on`, part: tidyCase(m[4].trim()) };
  }
  return { vehicle: '', years: '', part: tidyCase(t) };
}

const FINISHES = [
  ['primed', /\bprimed\b/i], ['dark chrome', /\bdark chrome\b/i], ['chrome', /\bchrome\b/i],
  ['gloss black', /\bgloss(y)? black\b/i], ['gloss', /\bgloss(y)?\b/i], ['matt black', /\bmatte? black\b/i],
  ['textured', /\btextured\b/i], ['painted', /\bpainted\b/i],
];
function detectFinish(title, metafieldFinish) {
  const f = String(metafieldFinish || '').trim().toLowerCase();
  if (f && f !== 'basic') return f;
  for (const [label, re] of FINISHES) if (re.test(title || '')) return label;
  return '';
}

function positionText(title, pos1, pos2) {
  const fromMeta = [pos1, pos2].map(x => String(x || '').trim()).filter(Boolean)
    .map(x => x.replace(/\s*side$/i, ''));
  const list = fromMeta.length ? fromMeta : seo.detectPositions(title);
  const uniq = [...new Set(list.map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()))];
  // "Front", "Rear" first, then "Upper/Lower", then the side.
  const order = ['Front', 'Rear', 'Upper', 'Lower', 'Left', 'Right'];
  uniq.sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  let s = uniq.join(' ');
  if (uniq.includes('Left')) s += ' (passenger side / N/S on UK cars)';
  else if (uniq.includes('Right')) s += ' (driver\'s side / O/S on UK cars)';
  return s;
}

/**
 * @param {{ title:string, partNumber?:string, altPartNumbers?:string, finish?:string,
 *           position?:string, secondaryPosition?:string, tags?:string[]|string, largePanel?:boolean }} p
 * @returns {string} HTML for Shopify body_html
 */
function buildDescriptionHtml(p = {}, brandCfg = brandLib) {
  const title = String(p.title || '').trim();
  const { vehicle, years, part } = parseTitle(title);
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const large = p.largePanel === true || tags.some(t => /^LP$/i.test(t));
  const finish = detectFinish(title, p.finish);
  const pos = positionText(title, p.position, p.secondaryPosition);
  const pn = String(p.partNumber || '').trim();
  const alts = String(p.altPartNumbers || '').split(/[,;/]+/).map(s => s.trim()).filter(x => x && x.toUpperCase() !== pn.toUpperCase());
  const genuine = /\bgenuine\b/i.test(title);
  const name = brandCfg.fullName || brandCfg.name || 'Razoryn e-Parts';
  const area = brandCfg.collectionArea || 'Watford';
  const partLc = part ? lowerPhrase(part) : 'replacement part';

  const intro = vehicle
    ? `A brand-new ${genuine ? '' : 'replacement '}${esc(partLc)} for the <strong>${esc(vehicle)}</strong>${years ? ` (${esc(years)})` : ''}.`
    : `Brand-new: ${esc(tidyCase(title))}.`;
  const finishLine = finish === 'primed'
    ? 'Supplied primed, ready for painting to your colour before fitting. We don\'t paint panels.'
    : '';

  const rows = [];
  rows.push(vehicle
    ? `<li><strong>Fits:</strong> ${esc(vehicle)}${years ? ` ${esc(years)}` : ''}. Not sure? Send us your reg or VIN and we'll confirm the fit before you order.</li>`
    : `<li><strong>Fits:</strong> check the OE reference against your original part, or send us your reg or VIN and we'll confirm the fit before you order.</li>`);
  if (pn) rows.push(`<li><strong>OE reference:</strong> ${esc(pn)}${alts.length ? ` (also ${esc(alts.join(', '))})` : ''}. Check it against the number on your original part.</li>`);
  if (pos) rows.push(`<li><strong>Position:</strong> ${esc(pos)}</li>`);
  if (finish) rows.push(`<li><strong>Finish:</strong> ${finish === 'primed' ? 'Primed (needs painting)' : esc(finish.charAt(0).toUpperCase() + finish.slice(1))}</li>`);
  rows.push(`<li><strong>Condition:</strong> Brand new${genuine ? ', genuine part' : ''}</li>`);

  const delivery = large
    ? 'Large panel: sent by our large-item courier at a flat rate shown at checkout, usually 2–5 working days. Order by 12pm Monday–Friday for same-day dispatch.'
    : 'Order by 12pm Monday–Friday for same-day dispatch. Free UK delivery over £50, next-day free over £80.';
  const returns = large
    ? 'Large panels can be returned only if faulty or supplied wrongly, so please check the fit first.'
    : '30-day returns on unused parts (10% restocking fee unless faulty or our error).';

  return [
    `<p>${intro}${finishLine ? ' ' + finishLine : ''}</p>`,
    `<ul>${rows.join('')}</ul>`,
    `<p><strong>Delivery &amp; collection:</strong> ${delivery} Or collect from our ${esc(area.split(',')[0])} warehouse.</p>`,
    `<p><strong>Returns:</strong> ${returns}</p>`,
    `<p>Questions? Message ${esc(name)} with your reg and we'll help you find the right part.</p>`,
  ].join('\n');
}

// Shopify "Product type" (POS search, filters, Google) + a taxonomy search term
// for the category. Specific car-part names first — lib/seo.js's list would call
// a "wheel arch trim" a Wheel and a "front bumper grille" a Bumper — then fall
// back to lib/seo.js.
const SPECIFIC_TYPES = [
  ['Parcel Shelf', /\bparcel\s?shel(f|ves)\b|\bload\s?cover|\bcargo\s?cover|\bboot\s?cover/i, null],
  ['Tow Hook Cover', /\btow\s?(hook|eye)\s?(cover|cap)/i, 'Bumpers'],
  ['Badge', /\bbadges?\b|\bemblems?\b|\bscript\b/i, 'Emblems'],
  ['Undertray', /\bunder\s?trays?\b|\bengine\s?(under\s?)?tray|\bskid\s?plates?\b|\bengine\s?cover/i, null],
  ['Wheel Arch Liner', /\bsplash\s?guards?\b|\barch\s?liners?\b|\bfender\s?liners?\b|\bmud\s?(flaps?|guards?)\b/i, 'Fender Liners'],
  ['Wheel Arch Trim', /\barch\s?(trim|garnish|moulding|molding)|\bfender\s?flares?\b/i, 'Fender Flares'],
  ['Headlight Repair Kit', /\bhead\s?(light|lamp)s?\s?(bracket|housing|repair)/i, 'Headlights'],
  ['Daytime Running Light', /\bdaytime\s?running|\bday\s?running|\bDRL\b/i, null],
  ['Tail Light', /\bbrake\s?(lamp|light)s?\b|\btail\s?(lamp|light)s?\b|\brear\b.*\b(outer|inner)?\s?(light|lamp)\b/i, 'Tail Lights'],
  ['Charging Flap', /\bcharging\s?(flap|port|cover)|\bfuel\s?(flap|filler)/i, null],
  ['Grille', /\bgrilles?\b|\bgrills?\b/i, 'Grilles'],
  ['Bumper Bracket', /\bbumper\s?(brackets?|supports?|mounts?|guides?)\b/i, 'Bumpers'],
  ['Bumper Reinforcement', /\breinforcement\b|\bcrash\s?bar\b|\bimpact\s?bar\b|\bbumper\s?beam\b/i, 'Bumpers'],
  ['Bumper Trim', /\bbumper\s?(trim|moulding|molding|lip|spoiler|splitter|skid)/i, 'Bumpers'],
  ['Door Shell', /\bdoor\s?shells?\b/i, 'Doors'],
  ['Moulding', /\bmouldings?\b|\bmoldings?\b|\bgarnish\b/i, null],
  ['Camera', /\bcameras?\b/i, null],
  ['Seatbelt Part', /\bseat\s?belt/i, null],
  ['Washer Part', /\bwasher\b/i, null],
  ['Bracket', /\bbrackets?\b/i, null],
];
function partTypeInfo(title) {
  const t = String(title || '');
  for (const [label, re, categoryQuery] of SPECIFIC_TYPES) if (re.test(t)) return { partType: label, categoryQuery };
  return seo.detectPartType(t);
}
function productTypeFor(title) {
  return partTypeInfo(title).partType || null;
}

module.exports = { buildDescriptionHtml, needsNewDescription, parseTitle, tidyCase, lowerPhrase, detectFinish, positionText, productTypeFor, partTypeInfo };
