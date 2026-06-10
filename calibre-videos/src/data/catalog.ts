import { VIDEO } from '../brand/theme';
import { PRODUCTS, type Product } from './products';
import { HOOKS, AUDIENCES, TESTIMONIALS, STORIES, type AudienceKey } from './brandFacts';
import { PART_LABELS, type PartKey } from './parts';
import {
  AD_SPOT_SECONDS,
  UGC_SECONDS,
  STORY_SECONDS,
  CARTOON_SECONDS,
  SHOWCASE_SECONDS,
  PROMO_SECONDS,
  TRUST_SECONDS,
  COMPARISON_SECONDS,
  TESTIMONIAL_SECONDS,
  TIP_SECONDS,
} from './durations';
import type { CarouselSlide } from '../compositions/Carousel';

export type TemplateKey =
  | 'AdSpot'
  | 'UgcReview'
  | 'StoryTime'
  | 'Cartoon'
  | 'PartsShowcase'
  | 'Promo'
  | 'TrustEbay'
  | 'Comparison'
  | 'Testimonial'
  | 'TipCard'
  | 'PhotoAd'
  | 'Carousel';

export type CatalogEntry = {
  id: string;
  template: TemplateKey;
  kind: 'video' | 'still';
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  meta: {
    type: string;
    audience: AudienceKey | 'all';
    series?: string;
    caption: string;
    hashtags: string;
  };
};

const { fps, width, height } = VIDEO;
const STILL_PORTRAIT = { width: 1080, height: 1350 };
const STILL_SQUARE = { width: 1080, height: 1080 };
const f = (sec: number) => Math.max(1, Math.round(sec * fps));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

const TAGS = {
  base: '#carparts #carrepair #ukcars #watford #carpartsuk #autoparts #calibreautoparts',
  flippers: '#carflipping #carflip #flippingcars #catscars #salvagecar #carflipper',
  garages: '#mechanic #garage #carmechanic #trade #bodyshop #cartrade',
  public: '#carmaintenance #carinsurance #cartips #drivinguk #cardamage',
};
const tagsFor = (a: AudienceKey | 'all') =>
  a === 'all' ? `${TAGS.base} ${TAGS.flippers}` : `${TAGS.base} ${TAGS[a]}`;

const audienceCycle: AudienceKey[] = ['flippers', 'garages', 'public'];

const entries: CatalogEntry[] = [];

/* ============================ 1. AD SPOTS ================================= */
// Each product across several scroll-stopping hooks → the workhorse format.
const adHookSet = HOOKS.slice(0, 8);
PRODUCTS.forEach((p, pi) => {
  adHookSet.forEach((hook, hi) => {
    const aud = audienceCycle[(pi + hi) % 3];
    entries.push({
      id: `ad-${slug(p.make)}-${slug(p.part)}-${hi}-${pi}`,
      template: 'AdSpot',
      kind: 'video',
      width,
      height,
      fps,
      durationInFrames: f(AD_SPOT_SECONDS),
      props: { product: p, hook, audienceLine: AUDIENCES[aud].line },
      meta: {
        type: 'Product ad',
        audience: aud,
        caption: `${hook} ${p.name} from ${p.price} (was ${p.was}) at Calibre Auto Parts. ${AUDIENCES[aud].line} 🔧 Shop calibreautoparts.co.uk`,
        hashtags: tagsFor(aud),
      },
    });
  });
});

/* ============================ 2. COMPARISONS ============================= */
const compHooks = ['Dealer price vs Calibre', 'Stop paying dealer prices', 'Same part, half the price'];
PRODUCTS.forEach((p, pi) => {
  compHooks.forEach((hook, hi) => {
    const aud = audienceCycle[(pi + hi) % 3];
    entries.push({
      id: `cmp-${slug(p.make)}-${slug(p.part)}-${pi}-${hi}`,
      template: 'Comparison',
      kind: 'video',
      width,
      height,
      fps,
      durationInFrames: f(COMPARISON_SECONDS),
      props: { product: p, hook },
      meta: {
        type: 'Price comparison',
        audience: aud,
        caption: `${p.name}: main dealer ${p.was} vs Calibre ${p.price}. Why pay more? 👀 calibreautoparts.co.uk`,
        hashtags: tagsFor(aud),
      },
    });
  });
});

/* ============================ 3. UGC REVIEWS ============================= */
const personas = [
  { name: 'Danny', role: 'Car flipper, Essex', aud: 'flippers' as const },
  { name: 'Sarah', role: 'Watford', aud: 'public' as const },
  { name: 'Mike', role: 'Garage owner', aud: 'garages' as const },
  { name: 'Jay', role: 'Project builder', aud: 'flippers' as const },
  { name: 'Leah', role: 'St Albans', aud: 'public' as const },
];
const ugcHooks = [
  'I order ALL my parts from here now',
  'Honest review after 6 months',
  'Cheapest quality parts in the UK?',
  'Why I stopped using main dealers',
];
PRODUCTS.forEach((p, pi) => {
  const persona = personas[pi % personas.length];
  const hook = ugcHooks[pi % ugcHooks.length];
  const quote = TESTIMONIALS[pi % TESTIMONIALS.length].text;
  entries.push({
    id: `ugc-${slug(persona.name)}-${slug(p.part)}-${pi}`,
    template: 'UgcReview',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(UGC_SECONDS),
    props: { reviewerName: persona.name, reviewerRole: persona.role, product: p, quote, hook },
    meta: {
      type: 'UGC review',
      audience: persona.aud,
      caption: `${hook} — got my ${p.name} for ${p.price} 😮 @calibreautoparts #review`,
      hashtags: tagsFor(persona.aud),
    },
  });
});

/* ============================ 4. STORY TIME (multi-part) ================= */
STORIES.forEach((story) => {
  story.parts.forEach((part, idx) => {
    const isLast = idx === story.parts.length - 1;
    entries.push({
      id: `story-${slug(story.id)}-p${idx + 1}`,
      template: 'StoryTime',
      kind: 'video',
      width,
      height,
      fps,
      durationInFrames: f(STORY_SECONDS(part.beats.length, isLast)),
      props: {
        title: story.title,
        partLabel: part.partLabel,
        partIndex: idx,
        totalParts: story.parts.length,
        beats: part.beats,
      },
      meta: {
        type: `Story time (${idx + 1}/${story.parts.length})`,
        audience: story.audience,
        series: story.id,
        caption: `${story.title} — ${part.partLabel} of ${story.parts.length}. ${isLast ? 'Full story now 👇' : 'Follow for the next part 👀'} @calibreautoparts`,
        hashtags: tagsFor(story.audience),
      },
    });
  });
});

/* ============================ 5. CARTOON EXPLAINERS ===================== */
const cartoons: { title: string; scenes: { caption: string; kind: 'mechanic' | 'parts' | 'drive' | 'map'; parts?: PartKey[] }[] }[] = [
  {
    title: 'Meet Calibre Auto Parts',
    scenes: [
      { caption: 'We’re a family-run team in Watford', kind: 'mechanic' },
      { caption: 'We stock body parts for every make', kind: 'parts' },
      { caption: 'At honest, trade-friendly prices', kind: 'parts', parts: ['bumper', 'headlight', 'grille', 'wing', 'mirror', 'tailgate'] },
      { caption: 'Delivered fast, all over the UK', kind: 'drive' },
      { caption: 'Getting your car back on the road', kind: 'map' },
    ],
  },
  {
    title: 'What Calibre stands for',
    scenes: [
      { caption: 'Quality you can trust', kind: 'mechanic' },
      { caption: 'Prices that make sense', kind: 'parts' },
      { caption: 'Service that picks up the phone', kind: 'mechanic' },
      { caption: 'From our family to your driveway', kind: 'drive' },
    ],
  },
  {
    title: 'How ordering works',
    scenes: [
      { caption: 'Find your part on our site', kind: 'parts' },
      { caption: 'Or buy via our trusted eBay store', kind: 'parts' },
      { caption: 'We pack it with care', kind: 'mechanic' },
      { caption: 'Fast UK delivery to your door', kind: 'drive' },
    ],
  },
  {
    title: 'Car flippers love Calibre',
    scenes: [
      { caption: 'Buy salvage. Fix smart.', kind: 'drive' },
      { caption: 'Panels at prices that protect your margin', kind: 'parts' },
      { caption: 'Flip it. Profit. Repeat.', kind: 'mechanic' },
    ],
  },
  {
    title: 'Pranged it? We’ve got you',
    scenes: [
      { caption: 'Bumps and scrapes happen to everyone', kind: 'drive' },
      { caption: 'Send us your reg, we find the part', kind: 'mechanic' },
      { caption: 'Right panel, right colour, right price', kind: 'parts' },
      { caption: 'Back on the road in no time', kind: 'map' },
    ],
  },
  {
    title: 'Trusted on eBay, better on our site',
    scenes: [
      { caption: '100% feedback as evbodyparts', kind: 'mechanic' },
      { caption: 'Same trusted team, same quality', kind: 'parts' },
      { caption: 'Even better prices direct on our website', kind: 'parts', parts: ['headlight', 'bumper', 'wing', 'mirror', 'grille', 'tailgate'] },
      { caption: 'Order direct & save', kind: 'drive' },
    ],
  },
];
cartoons.forEach((c, i) => {
  entries.push({
    id: `cartoon-${slug(c.title)}-${i}`,
    template: 'Cartoon',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(CARTOON_SECONDS(c.scenes.length)),
    props: c,
    meta: {
      type: 'Animated explainer',
      audience: 'all',
      caption: `${c.title} 🚗 Family-run from Watford. Quality car parts at trade prices. calibreautoparts.co.uk`,
      hashtags: tagsFor('all'),
    },
  });
});

/* ============================ 6. PARTS SHOWCASES ======================== */
const categories = Array.from(new Set(PRODUCTS.map((p) => p.part))) as PartKey[];
categories.forEach((cat) => {
  const items = PRODUCTS.filter((p) => p.part === cat).slice(0, 4);
  if (items.length === 0) return;
  entries.push({
    id: `showcase-${slug(cat)}`,
    template: 'PartsShowcase',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(SHOWCASE_SECONDS(items.length)),
    props: { category: cat, headline: `${PART_LABELS[cat]} for every make`, items },
    meta: {
      type: 'Parts showcase',
      audience: 'all',
      caption: `${PART_LABELS[cat]} for every make & budget, from ${items[0].price}. calibreautoparts.co.uk`,
      hashtags: tagsFor('all'),
    },
  });
});

/* ============================ 7. PROMOS ================================= */
const promos = [
  { hook: 'Exclusive TikTok offer', offerTop: '10%', offerBottom: 'OFF', code: 'TIKTOK10', detail: 'Follow + use code at checkout' },
  { hook: 'Trade accounts welcome', offerTop: 'TRADE', offerBottom: 'PRICES', detail: 'Garages — DM us to set up an account' },
  { hook: 'Free UK delivery weekend', offerTop: 'FREE', offerBottom: 'DELIVERY', detail: 'This weekend only — follow for more' },
  { hook: 'New followers get a deal', offerTop: '£10', offerBottom: 'OFF £100', code: 'NEW10', detail: 'Follow @calibreautoparts for the code' },
  { hook: 'Flash sale on bumpers', offerTop: 'FLASH', offerBottom: 'SALE', detail: 'Bumpers reduced — while stocks last' },
  { hook: 'Bundle & save', offerTop: 'SAVE', offerBottom: 'ON BUNDLES', detail: 'Front-end bundles cheaper than one dealer part' },
  { hook: 'Instagram followers only', offerTop: '15%', offerBottom: 'OFF', code: 'INSTA15', detail: 'Follow @calibreautoparts & DM for the code' },
  { hook: 'Headlight sale this week', offerTop: 'LIGHTS', offerBottom: 'FROM £44', detail: 'Headlights & tail lights reduced — follow to shop' },
  { hook: 'Refer a mate', offerTop: '£15', offerBottom: 'EACH', detail: 'You both get £15 off — tag a mate below' },
  { hook: 'Bank holiday blowout', offerTop: 'BANK HOL', offerBottom: 'DEALS', detail: 'Limited-time prices all weekend' },
];
promos.forEach((p, i) => {
  entries.push({
    id: `promo-${slug(p.hook)}-${i}`,
    template: 'Promo',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(PROMO_SECONDS),
    props: p,
    meta: {
      type: 'Offer / promo',
      audience: 'all',
      caption: `${p.hook}! ${p.detail} 🎉 ${p.code ? `Code: ${p.code}. ` : ''}calibreautoparts.co.uk`,
      hashtags: `${tagsFor('all')} #sale #discount #offer`,
    },
  });
});

/* ============================ 8. TRUST / EBAY =========================== */
const trustHooks = [
  'Is Calibre legit? Here’s the proof',
  'Why thousands trust us with their car',
  'Trusted on eBay. Even cheaper on our site',
];
trustHooks.forEach((hook, i) => {
  entries.push({
    id: `trust-${i}`,
    template: 'TrustEbay',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(TRUST_SECONDS),
    props: { feedback: '100%', reviewsLine: 'Thousands of happy UK buyers', hook },
    meta: {
      type: 'Trust / eBay proof',
      audience: 'all',
      caption: `${hook} ✅ 100% eBay feedback as evbodyparts, trading as Calibre Auto Parts. calibreautoparts.co.uk`,
      hashtags: `${tagsFor('all')} #trustedseller #ebay`,
    },
  });
});

/* ============================ 9. TESTIMONIALS ========================== */
TESTIMONIALS.forEach((t, i) => {
  entries.push({
    id: `testi-${slug(t.name)}-${i}`,
    template: 'Testimonial',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(TESTIMONIAL_SECONDS),
    props: { name: t.name, role: t.role, stars: t.stars, text: t.text },
    meta: {
      type: 'Testimonial',
      audience: 'all',
      caption: `⭐️⭐️⭐️⭐️⭐️ "${t.text}" — ${t.name}, ${t.role}. calibreautoparts.co.uk`,
      hashtags: tagsFor('all'),
    },
  });
});

/* ============================ 10. TIP CARDS ============================ */
const tips: { hook: string; tipTitle: string; steps: string[]; part: PartKey }[] = [
  { hook: 'Save money on body damage', tipTitle: 'Buy the panel, not the labour', steps: ['Get your part from Calibre', 'Use a local fitter or DIY', 'Pay a fraction of a dealer repair'], part: 'bumper' },
  { hook: 'Headlight gone foggy?', tipTitle: 'When to replace not restore', steps: ['Cracked or cloudy inside = replace', 'OEM-spec units from Calibre', 'Fitted in under an hour'], part: 'headlight' },
  { hook: 'Buying salvage to flip?', tipTitle: 'Check these 3 panels first', steps: ['Bumper & grille alignment', 'Wing & arch gaps', 'Source replacements at Calibre'], part: 'wing' },
  { hook: 'Know your part fits', tipTitle: 'Match by reg & VIN', steps: ['Send us your reg', 'We confirm exact fitment', 'No guesswork, no returns'], part: 'mirror' },
  { hook: 'Wing mirror smashed?', tipTitle: 'A cheap 10-minute fix', steps: ['Order the exact unit', 'Clip the old one off', 'Plug, fit, done'], part: 'mirror' },
  { hook: 'Cut your repair bill', tipTitle: 'Dealer vs independent', steps: ['Dealers mark up parts hugely', 'Calibre sells the same panels', 'You keep the difference'], part: 'grille' },
  { hook: 'Bumper scuffed not cracked?', tipTitle: 'Repair vs replace', steps: ['Light scuffs can be repaired', 'Cracks or tears = replace it', 'New bumpers from £54 at Calibre'], part: 'bumper' },
  { hook: 'New here? Start with this', tipTitle: 'How to buy from Calibre', steps: ['Browse calibreautoparts.co.uk', 'Or our trusted eBay store', 'Send your reg if unsure — we’ll confirm'], part: 'grille' },
  { hook: 'Stop binning good cars', tipTitle: 'Cat S / Cat N explained', steps: ['Often just cosmetic body damage', 'Source panels cheap from Calibre', 'Repair, sell, profit'], part: 'wing' },
  { hook: 'Alloy kerbed?', tipTitle: 'When to swap a wheel', steps: ['Cracks = unsafe, replace now', 'Refurbished alloys from £135', 'Cheaper than a dealer corner'], part: 'wheel' },
  { hook: 'Foggy or yellow lights?', tipTitle: 'Pass your MOT first time', steps: ['Cloudy lenses can fail MOT', 'Fit fresh OEM-spec units', 'Brighter, safer, MOT-ready'], part: 'headlight' },
  { hook: 'Winter’s coming', tipTitle: 'Check before the cold', steps: ['Cracked grille lets cold in', 'Check radiator & bumper mounts', 'Sort cheap panels at Calibre'], part: 'radiator' },
];
tips.forEach((t, i) => {
  entries.push({
    id: `tip-${slug(t.tipTitle)}-${i}`,
    template: 'TipCard',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(TIP_SECONDS(t.steps.length)),
    props: t,
    meta: {
      type: 'Educational tip',
      audience: 'all',
      caption: `${t.hook} 💡 ${t.tipTitle}. Save this & follow @calibreautoparts for more.`,
      hashtags: `${tagsFor('all')} #cartips #diycar`,
    },
  });
});

/* ============================ 11. PHOTO ADS (stills) =================== */
const photoHeadlines = ['Trade prices', 'Quality you can trust', 'Back on the road for less'];
PRODUCTS.forEach((p, pi) => {
  const theme = pi % 2 === 0 ? 'navy' : 'light';
  const headline = photoHeadlines[pi % photoHeadlines.length];
  entries.push({
    id: `photo-${slug(p.make)}-${slug(p.part)}-${pi}`,
    template: 'PhotoAd',
    kind: 'still',
    ...STILL_PORTRAIT,
    fps,
    durationInFrames: 31, // short clip so stills can be captured at a settled frame
    props: { product: p, headline, theme },
    meta: {
      type: 'Photo ad (still)',
      audience: 'all',
      caption: `${p.name} — ${p.price} (was ${p.was}). ${headline}. calibreautoparts.co.uk`,
      hashtags: tagsFor('all'),
    },
  });
});

/* ============================ 12. CAROUSELS (stills) ================== */
type CarouselDef = { id: string; theme: 'navy' | 'light'; audience: AudienceKey | 'all'; caption: string; slides: CarouselSlide[] };
const carousels: CarouselDef[] = [
  {
    id: 'why-calibre',
    theme: 'navy',
    audience: 'all',
    caption: '5 reasons to choose Calibre Auto Parts 👇 Family-run, Watford. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Why Calibre?', subtitle: '5 reasons we’re the UK’s smart choice for body parts' },
      { kind: 'point', index: 1, title: 'Trade prices', body: 'The same panels as the dealer, for a fraction of the price.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'Family-run', body: 'A proper Watford family business that picks up the phone.' },
      { kind: 'point', index: 3, title: 'Fast UK delivery', body: 'Parts packed with care and out the door quickly.' },
      { kind: 'point', index: 4, title: 'Trusted on eBay', body: '100% feedback as evbodyparts. Buy with confidence.' },
      { kind: 'cta', line: 'Get yours today' },
    ],
  },
  {
    id: 'flipper-guide',
    theme: 'navy',
    audience: 'flippers',
    caption: 'Car flippers: protect your margin 👇 Source panels at Calibre. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Flip smarter', subtitle: 'How flippers cut repair costs with Calibre' },
      { kind: 'point', index: 1, title: 'Buy the damage', body: 'Salvage cars are cheap because of the panels. That’s your opportunity.', part: 'wing' },
      { kind: 'point', index: 2, title: 'Source for less', body: 'Bumpers, wings, lights and grilles at trade prices.', part: 'headlight' },
      { kind: 'point', index: 3, title: 'Keep the margin', body: 'Lower parts cost = bigger profit on every flip.' },
      { kind: 'cta', line: 'Start your next flip' },
    ],
  },
  {
    id: 'garage-trade',
    theme: 'light',
    audience: 'garages',
    caption: 'Garages — open a trade account with Calibre 🔧 calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Trade accounts', subtitle: 'Better prices, faster panels, real service' },
      { kind: 'point', index: 1, title: 'Trade pricing', body: 'Competitive prices on every body panel, every make.', part: 'door' },
      { kind: 'point', index: 2, title: 'Quick turnaround', body: 'Parts in fast so your jobs go out faster.' },
      { kind: 'point', index: 3, title: 'We answer', body: 'A team that actually picks up and sorts it.' },
      { kind: 'cta', line: 'DM us to set up' },
    ],
  },
  {
    id: 'pranged-it',
    theme: 'navy',
    audience: 'public',
    caption: 'Had a prang? Don’t panic 👇 calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Pranged it?', subtitle: 'Get back on the road for less' },
      { kind: 'point', index: 1, title: 'Send your reg', body: 'We confirm the exact part for your car.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'Pay panel price', body: 'A fraction of a main-dealer repair bill.' },
      { kind: 'point', index: 3, title: 'Fit it', body: 'DIY or a local fitter — sorted in no time.' },
      { kind: 'offer', top: 'SAVE', bottom: 'VS DEALER', detail: 'Often hundreds cheaper than the quote' },
      { kind: 'cta', line: 'Sort it today' },
    ],
  },
  {
    id: 'ebay-to-site',
    theme: 'navy',
    audience: 'all',
    caption: 'You found us on eBay? Here’s why our website is even better 👇 calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'eBay ✓ Website ✓✓', subtitle: 'Trusted on eBay. Even better direct.' },
      { kind: 'point', index: 1, title: '100% feedback', body: 'We’re evbodyparts on eBay — trading as Calibre Auto Parts.' },
      { kind: 'point', index: 2, title: 'Bigger range', body: 'The full catalogue lives on our website.', part: 'tailgate' },
      { kind: 'point', index: 3, title: 'Better prices', body: 'Buy direct and skip the marketplace fees.' },
      { kind: 'cta', line: 'Shop direct & save' },
    ],
  },
  {
    id: 'parts-we-stock',
    theme: 'light',
    audience: 'all',
    caption: 'Just some of what we stock 👇 Every panel, every make. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'What we stock', subtitle: 'Body parts for every make & budget' },
      { kind: 'point', index: 1, title: 'Bumpers & wings', body: 'Fronts, rears, arches — from £54.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'Lights', body: 'Headlights & tail lights, OEM-spec.', part: 'headlight' },
      { kind: 'point', index: 3, title: 'Panels & doors', body: 'Bonnets, tailgates, doors, mirrors.', part: 'door' },
      { kind: 'point', index: 4, title: 'Grilles & trim', body: 'Finish the look for less.', part: 'grille' },
      { kind: 'cta', line: 'Find your part' },
    ],
  },
];
carousels.forEach((c) => {
  c.slides.forEach((slide, idx) => {
    entries.push({
      id: `carousel-${slug(c.id)}-s${idx + 1}`,
      template: 'Carousel',
      kind: 'still',
      ...STILL_SQUARE,
      fps,
      durationInFrames: 31, // short clip so stills can be captured at a settled frame
      props: { slide, theme: c.theme },
      meta: {
        type: `Carousel slide (${idx + 1}/${c.slides.length})`,
        audience: c.audience,
        series: c.id,
        caption: idx === 0 ? c.caption : `${c.caption} (slide ${idx + 1})`,
        hashtags: tagsFor(c.audience),
      },
    });
  });
});

// Fail fast if any id collides — every entry must be a unique composition.
const seenIds = new Set<string>();
for (const e of entries) {
  if (seenIds.has(e.id)) throw new Error(`Duplicate catalog id: ${e.id}`);
  seenIds.add(e.id);
}

export const CATALOG: CatalogEntry[] = entries;

export const CATALOG_SUMMARY = CATALOG.reduce<Record<string, number>>((acc, e) => {
  acc[e.template] = (acc[e.template] || 0) + 1;
  return acc;
}, {});
