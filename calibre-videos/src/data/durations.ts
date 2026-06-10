/** Pure timing helpers (seconds) shared by compositions and the catalog. */

export const AD_SPOT_SECONDS = 10.2;
export const UGC_SECONDS = 11.2;
export const PROMO_SECONDS = 10.6;
export const TRUST_SECONDS = 10.6;
export const COMPARISON_SECONDS = 11.2;
export const TESTIMONIAL_SECONDS = 11;

export const STORY_SECONDS = (beats: number, isLast: boolean) =>
  2.2 + beats * 2.0 + (isLast ? 3 : 2.6 + 1.6);
export const CARTOON_SECONDS = (scenes: number) => 2.2 + scenes * 2.6 + 3.2;
export const SHOWCASE_SECONDS = (items: number) => 2.2 + items * 1.9 + 2 + 3;
export const TIP_SECONDS = (steps: number) => 3.4 + steps * 1.6 + 1.6 + 3;
