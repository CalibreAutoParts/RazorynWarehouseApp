/** Pure (no-React) part definitions so the catalog can be read in plain Node. */

export type PartKey =
  | 'headlight'
  | 'taillight'
  | 'bumper'
  | 'wing'
  | 'bonnet'
  | 'grille'
  | 'mirror'
  | 'door'
  | 'tailgate'
  | 'wheel'
  | 'radiator'
  | 'splitter';

export const PART_LABELS: Record<PartKey, string> = {
  headlight: 'Headlights',
  taillight: 'Tail Lights',
  bumper: 'Bumpers',
  wing: 'Wings & Arches',
  bonnet: 'Bonnets',
  grille: 'Grilles',
  mirror: 'Wing Mirrors',
  door: 'Doors',
  tailgate: 'Tailgates',
  wheel: 'Alloy Wheels',
  radiator: 'Radiators',
  splitter: 'Splitters & Lips',
};
