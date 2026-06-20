// scripts/migrate.js — runs db/schema.sql, creates initial admin if no users exist
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { pool, query } = require('../db');

async function run() {
  console.log('[migrate] starting');

  // citext requires the extension first — but schema.sql creates it at the bottom.
  // We need it for the users.email column, so create it first explicitly.
  await query('CREATE EXTENSION IF NOT EXISTS citext');

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema applied');

  // Seed initial admin if users table is empty
  const { rows: existing } = await query('SELECT COUNT(*)::int AS n FROM users');
  if (existing[0].n === 0) {
    const email = process.env.INITIAL_ADMIN_EMAIL;
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    const username = process.env.INITIAL_ADMIN_USERNAME || null;
    const pin = process.env.INITIAL_ADMIN_PIN;
    // Need email OR username, plus a password. (Login accepts either.)
    if ((!email && !username) || !password) {
      console.warn('[migrate] set INITIAL_ADMIN_PASSWORD and at least one of INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_EMAIL; skipping admin creation');
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
      await query(
        `INSERT INTO users (email, username, password_hash, pin_hash, name, role, permissions)
         VALUES ($1, $2, $3, $4, $5, 'admin', $6::jsonb)`,
        [email || null, username, passwordHash, pinHash, 'Admin', JSON.stringify({})]
      );
      console.log(`[migrate] created initial admin: ${username || email}`);
    }
  }

  // Seed default settings row
  await query(`
    INSERT INTO app_settings (id, cash_discount_pct, vat_rate)
    VALUES (1, 10.00, 20.00)
    ON CONFLICT (id) DO NOTHING
  `);

  // Optional demo seed
  if (process.env.SEED_ON_MIGRATE === 'true') {
    try {
      const seed = require('./seed');
      await seed.run({ skipIfNotEmpty: true });
    } catch (e) {
      console.warn('[migrate] seed skipped:', e.message);
    }
  }

  console.log('[migrate] done');
  process.exit(0);
}

run().catch(err => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
