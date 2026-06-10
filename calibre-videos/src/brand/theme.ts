/**
 * Calibre Auto Parts — Brand Kit
 *
 * Colours sampled directly from the official company logo (logo-calibre.png):
 *   - Primary navy  : dominant cluster (34,68,119)  -> #223E78
 *   - Accent red    : dominant cluster (221,34,17)   -> #D62828
 *
 * Used across every composition so all output is on-brand and consistent.
 */

export const COLORS = {
  navy: '#223E78', // primary brand navy (from logo lettering)
  navyDeep: '#16294F', // darker navy for gradients / backgrounds
  navyInk: '#0E1B36', // near-black navy for deep backgrounds
  red: '#D62828', // brand red (from logo underline)
  redBright: '#EF2B2B', // punchier red for highlights / CTAs
  white: '#FFFFFF',
  offWhite: '#F4F6FB',
  silver: '#C7D0E2', // cool light grey-blue (auto / metal feel)
  steel: '#8893AE',
  gold: '#F2B705', // sparing accent for "deal"/star ratings
  green: '#1FA463', // trust / in-stock / success
  ink: '#0B1220',
} as const;

export const GRADIENTS = {
  navy: `linear-gradient(160deg, ${COLORS.navy} 0%, ${COLORS.navyDeep} 55%, ${COLORS.navyInk} 100%)`,
  navySoft: `linear-gradient(180deg, ${COLORS.navyDeep} 0%, ${COLORS.navyInk} 100%)`,
  red: `linear-gradient(160deg, ${COLORS.redBright} 0%, ${COLORS.red} 100%)`,
  light: `linear-gradient(180deg, ${COLORS.white} 0%, ${COLORS.offWhite} 100%)`,
  spotlight: `radial-gradient(circle at 50% 38%, ${COLORS.navy} 0%, ${COLORS.navyDeep} 45%, ${COLORS.navyInk} 100%)`,
} as const;

export const FONTS = {
  // Heavy condensed-ish display for headlines (matches bold logo lettering)
  display: '"Anton", "Arial Narrow", sans-serif',
  // Clean strong body / UI font
  body: '"Montserrat", system-ui, sans-serif',
} as const;

export const BRAND = {
  name: 'Calibre Auto Parts',
  shortName: 'Calibre',
  website: 'www.calibreautoparts.co.uk',
  ebay: 'Calibre Auto Parts on eBay',
  tiktok: '@calibreautoparts',
  instagram: '@calibreautoparts',
  location: 'Watford',
  tagline: 'Quality Car Parts. Trade Prices.',
  family: 'Family-run, Watford',
} as const;

// Vertical social video canvas (TikTok / Reels)
export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
} as const;
