// Shared Postgres pool + idempotent migration runner.
//
// src/index.js used to construct its own pg.Pool. To avoid two pools fighting
// for the same connection limit, that file now re-exports this one. Migration
// runner is identical to district6/backend/lib/db.js -- files under
// src/migrations/*.sql run once, in lex order, tracked in schema_migrations.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  // We intentionally do NOT throw at require-time -- some scripts/tests load
  // this file just for typing without ever calling query(). Throw lazily.
  console.warn('[db] DATABASE_URL is not set; pool will fail on first query.');
}

function resolveSsl() {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };

  const url = process.env.DATABASE_URL || '';
  const m = url.match(/[?&]sslmode=([a-z-]+)/i);
  if (m) {
    const sm = m[1].toLowerCase();
    if (sm === 'disable' || sm === 'allow' || sm === 'prefer') return false;
    if (sm === 'require') return { rejectUnauthorized: false };
    if (sm === 'verify-ca' || sm === 'verify-full') return { rejectUnauthorized: true };
  }

  return false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
});

async function query(text, params) {
  return pool.query(text, params);
}

async function runMigrations() {
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[db] migrations dir not found at ${migrationsDir}; skipping.`);
    return;
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      console.log(`[db] migration applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, runMigrations };
