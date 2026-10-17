// lib/spec-level.js — is a competitor's listing the SAME spec as ours?
//
// Part numbers lie for assemblies: a complete bumper has no part number of its
// own, so sellers list it under the bumper SKIN's number — the same number a
// bare primed skin carries. Comparing our £445 complete assembly with their
// £115 primed skin is nonsense. These title rules catch the clear cases
// instantly; unclear ones with a big price gap go to Claude (title + photo).

const COMPLETE_RE = [
  /\bcomplete\b/i, /\bassembly\b/i, /\bassy\b/i, /\bfully?\s+loaded\b/i,
  /\bwith\s+(?:all\s+)?(?:the\s+)?(?:grilles?|grills?|fogs?|fog\s*(?:lights?|lamps?|covers?)|brackets?|reinforcement|trims?|mouldings?|moldings?|chrome|inner)\b/i,
  /\bw\/?\s*(?:grilles?|grills?|fogs?|brackets?|inner)\b/i,
  /\b(?:inc|incl|including)\.?\s+(?:grilles?|grills?|fogs?|brackets?|trims?)\b/i,
];
const BARE_RE = [/\bprimed\b/i, /\bskin\b/i, /\bbare\b/i, /\bshell\b/i, /\bcover\s+only\b/i, /\bpanel\s+only\b/i, /\bonly\b/i];

// 'complete' | 'bare' | null (can't tell from the title)
function specLevel(title) {
  const t = String(title || '');
  if (COMPLETE_RE.some(re => re.test(t))) return 'complete';   // "complete … primed" is still complete
  if (BARE_RE.some(re => re.test(t))) return 'bare';
  return null;
}
function material(title) {
  const t = String(title || '').toLowerCase();
  const al = /\balumin(?:i)?um\b|\balloy\b/.test(t), st = /\bsteel\b/.test(t);
  return al && !st ? 'aluminium' : st && !al ? 'steel' : null;
}

// → { mismatch, suspect, reason }
//   mismatch: clearly NOT like-for-like (title rules alone are enough)
//   suspect:  can't tell from titles, and the price gap is big — ask Claude
function specCheck({ ourTitle, theirTitle, ourPrice, theirPrice }) {
  const lo = specLevel(ourTitle), lt = specLevel(theirTitle);
  if (lo && lt && lo !== lt) {
    return { mismatch: true, suspect: false, reason: lo === 'complete' ? 'ours is a complete assembly, theirs is a bare/primed part' : 'theirs is a complete assembly, ours is a bare/primed part' };
  }
  const mo = material(ourTitle), mt = material(theirTitle);
  if (mo && mt && mo !== mt) return { mismatch: true, suspect: false, reason: `different material (ours ${mo}, theirs ${mt})` };
  const op = parseFloat(ourPrice), tp = parseFloat(theirPrice);
  const bigGap = op > 0 && tp > 0 && (tp < op * 0.65 || tp > op * 1.5);
  // One side says complete, the other doesn't say — and the price says they
  // probably differ: Claude should look at the photos.
  if (bigGap && (lo === 'complete' || lt === 'complete') && lo !== lt) {
    return { mismatch: false, suspect: true, reason: `${lo === 'complete' ? 'ours is complete' : 'theirs is complete'}, the other title doesn't say — and the price gap is big` };
  }
  if (bigGap) return { mismatch: false, suspect: true, reason: 'price gap is unusually big — may not be the same spec' };
  return { mismatch: false, suspect: false, reason: null };
}

module.exports = { specLevel, specCheck, material };
