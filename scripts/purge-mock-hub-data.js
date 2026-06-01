#!/usr/bin/env node
/**
 * Remove mock Kompass cycle 242292, synthetic 99999* visits, and hub test data.
 *
 *   node scripts/purge-mock-hub-data.js [--resync]
 *
 * Optional --resync runs sync-checklane-visits-from-prod.js after purge.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { pool } = require('../src/lib/db');
const { purgeMockHubData } = require('../src/lib/purge-mock-hub-data');

async function main() {
  const counts = await purgeMockHubData(pool);
  console.log('[purge] Removed mock hub data:', counts);

  if (process.argv.includes('--resync')) {
    const syncScript = path.join(__dirname, 'sync-checklane-visits-from-prod.js');
    console.log('[purge] Re-syncing live blitz visits…');
    const result = spawnSync(process.execPath, [syncScript], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[purge] Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
