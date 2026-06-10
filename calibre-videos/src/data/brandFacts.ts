/** Reusable, on-message copy blocks shared across templates. */

export const BENEFITS = [
  'Exact-fit for your make & model',
  'EV, hybrid & modern-car specialists',
  'The only aftermarket supplier that does doors',
  'Tesla · MG · BYD · Honda · Toyota',
  'Family-run from Watford',
  'Free UK delivery over £25',
  'Same-day dispatch before 12pm',
  'Trusted eBay seller',
];

export const AUDIENCES = {
  flippers: {
    key: 'flippers',
    label: 'Car flippers',
    line: 'Flipping an EV or hybrid? Exact-fit panels — and the only aftermarket doors.',
  },
  garages: {
    key: 'garages',
    label: 'Garages & trade',
    line: 'EV, hybrid & modern repairs? Exact-fit parts dispatched same day.',
  },
  public: {
    key: 'public',
    label: 'General public',
    line: 'Pranged your car? Exact-fit parts to get you back on the road.',
  },
} as const;

export type AudienceKey = keyof typeof AUDIENCES;

/** Short hooks that stop the scroll (first 1.5s). Brand-broad, no price figures. */
export const HOOKS = [
  'Stop overpaying your main dealer.',
  'MG, BYD or Tesla? We’ve got your panels.',
  'BYD owners — exact-fit parts at last.',
  'MG drivers, this one’s for you.',
  'Need a door? We’re the only aftermarket supplier that does them.',
  'Exact-fit EV & hybrid parts, sorted.',
  'POV: you found exact-fit parts.',
  'Pranged it? Don’t panic.',
  'Aftermarket doors no other supplier does.',
  'Exact-fit panels for modern cars.',
  'Watford’s best-kept car-parts secret.',
  'Before you pay that dealer quote… watch this.',
];

/**
 * REAL customer reviews ONLY. These must be genuine, verbatim quotes from the
 * correct Calibre Auto Parts (Watford) on Trustpilot / eBay / Google, added
 * only after sign-off. Intentionally EMPTY — no fabricated reviews ship. Until
 * this is populated, the Testimonial and UGC-review formats render nothing.
 */
export type Review = { name: string; role: string; stars: number; text: string };
export const REVIEWS: Review[] = [];

/** Multi-part "story time" scripts (EV/modern car flipping / stumble-across-Calibre Auto Parts). */
export type StoryBeat = { text: string; emphasis?: string };
export type Story = {
  id: string;
  title: string;
  parts: { partLabel: string; beats: StoryBeat[] }[];
  audience: keyof typeof AUDIENCES;
};

export const STORIES: Story[] = [
  {
    id: 'flip-tesla',
    title: 'I flipped a crashed Tesla',
    audience: 'flippers',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'I bought a Cat S Model 3 for £14,500.' },
          { text: 'Front end was wrecked.', emphasis: 'wrecked' },
          { text: 'Everyone said I was mad.' },
          { text: 'Then I found Calibre Auto Parts…' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Front bumper and both LED headlights.' },
          { text: 'Tesla main-dealer quote? Eye-watering.' },
          { text: 'Calibre Auto Parts had the lot — exact fit, far less.', emphasis: 'exact fit' },
          { text: 'Dispatched same day to my unit.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Fitted it over a weekend.' },
          { text: 'Sold the car for £21,000.' },
          { text: 'That’s the flip. That’s the margin.', emphasis: 'margin' },
          { text: 'Calibre Auto Parts is now my first call. Every time.' },
        ],
      },
    ],
  },
  {
    id: 'stumble-watford',
    title: 'How I stumbled across Calibre Auto Parts',
    audience: 'public',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Someone reversed into my MG ZS in Tesco.' },
          { text: 'Bumper hanging off. Gutted.' },
          { text: 'Garage wanted a fortune to sort it.', emphasis: 'fortune' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'My mate said "try Calibre Auto Parts, they’re Watford lads".' },
          { text: 'Family-run. Picked up first ring.' },
          { text: 'Exact-fit bumper for my model.', emphasis: 'exact-fit' },
          { text: 'Sorted me out, dispatched same day.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Local fitter clipped it on for me.' },
          { text: 'Cost me a fraction of the quote.', emphasis: 'fraction' },
          { text: 'Car looks mint again.' },
          { text: 'Wish I’d found them sooner.' },
        ],
      },
    ],
  },
  {
    id: 'garage-trade',
    title: 'Why our garage switched suppliers',
    audience: 'garages',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'We took on more EV and hybrid work.' },
          { text: 'Our old supplier kept sending wrong panels.' },
          { text: 'Then we opened an account with Calibre Auto Parts.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Exact-fit parts for Tesla, MG & BYD.' },
          { text: 'The only aftermarket lot that does doors.', emphasis: 'doors' },
          { text: 'Dispatched same day — jobs out faster.', emphasis: 'same day' },
          { text: 'And they actually answer the phone.' },
        ],
      },
    ],
  },
  {
    id: 'flip-mg4',
    title: 'The MG4 flip',
    audience: 'flippers',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Picked up a damaged MG4 dirt cheap.' },
          { text: 'Front wing creased, headlight smashed.' },
          { text: 'Most people would’ve walked away.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Calibre Auto Parts: exact-fit wing and LED headlight.' },
          { text: 'Exact fit, dispatched same day.', emphasis: 'same day' },
          { text: 'A weekend of graft and it was mint.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'In cheap, out the door for a tidy profit.' },
          { text: 'Clear profit after parts.', emphasis: 'profit' },
          { text: 'Calibre Auto Parts makes the maths work.' },
        ],
      },
    ],
  },
  {
    id: 'school-run',
    title: 'The school-run prang',
    audience: 'public',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Clipped a bollard dropping the kids off.' },
          { text: 'Wing mirror hanging by the wires.' },
          { text: 'Main dealer wanted a fortune fitted.', emphasis: 'fortune' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Found Calibre Auto Parts — exact-fit mirror, sorted.' },
          { text: 'Watched a 10-minute video, clipped it on.' },
          { text: 'Saved a packet. Buzzing.', emphasis: 'packet' },
        ],
      },
    ],
  },
];
