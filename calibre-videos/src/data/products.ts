import type { PartKey } from './parts';

export type Product = {
  sku: string; // OEM / manufacturer part number (real)
  name: string; // short on-screen name
  make: string;
  model: string;
  part: PartKey; // for category grouping + illustration fallback
  fitment: string; // year range + side/variant
  price: string; // REAL price — hidden while SHOW_PRICING is false (data/config.ts)
  was?: string; // optional dealer-contrast price (unused now; kept for the type)
  condition: 'Brand New' | 'OEM Spec' | 'Genuine Used';
  image?: string; // REAL product photo (Shopify CDN). Loads where network allows;
  // falls back to the branded illustration otherwise (see ProductImage).
};

/**
 * REAL Calibre Auto Parts / Razoryn eParts range — pulled live from the
 * Shopify catalogue (vendor "Razoryn eParts", the shared warehouse behind
 * calibreautoparts.co.uk). These are genuine listings: real titles, makes,
 * models, OEM part numbers, prices and product photos — NOT placeholders.
 *
 * Positioning (per the warehouse brand config): "EV and modern vehicle body
 * parts" across mainstream makes — Hyundai, Kia, Toyota, Nissan, BMW, Mercedes,
 * Vauxhall, Audi, VW and MG. Headlights, tail & brake lights, fog lights,
 * bumpers, grilles, wings/fenders, bonnets and wheel-arch trims.
 *
 * PRICING: real prices are stored for accuracy, but every template honours
 * SHOW_PRICING (currently false) so none are shown ahead of the price update.
 */
const CDN = 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/';

export const PRODUCTS: Product[] = [
  // ---- Hyundai ----
  { sku: '92101-N7120', name: 'Hyundai Tucson Headlight', make: 'Hyundai', model: 'Tucson', part: 'headlight', fitment: '2021–2025 Front Left', price: '£185.99', condition: 'Brand New', image: CDN + '57_55230ab5-6a1f-414d-8dfc-b88856ec0776.jpg' },
  { sku: '92102-N7120', name: 'Hyundai Tucson Headlight', make: 'Hyundai', model: 'Tucson', part: 'headlight', fitment: '2021–2025 Front Right', price: '£185.99', condition: 'Brand New', image: CDN + '57_dc1fd1a2-3029-40f9-92ae-97c785142365.jpg' },
  { sku: '92101-Q0500', name: 'Hyundai Bayon Headlight', make: 'Hyundai', model: 'Bayon', part: 'headlight', fitment: '2021–2026 Left', price: '£185.99', condition: 'Brand New', image: CDN + '57_051946fa-463d-4326-9bc7-edbc02021039.jpg' },
  { sku: '92101BE030', name: 'Hyundai Kona MK2 Headlight', make: 'Hyundai', model: 'Kona MK2', part: 'headlight', fitment: '2023–2026 Front Left', price: '£232.49', condition: 'Brand New', image: CDN + '57_6a4a53a8-97cf-4bc9-8c2c-471090645b5a.jpg' },
  { sku: '92102-Q0100', name: 'Hyundai i20 MK3 Full LED Headlight', make: 'Hyundai', model: 'i20 MK3', part: 'headlight', fitment: '2020–2025 Right', price: '£511.50', condition: 'Brand New', image: CDN + '57_b7194b91-19bc-4290-a171-10f73a4d9588.jpg' },
  { sku: '92402-C0000', name: 'Hyundai i20 Brake Light', make: 'Hyundai', model: 'i20', part: 'taillight', fitment: '2020–2026 Rear Right Outer', price: '£185.99', condition: 'Brand New', image: CDN + '57_4b9df85a-2213-444c-8871-e5ea9516dbe5.jpg' },
  { sku: '92405-BE000', name: 'Hyundai Kona MK2 Brake Light', make: 'Hyundai', model: 'Kona MK2', part: 'taillight', fitment: '2023–2026 Rear Left Outer', price: '£176.69', condition: 'Brand New', image: CDN + '57_53dcdf4e-5d2a-42b5-95bc-d02ec93d6aae.jpg' },
  { sku: '66400-BE000', name: 'Hyundai Kona MK2 Bonnet', make: 'Hyundai', model: 'Kona MK2', part: 'bonnet', fitment: '2023–2026 Primed', price: '£399.89', condition: 'Brand New', image: CDN + '57_b78078ea-3877-42ef-96fb-026a76379875.jpg' },
  { sku: '86569-GI000', name: 'Hyundai Ioniq 5 Bumper Moulding', make: 'Hyundai', model: 'Ioniq 5', part: 'bumper', fitment: '2021–2026 Front, Silver Grey', price: '£148.79', condition: 'Brand New', image: CDN + '57_7b3c31bf-4557-459c-8577-2c10cd1669cd.jpg' },
  { sku: '86811-GI000', name: 'Hyundai Ioniq 5 Wheel Arch Liner', make: 'Hyundai', model: 'Ioniq 5', part: 'wing', fitment: 'Front Left Splash Guard', price: '£83.69', condition: 'Brand New', image: CDN + '57_00baf055-20a4-43ff-a964-a8e0f2210b7e.jpg' },
  { sku: '87711-N7000', name: 'Hyundai Tucson Arch Trim', make: 'Hyundai', model: 'Tucson', part: 'wing', fitment: '2020–2025 Front Left', price: '£55.79', condition: 'Brand New', image: CDN + '57_031755c9-1b4f-4cfd-8e6f-f290fe0c3a7c.jpg' },

  // ---- Kia ----
  { sku: '92202-R2000', name: 'Kia Sportage Fog Light', make: 'Kia', model: 'Sportage', part: 'headlight', fitment: '2022–2025 Front Right', price: '£111.59', condition: 'Brand New', image: CDN + '57_ca85c39f-a4d4-4f9a-a6d9-aa8666fabe24.jpg' },
  { sku: '92201-R2000', name: 'Kia Sportage Fog Light', make: 'Kia', model: 'Sportage', part: 'headlight', fitment: '2022–2025 Front Left', price: '£111.59', condition: 'Brand New', image: CDN + '57_26b31745-1cfe-4b5a-a8ce-7e4b670518c4.jpg' },
  { sku: '86596-R2000', name: 'Kia Sportage Grille Trim', make: 'Kia', model: 'Sportage', part: 'grille', fitment: '2021–2025 NQ5 Front Right', price: '£46.49', condition: 'Brand New', image: CDN + '57_0bffdb35-64c9-4de6-9f34-8cf75caa86ac.jpg' },
  { sku: '92207-G5500', name: 'Kia Niro Fog Lamp', make: 'Kia', model: 'Niro', part: 'headlight', fitment: '2018–2022 Front Left', price: '£111.59', condition: 'Brand New', image: CDN + '57_4499dcdc-12c7-4bd7-af7f-2144081fc2b3.jpg' },
  { sku: '86523-G5500', name: 'Kia Niro Bumper Grille Trim', make: 'Kia', model: 'Niro MK1', part: 'bumper', fitment: '2016–2022 Front Left DRL Cover', price: '£51.14', condition: 'Brand New', image: CDN + '57_14eb15b8-4ba3-4f66-9565-a4054aab76e9.jpg' },

  // ---- Toyota ----
  { sku: '52129-0D090', name: 'Toyota Yaris Cross Front Bumper Set', make: 'Toyota', model: 'Yaris Cross', part: 'bumper', fitment: '2020–2026 Front Lower', price: '£148.79', condition: 'Brand New', image: CDN + '57_931b645b-69df-45f3-8dc7-2982d61dc7eb.png' },
  { sku: '52159-0DB40', name: 'Toyota Yaris Cross Rear Bumper', make: 'Toyota', model: 'Yaris Cross', part: 'bumper', fitment: 'Primed Rear Skin', price: '£120.89', condition: 'Brand New', image: CDN + '57_13bd1a43-1be7-4d43-b4ee-924b673313f9.png' },
  { sku: '53111-0DD00', name: 'Toyota Yaris Cross Lower Grille', make: 'Toyota', model: 'Yaris Cross', part: 'grille', fitment: '2020–2026 Front Bumper', price: '£102.29', condition: 'Brand New', image: CDN + '57_9fea640d-7515-4a65-96dc-83b7d5896583.png' },
  { sku: '53811-F4050', name: 'Toyota C-HR Front Wing', make: 'Toyota', model: 'C-HR', part: 'wing', fitment: '2024–2026 Primed Right', price: '£185.99', condition: 'Brand New', image: CDN + '57_52ffbd3d-042d-4969-b238-577677a9f87e.jpg' },
  { sku: '53812-F4050', name: 'Toyota C-HR Front Wing', make: 'Toyota', model: 'C-HR', part: 'wing', fitment: '2024–2026 Primed Left', price: '£185.99', condition: 'Brand New', image: CDN + '57_711bb058-d70b-40a6-97d0-2a3a0c71429b.jpg' },

  // ---- Nissan ----
  { sku: 'F3101-6URMA-D410', name: 'Nissan Qashqai Front Wing', make: 'Nissan', model: 'Qashqai', part: 'wing', fitment: '2023–2026 Primed Left', price: '£111.59', condition: 'Brand New', image: CDN + '57_568e1b20-f596-4804-87a6-893038c8ebb2.jpg' },
  { sku: 'F5100-6URMA-D410', name: 'Nissan Qashqai Bonnet', make: 'Nissan', model: 'Qashqai', part: 'bonnet', fitment: '2023–2026 Primed', price: '£232.49', condition: 'Brand New', image: CDN + '57_890aba18-9005-44e4-9ee6-79ea4753c9af.jpg' },
  { sku: '631006RR0A', name: 'Nissan X-Trail Front Wing', make: 'Nissan', model: 'X-Trail', part: 'wing', fitment: '2022–2026 Primed Right', price: '£185.99', condition: 'Brand New', image: CDN + '57_380aefd1-c74f-4a78-81ad-0d514841cec1.jpg' },
  { sku: '651006RR0A', name: 'Nissan X-Trail Bonnet', make: 'Nissan', model: 'X-Trail', part: 'bonnet', fitment: '2022–2026 Primed', price: '£464.99', condition: 'Brand New', image: CDN + '57_00a170e1-1f55-4321-abf7-b5206d4a8fe1.jpg' },
  { sku: '62310-6PA0A', name: 'Nissan Juke Front Grille', make: 'Nissan', model: 'Juke', part: 'grille', fitment: '2019–2026 Gloss Black', price: '£86.02', condition: 'Brand New', image: CDN + '57_c6a0cbb7-0bbc-4f22-9e4e-1f4f7c64915a.png' },
  { sku: '79910-5MP1A', name: 'Nissan Ariya Parcel Shelf', make: 'Nissan', model: 'Ariya', part: 'tailgate', fitment: '2019–2026', price: '£92.99', condition: 'Brand New', image: CDN + '57_791442ee-ddfa-48fe-a690-e86baf7b1f0c.jpg' },

  // ---- BMW ----
  { sku: '41007492363', name: 'BMW X5 G05 Front Wing', make: 'BMW', model: 'X5', part: 'wing', fitment: '2018–2023 Primed Left', price: '£185.99', condition: 'Brand New', image: CDN + '57_0c6e5f86-f024-4d36-b4bc-2a497640b740.jpg' },
  { sku: '41007492375', name: 'BMW X5 Bonnet', make: 'BMW', model: 'X5', part: 'bonnet', fitment: '2018–2023 Primed', price: '£446.39', condition: 'Brand New', image: CDN + '57_2082eb53-b93a-4b62-b3e8-65712fc82f29.jpg' },
  { sku: '41007440427', name: 'BMW 5 Series G30 Bonnet', make: 'BMW', model: '5 Series', part: 'bonnet', fitment: '2017–2023 Primed', price: '£418.49', condition: 'Brand New', image: CDN + '57_1734cda1-7918-43cb-8e97-b0c5cf50853c.jpg' },
  { sku: '41002459937', name: 'BMW X3 G08 Bonnet', make: 'BMW', model: 'X3', part: 'bonnet', fitment: '2018–2023 Primed', price: '£418.49', condition: 'Brand New', image: CDN + '57_e0566866-8ac1-4132-9052-0d685825ede7.jpg' },

  // ---- Mercedes ----
  { sku: '1188810400', name: 'Mercedes CLA Front Wing', make: 'Mercedes', model: 'CLA W118', part: 'wing', fitment: '2019–2026 Primed Right', price: '£111.59', condition: 'Brand New', image: CDN + '57_cf2ac821-8b9c-44cc-a574-b35769cfb35c.jpg' },
  { sku: '1188810300', name: 'Mercedes CLA Front Wing', make: 'Mercedes', model: 'CLA W118', part: 'wing', fitment: '2019–2026 Primed Left', price: '£111.59', condition: 'Brand New', image: CDN + '57_680428df-a25f-4676-8bd6-7d9c3c3f7e88.jpg' },

  // ---- Vauxhall ----
  { sku: '9820555080', name: 'Vauxhall Combo Brake Light', make: 'Vauxhall', model: 'Combo', part: 'taillight', fitment: '2019–2025 Rear Right', price: '£74.20', condition: 'Brand New', image: CDN + '57_f87215ad-2752-4c50-9b3e-e725b50d41d3.jpg' },
  { sku: '9840129677', name: 'Vauxhall Grandland X Grille', make: 'Vauxhall', model: 'Grandland X', part: 'grille', fitment: '2023–2026 Front Main', price: '£92.99', condition: 'Brand New', image: CDN + '57_bf9da490-0a2c-4358-8d24-f619fe5cfb83.jpg' },

  // ---- Audi / VW ----
  { sku: '89A867769', name: 'Audi Q4 e-tron Parcel Shelf', make: 'Audi', model: 'Q4 e-tron', part: 'tailgate', fitment: '2021–2025', price: '£69.74', condition: 'Brand New', image: CDN + '57_5f4f37a8-0c39-479a-914a-418c35dd0da5.jpg' },
  { sku: '2GM853601GDPJ', name: 'VW Polo / T-Roc / T-Cross Grille Badge', make: 'VW', model: 'Polo MK6', part: 'grille', fitment: 'Front Badge', price: '£37.19', condition: 'Brand New', image: CDN + '57_c698d863-c07e-4bd5-8161-5838ce16758b.jpg' },

  // ---- MG ----
  { sku: '11816541', name: 'MG ZS MK2 Front Bumper Camera', make: 'MG', model: 'ZS MK2', part: 'bumper', fitment: '2024–2026 ZS32', price: '£92.99', condition: 'Brand New', image: CDN + '57_05a83503-38cc-4336-9a1c-708ea56898ee.jpg' },
  { sku: 'PARCELSHELF-MG-ZS', name: 'MG ZS Parcel Shelf', make: 'MG', model: 'ZS', part: 'tailgate', fitment: '2017–2022', price: '£92.99', condition: 'Brand New', image: CDN + '57_70a28d27-6c24-42c9-8a93-13b302367623.jpg' },
];

export const MAKES = Array.from(new Set(PRODUCTS.map((p) => p.make)));
