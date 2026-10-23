// lib/ebay-message-guard.js — stop messages eBay would treat as off-platform
// contact before they're sent.
//
// eBay's member-to-member contact policy blocks (and penalises accounts for)
// buyer messages carrying contact details or pulling buyers off eBay: email
// addresses, phone numbers, links to non-eBay sites, WhatsApp, "visit our
// website / contact us directly". One account was permanently restricted after
// such messages, so EVERY eBay message — automated or typed by staff — goes
// through this check and is refused if it trips it.

const RULES = [
  { re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, why: 'an email address' },
  // UK phone formats (07…, 01/02/03…, +44 …) — not eBay order / tracking numbers.
  { re: /(?:\+44\s?\(?0?\)?\s?|\b0)(?:7\d{3}|[1-3]\d{2,4})[\s-]?\d{3}[\s-]?\d{3,4}\b/, why: 'a phone number' },
  { re: /\bhttps?:\/\/(?![^\s/]*\bebay\.)[^\s]+/i, why: 'a link to a non-eBay website' },
  { re: /\bwww\.(?![^\s/]*\bebay\.)[^\s]+/i, why: 'a website address' },
  { re: /\b[a-z0-9-]+\.(?:co\.uk|com|uk|net|org|shop|store|io)\b(?![^\s]*ebay)/i, why: 'a website address' },
  { re: /\bwhats\s?app\b|\bwa\.me\b/i, why: 'WhatsApp' },
  { re: /\b(?:call|ring|text|phone|email|e-mail|contact)\s+(?:us|me)\s+(?:directly|outside|off\s*ebay|on|at)\b/i, why: 'an invitation to contact you outside eBay' },
  { re: /\b(?:our|my)\s+(?:own\s+)?(?:website|web\s?site|online\s+shop|web\s?shop)\b/i, why: 'a pointer to your own website' },
  { re: /\b(?:buy|order|purchase)\s+(?:direct|directly|outside\s+of\s+ebay|off\s+ebay)\b/i, why: 'an offer to sell outside eBay' },
  { re: /\b(?:discount|promo|voucher)\s+code\b/i, why: 'a promotion / discount code' },
];

// → [] when clean, else a list of plain-English problems.
function check(text) {
  // eBay's own links and domains are fine — strip them before checking.
  const t = String(text || '').replace(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*ebay\.[a-z.]+[^\s]*/gi, ' ');
  const found = [];
  for (const r of RULES) if (r.re.test(t) && !found.includes(r.why)) found.push(r.why);
  return found;
}

function assertClean(subject, body) {
  const problems = check(`${subject || ''}\n${body || ''}`);
  if (problems.length) {
    const e = new Error(`Not sent — eBay's messaging policy forbids ${problems.join(', ')} in messages to buyers. Remove ${problems.length > 1 ? 'them' : 'it'} and keep the message about this order only.`);
    e.code = 'ebay_message_policy';
    e.problems = problems;
    throw e;
  }
}

module.exports = { check, assertClean };
