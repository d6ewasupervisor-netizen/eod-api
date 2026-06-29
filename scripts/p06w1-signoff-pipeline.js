#!/usr/bin/env node
'use strict';

/**
 * P06W1 signoff pipeline — Districts 1, 6, 8 only.
 * 1) Copy live trackers to Downloads/p06w1 signoffs/
 * 2) Reconcile eligible rows against live PROD/SI; update tracker copies
 * 3) PROD-complete / SI-not → close SI (subprocess reconcile-d1-d8 when DATABASE_URL available)
 * 4) SI-complete / PROD-not → pull SI photos + detailed list
 *
 * Usage:
 *   node scripts/p06w1-signoff-pipeline.js
 *   node scripts/p06w1-signoff-pipeline.js --skip-prod-to-si
 *   node scripts/p06w1-signoff-pipeline.js --skip-si-photos
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
const OUT_DIR = 'C:/Users/tgaut/Downloads/p06w1 signoffs';
const CROSSREF_ROOT = path.join(OUT_DIR, 'cross-reference');
const PROD_XREF_DIR = path.join(CROSSREF_ROOT, 'prod');
const SI_XREF_DIR = path.join(CROSSREF_ROOT, 'si');
const DISTRICTS = [1, 6, 8];
const PERIOD_CUTOFF = 'P05W4';
const PERIOD_START = 'P04W1';
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';

function parseArgs(argv) {
  const opts = { skipProdToSi: false, skipSiPhotos: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--skip-prod-to-si') opts.skipProdToSi = true;
    if (argv[i] === '--skip-si-photos') opts.skipSiPhotos = true;
  }
  return opts;
}

function periodOrdinal(periodWeek) {
  const match = String(periodWeek || '').match(/^P(\d{2})W([1-4])$/i);
  if (!match) return null;
  return ((Number(match[1]) - 1) * 4) + Number(match[2]);
}

function periodsThrough(endLabel) {
  const endOrd = periodOrdinal(endLabel);
  const out = [];
  for (let period = 1; period <= 13; period += 1) {
    for (let week = 1; week <= 4; week += 1) {
      const label = `P${String(period).padStart(2, '0')}W${week}`;
      const ord = periodOrdinal(label);
      if (ord >= periodOrdinal(PERIOD_START) && ord <= endOrd) out.push(label);
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

/** Rows eligible for PROD/SI reconciliation (not current-week blank carry-forward). */
function shouldReconcileRow(row) {
  const periodWeek = normalizePeriodWeek(row.periodWeek || row.pogId);
  if (!periodWeek) return false;
  const k = normalizeCell(row.currentK).toLowerCase();
  const l = normalizeCell(row.currentL);
  if (k === 'yes') return false;
  if (k === 'no' && l) return false;
  if (k === 'no' && !l) return true;
  if (!k) {
    if (periodOrdinal(periodWeek) > periodOrdinal(PERIOD_CUTOFF)) return false;
    return true;
  }
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
  if (pDone && !sDone) return { K: 'No', L: 'SI PENDING' };
  if (!pDone && sDone) return { K: 'No', L: 'PROD PENDING' };
  return { K: 'No', L: '' };
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

const RECONCILE_PERIODS = new Set(periodsThrough(PERIOD_CUTOFF).filter(
  (pw) => periodOrdinal(pw) >= periodOrdinal(PERIOD_START),
));

async function loadScopedTrackerRows(kind, storeSet, workbookPath) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!RECONCILE_PERIODS.has(row.periodWeek)) continue;
    if (!shouldReconcileRow(row)) continue;
    rows.push(row);
  }
  return rows;
}

async function processWorkbook(kind, storeSet, workbookPath, summary) {
  const trackerRows = await loadScopedTrackerRows(kind, storeSet, workbookPath);
  summary.counts[kind].trackerRows = trackerRows.length;
  console.log(`[${kind}] reconcile-eligible rows=${trackerRows.length}`);
  if (!trackerRows.length) {
    summary.workbooks[kind] = { discrepancies: [], writes: [], prodToSi: [], siToProd: [] };
    return;
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
  summary.workbooks[kind].prodRows = prodRows;
  summary.workbooks[kind].siRows = siRows;
  summary.counts[kind].discrepancies = discrepancies.length;
  summary.counts[kind].writes = writes.length;
  summary.counts[kind].prodToSi = prodToSi.length;
  summary.counts[kind].siToProd = siToProd.length;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[,"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function prodRowIsComplete(row) {
  const status = String(row?.categoryCompletionStatus || row?.completionStatus || '').toLowerCase();
  return status === 'done' || status === 'true';
}

function siRowIsComplete(row) {
  const status = String(row?.status || '').toLowerCase();
  return status === 'done' || status === 'complete' || status === 'completed';
}

function siTaskStatusLabel(row) {
  return siRowIsComplete(row) ? 'Completed' : 'Not Completed';
}

async function writeCrossReferenceExports(prodRows, siRows, stamp) {
  await fsp.mkdir(PROD_XREF_DIR, { recursive: true });
  await fsp.mkdir(SI_XREF_DIR, { recursive: true });

  const prodPath = path.join(PROD_XREF_DIR, `category_report_data_export_${stamp}.csv`);
  const siPath = path.join(SI_XREF_DIR, `si_compliance_${stamp}.csv`);

  const prodSeen = new Set();
  const prodLines = ['Store #,Planogram ID,Category Completion Status,Cycle Name'];
  for (const row of prodRows) {
    const store = String(Number(row.storeNumber || ''));
    const dbkey = String(row.dbkey || '').trim();
    const planogramId = String(row.planogramId || dbkey).trim();
    if (!store || !dbkey) continue;
    const key = `${store}|${dbkey}`;
    if (prodSeen.has(key)) continue;
    prodSeen.add(key);
    prodLines.push([
      store,
      csvEscape(planogramId),
      prodRowIsComplete(row) ? 'True' : 'False',
      'pipeline',
    ].join(','));
  }

  const siSeen = new Set();
  const siLines = ['Store,Task Name,Task Status'];
  for (const row of siRows) {
    const store = String(Number(row.storeNumber || ''));
    const dbkey = String(row.dbkey || '').trim();
    const title = String(row.raw?.title || row.categorySetLabel || '').trim();
    if (!store || !dbkey) continue;
    const key = `${store}|${dbkey}`;
    if (siSeen.has(key)) continue;
    siSeen.add(key);
    const taskName = title.includes(dbkey) ? title : `${row.periodWeek || 'P00W0'} ${dbkey} ${title}`.trim();
    siLines.push([
      store,
      csvEscape(taskName),
      siTaskStatusLabel(row),
    ].join(','));
  }

  await fsp.writeFile(prodPath, `${prodLines.join('\n')}\n`, 'utf8');
  await fsp.writeFile(siPath, `${siLines.join('\n')}\n`, 'utf8');
  return { prodPath, siPath, prodRows: prodSeen.size, siRows: siSeen.size };
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
  const report = {
    startedAt: new Date().toISOString(),
    rows: rows.length,
    savedSets: 0,
    savedImages: 0,
    items: [],
    errors: [],
  };

  for (const row of rows) {
    const item = {
      ...row,
      images: [],
      folder: null,
      error: null,
    };
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
      const { task, actions } = await actionsForTask(api, token, row.siTaskId);
      item.taskTitle = task?.title || '';
      item.taskStatus = task?.status?.id || null;
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
        const writtenPath = await writeFileVersioned(dest, buf);
        item.images.push({ path: writtenPath, bytes: buf.length, bay: action.bay || bay, actionId });
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

  report.finishedAt = new Date().toISOString();
  return report;
}

async function runProdToSiCloseout(outDir) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, 'reconcile-d1-d8-prod-to-si.js');
    const args = [
      script,
      '--apply-si',
      '--districts', '1,6,8',
      '--confirm-scope', 'D1,D6,D8',
      '--cutoff', PERIOD_CUTOFF,
      '--out', path.join(outDir, 'prod-to-si-closeout'),
    ];
    console.log(`[prod-to-si] spawning: node ${args.join(' ')}`);
    const child = spawn('node', args, {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, code });
    });
  });
}

function mergeWritesAfterProdToSi(writes, completedKeys) {
  const keySet = new Set(completedKeys);
  return writes.map((row) => {
    if (!keySet.has(row.key)) return row;
    return { ...row, K: 'Yes', L: '' };
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const { api, token } = await bootstrapAuth();

  const storeSet = new Set(storesForDistricts(DISTRICTS));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const iseCopy = path.join(OUT_DIR, 'SUPER Tracker ISE V1.3 - P06W1 working copy.xlsm');
  const blitzCopy = path.join(OUT_DIR, 'SUPER Tracker Blitz V1.3 - P06W1 working copy.xlsx');
  await fsp.copyFile(LIVE_ISE, iseCopy);
  await fsp.copyFile(LIVE_BLITZ, blitzCopy);
  console.log(`Copied ISE -> ${iseCopy}`);
  console.log(`Copied Blitz -> ${blitzCopy}`);

  const summary = {
    generatedAt: new Date().toISOString(),
    districts: DISTRICTS,
    stores: [...storeSet].sort((a, b) => Number(a) - Number(b)),
    reconcileCutoff: PERIOD_CUTOFF,
    liveSources: { ise: LIVE_ISE, blitz: LIVE_BLITZ },
    copies: { ise: iseCopy, blitz: blitzCopy },
    counts: {
      ise: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
      blitz: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
    },
    workbooks: {},
  };

  await processWorkbook('ise', storeSet, iseCopy, summary);
  await processWorkbook('blitz', storeSet, blitzCopy, summary);

  const allProdRows = [
    ...(summary.workbooks.ise?.prodRows || []),
    ...(summary.workbooks.blitz?.prodRows || []),
  ];
  const allSiRows = [
    ...(summary.workbooks.ise?.siRows || []),
    ...(summary.workbooks.blitz?.siRows || []),
  ];
  const xrefExport = await writeCrossReferenceExports(allProdRows, allSiRows, stamp);
  summary.crossReference = {
    prodDir: PROD_XREF_DIR,
    siDir: SI_XREF_DIR,
    ...xrefExport,
  };
  console.log(`Cross-reference PROD CSV: ${xrefExport.prodPath} (${xrefExport.prodRows} keys)`);
  console.log(`Cross-reference SI CSV: ${xrefExport.siPath} (${xrefExport.siRows} keys)`);

  let prodToSiResult = { ok: false, skipped: true };
  if (!opts.skipProdToSi) {
    prodToSiResult = await runProdToSiCloseout(OUT_DIR);
    summary.prodToSiCloseout = prodToSiResult;
  }

  const allSiToProd = [
    ...(summary.workbooks.ise?.siToProd || []),
    ...(summary.workbooks.blitz?.siToProd || []),
  ].sort((a, b) => {
    const d = Number(a.district) - Number(b.district);
    if (d) return d;
    const s = Number(a.store) - Number(b.store);
    if (s) return s;
    return periodOrdinal(a.periodWeek) - periodOrdinal(b.periodWeek);
  });

  let siPhotoReport = null;
  if (!opts.skipSiPhotos && allSiToProd.length) {
    const photosRoot = path.join(OUT_DIR, 'si-complete-prod-not-photos');
    siPhotoReport = await pullSiPhotosForSiToProd(allSiToProd, api, token, photosRoot);
    summary.siPhotoReport = {
      photosRoot,
      savedSets: siPhotoReport.savedSets,
      savedImages: siPhotoReport.savedImages,
      errors: siPhotoReport.errors.length,
    };
  }

  const iseWrites = summary.workbooks.ise?.writes || [];
  const blitzWrites = summary.workbooks.blitz?.writes || [];

  const iseWrite = writeTrackerCells(iseCopy, workbookForKind('ise').sheetName, iseWrites);
  const blitzWrite = writeTrackerCells(blitzCopy, workbookForKind('blitz').sheetName, blitzWrites);
  summary.writeResults = { ise: iseWrite, blitz: blitzWrite };

  const allDiscrepancies = [
    ...(summary.workbooks.ise?.discrepancies || []),
    ...(summary.workbooks.blitz?.discrepancies || []),
  ];

  const siToProdListPath = path.join(OUT_DIR, `SI_complete_PROD_not_D1_D6_D8_${stamp}.json`);
  const siToProdCsvPath = path.join(OUT_DIR, `SI_complete_PROD_not_D1_D6_D8_${stamp}.csv`);
  const siToProdMdPath = path.join(OUT_DIR, `SI_complete_PROD_not_D1_D6_D8_${stamp}.md`);
  const summaryPath = path.join(OUT_DIR, `P06W1_pipeline_summary_${stamp}.json`);

  await fsp.writeFile(siToProdListPath, JSON.stringify(allSiToProd, null, 2));

  const csvHeaders = [
    'district', 'workbookKind', 'rowIndex', 'store', 'periodWeek', 'categoryId', 'dbkey',
    'pogName', 'setType', 'siTaskId', 'siStatus', 'prodCompletionStatus', 'prodExceptionReason',
    'prodAfterPhotoCount', 'bucket', 'bucketReason', 'photoFolder',
  ];
  const photoFolderByKey = new Map((siPhotoReport?.items || []).map((item) => [item.key, item.folder || '']));
  const csvLines = [csvHeaders.join(',')];
  for (const row of allSiToProd) {
    csvLines.push(csvHeaders.map((h) => {
      if (h === 'photoFolder') {
        const value = String(photoFolderByKey.get(row.key) || '');
        return /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }
      const value = String(row[h] ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(value) ? `"${value}"` : value;
    }).join(','));
  }
  await fsp.writeFile(siToProdCsvPath, `${csvLines.join('\n')}\n`);

  const md = [
    '# SI complete / PROD not — Districts 1, 6, 8',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total rows: ${allSiToProd.length}`,
    `Photos saved: ${siPhotoReport?.savedImages ?? 0} images across ${siPhotoReport?.savedSets ?? 0} sets`,
    '',
    '| District | Store | Week | Cat | DB Key | POG | SI Task | PROD status | Photos |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of allSiToProd) {
    const folder = photoFolderByKey.get(row.key) || '';
    const imgCount = (siPhotoReport?.items || []).find((i) => i.key === row.key)?.images?.length || 0;
    md.push(`| D${row.district} | ${row.store} | ${row.periodWeek} | ${row.categoryId} | ${row.dbkey} | ${String(row.pogName).replace(/\|/g, '/')} | ${row.siTaskId || ''} | ${row.prodCompletionStatus} | ${imgCount} → ${folder.replace(/\|/g, '/')} |`);
  }
  await fsp.writeFile(siToProdMdPath, `${md.join('\n')}\n`);

  summary.paths = {
    siToProdListPath,
    siToProdCsvPath,
    siToProdMdPath,
    summaryPath,
    discrepancyCount: allDiscrepancies.length,
    siToProdCount: allSiToProd.length,
  };
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n=== P06W1 pipeline reconcile complete ===');
  console.log(`Tracker copies: ${iseCopy}`);
  console.log(`                ${blitzCopy}`);
  console.log(`Discrepancies: ${allDiscrepancies.length}`);
  console.log(`SI-complete/PROD-not: ${allSiToProd.length} -> ${siToProdListPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
