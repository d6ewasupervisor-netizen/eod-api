#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function parseArgs(argv) {
  const opts = {
    outDir: process.env.TRACKER_OUT_DIR || process.env.D1_OUT_DIR || 'C:/Users/tgaut/Downloads/p06w2_district1',
    label: process.env.TRACKER_LABEL || 'D1',
    deltaPeriods: process.env.TRACKER_DELTA_PERIODS || process.env.D1_DELTA_PERIODS || 'P06W1,P06W2',
    writesCache: null,
    confirmedCache: null,
    recheckConfirmed: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--delta-periods') opts.deltaPeriods = argv[++i];
    else if (arg === '--writes-cache') opts.writesCache = argv[++i];
    else if (arg === '--confirmed-cache') opts.confirmedCache = argv[++i];
    else if (arg === '--recheck-confirmed') opts.recheckConfirmed = true;
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/district-tracker-delta-scan.js --out-dir PATH --label D1 [--delta-periods P06W1,P06W2]',
        '  --confirmed-cache path   Durable both-complete cache (default {out}/{label}_confirmed_sets.json)',
        '  --recheck-confirmed      Also re-fetch rows already marked Yes / in confirmed cache',
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

const CLI = parseArgs(process.argv);
const OUT_DIR = CLI.outDir;
const RUN_LABEL = CLI.label;
const FOCUS_PERIODS = String(CLI.deltaPeriods || '').toLowerCase() === 'all'
  ? []
  : String(CLI.deltaPeriods).split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
const ISE_COPY = path.join(OUT_DIR, `SUPER Tracker ISE V1.3 - ${RUN_LABEL} reconcile copy.xlsm`);
const BLITZ_COPY = path.join(OUT_DIR, `SUPER Tracker Blitz V1.3 - ${RUN_LABEL} reconcile copy.xlsx`);
const WRITES_CACHE = CLI.writesCache || path.join(OUT_DIR, `${RUN_LABEL}_writes_cache.json`);
const RECHECK_CONFIRMED = Boolean(CLI.recheckConfirmed);
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';

const sasBridge = require('../src/sas-bridge');
const reboticsBridge = require('../src/rebotics-bridge');
const { loadSasSession } = require('../../kompass-netcap/lib/sas-session');
const { periodWeekToRange } = require('../src/lib/trackers/snapshot-ingest');
const sasReports = require('../src/lib/trackers/sas-reports');
const reboticsReports = require('../src/lib/trackers/rebotics-reports');
const { classifyReconciliation } = require('../src/lib/trackers/sheet-reconciliation');
const { readTrackerWorkbookRaw, normalizeTrackerRow } = require('../src/lib/trackers/tracker-sheet-reader');
const {
  defaultConfirmedCachePath,
  loadConfirmedSetsSync,
  saveConfirmedSets,
  upsertConfirmed,
  seedFromWritesCache,
  isConfirmed,
} = require('../src/lib/trackers/confirmed-sets-cache');

const CONFIRMED_CACHE_PATH = CLI.confirmedCache || defaultConfirmedCachePath(OUT_DIR, RUN_LABEL);

function normalizeKey(key) {
  if (!key) return '';
  const parts = String(key).split('|');
  if (parts.length !== 4) return String(key);
  const [pw, store, cat, dbkey] = parts;
  const match = String(pw).match(/^P0?(\d{1,2})W([1-4])$/i);
  const normPw = match ? `P${String(Number(match[1])).padStart(2, '0')}W${Number(match[2])}` : pw;
  return `${normPw}|${String(Number(store))}|${String(Number(cat))}|${dbkey}`;
}

function loadReboticsApi() {
  const envPath = path.join(REBOTICS_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

async function bootstrapAuth() {
  const sas = await loadSasSession();
  if (!sas.cookieHeader || !sas.csrfToken) {
    throw new Error('SAS auth-state missing; refresh sas-auth session.');
  }
  sasBridge.applySession({
    cookieHeader: sas.cookieHeader,
    csrfToken: sas.csrfToken,
    source: sas.source,
  });
  const api = loadReboticsApi();
  const auth = await api.fetchTokenFromRailway();
  if (!auth?.token) throw new Error('Rebotics token unavailable.');
  reboticsBridge.getTokenForServer = () => auth.token;
  reboticsBridge.getUserIdForServer = () => auth.userId || api.DEFAULT_USER_ID || 211;
  console.log(`Auth OK: SAS=${sas.source} Rebotics=${auth.username || auth.userId || 'unknown'}`);
}

function inFocusPeriod(key) {
  if (!FOCUS_PERIODS.length) return true;
  return FOCUS_PERIODS.includes(normalizeKey(key).split('|')[0]);
}

function filterBaselineRows(rows, confirmedCache = null) {
  return rows.filter((r) => {
    if (!inFocusPeriod(r.key)) return false;
    if (RECHECK_CONFIRMED) return true;
    // Already both-complete: do not spend SI/PROD fetch budget re-checking.
    if (String(r.K || '').toLowerCase() === 'yes') return false;
    if (confirmedCache && isConfirmed(confirmedCache, r.key)) return false;
    return true;
  });
}

function loadBaselineMerged() {
  const cache = JSON.parse(fs.readFileSync(WRITES_CACHE, 'utf8'));
  const completed = new Set();
  const prodSummary = path.join(OUT_DIR, 'prod-to-si-closeout', 'summary.json');
  if (fs.existsSync(prodSummary)) {
    const s = JSON.parse(fs.readFileSync(prodSummary, 'utf8'));
    for (const row of [...(s.completed || []), ...(s.trackerWritePlan || [])]) {
      completed.add(normalizeKey(row.key));
    }
  }
  const sitoprodDir = path.join(OUT_DIR, 'sitoprod');
  if (fs.existsSync(sitoprodDir)) {
    const files = fs.readdirSync(sitoprodDir).filter((f) => f.startsWith('si-to-prod-backfill_') && f.endsWith('.json')).sort().reverse();
    if (files.length) {
      const report = JSON.parse(fs.readFileSync(path.join(sitoprodDir, files[0]), 'utf8'));
      for (const batch of report.batches || []) {
        for (const set of batch.sets || []) {
          if (set.status === 'completed') completed.add(normalizeKey(set.key));
        }
      }
    }
  }
  const needsLoaded = new Map();
  if (fs.existsSync(sitoprodDir)) {
    const files = fs.readdirSync(sitoprodDir).filter((f) => f.startsWith('si-to-prod-backfill_') && f.endsWith('.json')).sort().reverse();
    if (files.length) {
      const report = JSON.parse(fs.readFileSync(path.join(sitoprodDir, files[0]), 'utf8'));
      const SHIFT_MISS = /No SAS visit|No active lead shift|visit not found|no lead shift|POG not on visit/i;
      for (const batch of report.batches || []) {
        for (const set of batch.sets || []) {
          if (set.status === 'completed') continue;
          const reason = set.reason || batch.reason || '';
          if (SHIFT_MISS.test(String(reason))) {
            needsLoaded.set(normalizeKey(set.key), 'needs loaded to PROD');
          }
        }
      }
    }
  }
  function mergeRows(rows) {
    return (rows || []).map((row) => {
      const key = normalizeKey(row.key);
      if (completed.has(key)) return { ...row, K: 'Yes', L: '' };
      if (needsLoaded.has(key)) return { ...row, K: 'No', L: needsLoaded.get(key) };
      return row;
    });
  }
  const baseline = {
    generatedAt: cache.generatedAt,
    periodRange: cache.periodRange,
    ise: mergeRows(cache.ise),
    blitz: mergeRows(cache.blitz),
  };
  const byKey = new Map();
  for (const kind of ['ise', 'blitz']) {
    for (const row of baseline[kind]) byKey.set(`${kind}|${normalizeKey(row.key)}`, { ...row, workbookKind: kind });
  }
  return { baseline, byKey };
}

async function loadTrackerRowsByKeys(kind, workbookPath, keySet) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    const key = normalizeKey(`${row.periodWeek}|${row.store}|${row.categoryId}|${row.dbkey}`);
    if (!keySet.has(key)) continue;
    rows.push({ ...row, workbookKind: kind, key });
  }
  return rows;
}

function prodDone(proposal) {
  return proposal?.prod?.categoryCompletionStatus === 'done'
    || proposal?.prod?.completionStatus === 'done';
}

function siDone(proposal) {
  const status = String(proposal?.si?.status || '').toLowerCase();
  return status === 'done' || status === 'complete' || status === 'completed';
}

function trackerUpdate(proposal) {
  const pDone = prodDone(proposal);
  const sDone = siDone(proposal);
  if (pDone && sDone) return { K: 'Yes', L: '' };
  if (pDone && !sDone) return { K: 'No', L: 'needs SI complete' };
  if (!pDone && sDone) return { K: 'No', L: 'needs PROD complete' };
  const parts = [];
  const prodStatus = proposal?.prod?.categoryCompletionStatus || proposal?.prod?.completionStatus || 'absent';
  const siStatus = proposal?.si?.status || 'absent';
  if (!pDone) parts.push(`PROD not complete (${prodStatus})`);
  if (!sDone) parts.push(`SI not complete (${siStatus})`);
  return { K: 'No', L: parts.join('; ') };
}

async function fetchSourceRows(trackerRows) {
  const scopedRows = FOCUS_PERIODS.length
    ? trackerRows.filter((r) => FOCUS_PERIODS.includes(String(r.periodWeek || '').toUpperCase()))
    : trackerRows;
  const stores = [...new Set(scopedRows.map((r) => r.store))].sort((a, b) => Number(a) - Number(b));
  const ranges = [...new Set(scopedRows.map((r) => r.periodWeek))]
    .map(periodWeekToRange)
    .filter(Boolean);
  console.log(`Live fetch scope: periods=${FOCUS_PERIODS.join(',') || 'all'} rows=${scopedRows.length} ranges=${ranges.length} stores=${stores.length}`);
  const settings = { sasConcurrency: 4, reboticsConcurrency: 4, sasMaxAttempts: 4 };
  const prodRows = [];
  const siRows = [];
  const errors = [];
  for (const range of ranges) {
    try {
      const prod = await sasReports.fetchRows({ stores, dateFrom: range.dateFrom, dateTo: range.dateTo, settings });
      prodRows.push(...prod);
      console.log(`[prod] ${range.dateFrom}..${range.dateTo} rows=${prod.length}`);
    } catch (err) {
      errors.push({ range, source: 'prod', error: err.message });
    }
    try {
      const si = await reboticsReports.fetchRows({ stores, dates: range.dates, settings });
      siRows.push(...(si.rows || si));
      console.log(`[si] ${range.dateFrom}..${range.dateTo} rows=${(si.rows || si).length}`);
    } catch (err) {
      errors.push({ range, source: 'si', error: err.message });
    }
  }
  return { prodRows, siRows, errors };
}

function diffKind(kind, baselineRows, trackerRows, proposalByKey) {
  const baselineByKey = new Map(baselineRows.map((r) => [normalizeKey(r.key), r]));
  const changes = [];
  let skippedOutsideFocus = 0;
  for (const [key, base] of baselineByKey) {
    const periodWeek = key.split('|')[0];
    if (FOCUS_PERIODS.length && !FOCUS_PERIODS.includes(periodWeek)) {
      skippedOutsideFocus += 1;
      continue;
    }
    const proposal = proposalByKey.get(key);
    const update = proposal ? trackerUpdate(proposal) : null;
    const live = proposal ? {
      prodDone: prodDone(proposal),
      siDone: siDone(proposal),
      prodStatus: proposal.prod?.categoryCompletionStatus || proposal.prod?.completionStatus || 'absent',
      siStatus: proposal.si?.status || 'absent',
      K: update.K,
      L: update.L,
    } : null;
    const prev = { K: base.K, L: base.L || '' };
    const statusChanged = live && (prev.K !== live.K || prev.L !== live.L);
    if (statusChanged) {
      changes.push({
        workbookKind: kind,
        key,
        rowIndex: base.rowIndex,
        store: key.split('|')[1],
        periodWeek: key.split('|')[0],
        categoryId: key.split('|')[2],
        dbkey: key.split('|')[3],
        before: prev,
        after: live ? { K: live.K, L: live.L, prodDone: live.prodDone, siDone: live.siDone, prodStatus: live.prodStatus, siStatus: live.siStatus } : null,
        changeType: !live ? 'missing_live_data' : (prev.K !== live.K ? 'K_change' : 'L_change'),
      });
    }
  }
  return { kind, trackerRows: trackerRows.length, changes, skippedOutsideFocus };
}

async function classifyKind(kind, workbookPath, baselineRows, sharedFetch) {
  const keySet = new Set(baselineRows.map((r) => normalizeKey(r.key)));
  const trackerRows = await loadTrackerRowsByKeys(kind, workbookPath, keySet);
  console.log(`[${kind}] baseline=${baselineRows.length} trackerRows=${trackerRows.length}`);
  const classified = classifyReconciliation({
    trackerRows,
    prodRows: sharedFetch.prodRows,
    siRows: sharedFetch.siRows,
    projectMode: true,
    suppressAlreadySatisfied: false,
  });
  const proposalByKey = new Map(classified.proposals.map((p) => [normalizeKey(p.key), p]));
  const result = diffKind(kind, baselineRows, trackerRows, proposalByKey);
  return {
    ...result,
    prodRows: sharedFetch.prodRows.length,
    siRows: sharedFetch.siRows.length,
    errors: sharedFetch.errors,
    proposalCount: classified.proposals.length,
  };
}

function summarizeChanges(allChanges) {
  const newlyYes = allChanges.filter((c) => c.before.K !== 'Yes' && c.after?.K === 'Yes');
  const lostYes = allChanges.filter((c) => c.before.K === 'Yes' && c.after?.K !== 'Yes');
  const noteOnly = allChanges.filter((c) => c.before.K === c.after?.K && c.before.K !== 'Yes' && c.before.L !== c.after?.L);
  const byType = {};
  for (const c of allChanges) byType[c.changeType] = (byType[c.changeType] || 0) + 1;
  return { total: allChanges.length, newlyYes: newlyYes.length, lostYes: lostYes.length, noteOnly: noteOnly.length, byType, newlyYesRows: newlyYes, lostYesRows: lostYes, noteOnlyRows: noteOnly };
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`=== ${RUN_LABEL} delta scan out=${OUT_DIR} ===`);
  const { baseline } = loadBaselineMerged();
  let confirmedCache = loadConfirmedSetsSync(CONFIRMED_CACHE_PATH);
  if (!Object.keys(confirmedCache.sets || {}).length && fs.existsSync(WRITES_CACHE)) {
    const writesCache = JSON.parse(fs.readFileSync(WRITES_CACHE, 'utf8'));
    // Prefer merged baseline (includes remediation Yes) when seeding an empty cache.
    seedFromWritesCache(confirmedCache, baseline, {
      source: 'seed-delta-baseline',
      label: RUN_LABEL,
    });
    seedFromWritesCache(confirmedCache, writesCache, {
      source: 'seed-writes-cache',
      label: RUN_LABEL,
    });
    if (Object.keys(confirmedCache.sets).length) {
      await saveConfirmedSets(CONFIRMED_CACHE_PATH, confirmedCache);
      confirmedCache = loadConfirmedSetsSync(CONFIRMED_CACHE_PATH);
      console.log(`[confirmed-sets] seeded ${Object.keys(confirmedCache.sets).length} keys -> ${CONFIRMED_CACHE_PATH}`);
    }
  } else {
    console.log(
      `[confirmed-sets] loaded ${Object.keys(confirmedCache.sets || {}).length} keys`
      + (RECHECK_CONFIRMED ? ' (--recheck-confirmed)' : ` from ${CONFIRMED_CACHE_PATH}`),
    );
  }

  console.log(`Focus periods: ${FOCUS_PERIODS.length ? FOCUS_PERIODS.join(', ') : 'all'} (--delta-periods to override)`);
  console.log(`Baseline from ${baseline.generatedAt} (${baseline.periodRange}): ise=${baseline.ise.length} blitz=${baseline.blitz.length}`);

  await bootstrapAuth();

  const iseFocus = filterBaselineRows(baseline.ise, confirmedCache);
  const blitzFocus = filterBaselineRows(baseline.blitz, confirmedCache);
  const iseInFocusTotal = baseline.ise.filter((r) => inFocusPeriod(r.key)).length;
  const blitzInFocusTotal = baseline.blitz.filter((r) => inFocusPeriod(r.key)).length;
  const iseSkippedYes = iseInFocusTotal - iseFocus.length;
  const blitzSkippedYes = blitzInFocusTotal - blitzFocus.length;
  console.log(`In-focus open rows: ise=${iseFocus.length}/${baseline.ise.length} blitz=${blitzFocus.length}/${baseline.blitz.length}`);
  if (!RECHECK_CONFIRMED) {
    console.log(`[confirmed-sets] skipped already-Yes/confirmed from fetch: ise=${iseSkippedYes} blitz=${blitzSkippedYes}`);
  }

  const iseKeys = new Set(iseFocus.map((r) => normalizeKey(r.key)));
  const blitzKeys = new Set(blitzFocus.map((r) => normalizeKey(r.key)));
  const iseTrackerRows = await loadTrackerRowsByKeys('ise', ISE_COPY, iseKeys);
  const blitzTrackerRows = await loadTrackerRowsByKeys('blitz', BLITZ_COPY, blitzKeys);
  const trackerByKey = new Map();
  for (const row of [...iseTrackerRows, ...blitzTrackerRows]) {
    trackerByKey.set(normalizeKey(row.key), row);
  }
  const allTrackerRows = [...trackerByKey.values()];
  console.log(`Combined tracker rows for fetch: ${allTrackerRows.length}`);
  const sharedFetch = await fetchSourceRows(allTrackerRows);

  const iseResult = await classifyKind('ise', ISE_COPY, iseFocus, sharedFetch);
  const blitzResult = await classifyKind('blitz', BLITZ_COPY, blitzFocus, sharedFetch);
  const allChanges = [...iseResult.changes, ...blitzResult.changes];
  const summary = summarizeChanges(allChanges);

  if (summary.newlyYesRows?.length) {
    const upsert = upsertConfirmed(
      confirmedCache,
      summary.newlyYesRows.map((r) => ({
        key: r.key,
        workbookKind: r.workbookKind,
        source: 'delta-scan-both-complete',
      })),
      { source: 'delta-scan', label: RUN_LABEL },
    );
    await saveConfirmedSets(CONFIRMED_CACHE_PATH, confirmedCache);
    console.log(`[confirmed-sets] +${upsert.added} newly Yes cached (total=${upsert.total})`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baselineGeneratedAt: baseline.generatedAt,
    periodRange: baseline.periodRange,
    focusPeriods: FOCUS_PERIODS,
    districts: [1],
    confirmedSets: {
      path: CONFIRMED_CACHE_PATH,
      total: Object.keys(confirmedCache.sets || {}).length,
      skippedFromFetch: { ise: iseSkippedYes, blitz: blitzSkippedYes },
      recheckConfirmed: RECHECK_CONFIRMED,
    },
    scopeRows: {
      ise: { total: baseline.ise.length, inFocus: iseFocus.length, skippedConfirmed: iseSkippedYes },
      blitz: { total: baseline.blitz.length, inFocus: blitzFocus.length, skippedConfirmed: blitzSkippedYes },
    },
    fetch: {
      ise: { trackerRows: iseResult.trackerRows, prodRows: iseResult.prodRows, siRows: iseResult.siRows, errors: iseResult.errors },
      blitz: { trackerRows: blitzResult.trackerRows, prodRows: blitzResult.prodRows, siRows: blitzResult.siRows, errors: blitzResult.errors },
    },
    summary: {
      ...summary,
      skippedOutsideFocus: (iseResult.skippedOutsideFocus || 0) + (blitzResult.skippedOutsideFocus || 0),
    },
    changes: allChanges,
  };

  const jsonPath = path.join(OUT_DIR, `${RUN_LABEL}_delta_scan_${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `${RUN_LABEL}_delta_scan_${stamp}.csv`);
  await fsp.writeFile(jsonPath, JSON.stringify(report, null, 2));
  const csvLines = [
    'workbookKind,key,store,periodWeek,categoryId,dbkey,beforeK,beforeL,afterK,afterL,prodDone,siDone,prodStatus,siStatus',
    ...allChanges.map((c) => [
      c.workbookKind, c.key, c.store, c.periodWeek, c.categoryId, c.dbkey,
      c.before.K, JSON.stringify(c.before.L),
      c.after?.K || '', JSON.stringify(c.after?.L || ''),
      c.after?.prodDone ?? '', c.after?.siDone ?? '', c.after?.prodStatus ?? '', c.after?.siStatus ?? '',
    ].join(',')),
  ];
  await fsp.writeFile(csvPath, `${csvLines.join('\n')}\n`);
  console.log('\n=== Delta summary ===');
  console.log(`Changes: ${summary.total} (newly Yes: ${summary.newlyYes}, lost Yes: ${summary.lostYes}, note-only: ${summary.noteOnly})`);
  console.log(`Skipped outside focus (${FOCUS_PERIODS.join('/')}): ${report.summary.skippedOutsideFocus}`);
  if (summary.newlyYesRows.length) {
    console.log('\nNewly both-complete (would flip to Yes):');
    for (const r of summary.newlyYesRows) console.log(`  ${r.workbookKind} ${r.key}`);
  }
  if (summary.noteOnlyRows.length) {
    console.log('\nNote/status changes (still No):');
    for (const r of summary.noteOnlyRows.slice(0, 20)) {
      console.log(`  ${r.workbookKind} ${r.key}: ${r.before.L} -> ${r.after?.L}`);
    }
    if (summary.noteOnlyRows.length > 20) console.log(`  ... +${summary.noteOnlyRows.length - 20} more`);
  }
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
