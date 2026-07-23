#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workbookForKind } = require('../src/lib/trackers/tracker-workbooks');
const {
  defaultConfirmedCachePath,
  loadConfirmedSetsSync,
  saveConfirmedSets,
  upsertConfirmed,
} = require('../src/lib/trackers/confirmed-sets-cache');
const {
  remoteEnabled,
  pushConfirmedSets,
} = require('../src/lib/trackers/tracker-cache-remote');

function parseArgs(argv) {
  const opts = {
    outDir: process.env.TRACKER_OUT_DIR || process.env.D1_OUT_DIR || 'C:/Users/tgaut/Downloads/p06w2_district1',
    label: process.env.TRACKER_LABEL || 'D1',
    deltaJson: process.env.TRACKER_DELTA_JSON || process.env.D1_DELTA_JSON || null,
    writesCache: null,
    confirmedCache: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--delta-json') opts.deltaJson = argv[++i];
    else if (arg === '--writes-cache') opts.writesCache = argv[++i];
    else if (arg === '--confirmed-cache') opts.confirmedCache = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/district-tracker-apply-delta-writes.js --out-dir PATH --label D1 --delta-json PATH');
      process.exit(0);
    }
  }
  return opts;
}

const CLI = parseArgs(process.argv);
const OUT_DIR = CLI.outDir;
const RUN_LABEL = CLI.label;
const DELTA_JSON_ARG = CLI.deltaJson;
const WRITES_CACHE = CLI.writesCache || path.join(OUT_DIR, `${RUN_LABEL}_writes_cache.json`);
const CONFIRMED_CACHE_PATH = CLI.confirmedCache || defaultConfirmedCachePath(OUT_DIR, RUN_LABEL);

function resolveDeltaJson() {
  if (DELTA_JSON_ARG) return DELTA_JSON_ARG;
  const files = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(`${RUN_LABEL}_delta_scan_`) && f.endsWith('.json')).sort().reverse()
    : [];
  if (!files.length) throw new Error(`No ${RUN_LABEL}_delta_scan_*.json in ${OUT_DIR}; pass --delta-json`);
  return path.join(OUT_DIR, files[0]);
}

function workbookPaths(kind) {
  const ext = kind === 'ise' ? 'xlsm' : 'xlsx';
  const base = kind === 'ise' ? 'SUPER Tracker ISE V1.3' : 'SUPER Tracker Blitz V1.3';
  return [
    path.join(OUT_DIR, `${base} - ${RUN_LABEL} reconcile copy.${ext}`),
    path.join(OUT_DIR, `${base} - ${RUN_LABEL} copy.${ext}`),
  ];
}

const WORKBOOKS = {
  ise: workbookPaths('ise'),
  blitz: workbookPaths('blitz'),
};

function normalizeKey(key) {
  if (!key) return '';
  const parts = String(key).split('|');
  if (parts.length !== 4) return String(key);
  const [pw, store, cat, dbkey] = parts;
  const match = String(pw).match(/^P0?(\d{1,2})W([1-4])$/i);
  const normPw = match ? `P${String(Number(match[1])).padStart(2, '0')}W${Number(match[2])}` : pw;
  return `${normPw}|${String(Number(store))}|${String(Number(cat))}|${dbkey}`;
}

function writeTrackerCells(workbookPath, sheetName, updates) {
  if (!updates.length) return { written: 0, backupPath: null };
  console.log(`Writing ${updates.length} rows -> ${path.basename(workbookPath)}`);
  const payload = JSON.stringify({
    rows: updates.map(({ rowIndex, K, L }) => ({ rowIndex, K, L: L ?? '' })),
  });
  const scriptPath = path.resolve(__dirname, 'write_tracker.py');
  const result = spawnSync('python', [scriptPath, workbookPath, sheetName], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`write_tracker.py failed for ${workbookPath}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || '{}');
}

function countOutcomes(rows) {
  const counts = { yes: 0, needsSi: 0, needsProd: 0, needsLoaded: 0, unconfirmed: 0 };
  for (const row of rows) {
    const l = String(row.L || '').toLowerCase();
    if (row.K === 'Yes') counts.yes += 1;
    else if (l.includes('needs si complete')) counts.needsSi += 1;
    else if (l.includes('needs loaded to prod')) counts.needsLoaded += 1;
    else if (l.includes('needs prod complete')) counts.needsProd += 1;
    else counts.unconfirmed += 1;
  }
  return counts;
}

function applyChangesToCache(cache, changes) {
  const byKind = { ise: new Map(), blitz: new Map() };
  for (const change of changes) {
    byKind[change.workbookKind].set(normalizeKey(change.key), {
      K: change.after.K,
      L: change.after.L ?? '',
    });
  }
  const next = { ...cache, deltaAppliedAt: new Date().toISOString() };
  for (const kind of ['ise', 'blitz']) {
    next[kind] = (cache[kind] || []).map((row) => {
      const patch = byKind[kind].get(normalizeKey(row.key));
      return patch ? { ...row, K: patch.K, L: patch.L } : row;
    });
  }
  return next;
}

async function main() {
  const DELTA_JSON = resolveDeltaJson();
  if (!fs.existsSync(DELTA_JSON)) throw new Error(`Missing delta report: ${DELTA_JSON}`);
  const delta = JSON.parse(await fsp.readFile(DELTA_JSON, 'utf8'));
  const changes = delta.changes || [];
  if (!changes.length) throw new Error('No changes in delta report');

  const byKind = { ise: [], blitz: [] };
  for (const change of changes) {
    byKind[change.workbookKind].push({
      rowIndex: change.rowIndex,
      K: change.after.K,
      L: change.after.L ?? '',
      key: change.key,
    });
  }

  const writeResults = { ise: [], blitz: [] };
  for (const kind of ['ise', 'blitz']) {
    const updates = byKind[kind];
    const sheetName = workbookForKind(kind).sheetName;
    for (const workbookPath of WORKBOOKS[kind]) {
      if (!fs.existsSync(workbookPath)) throw new Error(`Missing workbook: ${workbookPath}`);
      writeResults[kind].push({
        path: workbookPath,
        result: writeTrackerCells(workbookPath, sheetName, updates),
      });
    }
  }

  const cache = JSON.parse(await fsp.readFile(WRITES_CACHE, 'utf8'));
  const updatedCache = applyChangesToCache(cache, changes);
  await fsp.writeFile(WRITES_CACHE, JSON.stringify(updatedCache, null, 2));

  const newlyYes = changes.filter((c) => c.after?.K === 'Yes');
  const confirmedCache = loadConfirmedSetsSync(CONFIRMED_CACHE_PATH);
  const confirmUpsert = upsertConfirmed(
    confirmedCache,
    newlyYes.map((c) => ({
      key: c.key,
      workbookKind: c.workbookKind,
      source: 'delta-apply-both-complete',
    })),
    { source: 'apply-delta', label: RUN_LABEL },
  );
  await saveConfirmedSets(CONFIRMED_CACHE_PATH, confirmedCache);
  console.log(`[confirmed-sets] saved ${confirmUpsert.total} keys (+${confirmUpsert.added}) -> ${CONFIRMED_CACHE_PATH}`);
  if (remoteEnabled()) {
    try {
      const pushed = await pushConfirmedSets({ label: RUN_LABEL, cache: confirmedCache });
      console.log(`[confirmed-sets] pushed Railway sets=${pushed.remote?.counts?.sets}`);
    } catch (err) {
      console.warn(`[confirmed-sets] Railway push failed: ${err.message}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'apply-delta-writes',
    sourceDelta: DELTA_JSON,
    baselineGeneratedAt: delta.baselineGeneratedAt,
    focusPeriods: delta.focusPeriods,
    appliedChanges: changes.length,
    newlyYes: (delta.summary?.newlyYesRows || newlyYes).length,
    confirmedSets: {
      path: CONFIRMED_CACHE_PATH,
      added: confirmUpsert.added,
      total: confirmUpsert.total,
    },
    writeResults,
    counts: {
      ise: countOutcomes(updatedCache.ise || []),
      blitz: countOutcomes(updatedCache.blitz || []),
    },
    stillOpen: {
      ise: (updatedCache.ise || []).filter((r) => r.K !== 'Yes').length,
      blitz: (updatedCache.blitz || []).filter((r) => r.K !== 'Yes').length,
    },
  };

  const summaryPath = path.join(OUT_DIR, `${RUN_LABEL}_delta_apply_summary_${stamp}.json`);
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n=== ${RUN_LABEL} delta apply complete ===`);
  console.log(`Applied ${changes.length} cell updates (${summary.newlyYes} newly Yes)`);
  console.log(`ISE: Yes=${summary.counts.ise.yes} open=${summary.stillOpen.ise}`);
  console.log(`Blitz: Yes=${summary.counts.blitz.yes} open=${summary.stillOpen.blitz}`);
  console.log(`Total Yes=${summary.counts.ise.yes + summary.counts.blitz.yes}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
