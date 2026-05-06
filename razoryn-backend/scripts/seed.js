// scripts/seed.js — demo data, mirroring the front-end prototype
require('dotenv').config();
const bcrypt = require('bcrypt');
const { query, withTx } = require('../db');

async function run({ skipIfNotEmpty = false } = {}) {
  console.log('[seed] starting');

  if (skipIfNotEmpty) {
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM products');
    if (rows[0].n > 0) {
      console.log('[seed] products table not empty — skipping');
      return;
    }
  }

  await withTx(async (c) => {
    // Locations
    const locs = [
      ['A1-01', 'Aisle A, Bay 1, Shelf 1', 'Front-of-house, fast movers'],
      ['A1-03', 'Aisle A, Bay 1, Shelf 3', 'Headlights — Hyundai/Kia'],
      ['B2-04', 'Aisle B, Bay 2, Shelf 4', 'Tail lights, fog lamps'],
      ['C3-02', 'Aisle C, Bay 3, Shelf 2', 'Body panels — bonnets, wings'],
    ];
    const locIds = {};
    for (const [code, name, desc] of locs) {
      const r = await c.query(
        `INSERT INTO locations (code, name, description) VALUES ($1,$2,$3) RETURNING id`,
        [code, name, desc]
      );
      locIds[code] = r.rows[0].id;
    }

    // Products
    const products = [
      ['RZ-HK2-HL-L', 'Hyundai Kona MK2 Headlight LH', 'Hyundai', 'Kona MK2', '92101-CL000', 'Left',  '5060000000011', 4, 2, 189.00, 175.00, 'A1-03'],
      ['RZ-HK2-HL-R', 'Hyundai Kona MK2 Headlight RH', 'Hyundai', 'Kona MK2', '92102-CL000', 'Right', '5060000000028', 6, 2, 189.00, 175.00, 'A1-03'],
      ['RZ-NIRO-HL-L', 'Kia Niro Headlight LH (2022+)', 'Kia', 'Niro', '92101-AT000', 'Left',  '5060000000035', 3, 2, 165.00, 152.00, 'A1-03'],
      ['RZ-NIRO-HL-R', 'Kia Niro Headlight RH (2022+)', 'Kia', 'Niro', '92102-AT000', 'Right', '5060000000042', 5, 2, 165.00, 152.00, 'A1-03'],
      ['RZ-MG4-TL-L', 'MG4 EV Tail Light LH', 'MG', 'MG4 EV', '10568901', 'Left',  '5060000000059', 8, 3, 95.00, 87.00, 'B2-04'],
      ['RZ-MG4-TL-R', 'MG4 EV Tail Light RH', 'MG', 'MG4 EV', '10568902', 'Right', '5060000000066', 8, 3, 95.00, 87.00, 'B2-04'],
      ['RZ-T3-BNT', 'Tesla Model 3 Bonnet (Aluminium)', 'Tesla', 'Model 3', '1081132-S0-A', null, '5060000000073', 1, 1, 540.00, 499.00, 'C3-02'],
      ['RZ-FOC-FOG', 'Ford Focus MK4 Front Fog Lamp', 'Ford', 'Focus MK4', 'JX7B-15K201-AC', null, '5060000000080', 12, 4, 38.00, 35.00, 'A1-01'],
    ];
    const productIds = {};
    for (const p of products) {
      const [sku, title, brand, model, pn, pos, bc, qty, low, pShop, pEbay, locCode] = p;
      const r = await c.query(
        `INSERT INTO products (sku, title, brand, model, part_number, position, barcode,
                               qty_on_hand, low_stock_threshold, price_shopify, price_ebay, location_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [sku, title, brand, model, pn, pos, bc, qty, low, pShop, pEbay, locIds[locCode]]
      );
      productIds[sku] = r.rows[0].id;
    }

    // Demo warehouse staff
    const pinHash = await bcrypt.hash('1234', 10);
    await c.query(
      `INSERT INTO users (name, role, pin_hash, permissions)
       VALUES ($1, 'warehouse', $2, $3::jsonb)
       ON CONFLICT DO NOTHING`,
      ['Sam (Warehouse)', pinHash, JSON.stringify({
        inventory: true, scan: true, locations: true, returns: true,
        sales: true, pricing: true, kb: true, kbSensitive: false,
        schedule: true, videos: true,
      })]
    );

    // KB entries
    const kb = [
      ['FedEx account', 'contact', 'Account #: 1234-5678-90\nLogin: ali@razoryn.co.uk', false],
      ['Royal Mail Click & Drop', 'login', 'Username: razoryn\nPassword in 1Password under "RM C&D"', true],
      ['DropFleet driver dispatch', 'process', 'Same-day pickups go via DropFleet for postcodes WD/HA/AL', false],
      ['Returns process', 'process', '1. Photograph item 2. Log in app 3. Notify finance if refund > £100', false],
    ];
    for (const [title, cat, body, sens] of kb) {
      await c.query(
        `INSERT INTO kb_entries (title, category, body, sensitive) VALUES ($1,$2,$3,$4)`,
        [title, cat, body, sens]
      );
    }

    // Schedule (today)
    const tasks = [
      ['Morning stock check — Aisle A',  'stock_check', '09:30', 'daily'],
      ['Process overnight Shopify orders', 'packing',   '10:00', 'daily'],
      ['Review pending returns',          'returns',    '14:00', 'daily'],
      ['eBay despatch cut-off prep',      'packing',    '11:30', 'daily'],
    ];
    for (const [t, type, time, rec] of tasks) {
      await c.query(
        `INSERT INTO schedule_tasks (title, task_type, scheduled_for, due_time, recurrence)
         VALUES ($1, $2, CURRENT_DATE, $3::time, $4)`,
        [t, type, time, rec]
      );
    }

    console.log('[seed] inserted', products.length, 'products,', kb.length, 'KB entries,', tasks.length, 'tasks');
  });

  console.log('[seed] done');
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
