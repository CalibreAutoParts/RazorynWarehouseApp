import type { PartKey } from './parts';

export type Product = {
  sku: string;
  name: string; // short on-screen name
  make: string;
  part: PartKey;
  price: string; // Calibre price
  was: string; // typical main-dealer price (for contrast)
  condition: 'Brand New' | 'OEM Spec' | 'Genuine Used';
  fitment: string;
};

/**
 * Calibre Auto Parts real range: EXACT-FIT body parts for EVs, hybrids and
 * modern vehicles — Tesla, MG, BYD, Honda and Toyota (see calibreautoparts.co.uk).
 * Parts are headlights, tail lights, bumpers, bonnets, wings and mirrors.
 * Prices reflect their typical £80–£350 range. Extend this list to scale output.
 */
export const PRODUCTS: Product[] = [
  // ---- Tesla ----
  { sku: 'CAP-TES-M3-BMP', name: 'Tesla Model 3 Front Bumper', make: 'Tesla', part: 'bumper', price: '£289', was: '£690', condition: 'OEM Spec', fitment: '2021–2023 facelift' },
  { sku: 'CAP-TES-M3-HL', name: 'Tesla Model 3 LED Headlight', make: 'Tesla', part: 'headlight', price: '£249', was: '£610', condition: 'OEM Spec', fitment: '2021+ O/S driver side' },
  { sku: 'CAP-TES-MY-BMP', name: 'Tesla Model Y Front Bumper', make: 'Tesla', part: 'bumper', price: '£299', was: '£720', condition: 'OEM Spec', fitment: '2020–2024' },
  { sku: 'CAP-TES-MY-TL', name: 'Tesla Model Y Tail Light', make: 'Tesla', part: 'taillight', price: '£149', was: '£360', condition: 'Brand New', fitment: '2021+ O/S' },
  { sku: 'CAP-TES-MY-MIR', name: 'Tesla Model Y Wing Mirror', make: 'Tesla', part: 'mirror', price: '£119', was: '£300', condition: 'Brand New', fitment: 'Auto-fold heated' },

  // ---- MG ----
  { sku: 'CAP-MG4-BMP', name: 'MG4 Front Bumper', make: 'MG', part: 'bumper', price: '£179', was: '£430', condition: 'OEM Spec', fitment: '2022–2026' },
  { sku: 'CAP-MG4-HL', name: 'MG4 LED Headlight', make: 'MG', part: 'headlight', price: '£159', was: '£390', condition: 'OEM Spec', fitment: '2022–2026 O/S' },
  { sku: 'CAP-MGZS-BMP', name: 'MG ZS Front Bumper', make: 'MG', part: 'bumper', price: '£139', was: '£330', condition: 'Brand New', fitment: '2020–2024' },
  { sku: 'CAP-MGZS-HL', name: 'MG ZS Headlight', make: 'MG', part: 'headlight', price: '£129', was: '£300', condition: 'OEM Spec', fitment: '2020–2024 N/S' },
  { sku: 'CAP-MG5-HL-R', name: 'MG5 LED Right Headlight', make: 'MG', part: 'headlight', price: '£135', was: '£320', condition: 'OEM Spec', fitment: '2020–2023 O/S driver' },
  { sku: 'CAP-MG5-HL-L', name: 'MG5 LED Left Headlight', make: 'MG', part: 'headlight', price: '£135', was: '£320', condition: 'OEM Spec', fitment: '2020–2023 N/S passenger' },
  { sku: 'CAP-MG3-BMP', name: 'MG3 Front Bumper', make: 'MG', part: 'bumper', price: '£99', was: '£250', condition: 'Brand New', fitment: 'MK2 2018–2024' },
  { sku: 'CAP-MGHS-BNT', name: 'MG HS Bonnet', make: 'MG', part: 'bonnet', price: '£225', was: '£640', condition: 'OEM Spec', fitment: '2018–2023' },
  { sku: 'CAP-MGHS-WING', name: 'MG HS Front Wing', make: 'MG', part: 'wing', price: '£89', was: '£210', condition: 'Brand New', fitment: '2018–2023 O/S' },

  // ---- BYD ----
  { sku: 'CAP-BYD-ATTO-BMP', name: 'BYD Atto 3 Front Bumper', make: 'BYD', part: 'bumper', price: '£199', was: '£520', condition: 'OEM Spec', fitment: '2022+' },
  { sku: 'CAP-BYD-ATTO-HL', name: 'BYD Atto 3 Headlight', make: 'BYD', part: 'headlight', price: '£179', was: '£450', condition: 'OEM Spec', fitment: '2022+ O/S' },
  { sku: 'CAP-BYD-DOL-BMP', name: 'BYD Dolphin Front Bumper', make: 'BYD', part: 'bumper', price: '£179', was: '£470', condition: 'Brand New', fitment: '2023+' },
  { sku: 'CAP-BYD-SEAL-TL', name: 'BYD Seal Tail Light', make: 'BYD', part: 'taillight', price: '£159', was: '£390', condition: 'Brand New', fitment: '2023+ O/S' },

  // ---- Honda ----
  { sku: 'CAP-HON-CIV-BMP', name: 'Honda Civic Front Bumper', make: 'Honda', part: 'bumper', price: '£149', was: '£390', condition: 'OEM Spec', fitment: '2022+ e:HEV' },
  { sku: 'CAP-HON-JAZ-HL', name: 'Honda Jazz Headlight', make: 'Honda', part: 'headlight', price: '£119', was: '£300', condition: 'Brand New', fitment: '2020+ Hybrid N/S' },
  { sku: 'CAP-HON-HRV-WING', name: 'Honda HR-V Front Wing', make: 'Honda', part: 'wing', price: '£89', was: '£220', condition: 'Brand New', fitment: '2021+ O/S' },
  { sku: 'CAP-HON-CRV-BNT', name: 'Honda CR-V Bonnet', make: 'Honda', part: 'bonnet', price: '£239', was: '£680', condition: 'OEM Spec', fitment: '2018–2023' },

  // ---- Toyota ----
  { sku: 'CAP-TOY-COR-BMP', name: 'Toyota Corolla Front Bumper', make: 'Toyota', part: 'bumper', price: '£139', was: '£360', condition: 'OEM Spec', fitment: '2019+ Hybrid' },
  { sku: 'CAP-TOY-YAR-HL', name: 'Toyota Yaris LED Headlight', make: 'Toyota', part: 'headlight', price: '£129', was: '£330', condition: 'OEM Spec', fitment: '2020+ Hybrid O/S' },
  { sku: 'CAP-TOY-CHR-BMP', name: 'Toyota C-HR Front Bumper', make: 'Toyota', part: 'bumper', price: '£149', was: '£380', condition: 'Brand New', fitment: '2020–2023' },
  { sku: 'CAP-TOY-PRI-TL', name: 'Toyota Prius Tail Light', make: 'Toyota', part: 'taillight', price: '£119', was: '£300', condition: 'Brand New', fitment: '2016–2022 O/S' },
  { sku: 'CAP-TOY-COR-BNT', name: 'Toyota Corolla Bonnet', make: 'Toyota', part: 'bonnet', price: '£199', was: '£560', condition: 'OEM Spec', fitment: '2019+' },

  // ---- Extended range ----
  { sku: 'CAP-TES-M3-TL', name: 'Tesla Model 3 Tail Light', make: 'Tesla', part: 'taillight', price: '£139', was: '£330', condition: 'Brand New', fitment: '2021+ O/S' },
  { sku: 'CAP-TES-M3-WING', name: 'Tesla Model 3 Front Wing', make: 'Tesla', part: 'wing', price: '£99', was: '£240', condition: 'Brand New', fitment: '2021+ O/S' },
  { sku: 'CAP-TES-MY-HL', name: 'Tesla Model Y LED Headlight', make: 'Tesla', part: 'headlight', price: '£259', was: '£620', condition: 'OEM Spec', fitment: '2020–2024 N/S' },
  { sku: 'CAP-TES-MY-BNT', name: 'Tesla Model Y Bonnet', make: 'Tesla', part: 'bonnet', price: '£319', was: '£820', condition: 'OEM Spec', fitment: '2020–2024 frunk lid' },
  { sku: 'CAP-MG4-TL', name: 'MG4 Tail Light', make: 'MG', part: 'taillight', price: '£129', was: '£310', condition: 'Brand New', fitment: '2022–2026 O/S' },
  { sku: 'CAP-MGZS-BNT', name: 'MG ZS Bonnet', make: 'MG', part: 'bonnet', price: '£189', was: '£520', condition: 'OEM Spec', fitment: '2020–2024' },
  { sku: 'CAP-MGHS-BMP', name: 'MG HS Front Bumper', make: 'MG', part: 'bumper', price: '£159', was: '£400', condition: 'OEM Spec', fitment: '2018–2023' },
  { sku: 'CAP-MG3-HL', name: 'MG3 Headlight', make: 'MG', part: 'headlight', price: '£109', was: '£260', condition: 'Brand New', fitment: 'MK2 2018–2024 O/S' },
  { sku: 'CAP-BYD-ATTO-MIR', name: 'BYD Atto 3 Wing Mirror', make: 'BYD', part: 'mirror', price: '£99', was: '£250', condition: 'Brand New', fitment: '2022+ power-fold' },
  { sku: 'CAP-BYD-DOL-HL', name: 'BYD Dolphin Headlight', make: 'BYD', part: 'headlight', price: '£169', was: '£420', condition: 'OEM Spec', fitment: '2023+ O/S' },
  { sku: 'CAP-BYD-SEAL-BMP', name: 'BYD Seal Front Bumper', make: 'BYD', part: 'bumper', price: '£219', was: '£560', condition: 'OEM Spec', fitment: '2023+' },
  { sku: 'CAP-HON-CIV-HL', name: 'Honda Civic LED Headlight', make: 'Honda', part: 'headlight', price: '£139', was: '£360', condition: 'OEM Spec', fitment: '2022+ e:HEV O/S' },
  { sku: 'CAP-HON-JAZ-BMP', name: 'Honda Jazz Front Bumper', make: 'Honda', part: 'bumper', price: '£119', was: '£300', condition: 'Brand New', fitment: '2020+ Hybrid' },
  { sku: 'CAP-HON-HRV-HL', name: 'Honda HR-V Headlight', make: 'Honda', part: 'headlight', price: '£129', was: '£330', condition: 'Brand New', fitment: '2021+ N/S' },
  { sku: 'CAP-TOY-CHR-HL', name: 'Toyota C-HR LED Headlight', make: 'Toyota', part: 'headlight', price: '£139', was: '£360', condition: 'OEM Spec', fitment: '2020–2023 O/S' },
  { sku: 'CAP-TOY-YAR-BMP', name: 'Toyota Yaris Front Bumper', make: 'Toyota', part: 'bumper', price: '£119', was: '£300', condition: 'Brand New', fitment: '2020+ Hybrid' },
  { sku: 'CAP-TOY-COR-TL', name: 'Toyota Corolla Tail Light', make: 'Toyota', part: 'taillight', price: '£109', was: '£280', condition: 'Brand New', fitment: '2019+ O/S' },
  { sku: 'CAP-TOY-RAV-BMP', name: 'Toyota RAV4 Front Bumper', make: 'Toyota', part: 'bumper', price: '£169', was: '£430', condition: 'OEM Spec', fitment: '2019+ Hybrid' },
];

export const MAKES = Array.from(new Set(PRODUCTS.map((p) => p.make)));
