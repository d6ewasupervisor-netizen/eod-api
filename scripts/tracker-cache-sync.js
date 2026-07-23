#!/usr/bin/env node
'use strict';

/**
 * Sync district tracker caches with Railway eod-api volume.
 *
 *   node scripts/tracker-cache-sync.js --pull --label D6D8
 *   node scripts/tracker-cache-sync.js --push --label D6D8
 *   node scripts/tracker-cache-sync.js --pull --push --label D1 --out-dir "C:/Users/tgaut/Downloads/p06w2_district1"
 *   node scripts/tracker-cache-sync.js --list
 *
 * Requires SAS_AUTH_SECRET (same as Railway eod-api).
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  defaultConfirmedCachePath,
} = require('../src/lib/trackers/confirmed-sets-cache');
const {
  remoteEnabled,
  apiBaseUrl,
  listRemoteCaches,
  pullConfirmedSets,
  pushConfirmedSets,
  pullWritesCache,
  pushWritesCache,
} = require('../src/lib/trackers/tracker-cache-remote');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function parseArgs(argv) {
  const opts = {
    label: process.env.TRACKER_LABEL || 'D6D8',
    outDir: process.env.TRACKER_OUT_DIR || 'C:/Users/tgaut/Downloads/tracking_new',
    pull: false,
    push: false,
    list: false,
    writes: true,
    confirmed: true,
    replace: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--pull') opts.pull = true;
    else if (arg === '--push') opts.push = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--replace') opts.replace = true;
    else if (arg === '--confirmed-only') { opts.confirmed = true; opts.writes = false; }
    else if (arg === '--writes-only') { opts.confirmed = false; opts.writes = true; }
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/tracker-cache-sync.js [--pull] [--push] [--list] --label D6D8 --out-dir PATH',
        '  --confirmed-only / --writes-only',
        '  --replace   full replace on push (confirmed sets default is merge)',
      ].join('\n'));
      process.exit(0);
    }
  }
  if (!opts.pull && !opts.push && !opts.list) opts.list = true;
  return opts;
}

async function main() {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const opts = parseArgs(process.argv);
  console.log(`API: ${apiBaseUrl()}`);
  if (!remoteEnabled() && !opts.list) {
    throw new Error('Set SAS_AUTH_SECRET in eod-api/.env (must match Railway).');
  }

  if (opts.list) {
    const listing = await listRemoteCaches();
    console.log(JSON.stringify(listing, null, 2));
  }

  const confirmedPath = defaultConfirmedCachePath(opts.outDir, opts.label);
  const writesPath = path.join(opts.outDir, `${opts.label}_writes_cache.json`);

  if (opts.pull) {
    if (opts.confirmed) {
      const result = await pullConfirmedSets({
        label: opts.label,
        localPath: confirmedPath,
        mergeLocal: true,
      });
      console.log(`[pull confirmed] ${opts.label}: total=${result.total} -> ${confirmedPath}`);
    }
    if (opts.writes) {
      const result = await pullWritesCache({ label: opts.label, localPath: writesPath });
      console.log(`[pull writes] ${opts.label}: exists=${result.exists} -> ${writesPath}`);
    }
  }

  if (opts.push) {
    if (opts.confirmed) {
      if (!fs.existsSync(confirmedPath)) {
        console.warn(`[push confirmed] skip missing ${confirmedPath}`);
      } else {
        const result = await pushConfirmedSets({
          label: opts.label,
          localPath: confirmedPath,
          replace: opts.replace,
        });
        console.log(`[push confirmed] ${opts.label}: remote sets=${result.remote?.counts?.sets} (${opts.replace ? 'replace' : 'merge'})`);
      }
    }
    if (opts.writes) {
      if (!fs.existsSync(writesPath)) {
        console.warn(`[push writes] skip missing ${writesPath}`);
      } else {
        const result = await pushWritesCache({ label: opts.label, localPath: writesPath });
        console.log(`[push writes] ${opts.label}: ise=${result.remote?.counts?.ise} blitz=${result.remote?.counts?.blitz}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
