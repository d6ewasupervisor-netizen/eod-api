#!/usr/bin/env node
'use strict';

/**
 * Finish D6/D8 tracker writes from cached reconcile proposals + remediation reports.
 * Use when the main reconcile run completed cross-ref but was interrupted before write.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { workbookForKind } = require('../src/lib/trackers/tracker-workbooks');

const OUT_DIR = 'C:/Users/tgaut/Downloads/tracking_new';
const ISE_COPY = path.join(OUT_DIR, 'SUPER Tracker ISE V1.3 - D6D8 reconcile copy.xlsm');
const BLITZ_COPY = path.join(OUT_DIR, 'SUPER Tracker Blitz V1.3 - D6D8 reconcile copy.xlsx');
const WRITES_CACHE = path.join(OUT_DIR, 'D6D8_writes_cache.json');

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

function mergeWrites(writes, completedKeys, needsLoadedComments) {
  return writes.map((row) => {
    const key = normalizeReconcileKey(row.key);
    if (completedKeys.has(key)) return { ...row, K: 'Yes', L: '' };
    if (needsLoadedComments.has(key)) {
      return { ...row, K: 'No', L: needsLoadedComments.get(key) };
    }
    if (row.L === 'needs PROD complete' && needsLoadedComments.has(key)) {
      return { ...row, L: needsLoadedComments.get(key) };
    }
    return row;
  });
}

function writeTrackerCells(workbookPath, sheetName, updates) {
  if (!updates.length) return { written: 0, backup: null };
  const payload = JSON.stringify({ rows: updates.map(({ rowIndex, K, L }) => ({ rowIndex, K, L })) });
  const scriptPath = path.resolve(__dirname, 'write_tracker.py');
  const result = spawnSync('python', [scriptPath, workbookPath, sheetName], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
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
  const completedKeys = loadCompletedKeysFromProdToSi();
  const needsLoadedComments = loadNeedsLoadedComments();

  const iseWrites = mergeWrites(cache.ise || [], completedKeys, needsLoadedComments);
  const blitzWrites = mergeWrites(cache.blitz || [], completedKeys, needsLoadedComments);

  const iseResult = writeTrackerCells(ISE_COPY, workbookForKind('ise').sheetName, iseWrites);
  const blitzResult = writeTrackerCells(BLITZ_COPY, workbookForKind('blitz').sheetName, blitzWrites);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'finish-writes',
    periodRange: cache.periodRange,
    copies: { ise: ISE_COPY, blitz: BLITZ_COPY },
    writeResults: { ise: iseResult, blitz: blitzResult },
    counts: {
      ise: countOutcomes(iseWrites),
      blitz: countOutcomes(blitzWrites),
    },
    needsLoadedKeys: [...needsLoadedComments.entries()],
    prodToSiCompletedKeys: [...completedKeys],
  };

  const summaryPath = path.join(OUT_DIR, `D6D8_reconcile_summary_${stamp}.json`);
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log('=== D6/D8 finish writes complete ===');
  console.log(`ISE: ${iseResult.written || iseWrites.length} rows`);
  console.log(`Blitz: ${blitzResult.written || blitzWrites.length} rows`);
  console.log(`Marked Yes: ise=${summary.counts.ise.yes} blitz=${summary.counts.blitz.yes}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
