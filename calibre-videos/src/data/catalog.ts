import { VIDEO } from '../brand/theme';
import { PRODUCTS, type Product } from './products';
import { HOOKS, AUDIENCES, REVIEWS, STORIES, type AudienceKey } from './brandFacts';
import { PART_LABELS, type PartKey } from './parts';
import { VOICEOVER_DIR } from './config';
import { VOICEOVER_IDS } from './voiceovers';
import { PHOTOS } from './photos';
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
  base: '#evparts #carparts #tesla #mgmotor #byd #ukcars #watford #calibreautoparts #electriccar #hybrid',
  flippers: '#carflipping #carflip #flippingcars #catscars #salvagecar #evflip',
  garages: '#mechanic #garage #evrepair #bodyshop #cartrade #evgarage',
  public: '#carmaintenance #carinsurance #cartips #evlife #cardamage',
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
        caption: `${hook} Exact-fit ${p.name} at Calibre Auto Parts. ${AUDIENCES[aud].line} 🔧 Shop calibreautoparts.co.uk`,
        hashtags: tagsFor(aud),
      },
    });
  });
});

/* ============================ 2. COMPARISONS ============================= */
const compHooks = ['Main dealer vs Calibre', 'Why we beat the main dealer', 'Dealer vs Calibre — who wins?'];
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
        type: 'Dealer comparison',
        audience: aud,
        caption: `${p.name}: main dealer vs Calibre — exact fit, same-day dispatch and aftermarket doors no one else stocks. 👀 calibreautoparts.co.uk`,
        hashtags: tagsFor(aud),
      },
    });
  });
});

/* ============================ 3. UGC REVIEWS ============================= */
// Driven ENTIRELY by real, approved reviews (brandFacts → REVIEWS). That list
// is empty until genuine reviews are signed off, so no fabricated UGC ships.
const ugcHooks = [
  'I order all my parts from here now',
  'Honest review',
  'Why I stopped using main dealers',
  'Exact-fit, every time',
];
REVIEWS.forEach((r, ri) => {
  const p = PRODUCTS[ri % PRODUCTS.length];
  const hook = ugcHooks[ri % ugcHooks.length];
  const aud = audienceCycle[ri % 3];
  entries.push({
    id: `ugc-${slug(r.name)}-${ri}`,
    template: 'UgcReview',
    kind: 'video',
    width,
    height,
    fps,
    durationInFrames: f(UGC_SECONDS),
    props: { reviewerName: r.name, reviewerRole: r.role, product: p, quote: r.text, hook },
    meta: {
      type: 'UGC review',
      audience: aud,
      caption: `${hook} — ${r.name} on Calibre Auto Parts. @calibreautoparts #review`,
      hashtags: tagsFor(aud),
    },
  });
});

/* ============================ 4. STORY TIME (multi-part) ================= */
STORIES.forEach((story) => {
  story.parts.forEach((part, idx) => {
    const isLast = idx === story.parts.length - 1;
    const id = `story-${slug(story.id)}-p${idx + 1}`;
    // Narration plays only when the audio file has actually been generated
    // (see scripts/gen-voiceover.ts → src/data/voiceovers.ts). No file → silent.
    const voiceover = VOICEOVER_IDS.includes(id) ? `${VOICEOVER_DIR}/${id}.mp3` : undefined;
    entries.push({
      id,
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
        voiceover,
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
      { caption: 'Exact-fit parts for EVs & modern cars', kind: 'parts' },
      { caption: 'Tesla · MG · BYD · Honda · Toyota', kind: 'parts', parts: ['bumper', 'headlight', 'wing', 'mirror', 'bonnet', 'taillight'] },
      { caption: 'Free delivery over £25, dispatched same day', kind: 'drive' },
      { caption: 'Getting your car back on the road', kind: 'map' },
    ],
  },
  {
    title: 'What Calibre stands for',
    scenes: [
      { caption: 'Exact-fit you can trust', kind: 'mechanic' },
      { caption: 'Prices that make sense', kind: 'parts' },
      { caption: 'Service that picks up the phone', kind: 'mechanic' },
      { caption: 'From our family to your driveway', kind: 'drive' },
    ],
  },
  {
    title: 'How ordering works',
    scenes: [
      { caption: 'Pick your make & model on our site', kind: 'parts' },
      { caption: 'Or buy via our trusted eBay store', kind: 'parts' },
      { caption: 'Order before 12pm — dispatched same day', kind: 'mechanic' },
      { caption: 'Free UK delivery over £25', kind: 'drive' },
    ],
  },
  {
    title: 'EV flippers love Calibre',
    scenes: [
      { caption: 'Buy salvage. Fix smart.', kind: 'drive' },
      { caption: 'Exact-fit panels that protect your margin', kind: 'parts' },
      { caption: 'Flip it. Profit. Repeat.', kind: 'mechanic' },
    ],
  },
  {
    title: 'Pranged it? We’ve got you',
    scenes: [
      { caption: 'Bumps and scrapes happen to everyone', kind: 'drive' },
      { caption: 'Tell us your make & model, we find the part', kind: 'mechanic' },
      { caption: 'Exact fit, right price, dispatched fast', kind: 'parts' },
      { caption: 'Back on the road in no time', kind: 'map' },
    ],
  },
  {
    title: 'Trusted on eBay, better on our site',
    scenes: [
      { caption: '100% feedback as evbodyparts', kind: 'mechanic' },
      { caption: 'Same trusted team, exact-fit quality', kind: 'parts' },
      { caption: 'Even better prices direct on our website', kind: 'parts', parts: ['headlight', 'bumper', 'wing', 'mirror', 'bonnet', 'taillight'] },
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
    props: { category: cat, headline: `Exact-fit ${PART_LABELS[cat]}`, items },
    meta: {
      type: 'Parts showcase',
      audience: 'all',
      caption: `Exact-fit ${PART_LABELS[cat]} for Tesla, MG, BYD, Honda & Toyota. calibreautoparts.co.uk`,
      hashtags: tagsFor('all'),
    },
  });
});

/* ============================ 7. PROMOS ================================= */
// NOTE: percentage codes & policy offers only — no £ price figures, so these
// stay valid through the pending listing price update.
const promos = [
  { hook: 'Exclusive TikTok offer', offerTop: '10%', offerBottom: 'OFF', code: 'TIKTOK10', detail: 'Follow + use code at checkout' },
  { hook: 'Trade accounts welcome', offerTop: 'TRADE', offerBottom: 'ACCOUNTS', detail: 'Garages — DM us to set up an account' },
  { hook: 'Free UK delivery weekend', offerTop: 'FREE', offerBottom: 'DELIVERY', detail: 'This weekend only — follow for more' },
  { hook: 'New followers get a deal', offerTop: '10%', offerBottom: 'OFF', code: 'NEW10', detail: 'First order — follow @calibreautoparts for the code' },
  { hook: 'Flash sale on bumpers', offerTop: 'FLASH', offerBottom: 'SALE', detail: 'Bumpers reduced — while stocks last' },
  { hook: 'Doors no one else does', offerTop: 'AFTERMARKET', offerBottom: 'DOORS', detail: 'Dealers only sell brand-new — we don’t' },
  { hook: 'Instagram followers only', offerTop: '15%', offerBottom: 'OFF', code: 'INSTA15', detail: 'Follow @calibreautoparts & DM for the code' },
  { hook: 'Headlight sale this week', offerTop: 'LIGHTS', offerBottom: 'SALE', detail: 'Headlights & tail lights reduced — follow to shop' },
  { hook: 'Refer a mate', offerTop: 'REFER', offerBottom: 'A MATE', detail: 'You both get a deal — tag a mate below' },
  { hook: 'Bank holiday blowout', offerTop: 'BANK HOL', offerBottom: 'DEALS', detail: 'Limited-time offers all weekend' },
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
// Real, approved reviews only (brandFacts → REVIEWS). Empty list → no cards.
REVIEWS.forEach((t, i) => {
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
  { hook: 'Bumper scuffed not cracked?', tipTitle: 'Repair vs replace', steps: ['Light scuffs can be repaired', 'Cracks or tears = replace it', 'Exact-fit bumpers ready to ship'], part: 'bumper' },
  { hook: 'Damaged door?', tipTitle: 'You don’t need a dealer', steps: ['Dealers only sell brand-new doors', 'We do aftermarket exact-fit doors', 'A fraction of the dealer route'], part: 'door' },
  { hook: 'New here? Start with this', tipTitle: 'How to buy from Calibre', steps: ['Browse calibreautoparts.co.uk', 'Or our trusted eBay store', 'Send your reg if unsure — we’ll confirm'], part: 'grille' },
  { hook: 'Stop binning good EVs', tipTitle: 'Cat S / Cat N explained', steps: ['Often just cosmetic body damage', 'Source exact-fit panels from Calibre', 'Repair, sell, profit'], part: 'wing' },
  { hook: 'Buying an EV part?', tipTitle: 'Always check exact fit', steps: ['EV trims change year to year', 'Send your make, model & year', 'We confirm the exact part — no guesswork'], part: 'bumper' },
  { hook: 'Foggy or yellow lights?', tipTitle: 'Pass your MOT first time', steps: ['Cloudy lenses can fail MOT', 'Fit fresh exact-fit LED units', 'Brighter, safer, MOT-ready'], part: 'headlight' },
  { hook: 'New EV, dear repairs?', tipTitle: 'Skip the main-dealer markup', steps: ['Dealers charge a fortune for panels', 'Calibre does the exact-fit part for less', 'Same-day dispatch before 12pm'], part: 'taillight' },
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
const photoHeadlines = ['Exact-fit quality', 'Quality you can trust', 'Back on the road'];
PRODUCTS.forEach((p, pi) => {
  const theme = pi % 2 === 0 ? 'navy' : 'light';
  const headline = photoHeadlines[pi % photoHeadlines.length];
  // Use a real product photo if one has been supplied for this SKU; otherwise
  // the template falls back to the branded illustration (see data/photos.ts).
  const photoSrc = PHOTOS[p.sku];
  entries.push({
    id: `photo-${slug(p.make)}-${slug(p.part)}-${pi}`,
    template: 'PhotoAd',
    kind: 'still',
    ...STILL_PORTRAIT,
    fps,
    durationInFrames: 31, // short clip so stills can be captured at a settled frame
    props: { product: p, headline, theme, photoSrc },
    meta: {
      type: 'Photo ad (still)',
      audience: 'all',
      caption: `${p.name} — ${p.fitment}. ${headline}. calibreautoparts.co.uk`,
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
    caption: 'Why choose Calibre Auto Parts 👇 Family-run, Watford. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Why Calibre?', subtitle: 'The UK’s smart choice for EV & modern car parts' },
      { kind: 'point', index: 1, title: 'Exact fit', body: 'Sourced for your exact make & model — Tesla, MG, BYD, Honda, Toyota.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'Aftermarket doors', body: 'Exact-fit doors no one else offers — dealers only sell brand-new.', part: 'door' },
      { kind: 'point', index: 3, title: 'Family-run', body: 'A proper Watford family business that picks up the phone.' },
      { kind: 'point', index: 4, title: 'Same-day dispatch', body: 'Order before 12pm. Free UK delivery over £25.' },
      { kind: 'point', index: 5, title: 'Trusted on eBay', body: '100% feedback as evbodyparts. Buy with confidence.' },
      { kind: 'cta', line: 'Get yours today' },
    ],
  },
  {
    id: 'flipper-guide',
    theme: 'navy',
    audience: 'flippers',
    caption: 'EV flippers: protect your margin 👇 Exact-fit panels at Calibre. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Flip smarter', subtitle: 'How EV & hybrid flippers cut repair costs' },
      { kind: 'point', index: 1, title: 'Buy the damage', body: 'Salvage EVs are cheap because of the panels. That’s your opportunity.', part: 'wing' },
      { kind: 'point', index: 2, title: 'Source exact-fit', body: 'Bumpers, wings & LED lights for Tesla, MG, BYD & more.', part: 'headlight' },
      { kind: 'point', index: 3, title: 'Keep the margin', body: 'Lower parts cost = bigger profit on every flip.' },
      { kind: 'cta', line: 'Start your next flip' },
    ],
  },
  {
    id: 'garage-trade',
    theme: 'light',
    audience: 'garages',
    caption: 'Garages — open a trade account with Calibre 🔧 EV & hybrid specialists. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'Trade accounts', subtitle: 'Exact-fit EV parts, faster panels, real service' },
      { kind: 'point', index: 1, title: 'Exact-fit pricing', body: 'Competitive prices on EV & modern panels — Tesla, MG, BYD & more.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'Same-day dispatch', body: 'Order before 12pm so your jobs go out faster.' },
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
    caption: 'Just some of what we stock 👇 Exact-fit for Tesla, MG, BYD, Honda & Toyota. calibreautoparts.co.uk',
    slides: [
      { kind: 'cover', title: 'What we stock', subtitle: 'Exact-fit parts for EVs & modern cars' },
      { kind: 'point', index: 1, title: 'Bumpers & wings', body: 'Fronts, rears & wings, exact-fit for your model.', part: 'bumper' },
      { kind: 'point', index: 2, title: 'LED lights', body: 'Headlights & tail lights, exact-fit.', part: 'headlight' },
      { kind: 'point', index: 3, title: 'Aftermarket doors', body: 'Doors no one else does — dealers only sell brand-new.', part: 'door' },
      { kind: 'point', index: 4, title: 'Bonnets & mirrors', body: 'Bonnets, wings & wing mirrors for your model.', part: 'bonnet' },
      { kind: 'point', index: 5, title: 'Tesla · MG · BYD', body: 'Honda & Toyota too — pick your make & model.', part: 'mirror' },
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
