#!/usr/bin/env node
'use strict';

/**
 * D6/D8 tracker reconciliation — copies only, never live OneDrive trackers.
 *
 * 1) Copy ISE + Blitz trackers to Downloads/tracking_new/
 * 2) Scan D6/D8 eligible rows (K blank/No, L blank) through P06W1
 * 3) Dynamic period start = oldest eligible period in D6/D8
 * 4) Cross-reference live PROD + SI; remediate one-sided rows
 * 5) Write K/L to copies only
 *
 * Usage:
 *   node scripts/d6-d8-tracking-reconcile.js
 *   node scripts/d6-d8-tracking-reconcile.js --skip-prod-to-si --skip-si-to-prod
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const sasBridge = require('../src/sas-bridge');
const reboticsBridge = require('../src/rebotics-bridge');
const { writeFileVersioned } = require('../src/lib/file-utils');
const { loadSasSession } = require('../../kompass-netcap/lib/sas-session');
const { storesForDistricts, DISTRICT_STORES } = require('../src/lib/trackers/metadata');
const { periodWeekToRange } = require('../src/lib/trackers/snapshot-ingest');
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
const OUT_DIR = 'C:/Users/tgaut/Downloads/tracking_new';
const DISTRICTS = [6, 8];
const PERIOD_END = 'P06W1';
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const BEFORE_PHOTO = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/samples/701-00661_cat4_pog9011792_BAY1_P05W3_task39166297_action23580254.jpg';

const ISE_COPY_NAME = 'SUPER Tracker ISE V1.3 - D6D8 reconcile copy.xlsm';
const BLITZ_COPY_NAME = 'SUPER Tracker Blitz V1.3 - D6D8 reconcile copy.xlsx';

function parseArgs(argv) {
  const opts = { skipProdToSi: false, skipSiToProd: false, skipSiPhotos: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--skip-prod-to-si') opts.skipProdToSi = true;
    if (argv[i] === '--skip-si-to-prod') opts.skipSiToProd = true;
    if (argv[i] === '--skip-si-photos') opts.skipSiPhotos = true;
  }
  return opts;
}

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

function districtForStore(store) {
  const normalized = String(Number(store));
  for (const [district, stores] of Object.entries(DISTRICT_STORES)) {
    if (stores.map(String).includes(normalized)) return Number(district);
  }
  return null;
}

function isEligibleRow(row, periodEndOrd) {
  const periodWeek = normalizePeriodWeek(row.periodWeek || row.pogId);
  if (!periodWeek) return false;
  const ord = periodOrdinal(periodWeek);
  if (ord == null || ord > periodEndOrd) return false;
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
  return { api, token: auth.token };
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
      prodErrors.push({ range, source: 'prod', error: err.message });
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
  return { prodRows, siRows, prodErrors };
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

function isDiscrepancy(proposal) {
  return prodDone(proposal) !== siDone(proposal);
}

function detailedReportRow(proposal, trackerRow) {
  const update = trackerUpdate(proposal);
  return {
    district: districtForStore(trackerRow.store),
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
    prodCompletionStatus: proposal.prod?.categoryCompletionStatus || proposal.prod?.completionStatus || 'absent',
    prodExceptionReason: proposal.prod?.categoryExceptionReason || proposal.prod?.exceptionReason || '',
    prodComment: proposal.prod?.comment || '',
    prodAfterPhotoCount: Array.isArray(proposal.prod?.afterPictureUrls) ? proposal.prod.afterPictureUrls.length : 0,
    prodAfterPictureUrls: proposal.prod?.afterPictureUrls || [],
    siPresent: Boolean(proposal.si),
    siStatus: proposal.si?.status || 'absent',
    siTaskId: proposal.si?.taskId || proposal.si?.raw?.taskId || null,
    siScanStatus: proposal.si?.scanStatus || null,
    bucket: proposal.bucket,
    bucketReason: proposal.reason,
    proposedComplete: update.K,
    proposedComment: update.L,
    discrepancy: isDiscrepancy(proposal),
    prodDone: prodDone(proposal),
    siDone: siDone(proposal),
  };
}

async function scanEligibleRowsFromWorkbook(kind, storeSet, workbookPath, periodEndOrd) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!isEligibleRow(row, periodEndOrd)) continue;
    rows.push(row);
  }
  return rows;
}

async function discoverPeriodStart(storeSet) {
  const periodEndOrd = periodOrdinal(PERIOD_END);
  const iseRows = await scanEligibleRowsFromWorkbook('ise', storeSet, LIVE_ISE, periodEndOrd);
  const blitzRows = await scanEligibleRowsFromWorkbook('blitz', storeSet, LIVE_BLITZ, periodEndOrd);
  const all = [...iseRows, ...blitzRows];
  if (!all.length) return { periodStart: null, eligibleCount: 0, iseCount: 0, blitzCount: 0 };
  let minOrd = Infinity;
  let periodStart = null;
  for (const row of all) {
    const ord = periodOrdinal(row.periodWeek);
    if (ord != null && ord < minOrd) {
      minOrd = ord;
      periodStart = row.periodWeek;
    }
  }
  return { periodStart, eligibleCount: all.length, iseCount: iseRows.length, blitzCount: blitzRows.length };
}

async function loadScopedTrackerRows(kind, storeSet, workbookPath, reconcilePeriods) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!reconcilePeriods.has(row.periodWeek)) continue;
    if (!isEligibleRow(row, periodOrdinal(PERIOD_END))) continue;
    rows.push(row);
  }
  return rows;
}

async function processWorkbook(kind, storeSet, workbookPath, reconcilePeriods, summary) {
  const trackerRows = await loadScopedTrackerRows(kind, storeSet, workbookPath, reconcilePeriods);
  summary.counts[kind].trackerRows = trackerRows.length;
  console.log(`[${kind}] reconcile-eligible rows=${trackerRows.length}`);
  if (!trackerRows.length) {
    summary.workbooks[kind] = { discrepancies: [], writes: [], prodToSi: [], siToProd: [], prodErrors: [] };
    return { trackerRows: [], proposalByKey: new Map() };
  }

  const { prodRows, siRows, prodErrors } = await resilientFetchSourceRows(trackerRows);
  summary.workbooks[kind] = { prodErrors, prodRowCount: prodRows.length, siRowCount: siRows.length };

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
  const prodToSi = [];
  const siToProd = [];

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
    const detail = detailedReportRow(proposal, trackerRow);
    if (isDiscrepancy(proposal)) discrepancies.push(detail);
    if (detail.prodDone && !detail.siDone) prodToSi.push(detail);
    if (detail.siDone && !detail.prodDone) siToProd.push(detail);
  }

  summary.workbooks[kind].discrepancies = discrepancies;
  summary.workbooks[kind].writes = writes;
  summary.workbooks[kind].prodToSi = prodToSi;
  summary.workbooks[kind].siToProd = siToProd;
  summary.counts[kind].discrepancies = discrepancies.length;
  summary.counts[kind].writes = writes.length;
  summary.counts[kind].prodToSi = prodToSi.length;
  summary.counts[kind].siToProd = siToProd.length;

  return { trackerRows, proposalByKey };
}

function safeSegment(value, max = 80) {
  return String(value || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, max) || 'unknown';
}

function imageUrlFromPrePhoto(entry) {
  return entry?.file?.file || entry?.merged_image || entry?.image || null;
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty body');
  return buf;
}

async function actionsForTask(api, token, taskId) {
  const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  const fromEmbedded = (task?.result?.pre_photo || [])
    .map((action, idx) => ({
      ...action,
      id: action?.id ?? action?.action_id,
      stage: action?.stage || 'pre_photo',
      bay: idx + 1,
    }))
    .filter((a) => a.id && imageUrlFromPrePhoto(a));
  return { task, actions: fromEmbedded };
}

async function pullSiPhotosForSiToProd(rows, api, token, photosRoot) {
  const report = { savedSets: 0, savedImages: 0, items: [], errors: [] };
  for (const row of rows) {
    const item = { ...row, images: [], folder: null, error: null };
    if (!row.siTaskId) {
      item.error = 'missing siTaskId';
      report.items.push(item);
      continue;
    }
    const district = row.district || districtForStore(row.store) || 'unknown';
    const setFolder = path.join(
      photosRoot,
      `District_${district}`,
      `Store_${row.store}`,
      `${row.periodWeek}_${row.dbkey}_${safeSegment(row.pogName, 40)}`,
    );
    item.folder = setFolder;
    try {
      await fsp.mkdir(setFolder, { recursive: true });
      const { actions } = await actionsForTask(api, token, row.siTaskId);
      let bay = 0;
      for (const action of actions) {
        const imageUrl = imageUrlFromPrePhoto(action);
        if (!imageUrl) continue;
        bay += 1;
        const actionId = action.id ?? action.action_id;
        const customId = `701-${String(row.store).padStart(5, '0')}`;
        const filename = [
          customId,
          `cat${row.categoryId}`,
          `pog${row.dbkey}`,
          `BAY${String(action.bay || bay).padStart(2, '0')}`,
          row.periodWeek,
          safeSegment(row.setType, 20),
          `task${row.siTaskId}`,
          `action${actionId}.jpg`,
        ].join('_');
        const buf = await downloadImage(imageUrl);
        const dest = path.join(setFolder, filename);
        await writeFileVersioned(dest, buf);
        item.images.push({ path: dest, bytes: buf.length, bay: action.bay || bay, actionId });
        report.savedImages += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (item.images.length) report.savedSets += 1;
      else item.error = 'no downloadable SI images';
    } catch (err) {
      item.error = err.message;
      report.errors.push({ key: row.key, error: err.message });
    }
    report.items.push(item);
    console.log(`[si-photos] ${row.key}: ${item.images.length} images${item.error ? ` (${item.error})` : ''}`);
  }
  return report;
}

function spawnNode(args, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[spawn] node ${args.join(' ')}`);
    const child = spawn('node', args, {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
      ...opts,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

async function runProdToSiCloseout(outDir) {
  const script = path.resolve(__dirname, 'reconcile-d1-d8-prod-to-si.js');
  const closeoutDir = path.join(outDir, 'prod-to-si-closeout');
  const args = [
    script,
    '--apply-si',
    '--districts', '6,8',
    '--confirm-scope', 'D6,D8',
    '--cutoff', PERIOD_END,
    '--out', closeoutDir,
  ];
  if (process.env.DATABASE_URL) {
    return spawnNode(args);
  }
  console.log('[prod-to-si] DATABASE_URL not set; trying railway run...');
  return new Promise((resolve, reject) => {
    const child = spawn('railway', ['run', 'node', ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
      shell: true,
    });
    child.on('error', (err) => resolve({ ok: false, code: null, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

async function runSiToProdBackfill(discrepancyPath, outDir) {
  if (!fs.existsSync(BEFORE_PHOTO)) {
    console.warn(`[si-to-prod] Before photo missing (${BEFORE_PHOTO}); skipping backfill apply.`);
    return { ok: false, skipped: true, reason: 'before photo missing' };
  }
  const script = path.resolve(__dirname, 'p06w1-si-to-prod-backfill.js');
  const sitoprodDir = path.join(outDir, 'sitoprod');
  return spawnNode([
    script,
    '--apply',
    '--discrepancies', discrepancyPath,
    '--out-root', sitoprodDir,
  ]);
}

function normalizeReconcileKey(key) {
  if (!key) return '';
  const parts = String(key).split('|');
  if (parts.length !== 4) return String(key);
  const [pw, store, cat, dbkey] = parts;
  const normPw = normalizePeriodWeek(pw) || pw;
  return `${normPw}|${String(Number(store))}|${String(Number(cat))}|${dbkey}`;
}

function loadCompletedKeysFromProdToSi(outDir) {
  const summaryPath = path.join(outDir, 'prod-to-si-closeout', 'summary.json');
  if (!fs.existsSync(summaryPath)) return new Set();
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const keys = new Set();
  for (const row of summary.completed || []) {
    keys.add(normalizeReconcileKey(row.key));
  }
  for (const row of summary.trackerWritePlan || []) {
    keys.add(normalizeReconcileKey(row.key));
  }
  return keys;
}

function loadCompletedKeysFromSiToProd(outDir) {
  const sitoprodDir = path.join(outDir, 'sitoprod');
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

function loadNeedsLoadedComments(outDir) {
  const sitoprodDir = path.join(outDir, 'sitoprod');
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

function mergeWrites(writes, completedKeys, needsLoadedComments, finalProposalByKey) {
  return writes.map((row) => {
    const key = normalizeReconcileKey(row.key);
    if (completedKeys.has(key)) return { ...row, K: 'Yes', L: '' };
    const proposal = finalProposalByKey.get(row.key) || finalProposalByKey.get(key);
    if (proposal) {
      const update = trackerUpdate(proposal);
      let { L } = update;
      if (needsLoadedComments.has(key) && update.K === 'No' && update.L === 'needs PROD complete') {
        L = 'needs loaded to PROD';
      }
      return { ...row, K: update.K, L };
    }
    if (needsLoadedComments.has(key)) {
      return { ...row, K: 'No', L: needsLoadedComments.get(key) };
    }
    return row;
  });
}

function countWriteOutcomes(writes) {
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

function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => {
      const value = String(row[h] ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(value) ? `"${value}"` : value;
    }).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv);
  await fsp.mkdir(OUT_DIR, { recursive: true });

  if (!fs.existsSync(LIVE_ISE)) throw new Error(`Live ISE tracker not found: ${LIVE_ISE}`);
  if (!fs.existsSync(LIVE_BLITZ)) throw new Error(`Live Blitz tracker not found: ${LIVE_BLITZ}`);

  const storeSet = new Set(storesForDistricts(DISTRICTS));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const iseCopy = path.join(OUT_DIR, ISE_COPY_NAME);
  const blitzCopy = path.join(OUT_DIR, BLITZ_COPY_NAME);
  await fsp.copyFile(LIVE_ISE, iseCopy);
  await fsp.copyFile(LIVE_BLITZ, blitzCopy);
  console.log(`Copied ISE -> ${iseCopy}`);
  console.log(`Copied Blitz -> ${blitzCopy}`);

  const discovery = await discoverPeriodStart(storeSet);
  if (!discovery.periodStart) {
    console.log('No eligible D6/D8 incomplete rows found through P06W1. Nothing to reconcile.');
    const emptySummary = {
      generatedAt: new Date().toISOString(),
      districts: DISTRICTS,
      periodRange: null,
      copies: { ise: iseCopy, blitz: blitzCopy },
      discovery,
    };
    await fsp.writeFile(path.join(OUT_DIR, `D6D8_reconcile_summary_${stamp}.json`), JSON.stringify(emptySummary, null, 2));
    return;
  }

  const reconcilePeriods = new Set(periodsInRange(discovery.periodStart, PERIOD_END));
  console.log(`Period window: ${discovery.periodStart}..${PERIOD_END} (${reconcilePeriods.size} weeks)`);
  console.log(`Eligible rows scanned: ise=${discovery.iseCount} blitz=${discovery.blitzCount}`);

  const { api, token } = await bootstrapAuth();

  const summary = {
    generatedAt: new Date().toISOString(),
    districts: DISTRICTS,
    stores: [...storeSet].sort((a, b) => Number(a) - Number(b)),
    periodRange: `${discovery.periodStart}..${PERIOD_END}`,
    discovery,
    liveSources: { ise: LIVE_ISE, blitz: LIVE_BLITZ },
    copies: { ise: iseCopy, blitz: blitzCopy },
    counts: {
      ise: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
      blitz: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
    },
    workbooks: {},
  };

  await processWorkbook('ise', storeSet, iseCopy, reconcilePeriods, summary);
  await processWorkbook('blitz', storeSet, blitzCopy, reconcilePeriods, summary);

  const writesCachePath = path.join(OUT_DIR, 'D6D8_writes_cache.json');
  await fsp.writeFile(writesCachePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    periodRange: `${discovery.periodStart}..${PERIOD_END}`,
    ise: summary.workbooks.ise?.writes || [],
    blitz: summary.workbooks.blitz?.writes || [],
  }, null, 2));

  const allDiscrepancies = [
    ...(summary.workbooks.ise?.discrepancies || []),
    ...(summary.workbooks.blitz?.discrepancies || []),
  ];
  const allSiToProd = [
    ...(summary.workbooks.ise?.siToProd || []),
    ...(summary.workbooks.blitz?.siToProd || []),
  ];

  const discrepancyPath = path.join(OUT_DIR, `D6D8_reconcile_discrepancies_${stamp}.json`);
  await fsp.writeFile(discrepancyPath, JSON.stringify(allDiscrepancies, null, 2));
  console.log(`Discrepancies=${allDiscrepancies.length} -> ${discrepancyPath}`);

  if (!opts.skipProdToSi && (summary.workbooks.ise?.prodToSi?.length || summary.workbooks.blitz?.prodToSi?.length)) {
    summary.prodToSiCloseout = await runProdToSiCloseout(OUT_DIR);
  } else {
    summary.prodToSiCloseout = { ok: false, skipped: true };
  }

  if (!opts.skipSiPhotos && allSiToProd.length) {
    const photosRoot = path.join(OUT_DIR, 'si-complete-prod-not-photos');
    summary.siPhotoReport = await pullSiPhotosForSiToProd(allSiToProd, api, token, photosRoot);
  }

  if (!opts.skipSiToProd && allSiToProd.length) {
    summary.siToProdBackfill = await runSiToProdBackfill(discrepancyPath, OUT_DIR);
  } else {
    summary.siToProdBackfill = { ok: false, skipped: true };
  }

  const completedKeys = loadCompletedKeysFromProdToSi(OUT_DIR);
  const needsLoadedComments = loadNeedsLoadedComments(OUT_DIR);

  for (const kind of ['ise', 'blitz']) {
    const writes = summary.workbooks[kind]?.writes || [];
    summary.workbooks[kind].finalWrites = mergeWrites(writes, completedKeys, needsLoadedComments, new Map());
    summary.counts[kind].finalOutcomes = countWriteOutcomes(summary.workbooks[kind].finalWrites);
  }

  const iseWrite = writeTrackerCells(iseCopy, workbookForKind('ise').sheetName, summary.workbooks.ise?.finalWrites || []);
  const blitzWrite = writeTrackerCells(blitzCopy, workbookForKind('blitz').sheetName, summary.workbooks.blitz?.finalWrites || []);
  summary.writeResults = { ise: iseWrite, blitz: blitzWrite };

  const finalDiscrepancies = [];
  for (const kind of ['ise', 'blitz']) {
    for (const row of summary.workbooks[kind]?.finalWrites || []) {
      if (row.K !== 'Yes') {
        finalDiscrepancies.push({
          workbookKind: kind,
          rowIndex: row.rowIndex,
          key: row.key,
          K: row.K,
          L: row.L,
        });
      }
    }
  }

  const csvPath = path.join(OUT_DIR, `D6D8_reconcile_discrepancies_${stamp}.csv`);
  const csvHeaders = [
    'district', 'workbookKind', 'rowIndex', 'store', 'periodWeek', 'categoryId', 'dbkey',
    'pogName', 'setType', 'proposedComplete', 'proposedComment', 'prodDone', 'siDone', 'siTaskId', 'bucket', 'bucketReason',
  ];
  await fsp.writeFile(csvPath, toCsv(allDiscrepancies, csvHeaders));

  const summaryPath = path.join(OUT_DIR, `D6D8_reconcile_summary_${stamp}.json`);
  summary.paths = { discrepancyPath, csvPath, summaryPath, discrepancyCount: allDiscrepancies.length };
  summary.finalOpenCount = finalDiscrepancies.length;
  await fsp.writeFile(summaryPath, JSON.stringify({
    ...summary,
    workbooks: {
      ise: { ...summary.workbooks.ise, writes: summary.workbooks.ise?.finalWrites },
      blitz: { ...summary.workbooks.blitz, writes: summary.workbooks.blitz?.finalWrites },
    },
  }, null, 2));

  console.log('\n=== D6/D8 tracker reconcile complete ===');
  console.log(`Period: ${discovery.periodStart}..${PERIOD_END}`);
  console.log(`Tracker copies: ${iseCopy}`);
  console.log(`                ${blitzCopy}`);
  console.log(`Marked Yes: ise=${summary.counts.ise.finalOutcomes?.yes || 0} blitz=${summary.counts.blitz.finalOutcomes?.yes || 0}`);
  console.log(`Still open: ${finalDiscrepancies.length}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
