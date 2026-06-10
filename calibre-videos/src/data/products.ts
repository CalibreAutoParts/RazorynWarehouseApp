import type { PartKey } from './parts';

export type Product = {
  sku: string;
  name: string; // short on-screen name
  make: string;
  part: PartKey;
  price: string; // Calibre price
  was: string; // typical dealer / retail price (for contrast)
  condition: 'Brand New' | 'OEM Spec' | 'Genuine Used' | 'Refurbished';
  fitment: string;
};

/**
 * Representative Calibre body-parts catalogue across popular UK makes (incl. EV).
 * Prices are illustrative for ad creative. Extend this list to scale output.
 */
export const PRODUCTS: Product[] = [
  { sku: 'CAP-BMW-3F-BMP', name: 'BMW 3 Series Front Bumper', make: 'BMW', part: 'bumper', price: '£165', was: '£430', condition: 'OEM Spec', fitment: 'F30 / F31 2012–2019' },
  { sku: 'CAP-BMW-3F-HL', name: 'BMW 3 Series Headlight', make: 'BMW', part: 'headlight', price: '£139', was: '£610', condition: 'OEM Spec', fitment: 'F30 LCI Halogen' },
  { sku: 'CAP-AUD-A4-WING', name: 'Audi A4 Front Wing', make: 'Audi', part: 'wing', price: '£72', was: '£190', condition: 'Brand New', fitment: 'B9 2016–2020 O/S' },
  { sku: 'CAP-AUD-A3-GRL', name: 'Audi A3 Grille', make: 'Audi', part: 'grille', price: '£89', was: '£245', condition: 'OEM Spec', fitment: '8V S-Line 2016–2020' },
  { sku: 'CAP-MRC-C-BNT', name: 'Mercedes C-Class Bonnet', make: 'Mercedes', part: 'bonnet', price: '£240', was: '£720', condition: 'OEM Spec', fitment: 'W205 2014–2021' },
  { sku: 'CAP-MRC-A-MIR', name: 'Mercedes A-Class Wing Mirror', make: 'Mercedes', part: 'mirror', price: '£95', was: '£280', condition: 'Brand New', fitment: 'W177 Power-fold' },
  { sku: 'CAP-FRD-FST-BMP', name: 'Ford Fiesta Front Bumper', make: 'Ford', part: 'bumper', price: '£98', was: '£260', condition: 'Brand New', fitment: 'Mk8 2017–2022' },
  { sku: 'CAP-FRD-FOC-HL', name: 'Ford Focus Headlight', make: 'Ford', part: 'headlight', price: '£82', was: '£235', condition: 'OEM Spec', fitment: 'Mk4 2018+ LED-look' },
  { sku: 'CAP-VW-GLF-TG', name: 'VW Golf Tailgate', make: 'VW', part: 'tailgate', price: '£185', was: '£540', condition: 'Genuine Used', fitment: 'Mk7 2013–2019' },
  { sku: 'CAP-VW-PLO-DR', name: 'VW Polo Door', make: 'VW', part: 'door', price: '£160', was: '£480', condition: 'Genuine Used', fitment: '6R/6C Front N/S' },
  { sku: 'CAP-VAU-COR-WING', name: 'Vauxhall Corsa Wing', make: 'Vauxhall', part: 'wing', price: '£54', was: '£150', condition: 'Brand New', fitment: 'E 2015–2019' },
  { sku: 'CAP-VAU-AST-TL', name: 'Vauxhall Astra Tail Light', make: 'Vauxhall', part: 'taillight', price: '£44', was: '£135', condition: 'Brand New', fitment: 'K 2015–2021 O/S' },
  { sku: 'CAP-NIS-QQ-BMP', name: 'Nissan Qashqai Bumper', make: 'Nissan', part: 'bumper', price: '£128', was: '£360', condition: 'OEM Spec', fitment: 'J11 2014–2017' },
  { sku: 'CAP-TOY-YAR-HL', name: 'Toyota Yaris Headlight', make: 'Toyota', part: 'headlight', price: '£76', was: '£220', condition: 'Brand New', fitment: 'XP130 2014–2020' },
  { sku: 'CAP-TES-M3-BMP', name: 'Tesla Model 3 Front Bumper', make: 'Tesla', part: 'bumper', price: '£260', was: '£690', condition: 'OEM Spec', fitment: '2017–2023 pre-facelift' },
  { sku: 'CAP-TES-M3-MIR', name: 'Tesla Model 3 Wing Mirror', make: 'Tesla', part: 'mirror', price: '£120', was: '£330', condition: 'Brand New', fitment: 'Auto-fold heated' },
  { sku: 'CAP-BMW-1-WHL', name: 'BMW Alloy Wheel 18"', make: 'BMW', part: 'wheel', price: '£135', was: '£395', condition: 'Refurbished', fitment: 'Style 397M' },
  { sku: 'CAP-AUD-A4-RAD', name: 'Audi A4 Radiator', make: 'Audi', part: 'radiator', price: '£88', was: '£210', condition: 'Brand New', fitment: 'B9 2.0 TDI' },
  { sku: 'CAP-FRD-FOC-SPL', name: 'Ford Focus ST Splitter', make: 'Ford', part: 'splitter', price: '£64', was: '£160', condition: 'Brand New', fitment: 'Mk4 ST-Line' },
  { sku: 'CAP-MRC-C-TL', name: 'Mercedes C-Class Tail Light', make: 'Mercedes', part: 'taillight', price: '£110', was: '£300', condition: 'OEM Spec', fitment: 'W205 Saloon LED' },
  { sku: 'CAP-VW-GLF-HL', name: 'VW Golf Headlight', make: 'VW', part: 'headlight', price: '£105', was: '£320', condition: 'OEM Spec', fitment: 'Mk7.5 LED' },
  { sku: 'CAP-NIS-JUK-GRL', name: 'Nissan Juke Grille', make: 'Nissan', part: 'grille', price: '£59', was: '£165', condition: 'Brand New', fitment: 'F15 2014–2019' },
  { sku: 'CAP-TOY-COR-BNT', name: 'Toyota Corolla Bonnet', make: 'Toyota', part: 'bonnet', price: '£175', was: '£520', condition: 'OEM Spec', fitment: 'E210 2019+' },
  { sku: 'CAP-VAU-COR-DR', name: 'Vauxhall Corsa Door', make: 'Vauxhall', part: 'door', price: '£140', was: '£420', condition: 'Genuine Used', fitment: 'F 2019+ N/S' },
  { sku: 'CAP-KIA-SPO-BMP', name: 'Kia Sportage Front Bumper', make: 'Kia', part: 'bumper', price: '£135', was: '£380', condition: 'OEM Spec', fitment: 'QL 2016–2018' },
  { sku: 'CAP-HYU-I30-HL', name: 'Hyundai i30 Headlight', make: 'Hyundai', part: 'headlight', price: '£92', was: '£270', condition: 'Brand New', fitment: 'PD 2017–2020' },
  { sku: 'CAP-PEU-208-WING', name: 'Peugeot 208 Front Wing', make: 'Peugeot', part: 'wing', price: '£58', was: '£165', condition: 'Brand New', fitment: 'Mk2 2019+ O/S' },
  { sku: 'CAP-REN-CLI-BMP', name: 'Renault Clio Front Bumper', make: 'Renault', part: 'bumper', price: '£96', was: '£250', condition: 'OEM Spec', fitment: 'Mk5 2019+' },
  { sku: 'CAP-MIN-CPR-GRL', name: 'Mini Cooper Grille', make: 'Mini', part: 'grille', price: '£68', was: '£190', condition: 'Brand New', fitment: 'F56 2014–2018' },
  { sku: 'CAP-SEA-LEO-TL', name: 'Seat Leon Tail Light', make: 'Seat', part: 'taillight', price: '£72', was: '£205', condition: 'OEM Spec', fitment: 'Mk3 2017–2020 O/S' },
  { sku: 'CAP-SKO-OCT-BNT', name: 'Skoda Octavia Bonnet', make: 'Skoda', part: 'bonnet', price: '£165', was: '£500', condition: 'OEM Spec', fitment: 'Mk3 2017–2020' },
  { sku: 'CAP-HON-CIV-MIR', name: 'Honda Civic Wing Mirror', make: 'Honda', part: 'mirror', price: '£84', was: '£240', condition: 'Brand New', fitment: 'FK 2017–2021 power-fold' },
  { sku: 'CAP-LR-DISC-GRL', name: 'Land Rover Discovery Grille', make: 'Land Rover', part: 'grille', price: '£120', was: '£340', condition: 'OEM Spec', fitment: 'Sport 2014–2018' },
  { sku: 'CAP-NIS-LEAF-BMP', name: 'Nissan Leaf Front Bumper', make: 'Nissan', part: 'bumper', price: '£148', was: '£410', condition: 'OEM Spec', fitment: 'ZE1 2018+ EV' },
  { sku: 'CAP-BMW-i3-WING', name: 'BMW i3 Front Wing', make: 'BMW', part: 'wing', price: '£110', was: '£300', condition: 'Brand New', fitment: '2013–2020 EV O/S' },
  { sku: 'CAP-AUD-Q5-TG', name: 'Audi Q5 Tailgate', make: 'Audi', part: 'tailgate', price: '£260', was: '£760', condition: 'Genuine Used', fitment: 'FY 2017–2020' },
  { sku: 'CAP-MRC-GLA-WHL', name: 'Mercedes GLA Alloy Wheel 18"', make: 'Mercedes', part: 'wheel', price: '£150', was: '£440', condition: 'Refurbished', fitment: 'H247 5-twin-spoke' },
  { sku: 'CAP-FRD-KUG-RAD', name: 'Ford Kuga Radiator', make: 'Ford', part: 'radiator', price: '£95', was: '£235', condition: 'Brand New', fitment: 'Mk3 1.5 EcoBoost' },
  { sku: 'CAP-VW-TIG-HL', name: 'VW Tiguan Headlight', make: 'VW', part: 'headlight', price: '£128', was: '£380', condition: 'OEM Spec', fitment: 'Mk2 2016–2020 LED' },
  { sku: 'CAP-TOY-AYG-DR', name: 'Toyota Aygo Door', make: 'Toyota', part: 'door', price: '£130', was: '£395', condition: 'Genuine Used', fitment: 'Mk2 2014–2021 N/S' },
  { sku: 'CAP-VAU-MOK-SPL', name: 'Vauxhall Mokka Splitter', make: 'Vauxhall', part: 'splitter', price: '£56', was: '£150', condition: 'Brand New', fitment: 'B 2021+ GS-Line' },
  { sku: 'CAP-TES-MY-TL', name: 'Tesla Model Y Tail Light', make: 'Tesla', part: 'taillight', price: '£140', was: '£390', condition: 'OEM Spec', fitment: '2021+ O/S' },
  { sku: 'CAP-BMW-5-BNT', name: 'BMW 5 Series Bonnet', make: 'BMW', part: 'bonnet', price: '£255', was: '£780', condition: 'OEM Spec', fitment: 'G30 2017–2020' },
];

export const MAKES = Array.from(new Set(PRODUCTS.map((p) => p.make)));
