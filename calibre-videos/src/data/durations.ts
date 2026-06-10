/** Pure timing helpers (seconds) shared by compositions and the catalog. */

export const AD_SPOT_SECONDS = 10.2;
export const UGC_SECONDS = 11.2;
export const PROMO_SECONDS = 10.6;
export const TRUST_SECONDS = 10.6;
export const COMPARISON_SECONDS = 11.6;
export const TESTIMONIAL_SECONDS = 11;

/**
 * Per-beat hold for story-time captions (seconds). Single source of truth so
 * the StoryTime composition and catalog duration stay in lock-step. Slowed so
 * each line is comfortably readable — and long enough to carry a voiceover.
 */
export const STORY_BEAT_SECONDS = 2.9;
export const STORY_SECONDS = (beats: number, isLast: boolean) =>
  2.6 + beats * STORY_BEAT_SECONDS + (isLast ? 3 : 2.8 + 1.6);
export const CARTOON_SECONDS = (scenes: number) => 2.4 + scenes * 3.1 + 3.2;
export const SHOWCASE_SECONDS = (items: number) => 2.4 + items * 2.7 + 2 + 3;
export const TIP_SECONDS = (steps: number) => 3.4 + steps * 2.3 + 1.6 + 3;
