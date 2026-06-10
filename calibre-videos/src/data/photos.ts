/**
 * Real product photos by SKU.
 *
 * Map a product SKU → an image path under /public (e.g. 'photos/CAP-TES-M3-BMP.jpg').
 * Any SKU listed here shows the REAL photo in the PhotoAd template; every other
 * SKU falls back to the branded illustration. Mix-and-match is the intent — you
 * only need photos for the products you want to feature with a real image.
 *
 * To add one:
 *   1. Drop the image into  calibre-videos/public/photos/
 *   2. Add an entry below, e.g.  'CAP-MG5-HL-R': 'photos/mg5-headlight.jpg',
 */
export const PHOTOS: Record<string, string> = {
  // 'CAP-TES-M3-BMP': 'photos/CAP-TES-M3-BMP.jpg',
};
