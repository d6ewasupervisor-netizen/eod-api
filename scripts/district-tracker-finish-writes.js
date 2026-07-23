#!/usr/bin/env node
'use strict';

/**
 * Finish district tracker writes from cached reconcile proposals + remediation reports.
 * Merges prod-to-si and si-to-prod completed keys; writes reconcile + working copies.
 */

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
    outDir: process.env.TRACKER_OUT_DIR || 'C:/Users/tgaut/Downloads/tracking_new',
    label: process.env.TRACKER_LABEL || 'D6D8',
    writesCache: null,
    confirmedCache: null,
    yesOnly: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--writes-cache') opts.writesCache = argv[++i];
    else if (arg === '--confirmed-cache') opts.confirmedCache = argv[++i];
    else if (arg === '--yes-only') opts.yesOnly = true;
    else if (arg === '--write-all-kl') opts.yesOnly = false;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/district-tracker-finish-writes.js --out-dir PATH --label D1 [--yes-only|--write-all-kl]');
      process.exit(0);
    }
  }
  return opts;
}

const CLI = parseArgs(process.argv);
const OUT_DIR = CLI.outDir;
const RUN_LABEL = CLI.label;
const WRITES_CACHE = CLI.writesCache || path.join(OUT_DIR, `${RUN_LABEL}_writes_cache.json`);
const CONFIRMED_CACHE_PATH = CLI.confirmedCache || defaultConfirmedCachePath(OUT_DIR, RUN_LABEL);

function workbookPaths(kind) {
  const ext = kind === 'ise' ? 'xlsm' : 'xlsx';
  const base = kind === 'ise' ? 'SUPER Tracker ISE V1.3' : 'SUPER Tracker Blitz V1.3';
  return [
    path.join(OUT_DIR, `${base} - ${RUN_LABEL} reconcile copy.${ext}`),
    path.join(OUT_DIR, `${base} - ${RUN_LABEL} copy.${ext}`),
  ];
}

function normalizeReconcileKey(key) {
  if (!key) return '';
  const parts = String(key).split('|');
  if (parts.length !== 4) return String(key);
  const [pw, store, cat, dbkey] = parts;
  const match = String(pw).match(/^P0?(\d{1,2})W([1-4])$/i);
  const normPw = match ? `P${String(Number(match[1])).padStart(2, '0')}W${Number(match[2])}` : pw;
  return `${normPw}|${String(Number(store))}|${String(Number(cat))}|${dbkey}`;
}

function loadNeedsLoadedComments() {
  const sitoprodDir = path.join(OUT_DIR, 'sitoprod');
  if (!fs.existsSync(sitoprodDir)) return new Map();
  const files = fs.readdirSync(sitoprodDir)
    .filter((f) => f.startsWith('si-to-prod-backfill_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return new Map();
  const report = JSON.parse(fs.readFileSync(path.join(sitoprodDir, files[0]), 'utf8'));
  const SHIFT_MISS = /No SAS visit|No active lead shift|visit not found|no lead shift|POG not on visit/i;
  const comments = new Map();
  for (const batch of report.batches || []) {
    for (const set of batch.sets || []) {
      if (set.status === 'completed') continue;
      const reason = set.reason || batch.reason || '';
      if (SHIFT_MISS.test(String(reason))) {
        comments.set(normalizeReconcileKey(set.key), 'needs loaded to PROD');
      }
    }
  }
  return comments;
}

function loadCompletedKeysFromProdToSi() {
  const summaryPath = path.join(OUT_DIR, 'prod-to-si-closeout', 'summary.json');
  if (!fs.existsSync(summaryPath)) return new Set();
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const keys = new Set();
  for (const row of [...(summary.completed || []), ...(summary.trackerWritePlan || [])]) {
    keys.add(normalizeReconcileKey(row.key));
  }
  return keys;
}

function loadCompletedKeysFromSiToProd() {
  const sitoprodDir = path.join(OUT_DIR, 'sitoprod');
  if (!fs.existsSync(sitoprodDir)) return new Set();
  const files = fs.readdirSync(sitoprodDir)
    .filter((f) => f.startsWith('si-to-prod-backfill_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return new Set();
  const report = JSON.parse(fs.readFileSync(path.join(sitoprodDir, files[0]), 'utf8'));
  const keys = new Set();
  for (const batch of report.batches || []) {
    for (const set of batch.sets || []) {
      if (set.status === 'completed') keys.add(normalizeReconcileKey(set.key));
    }
  }
  return keys;
}

function mergeWrites(writes, completedKeys, needsLoadedComments) {
  return writes.map((row) => {
    const key = normalizeReconcileKey(row.key);
    if (completedKeys.has(key)) return { ...row, K: 'Yes', L: '' };
    if (needsLoadedComments.has(key)) {
      return { ...row, K: 'No', L: needsLoadedComments.get(key) };
    }
    return row;
  });
}

function writeTrackerCells(workbookPath, sheetName, updates) {
  if (!updates.length) return { written: 0, backupPath: null };
  console.log(`Writing ${updates.length} rows -> ${path.basename(workbookPath)}`);
  const payload = JSON.stringify({ rows: updates.map(({ rowIndex, K, L }) => ({ rowIndex, K, L: L ?? '' })) });
  const scriptPath = path.resolve(__dirname, 'write_tracker.py');
  const result = spawnSync('python', [scriptPath, workbookPath, sheetName], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`write_tracker.py failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || '{}');
}

function countOutcomes(writes) {
  const counts = { yes: 0, needsSi: 0, needsProd: 0, needsLoaded: 0, unconfirmed: 0 };
  for (const row of writes) {
    const l = String(row.L || '').toLowerCase();
    if (row.K === 'Yes') counts.yes += 1;
    else if (l.includes('needs si complete')) counts.needsSi += 1;
    else if (l.includes('needs loaded to prod')) counts.needsLoaded += 1;
    else if (l.includes('needs prod complete')) counts.needsProd += 1;
    else counts.unconfirmed += 1;
  }
  return counts;
}

async function main() {
  if (!fs.existsSync(WRITES_CACHE)) {
    throw new Error(`Writes cache missing: ${WRITES_CACHE}. Re-run d6-d8-tracking-reconcile.js first.`);
  }
  const cache = JSON.parse(await fsp.readFile(WRITES_CACHE, 'utf8'));
  const completedKeys = new Set([
    ...loadCompletedKeysFromProdToSi(),
    ...loadCompletedKeysFromSiToProd(),
  ]);
  const needsLoadedComments = loadNeedsLoadedComments();

  // Diagnostic L text stays in reports/counts; tracker cells stay comment-clean.
  // Default: Yes-only (incomplete rows left as-is on the copy).
  const iseWritesRaw = mergeWrites(cache.ise || [], completedKeys, needsLoadedComments);
  const blitzWritesRaw = mergeWrites(cache.blitz || [], completedKeys, needsLoadedComments);
  const filterForTracker = (rows) => {
    const cleaned = rows.map((row) => ({ ...row, L: '' }));
    return CLI.yesOnly ? cleaned.filter((row) => row.K === 'Yes') : cleaned;
  };
  const iseWrites = filterForTracker(iseWritesRaw);
  const blitzWrites = filterForTracker(blitzWritesRaw);
  console.log(`Yes-only=${CLI.yesOnly} tracker writes: ise=${iseWrites.length} blitz=${blitzWrites.length}`);
  console.log(`Diagnostic outcomes ise=${JSON.stringify(countOutcomes(iseWritesRaw))} blitz=${JSON.stringify(countOutcomes(blitzWritesRaw))}`);

  const writeResults = { ise: [], blitz: [] };
  for (const kind of ['ise', 'blitz']) {
    const writes = kind === 'ise' ? iseWrites : blitzWrites;
    const sheetName = workbookForKind(kind).sheetName;
    for (const workbookPath of workbookPaths(kind)) {
      if (!fs.existsSync(workbookPath)) {
        // Create working copy from reconcile copy if missing.
        const [reconcilePath, workingPath] = workbookPaths(kind);
        if (workbookPath === workingPath && fs.existsSync(reconcilePath)) {
          fs.copyFileSync(reconcilePath, workingPath);
          console.log(`Created working copy from reconcile: ${workingPath}`);
        } else {
          throw new Error(`Missing workbook: ${workbookPath}`);
        }
      }
      writeResults[kind].push({ path: workbookPath, result: writeTrackerCells(workbookPath, sheetName, writes) });
    }
  }

  // Preserve full diagnostic proposals; only tracker cells get the yes-only subset.
  const mergedCache = {
    ...cache,
    writtenToTracker: {
      yesOnly: CLI.yesOnly,
      ise: iseWrites,
      blitz: blitzWrites,
    },
    // Keep original proposal list (pre-filter) for reports / delta baseline.
    ise: iseWritesRaw,
    blitz: blitzWritesRaw,
    finishMergedAt: new Date().toISOString(),
  };
  await fsp.writeFile(WRITES_CACHE, JSON.stringify(mergedCache, null, 2));

  const confirmedCache = loadConfirmedSetsSync(CONFIRMED_CACHE_PATH);
  const yesEntries = [
    ...iseWritesRaw.filter((r) => r.K === 'Yes').map((r) => ({ key: r.key, workbookKind: 'ise' })),
    ...blitzWritesRaw.filter((r) => r.K === 'Yes').map((r) => ({ key: r.key, workbookKind: 'blitz' })),
    ...[...completedKeys].map((key) => ({ key, source: 'finish-writes-remediation' })),
  ];
  const confirmUpsert = upsertConfirmed(confirmedCache, yesEntries, {
    source: 'finish-writes',
    label: RUN_LABEL,
  });
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
    mode: 'finish-writes',
    label: RUN_LABEL,
    periodRange: cache.periodRange,
    copies: { ise: workbookPaths('ise'), blitz: workbookPaths('blitz') },
    writeResults,
    confirmedSets: {
      path: CONFIRMED_CACHE_PATH,
      added: confirmUpsert.added,
      total: confirmUpsert.total,
    },
    counts: {
      ise: countOutcomes(iseWritesRaw),
      blitz: countOutcomes(blitzWritesRaw),
    },
    completedKeyCount: completedKeys.size,
    needsLoadedKeyCount: needsLoadedComments.size,
  };

  const summaryPath = path.join(OUT_DIR, `${RUN_LABEL}_reconcile_summary_${stamp}.json`);
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n=== ${RUN_LABEL} finish writes complete ===`);
  console.log(`Marked Yes: ise=${summary.counts.ise.yes} blitz=${summary.counts.blitz.yes}`);
  console.log(`Needs SI: ise=${summary.counts.ise.needsSi} | Needs loaded: ise=${summary.counts.ise.needsLoaded}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
