/** Reusable, on-message copy blocks shared across templates. */

export const BENEFITS = [
  'Exact-fit for your make & model',
  'EV, hybrid & modern vehicle specialists',
  'Family-run from Watford',
  'Free UK delivery over £25',
  'Same-day dispatch before 12pm',
  'Trusted eBay seller',
];

export const AUDIENCES = {
  flippers: {
    key: 'flippers',
    label: 'Car flippers',
    line: 'Flipping an EV or hybrid? Exact-fit panels, margin-friendly prices.',
  },
  garages: {
    key: 'garages',
    label: 'Garages & trade',
    line: 'EV & hybrid repairs? Exact-fit parts, dispatched same day.',
  },
  public: {
    key: 'public',
    label: 'General public',
    line: 'Pranged your EV? We’ll get you back on the road for less.',
  },
} as const;

export type AudienceKey = keyof typeof AUDIENCES;

/** Short hooks that stop the scroll (first 1.5s). */
export const HOOKS = [
  'Stop overpaying for EV parts.',
  'Your dealer is robbing you.',
  'Tesla repair quote made you cry?',
  'MG owners — you NEED this.',
  'EV parts without the dealer price.',
  'POV: you found exact-fit parts.',
  'Pranged it? Don’t panic.',
  'This is why your EV repair bill is mad.',
  'I stopped using main dealers. Here’s why.',
  'Exact-fit parts shouldn’t cost a fortune.',
  'Watford’s best-kept EV parts secret.',
  'Before you pay that quote… watch this.',
];

export const TESTIMONIALS = [
  { name: 'Danny', role: 'EV flipper, Essex', stars: 5, text: 'Bought 4 Tesla bumpers off Calibre this month. Exact fit every time and the price means I actually make money on the flip.' },
  { name: 'Sarah', role: 'Watford', stars: 5, text: 'Reversed my MG ZS into a post 🙈 Calibre had the exact bumper, dispatched same day. Half what the garage quoted.' },
  { name: 'Mike’s Motors', role: 'Independent garage', stars: 5, text: 'We do a lot of EV work now. Calibre’s exact-fit panels turn up fast and they actually pick up the phone.' },
  { name: 'Jay', role: 'Tesla project builder', stars: 5, text: 'Did my whole Model 3 front end — bumper and both headlights. Came to less than one dealer headlight. Mad.' },
  { name: 'Priya', role: 'Hemel Hempstead', stars: 5, text: 'Dreading the cost after the prang on my MG4. These were honest, quick and so much cheaper. Car looks new again.' },
  { name: 'Tom', role: 'Weekend flipper', stars: 5, text: 'Found them on eBay, 100% feedback, then realised they’ve got a full website for EVs. Now it’s my first stop.' },
  { name: 'Leah', role: 'St Albans', stars: 5, text: 'Wing mirror gone on my Tesla. Ordered 9pm, dispatched next morning, fitted by the weekend. Brilliant.' },
  { name: 'Karl', role: 'Body shop, Luton', stars: 5, text: 'Exact-fit BYD and MG panels turn up straight and on time. We just fit and move on. Saves us hours.' },
  { name: 'Aisha', role: 'Watford', stars: 5, text: 'Local, friendly and honest. Matched the exact part for my Toyota Corolla and sorted me out same day.' },
  { name: 'Connor', role: 'First-time EV flipper', stars: 5, text: 'Did my first flip — a Cat S MG4 — thanks to these. Walked me through the panels I needed. Made £600 clear.' },
  { name: 'Megan', role: 'Hertford', stars: 5, text: 'Exact-fit Honda Jazz headlight, perfect match. You can’t even tell it was ever damaged.' },
  { name: 'Sandra', role: 'Borehamwood', stars: 5, text: 'Quoted a fortune by the dealer for my Yaris. Calibre was a third of the price and dispatched same day. Unreal.' },
];

/** Multi-part "story time" scripts (EV/modern car flipping / stumble-across-Calibre). */
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
          { text: 'Tesla dealer quote? Over £1,900.' },
          { text: 'Calibre? £790 the lot — exact fit.', emphasis: '£790' },
          { text: 'Dispatched same day to my unit.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Fitted it over a weekend.' },
          { text: 'Sold the car for £21,000.' },
          { text: 'That’s the flip. That’s the margin.', emphasis: 'margin' },
          { text: 'Calibre is now my first call. Every time.' },
        ],
      },
    ],
  },
  {
    id: 'stumble-watford',
    title: 'How I stumbled across Calibre',
    audience: 'public',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Someone reversed into my MG ZS in Tesco.' },
          { text: 'Bumper hanging off. Gutted.' },
          { text: 'Garage wanted £680 to sort it.', emphasis: '£680' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'My mate said "try Calibre, they’re Watford lads".' },
          { text: 'Family-run. Picked up first ring.' },
          { text: 'Exact-fit bumper for my model.', emphasis: 'exact-fit' },
          { text: 'Was £139, dispatched same day.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Local fitter put it on for £80.' },
          { text: '£680 quote became £220 all in.', emphasis: '£220' },
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
          { text: 'Then we opened an account with Calibre.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Exact-fit parts for Tesla, MG & BYD.' },
          { text: 'Dispatched same day — jobs out faster.', emphasis: 'same day' },
          { text: 'And they actually answer the phone.' },
        ],
      },
    ],
  },
  {
    id: 'flip-mg4',
    title: 'The £600 MG4 flip',
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
          { text: 'Calibre: wing £89, LED headlight £159.' },
          { text: 'Exact fit, dispatched same day.', emphasis: 'same day' },
          { text: 'A weekend of graft and it was mint.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'In cheap, out the door for a tidy profit.' },
          { text: 'That’s £600+ clear after parts.', emphasis: '£600+' },
          { text: 'Calibre makes the maths work.' },
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
          { text: 'Main dealer wanted £300 fitted.', emphasis: '£300' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Found Calibre — exact-fit mirror £119.' },
          { text: 'Watched a 10-minute video, clipped it on.' },
          { text: 'Saved over £150. Buzzing.', emphasis: '£150' },
        ],
      },
    ],
  },
];
