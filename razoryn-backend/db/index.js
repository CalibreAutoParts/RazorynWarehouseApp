// db/index.js — Postgres connection pool
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's managed Postgres requires SSL in production.
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error', err);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const dur = Date.now() - start;
  if (process.env.LOG_SQL === '1') {
    console.log('[sql]', { text, dur, rows: res.rowCount });
  }
  return res;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx };
