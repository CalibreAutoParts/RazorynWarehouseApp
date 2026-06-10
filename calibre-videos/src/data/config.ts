/**
 * Global content switches.
 *
 * SHOW_PRICING — master switch for ANY on-screen or caption pricing (product
 * prices and "main dealer was £X" figures). Turned OFF ahead of the site-wide
 * price update: no ad should quote a price until the new prices are live and
 * verified. Flip back to `true` (and refresh products.ts with the real prices)
 * once pricing is finalised — every template already reads this flag.
 */
export const SHOW_PRICING = false;

/**
 * VOICEOVER_DIR — where pre-rendered narration audio lives (under /public).
 * Story-time parts look for `vo/story-<id>-p<n>.mp3`; a part only plays audio
 * if that file exists (see scripts/gen-voiceover.ts). No file → silent render,
 * so nothing breaks before the voiceover is generated or supplied.
 */
export const VOICEOVER_DIR = 'vo';
