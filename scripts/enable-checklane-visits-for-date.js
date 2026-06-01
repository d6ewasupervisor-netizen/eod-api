#!/usr/bin/env node
/**
 * Point hub_stores at tomorrow's (or any date's) SAS visit ids and bootstrap
 * section_state from hub fixture catalogs so Checklanes hub is live.
 *
 *   node scripts/enable-checklane-visits-for-date.js [--date YYYY-MM-DD] [--dry-run]
 *
 * Uses schedules.supervisor / visit_lead rows for the date. Only stores with a
 * hub-fixtures catalog are updated.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { query, pool } = require('../src/lib/db');

const FIXTURES_DIR = path.join(__dirname, '../src/data/hub-fixtures');
const DRY_RUN = process.argv.includes('--dry-run');

function parseDateArg() {
  const idx = process.argv.indexOf('--date');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function listFixtureStores() {
  return fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadFixtures(storeNumber) {
  const p = path.join(FIXTURES_DIR, `${storeNumber}.json`);
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return data.fixtures || [];
}

async function main() {
  const targetDate = parseDateArg();
  const fixtureStores = new Set(listFixtureStores());
  console.log(`[enable-visits] date=${targetDate} fixtureStores=${fixtureStores.size} dryRun=${DRY_RUN}`);

  const { rows: schedules } = await query(
    `SELECT visit_id, store_number, store_name, visit_lead, supervisor, scheduled_date
     FROM schedules
     WHERE scheduled_date = $1::date
     ORDER BY store_number::int, visit_id`,
    [targetDate],
  );

  if (!schedules.length) {
    console.warn(`[enable-visits] No schedules for ${targetDate}`);
    process.exit(1);
  }

  const byStore = new Map();
  for (const row of schedules) {
    const sn = String(Number(row.store_number) || row.store_number);
    if (!fixtureStores.has(sn)) continue;
    if (!byStore.has(sn)) byStore.set(sn, row);
  }

  if (!byStore.size) {
    console.warn('[enable-visits] No scheduled stores overlap hub fixture catalogs');
    process.exit(1);
  }

  let storesUpdated = 0;
  let sectionsInserted = 0;

  for (const [storeNumber, sched] of byStore.entries()) {
    const visitId = Number(sched.visit_id);
    const fixtures = loadFixtures(storeNumber);
    const manifest = fixtures.filter((f) => f.on_manifest && f.dbkey);
    console.log(
      `[enable-visits] store ${storeNumber} → visit ${visitId} `
      + `(${manifest.length} manifest sections, lead=${sched.visit_lead || '—'})`,
    );

    if (!DRY_RUN) {
      await query(
        `INSERT INTO hub_stores (store_number, name, default_visit_id, is_test)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT (store_number) DO UPDATE SET
           default_visit_id = EXCLUDED.default_visit_id,
           name = COALESCE(hub_stores.name, EXCLUDED.name)`,
        [storeNumber, sched.store_name || `FM ${storeNumber}`, visitId],
      );
      storesUpdated += 1;

      for (const f of manifest) {
        const { rowCount } = await query(
          `INSERT INTO section_state (visit_id, lane, dbkey, state)
           VALUES ($1, $2, $3, 'not_started')
           ON CONFLICT (visit_id, lane, dbkey) DO NOTHING`,
          [visitId, f.lane || '', f.dbkey],
        );
        sectionsInserted += rowCount || 0;
      }
    }
  }

  console.log(
    `[enable-visits] Done. stores=${byStore.size} updated=${storesUpdated} `
    + `newSections=${sectionsInserted}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error('[enable-visits] Failed:', err.message);
  process.exit(1);
});
