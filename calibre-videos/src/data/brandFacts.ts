/** Reusable, on-message copy blocks shared across templates. */

export const BENEFITS = [
  'Quality parts, trade prices',
  'Family-run from Watford',
  'Fast UK delivery',
  'Trusted eBay seller',
  'Parts for every budget',
  'Get your car back on the road',
];

export const AUDIENCES = {
  flippers: {
    key: 'flippers',
    label: 'Car flippers',
    line: 'Flipping a car? Smash your margins, not your budget.',
  },
  garages: {
    key: 'garages',
    label: 'Garages & trade',
    line: 'Trade account? Trade prices on every panel.',
  },
  public: {
    key: 'public',
    label: 'General public',
    line: 'Pranged the car? We’ll get you back on the road for less.',
  },
} as const;

export type AudienceKey = keyof typeof AUDIENCES;

/** Short hooks that stop the scroll (first 1.5s). */
export const HOOKS = [
  'Stop overpaying for car parts.',
  'Your dealer is robbing you.',
  'POV: you found cheap quality parts.',
  'Car flippers — you NEED this.',
  'How I fixed my car for half price.',
  'Garages are keeping this a secret.',
  'Pranged it? Don’t panic.',
  'This is why your repair bill is mad.',
  'I stopped using main dealers. Here’s why.',
  'Quality parts shouldn’t cost a fortune.',
  'Watford’s best-kept car parts secret.',
  'Before you pay that quote… watch this.',
];

export const TESTIMONIALS = [
  { name: 'Danny', role: 'Car flipper, Essex', stars: 5, text: 'Bought 6 bumpers off Calibre this month. Quality’s spot on and the price means I actually make money on the flip.' },
  { name: 'Sarah', role: 'Watford', stars: 5, text: 'Reversed into a post 🙈 Calibre sorted me a new wing next day. Half what the garage quoted.' },
  { name: 'Mike’s Motors', role: 'Independent garage', stars: 5, text: 'Trade account with these guys is a no-brainer. Panels turn up fast and they actually pick up the phone.' },
  { name: 'Jay', role: 'Project builder', stars: 5, text: 'Did my whole front end — bumper, grille, headlights. Came to less than one dealer headlight. Mad.' },
  { name: 'Priya', role: 'Hemel Hempstead', stars: 5, text: 'Was dreading the cost after the prang. These were honest, quick and so much cheaper. Car looks new again.' },
  { name: 'Tom', role: 'Weekend flipper', stars: 5, text: 'Found them on eBay, 100% feedback, then realised they’ve got a full website. Now it’s my first stop every time.' },
  { name: 'Recovery Ray', role: 'Trade', stars: 5, text: 'Family-run, proper old-school service. They sort me parts other suppliers say are "discontinued".' },
  { name: 'Leah', role: 'St Albans', stars: 5, text: 'Wing mirror smashed on the school run. Ordered 9pm, fitted by the weekend. Brilliant.' },
  { name: 'Karl', role: 'Body shop, Luton', stars: 5, text: 'Panels turn up straight and on time. Saves us hammering out repairs — we just fit and move on.' },
  { name: 'Aisha', role: 'Watford', stars: 5, text: 'Local, friendly and honest. They could see I was worried about the cost and genuinely sorted me out.' },
  { name: 'Big Dave', role: 'Trade buyer', stars: 5, text: 'Been buying off them for over a year. Never had a wrong part. That’s rare in this game.' },
  { name: 'Connor', role: 'First-time flipper', stars: 5, text: 'Did my first flip thanks to these. Walked me through what panels I needed. Made £600 clear.' },
  { name: 'Megan', role: 'Hertford', stars: 5, text: 'Colour-coded bumper matched perfectly. You can’t even tell it was ever damaged.' },
  { name: 'Sandra', role: 'Borehamwood', stars: 5, text: 'Was quoted a fortune elsewhere. Calibre was a third of the price and delivered next day. Unreal.' },
];

/** Multi-part "story time" scripts (car-flipping / stumble-across-Calibre). */
export type StoryBeat = { text: string; emphasis?: string };
export type Story = {
  id: string;
  title: string;
  parts: { partLabel: string; beats: StoryBeat[] }[];
  audience: keyof typeof AUDIENCES;
};

export const STORIES: Story[] = [
  {
    id: 'flip-bmw',
    title: 'I flipped a crashed BMW',
    audience: 'flippers',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'I bought a Cat S 3 Series for £4,200.' },
          { text: 'Front end was wrecked.', emphasis: 'wrecked' },
          { text: 'Everyone said I was mad.' },
          { text: 'Then I found Calibre Auto Parts…' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Bumper, both headlights, a wing and a grille.' },
          { text: 'Dealer quote? Over £1,900.' },
          { text: 'Calibre? £540 the lot.', emphasis: '£540' },
          { text: 'Next-day delivery to my unit.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Fitted it over a weekend.' },
          { text: 'Sold the car for £8,750.' },
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
          { text: 'Someone reversed into my Golf in Tesco.' },
          { text: 'Bumper hanging off. Gutted.' },
          { text: 'Garage wanted £680 to sort it.', emphasis: '£680' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'My mate said "try Calibre, they’re Watford lads".' },
          { text: 'Family-run. Picked up first ring.' },
          { text: 'Matched my exact colour code.', emphasis: 'exact' },
          { text: 'Bumper was £120 delivered.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'Local fitter put it on for £80.' },
          { text: '£680 quote became £200 all in.', emphasis: '£200' },
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
          { text: 'Our old parts supplier kept letting us down.' },
          { text: 'Wrong panels. Slow delivery. Customers waiting.' },
          { text: 'Then we opened a trade account with Calibre.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Trade prices on every body panel.' },
          { text: 'Parts in fast — jobs out faster.', emphasis: 'fast' },
          { text: 'And they actually answer the phone.' },
        ],
      },
    ],
  },
  {
    id: 'flip-audi',
    title: 'The £900 Audi flip',
    audience: 'flippers',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Picked up a damaged A4 dirt cheap.' },
          { text: 'Front wing creased, headlight smashed.' },
          { text: 'Most people would’ve walked away.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Calibre: wing £72, headlight £139.' },
          { text: 'Genuine fitment, next-day delivery.', emphasis: 'next-day' },
          { text: 'A weekend of graft and it was mint.' },
        ],
      },
      {
        partLabel: 'Part 3',
        beats: [
          { text: 'In at £3.1k, out the door at £5.4k.' },
          { text: 'That’s a £900+ profit after parts.', emphasis: '£900+' },
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
          { text: 'Main dealer wanted £240 fitted.', emphasis: '£240' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Found Calibre — power-fold mirror £84.' },
          { text: 'Watched a 10-minute video, clipped it on.' },
          { text: 'Saved over £150. Buzzing.', emphasis: '£150' },
        ],
      },
    ],
  },
  {
    id: 'discontinued',
    title: '“It’s discontinued, mate”',
    audience: 'garages',
    parts: [
      {
        partLabel: 'Part 1',
        beats: [
          { text: 'Customer’s car needed a tailgate.' },
          { text: 'Every supplier said “discontinued”.' },
          { text: 'Job stuck on the ramp for a week.' },
        ],
      },
      {
        partLabel: 'Part 2',
        beats: [
          { text: 'Rang Calibre as a last resort.' },
          { text: 'They had it. Boxed and on a pallet.', emphasis: 'had it' },
          { text: 'Car back to the customer in 2 days.' },
        ],
      },
    ],
  },
];
