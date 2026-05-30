#!/usr/bin/env node
/**
 * Re-apply kompass cycle 242292 mock shifts from src/data/kompass-cycle-242292-seed.json
 * without waiting for migration replay. Useful after editing the seed file.
 *
 *   node scripts/seed-kompass-mock-shifts.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/lib/db');

const SEED_PATH = path.join(__dirname, '../src/data/kompass-cycle-242292-seed.json');
const SQL_PATH = path.join(__dirname, '../src/migrations/025_kompass_cycle_242292_mock_shifts.sql');

async function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error('Missing seed file:', SEED_PATH);
    console.error('Run: python scripts/generate-kompass-cycle-242292-seed.py');
    process.exit(1);
  }
  if (!fs.existsSync(SQL_PATH)) {
    console.error('Missing migration SQL:', SQL_PATH);
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const sql = fs.readFileSync(SQL_PATH, 'utf8');

  console.log(
    `[seed] Applying cycle ${seed.cycle_id}: `
    + `${seed.stores.length} stores, ${seed.associates.length} associates, `
    + `${seed.schedules.length} schedule rows`,
  );

  await pool.query(sql);
  console.log('[seed] Done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});
