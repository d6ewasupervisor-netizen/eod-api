#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sasBridge = require('../src/sas-bridge');
const reboticsBridge = require('../src/rebotics-bridge');
const { loadSasSession } = require('../../kompass-netcap/lib/sas-session');
const { storesForDistricts } = require('../src/lib/trackers/metadata');
const { defaultFetchSourceRows, periodWeekToRange } = require('../src/lib/trackers/snapshot-ingest');
const sasReports = require('../src/lib/trackers/sas-reports');
const reboticsReports = require('../src/lib/trackers/rebotics-reports');
const { classifyReconciliation, normalizePeriodWeek } = require('../src/lib/trackers/sheet-reconciliation');
const {
  normalizeTrackerRow,
  readTrackerWorkbookRaw,
} = require('../src/lib/trackers/tracker-sheet-reader');
const { workbookForKind } = require('../src/lib/trackers/tracker-workbooks');

const LIVE_ISE = "C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker ISE V1.3.xlsm";
const LIVE_BLITZ = "C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker Blitz V1.3.xlsx";
const OUT_DIR = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify';
const PERIOD_START = 'P04W1';
const PERIOD_END = 'P05W4';
const DISTRICTS = [1, 6, 8];
const TASK_DATE = new Date().toISOString().slice(0, 10);
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';

function periodOrdinal(periodWeek) {
  const match = String(periodWeek || '').match(/^P(\d{2})W([1-4])$/i);
  if (!match) return null;
  return ((Number(match[1]) - 1) * 4) + Number(match[2]);
}

function periodsInRange(start, end) {
  const startOrd = periodOrdinal(start);
  const endOrd = periodOrdinal(end);
  const out = [];
  for (let period = 1; period <= 13; period += 1) {
    for (let week = 1; week <= 4; week += 1) {
      const label = `P${String(period).padStart(2, '0')}W${week}`;
      const ord = periodOrdinal(label);
      if (ord >= startOrd && ord <= endOrd) out.push(label);
    }
  }
  return out;
}

function normalizeCell(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function shouldIncludeRow(row) {
  const periodWeek = normalizePeriodWeek(row.periodWeek || row.pogId);
  if (!periodWeek) return false;
  if (periodOrdinal(periodWeek) > periodOrdinal(PERIOD_END)) return false;
  if (periodOrdinal(periodWeek) < periodOrdinal(PERIOD_START)) return false;
  const k = normalizeCell(row.currentK).toLowerCase();
  const l = normalizeCell(row.currentL);
  if (k === 'yes') return false;
  if (k === 'no' && l) return false;
  if (k === 'no' && !l) return true;
  if (!k) return true;
  return false;
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
    throw new Error('SAS auth-state missing cookieHeader/csrfToken; refresh sas-auth session.');
  }
  sasBridge.applySession({
    cookieHeader: sas.cookieHeader,
    csrfToken: sas.csrfToken,
    source: sas.source,
  });
  console.log(`SAS session applied from ${sas.source} generatedAt=${sas.generatedAt || 'unknown'}`);

  const api = loadReboticsApi();
  const auth = await api.fetchTokenFromRailway();
  if (!auth?.token) throw new Error('Rebotics token unavailable from Railway bridge.');
  reboticsBridge.getTokenForServer = () => auth.token;
  reboticsBridge.getUserIdForServer = () => auth.userId || api.DEFAULT_USER_ID || 211;
  console.log(`Rebotics auth: ${auth.username || auth.userId || 'unknown'}`);
}

async function loadScopedTrackerRows(kind, storeSet, periods) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath: kind === 'ise' ? LIVE_ISE : LIVE_BLITZ });
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!periods.has(row.periodWeek)) continue;
    if (!shouldIncludeRow(row)) continue;
    rows.push(row);
  }
  return rows;
}

function prodDone(proposal) {
  return proposal?.prod?.completionStatus === 'done';
}

function siDone(proposal) {
  return proposal?.si?.status === 'done';
}

function trackerUpdate(proposal) {
  const pDone = prodDone(proposal);
  const sDone = siDone(proposal);
  if (pDone && sDone) return { K: 'Yes', L: '' };
  if (pDone && !sDone) return { K: 'No', L: 'needs SI complete' };
  if (!pDone && sDone) return { K: 'No', L: 'needs PROD complete' };
  return { K: 'No', L: '' };
}

function isDiscrepancy(proposal) {
  return prodDone(proposal) !== siDone(proposal);
}

function detailedReportRow(proposal, trackerRow) {
  return {
    key: proposal.key,
    workbookKind: trackerRow.workbookKind,
    rowIndex: trackerRow.rowIndex,
    store: trackerRow.store,
    periodWeek: trackerRow.periodWeek,
    categoryId: trackerRow.categoryId,
    dbkey: trackerRow.dbkey,
    pogId: trackerRow.pogId,
    pogName: trackerRow.pogName,
    setType: trackerRow.setType,
    trackerComplete: trackerRow.currentK,
    trackerComment: trackerRow.currentL,
    prodCompletionStatus: proposal.prod?.completionStatus || 'absent',
    prodExceptionReason: proposal.prod?.exceptionReason || '',
    prodComment: proposal.prod?.comment || '',
    prodAfterPhotoCount: Array.isArray(proposal.prod?.afterPictureUrls) ? proposal.prod.afterPictureUrls.length : 0,
    siPresent: proposal.si?.present ?? false,
    siStatus: proposal.si?.status || 'absent',
    siTaskId: proposal.si?.taskId || null,
    siScanStatus: proposal.si?.scanStatus || null,
    bucket: proposal.bucket,
    bucketReason: proposal.reason,
    proposedComplete: trackerUpdate(proposal).K,
    proposedComment: trackerUpdate(proposal).L,
    discrepancy: isDiscrepancy(proposal),
  };
}

function writeTrackerCells(workbookPath, sheetName, updates) {
  if (!updates.length) return { written: 0, backup: null };
  const payload = JSON.stringify({ rows: updates });
  const scriptPath = path.resolve(__dirname, 'write_tracker.py');
  const result = spawnSync('python', [scriptPath, workbookPath, sheetName], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`write_tracker.py failed for ${workbookPath}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  let parsed = {};
  try { parsed = JSON.parse(result.stdout || '{}'); } catch { /* ignore */ }
  return parsed;
}

async function resilientFetchSourceRows(trackerRows) {
  const stores = [...new Set(trackerRows.map((row) => row.store).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  const ranges = [...new Set(trackerRows.map((row) => row.periodWeek).filter(Boolean))]
    .map(periodWeekToRange)
    .filter(Boolean);
  const prodRows = [];
  const siRows = [];
  const prodErrors = [];
  const settings = { sasConcurrency: 4, reboticsConcurrency: 4, sasMaxAttempts: 4 };
  for (const range of ranges) {
    try {
      const prod = await sasReports.fetchRows({
        stores,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        settings,
      });
      prodRows.push(...prod);
      console.log(`[prod] ${range.dateFrom}..${range.dateTo} rows=${prod.length}`);
    } catch (err) {
      prodErrors.push({ range, error: err.message });
      console.warn(`[prod] ${range.dateFrom}..${range.dateTo} failed: ${err.message}`);
    }
    try {
      const si = await reboticsReports.fetchRows({
        stores,
        dates: range.dates,
        settings,
      });
      siRows.push(...(si.rows || si));
      console.log(`[si] ${range.dateFrom}..${range.dateTo} rows=${(si.rows || si).length}`);
    } catch (err) {
      prodErrors.push({ range, source: 'si', error: err.message });
      console.warn(`[si] ${range.dateFrom}..${range.dateTo} failed: ${err.message}`);
    }
  }
  return {
    prodRows,
    siRows,
    siSourceInfo: { siSource: 'si-api', siFallbackReason: null, prodErrors },
  };
}

async function processWorkbook(kind, storeSet, periods, summary) {
  const workbook = workbookForKind(kind);
  const trackerRows = await loadScopedTrackerRows(kind, storeSet, periods);
  summary.counts[kind].trackerRows = trackerRows.length;
  console.log(`[${kind}] scoped tracker rows=${trackerRows.length}`);
  if (!trackerRows.length) {
    summary.workbooks[kind].proposals = [];
    summary.workbooks[kind].discrepancies = [];
    summary.workbooks[kind].writes = [];
    return;
  }

  const { prodRows, siRows, siSourceInfo } = await resilientFetchSourceRows(trackerRows);
  summary.workbooks[kind].siSource = siSourceInfo;
  summary.workbooks[kind].prodRowCount = prodRows.length;
  summary.workbooks[kind].siRowCount = siRows.length;
  console.log(`[${kind}] fetched prod=${prodRows.length} si=${siRows.length} source=${siSourceInfo.siSource}`);

  const classified = classifyReconciliation({
    trackerRows,
    prodRows,
    siRows,
    projectMode: true,
    suppressAlreadySatisfied: false,
  });
  const proposalByKey = new Map(classified.proposals.map((p) => [p.key, p]));
  const discrepancies = [];
  const writes = [];
  for (const trackerRow of trackerRows) {
    const proposal = proposalByKey.get(trackerRow.key);
    if (!proposal) continue;
    const update = trackerUpdate(proposal);
    writes.push({
      rowIndex: trackerRow.rowIndex,
      K: update.K,
      L: update.L,
      key: trackerRow.key,
    });
    if (isDiscrepancy(proposal)) {
      discrepancies.push(detailedReportRow(proposal, trackerRow));
    }
  }
  summary.workbooks[kind].proposals = classified.proposals;
  summary.workbooks[kind].discrepancies = discrepancies;
  summary.workbooks[kind].writes = writes;
  summary.counts[kind].discrepancies = discrepancies.length;
  summary.counts[kind].writes = writes.length;
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await bootstrapAuth();

  const storeSet = new Set(storesForDistricts(DISTRICTS));
  const periods = new Set(periodsInRange(PERIOD_START, PERIOD_END));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const iseCopy = path.join(OUT_DIR, `SUPER Tracker ISE V1.3 - P06W1 verify copy ${stamp}.xlsm`);
  const blitzCopy = path.join(OUT_DIR, `SUPER Tracker Blitz V1.3 - P06W1 verify copy ${stamp}.xlsx`);
  await fsp.copyFile(LIVE_ISE, iseCopy);
  await fsp.copyFile(LIVE_BLITZ, blitzCopy);
  console.log(`Copied ISE -> ${iseCopy}`);
  console.log(`Copied Blitz -> ${blitzCopy}`);

  const summary = {
    generatedAt: new Date().toISOString(),
    taskDate: TASK_DATE,
    districts: DISTRICTS,
    stores: [...storeSet].sort((a, b) => Number(a) - Number(b)),
    periodRange: `${PERIOD_START}..${PERIOD_END}`,
    liveSources: { ise: LIVE_ISE, blitz: LIVE_BLITZ },
    copies: { ise: iseCopy, blitz: blitzCopy },
    counts: {
      ise: { trackerRows: 0, discrepancies: 0, writes: 0 },
      blitz: { trackerRows: 0, discrepancies: 0, writes: 0 },
    },
    workbooks: { ise: {}, blitz: {} },
  };

  await processWorkbook('ise', storeSet, periods, summary);
  await processWorkbook('blitz', storeSet, periods, summary);

  const iseWrite = writeTrackerCells(iseCopy, workbookForKind('ise').sheetName, summary.workbooks.ise.writes || []);
  const blitzWrite = writeTrackerCells(blitzCopy, workbookForKind('blitz').sheetName, summary.workbooks.blitz.writes || []);
  summary.writeResults = { ise: iseWrite, blitz: blitzWrite };

  const allDiscrepancies = [
    ...(summary.workbooks.ise.discrepancies || []),
    ...(summary.workbooks.blitz.discrepancies || []),
  ].sort((a, b) => {
    const storeCmp = Number(a.store) - Number(b.store);
    if (storeCmp) return storeCmp;
    const periodCmp = periodOrdinal(a.periodWeek) - periodOrdinal(b.periodWeek);
    if (periodCmp) return periodCmp;
    return String(a.key).localeCompare(String(b.key));
  });

  const reportPath = path.join(OUT_DIR, `P06W1_signoff_verify_discrepancies_${stamp}.json`);
  const summaryPath = path.join(OUT_DIR, `P06W1_signoff_verify_summary_${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `P06W1_signoff_verify_discrepancies_${stamp}.csv`);

  await fsp.writeFile(reportPath, JSON.stringify(allDiscrepancies, null, 2));
  await fsp.writeFile(summaryPath, JSON.stringify({
    ...summary,
    workbooks: {
      ise: {
        ...summary.workbooks.ise,
        proposals: undefined,
      },
      blitz: {
        ...summary.workbooks.blitz,
        proposals: undefined,
      },
    },
    allDiscrepancyCount: allDiscrepancies.length,
    reportPath,
    csvPath,
  }, null, 2));

  const headers = [
    'workbookKind', 'rowIndex', 'store', 'periodWeek', 'categoryId', 'dbkey', 'pogId', 'pogName', 'setType',
    'trackerComplete', 'trackerComment', 'prodCompletionStatus', 'siStatus', 'siTaskId', 'proposedComplete', 'proposedComment', 'bucketReason',
  ];
  const csvLines = [headers.join(',')];
  for (const row of allDiscrepancies) {
    csvLines.push(headers.map((h) => {
      const value = String(row[h] ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(value) ? `"${value}"` : value;
    }).join(','));
  }
  await fsp.writeFile(csvPath, `${csvLines.join('\n')}\n`);

  console.log(`Discrepancies=${allDiscrepancies.length}`);
  console.log(`Report: ${reportPath}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
