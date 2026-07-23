#!/usr/bin/env node
'use strict';

/**
 * District-scoped tracker reconciliation — copies only, never live OneDrive trackers.
 *
 * 1) Copy ISE + Blitz trackers to --out-dir
 * 2) Scan eligible rows (K blank/No, L blank) through --period-end
 * 3) Dynamic period start = oldest eligible period in scope
 * 4) Cross-reference live PROD + SI; remediate one-sided rows
 * 5) Write K/L to copies only
 *
 * Usage:
 *   node scripts/d6-d8-tracking-reconcile.js
 *   node scripts/d6-d8-tracking-reconcile.js --districts "1" --out-dir "C:/Users/tgaut/Downloads/p06w1_district1_tracking" --label D1
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
const { storesForDistricts, DISTRICT_STORES, normalizeDistricts } = require('../src/lib/trackers/metadata');
const { periodWeekToRange } = require('../src/lib/trackers/snapshot-ingest');
const sasReports = require('../src/lib/trackers/sas-reports');
const reboticsReports = require('../src/lib/trackers/rebotics-reports');
const { classifyReconciliation, normalizePeriodWeek } = require('../src/lib/trackers/sheet-reconciliation');
const {
  normalizeTrackerRow,
  readTrackerWorkbookRaw,
} = require('../src/lib/trackers/tracker-sheet-reader');
const { workbookForKind } = require('../src/lib/trackers/tracker-workbooks');
const { normalizeQuery46Rows } = require('../src/lib/trackers/si-grafana-adapter');
const {
  loadDistrictReboticsSessions,
  envForReboticsSession,
} = require('../src/lib/trackers/rebotics-password-auth');
const {
  defaultConfirmedCachePath,
  loadConfirmedSetsSync,
  saveConfirmedSets,
  upsertConfirmed,
  seedFromWritesCache,
  isConfirmed,
} = require('../src/lib/trackers/confirmed-sets-cache');
const {
  remoteEnabled,
  pullConfirmedSets,
  pushConfirmedSets,
} = require('../src/lib/trackers/tracker-cache-remote');

const LIVE_ISE = "C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker ISE V1.3.xlsm";
const LIVE_BLITZ = "C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker Blitz V1.3.xlsx";
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const BEFORE_PHOTO = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/samples/701-00661_cat4_pog9011792_BAY1_P05W3_task39166297_action23580254.jpg';

let OUT_DIR = 'C:/Users/tgaut/Downloads/tracking_new';
let DISTRICTS = [6, 8];
let PERIOD_END = 'P06W1';
let RUN_LABEL = 'D6D8';
let CONFIRM_SCOPE = 'D6,D8';
let ISE_COPY_NAME = 'SUPER Tracker ISE V1.3 - D6D8 reconcile copy.xlsm';
let BLITZ_COPY_NAME = 'SUPER Tracker Blitz V1.3 - D6D8 reconcile copy.xlsx';
let SI_CSV_PATH = null;
/** When true, only write K=Yes rows to copies (leave incomplete rows untouched). */
let YES_ONLY_WRITES = true;
/** Durable both-complete cache path; null until runtime config applied. */
let CONFIRMED_CACHE_PATH = null;
/** When true, ignore confirmed-sets cache and re-fetch/reclassify those keys. */
let RECHECK_CONFIRMED = false;

function parseCsvRecords(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((v) => String(v || '').trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((v) => String(v || '').trim())) rows.push(row);
  return rows;
}

function loadSiRowsFromCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const records = parseCsvRecords(text);
  if (!records.length) throw new Error(`SI CSV empty: ${csvPath}`);
  const headers = records[0];
  const rawRows = records.slice(1).map((record) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = record[index] == null ? '' : record[index];
    });
    return obj;
  });
  // Map each raw row individually so Req IDs attach to the correct engine row.
  const engineRows = [];
  for (const raw of rawRows) {
    const [engine] = normalizeQuery46Rows([raw]);
    if (!engine) continue;
    const reqId = String(raw['Req IDs'] || raw.ReqIDs || raw.req_ids || '').trim();
    if (reqId && /^\d+$/.test(reqId)) {
      engine.taskId = Number(reqId);
      engine.raw = { ...(engine.raw || {}), taskId: Number(reqId), grafana: raw };
    }
    engineRows.push(engine);
  }
  console.log(`[si-csv] loaded path=${csvPath} raw=${rawRows.length} engine=${engineRows.length}`);
  return engineRows;
}

function parseArgs(argv) {
  const opts = {
    districts: [6, 8],
    outDir: 'C:/Users/tgaut/Downloads/tracking_new',
    periodEnd: 'P06W1',
    label: 'D6D8',
    confirmScope: null,
    skipProdToSi: false,
    skipSiToProd: false,
    skipSiPhotos: false,
    allowBlurry: true,
    siCsv: null,
    yesOnlyWrites: true,
    writeWorkingCopies: true,
    confirmedCache: null,
    recheckConfirmed: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-prod-to-si') opts.skipProdToSi = true;
    else if (arg === '--skip-si-to-prod') opts.skipSiToProd = true;
    else if (arg === '--skip-si-photos') opts.skipSiPhotos = true;
    else if (arg === '--allow-blurry') opts.allowBlurry = true;
    else if (arg === '--no-allow-blurry') opts.allowBlurry = false;
    else if (arg === '--districts') opts.districts = normalizeDistricts(argv[++i]);
    else if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--period-end') opts.periodEnd = argv[++i];
    else if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--confirm-scope') opts.confirmScope = argv[++i];
    else if (arg === '--si-csv') opts.siCsv = argv[++i];
    else if (arg === '--yes-only-writes') opts.yesOnlyWrites = true;
    else if (arg === '--write-all-kl') opts.yesOnlyWrites = false;
    else if (arg === '--no-working-copies') opts.writeWorkingCopies = false;
    else if (arg === '--confirmed-cache') opts.confirmedCache = argv[++i];
    else if (arg === '--recheck-confirmed') opts.recheckConfirmed = true;
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/d6-d8-tracking-reconcile.js [options]',
        '  --districts "1" or "6,8"     District scope (default 6,8)',
        '  --out-dir path               Output folder for copies + reports',
        '  --period-end P06W1           Upper period bound (default P06W1)',
        '  --label D1                   Prefix for copy names and report files',
        '  --confirm-scope D1           Required confirm string for prod-to-SI apply',
        '  --si-csv path                Use attached SI Grafana/export CSV instead of live SI API',
        '  --yes-only-writes            Only mark Yes on copies (default); leave incomplete rows as-is',
        '  --write-all-kl               Write No + blank L for incomplete rows (legacy)',
        '  --confirmed-cache path       Durable both-complete set cache (default {out}/{label}_confirmed_sets.json)',
        '  --recheck-confirmed          Ignore confirmed-sets cache; re-fetch those keys',
        '  --skip-prod-to-si --skip-si-to-prod --skip-si-photos',
        '  --allow-blurry               Pass --allow-blurry to prod-to-SI closeout (default on)',
      ].join('\n'));
      process.exit(0);
    }
  }
  if (!opts.districts.length) throw new Error('No valid districts in --districts');
  opts.confirmScope = opts.confirmScope || opts.districts.map((d) => `D${d}`).join(',');
  return opts;
}

function applyRuntimeConfig(opts) {
  OUT_DIR = opts.outDir;
  DISTRICTS = opts.districts;
  PERIOD_END = opts.periodEnd;
  RUN_LABEL = opts.label;
  CONFIRM_SCOPE = opts.confirmScope;
  SI_CSV_PATH = opts.siCsv || null;
  YES_ONLY_WRITES = opts.yesOnlyWrites !== false;
  RECHECK_CONFIRMED = Boolean(opts.recheckConfirmed);
  CONFIRMED_CACHE_PATH = opts.confirmedCache || defaultConfirmedCachePath(OUT_DIR, RUN_LABEL);
  ISE_COPY_NAME = `SUPER Tracker ISE V1.3 - ${RUN_LABEL} reconcile copy.xlsm`;
  BLITZ_COPY_NAME = `SUPER Tracker Blitz V1.3 - ${RUN_LABEL} reconcile copy.xlsx`;
}

async function loadOrSeedConfirmedCache() {
  // Travel/multi-device: merge Railway volume cache before local seed.
  if (remoteEnabled() && !RECHECK_CONFIRMED) {
    try {
      const pulled = await pullConfirmedSets({
        label: RUN_LABEL,
        localPath: CONFIRMED_CACHE_PATH,
        mergeLocal: true,
      });
      console.log(
        `[confirmed-sets] pulled Railway cache total=${pulled.total} `
        + `(remoteExists=${pulled.remoteExists}) -> ${CONFIRMED_CACHE_PATH}`,
      );
    } catch (err) {
      console.warn(`[confirmed-sets] Railway pull failed (continuing local): ${err.message}`);
    }
  }

  const cache = loadConfirmedSetsSync(CONFIRMED_CACHE_PATH);
  const existingCount = Object.keys(cache.sets || {}).length;
  if (existingCount > 0 || RECHECK_CONFIRMED) {
    console.log(
      `[confirmed-sets] loaded ${existingCount} keys from ${CONFIRMED_CACHE_PATH}`
      + (RECHECK_CONFIRMED ? ' (--recheck-confirmed: will not skip)' : ''),
    );
    return cache;
  }
  // First run / empty cache: seed from prior writes cache Yes rows so we
  // immediately skip sets already confirmed on a previous week.
  const writesCachePath = path.join(OUT_DIR, `${RUN_LABEL}_writes_cache.json`);
  if (fs.existsSync(writesCachePath)) {
    try {
      const writesCache = JSON.parse(fs.readFileSync(writesCachePath, 'utf8'));
      const seeded = seedFromWritesCache(cache, writesCache, {
        source: 'seed-writes-cache',
        label: RUN_LABEL,
      });
      console.log(
        `[confirmed-sets] seeded ${seeded.added} Yes keys from ${path.basename(writesCachePath)} `
        + `(total=${seeded.total}) -> ${CONFIRMED_CACHE_PATH}`,
      );
    } catch (err) {
      console.warn(`[confirmed-sets] seed from writes cache failed: ${err.message}`);
    }
  } else {
    console.log(`[confirmed-sets] empty cache at ${CONFIRMED_CACHE_PATH}`);
  }
  return cache;
}

async function persistConfirmedCache(cache, summary = null) {
  await saveConfirmedSets(CONFIRMED_CACHE_PATH, cache);
  if (!remoteEnabled()) return { pushed: false };
  try {
    const pushed = await pushConfirmedSets({
      label: RUN_LABEL,
      cache,
      replace: false,
    });
    console.log(
      `[confirmed-sets] pushed Railway cache sets=${pushed.remote?.counts?.sets ?? '?'} `
      + `(+${pushed.remote?.merge?.added ?? 0})`,
    );
    if (summary?.confirmedSets) {
      summary.confirmedSets.remotePushed = true;
      summary.confirmedSets.remoteCounts = pushed.remote?.counts || null;
    }
    return { pushed: true, remote: pushed.remote };
  } catch (err) {
    console.warn(`[confirmed-sets] Railway push failed: ${err.message}`);
    return { pushed: false, error: err.message };
  }
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

function applyReboticsSession(session, api) {
  if (!session?.token) throw new Error('Rebotics session missing token');
  reboticsBridge.getTokenForServer = () => session.token;
  reboticsBridge.getUserIdForServer = () => session.userId || api.DEFAULT_USER_ID || 211;
  console.log(`Rebotics auth active: ${session.username || 'unknown'} userId=${session.userId || 'unknown'}`);
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
  // D6 → REBOTICS_USERNAME2, D8 → REBOTICS_USERNAME (primary)
  const sessions = await loadDistrictReboticsSessions();
  applyReboticsSession(sessions.primary, api);
  console.log(
    `Rebotics district map: D6=${sessions.byDistrict[6].username} D8=${sessions.byDistrict[8].username}`,
  );
  return {
    api,
    token: sessions.primary.token,
    sessions,
  };
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

function storesByDistrict(stores) {
  const grouped = new Map();
  for (const store of stores) {
    const district = districtForStore(store);
    if (district == null) continue;
    if (!grouped.has(district)) grouped.set(district, []);
    grouped.get(district).push(store);
  }
  for (const list of grouped.values()) list.sort((a, b) => Number(a) - Number(b));
  return grouped;
}

async function resilientFetchSourceRows(trackerRows, { siCsvPath = null, sessions = null, api = null } = {}) {
  const stores = [...new Set(trackerRows.map((row) => row.store).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  const periodWeeks = [...new Set(trackerRows.map((row) => row.periodWeek).filter(Boolean))];
  const ranges = periodWeeks.map(periodWeekToRange).filter(Boolean);
  const prodRows = [];
  let siRows = [];
  const prodErrors = [];
  const settings = { sasConcurrency: 4, reboticsConcurrency: 4, sasMaxAttempts: 4 };
  const byDistrict = storesByDistrict(stores);

  console.log(`[fetch] stores=${stores.length} periods=${periodWeeks.join(',') || '(none)'} siSource=${siCsvPath ? 'csv' : 'live-api'}`);
  console.log(`[fetch] district store splits: ${[...byDistrict.entries()].map(([d, s]) => `D${d}=${s.length}`).join(' ')}`);

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
  }

  async function liveFetchSiForDistrictStores(storeList, range, label) {
    if (!storeList.length) return [];
    const si = await reboticsReports.fetchRows({
      stores: storeList,
      dates: range.dates,
      settings,
    });
    const rows = si.rows || si;
    console.log(`[si] ${label} ${range.dateFrom}..${range.dateTo} stores=${storeList.length} rows=${rows.length}`);
    return rows;
  }

  async function liveFetchSiAllDistricts(range, labelPrefix) {
    const out = [];
    if (sessions?.byDistrict && api) {
      for (const [district, storeList] of byDistrict.entries()) {
        const session = sessions.byDistrict[district];
        if (!session) {
          console.warn(`[si] no Rebotics session for district ${district}; skipping ${storeList.length} stores`);
          continue;
        }
        applyReboticsSession(session, api);
        try {
          out.push(...await liveFetchSiForDistrictStores(storeList, range, `${labelPrefix} D${district}`));
        } catch (err) {
          prodErrors.push({ range, source: 'si', district, error: err.message });
          console.warn(`[si] D${district} ${range.dateFrom}..${range.dateTo} failed: ${err.message}`);
        }
      }
      return out;
    }
    // Fallback: single active bridge token
    return liveFetchSiForDistrictStores(stores, range, labelPrefix);
  }

  if (siCsvPath) {
    if (!fs.existsSync(siCsvPath)) throw new Error(`SI CSV not found: ${siCsvPath}`);
    const allSi = loadSiRowsFromCsv(siCsvPath);
    const storeSet = new Set(stores.map(String));
    const periodSet = new Set(periodWeeks.map((p) => normalizePeriodWeek(p) || p));
    siRows = allSi.filter((row) => {
      const store = String(row.storeNumber || row.store || '');
      const pw = normalizePeriodWeek(row.periodWeek) || row.periodWeek;
      return storeSet.has(store) && (!periodSet.size || periodSet.has(pw));
    });
    console.log(`[si-csv] scoped stores×periods rows=${siRows.length} (from ${allSi.length})`);
    const coveredPeriods = new Set(siRows.map((r) => normalizePeriodWeek(r.periodWeek) || r.periodWeek));
    const missingPeriods = periodWeeks.filter((p) => !coveredPeriods.has(normalizePeriodWeek(p) || p));
    if (missingPeriods.length) {
      console.warn(`[si-csv] periods not present in CSV (will live-fetch): ${missingPeriods.join(',')}`);
      for (const periodWeek of missingPeriods) {
        const range = periodWeekToRange(periodWeek);
        if (!range) continue;
        try {
          siRows.push(...await liveFetchSiAllDistricts(range, 'si-live'));
        } catch (err) {
          prodErrors.push({ range, source: 'si', error: err.message });
          console.warn(`[si-live] ${range.dateFrom}..${range.dateTo} failed: ${err.message}`);
        }
      }
    }
  } else {
    for (const range of ranges) {
      try {
        siRows.push(...await liveFetchSiAllDistricts(range, 'si'));
      } catch (err) {
        prodErrors.push({ range, source: 'si', error: err.message });
        console.warn(`[si] ${range.dateFrom}..${range.dateTo} failed: ${err.message}`);
      }
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

async function scanEligibleRowsFromWorkbook(kind, storeSet, workbookPath, periodEndOrd, confirmedCache = null) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  let skippedConfirmed = 0;
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!isEligibleRow(row, periodEndOrd)) continue;
    if (!RECHECK_CONFIRMED && confirmedCache && isConfirmed(confirmedCache, row)) {
      skippedConfirmed += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, skippedConfirmed };
}

async function discoverPeriodStart(storeSet, confirmedCache = null) {
  const periodEndOrd = periodOrdinal(PERIOD_END);
  const iseScan = await scanEligibleRowsFromWorkbook('ise', storeSet, LIVE_ISE, periodEndOrd, confirmedCache);
  const blitzScan = await scanEligibleRowsFromWorkbook('blitz', storeSet, LIVE_BLITZ, periodEndOrd, confirmedCache);
  const iseRows = iseScan.rows;
  const blitzRows = blitzScan.rows;
  const all = [...iseRows, ...blitzRows];
  const skippedConfirmed = iseScan.skippedConfirmed + blitzScan.skippedConfirmed;
  if (skippedConfirmed) {
    console.log(`[confirmed-sets] skipped ${skippedConfirmed} already-confirmed eligible sheet rows (ise=${iseScan.skippedConfirmed} blitz=${blitzScan.skippedConfirmed})`);
  }
  if (!all.length) {
    return {
      periodStart: null,
      eligibleCount: 0,
      iseCount: 0,
      blitzCount: 0,
      skippedConfirmed,
    };
  }
  let minOrd = Infinity;
  let periodStart = null;
  for (const row of all) {
    const ord = periodOrdinal(row.periodWeek);
    if (ord != null && ord < minOrd) {
      minOrd = ord;
      periodStart = row.periodWeek;
    }
  }
  return {
    periodStart,
    eligibleCount: all.length,
    iseCount: iseRows.length,
    blitzCount: blitzRows.length,
    skippedConfirmed,
  };
}

async function loadScopedTrackerRows(kind, storeSet, workbookPath, reconcilePeriods, confirmedCache = null) {
  const rawRows = await readTrackerWorkbookRaw(kind, { workbookPath });
  const rows = [];
  let skippedConfirmed = 0;
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, kind);
    if (!row.store || !row.categoryId || !row.dbkey || !row.periodWeek) continue;
    if (!storeSet.has(row.store)) continue;
    if (!reconcilePeriods.has(row.periodWeek)) continue;
    if (!isEligibleRow(row, periodOrdinal(PERIOD_END))) continue;
    if (!RECHECK_CONFIRMED && confirmedCache && isConfirmed(confirmedCache, row)) {
      skippedConfirmed += 1;
      continue;
    }
    rows.push(row);
  }
  if (skippedConfirmed) {
    console.log(`[${kind}] skipped ${skippedConfirmed} confirmed-sets cache hits`);
  }
  return rows;
}

function classifyWorkbook(kind, trackerRows, prodRows, siRows, summary, sourceMeta = {}) {
  summary.counts[kind].trackerRows = trackerRows.length;
  console.log(`[${kind}] reconcile-eligible rows=${trackerRows.length}`);
  if (!trackerRows.length) {
    summary.workbooks[kind] = {
      discrepancies: [],
      writes: [],
      prodToSi: [],
      siToProd: [],
      prodErrors: sourceMeta.prodErrors || [],
      prodRowCount: prodRows.length,
      siRowCount: siRows.length,
    };
    return { trackerRows: [], proposalByKey: new Map() };
  }

  summary.workbooks[kind] = {
    prodErrors: sourceMeta.prodErrors || [],
    prodRowCount: prodRows.length,
    siRowCount: siRows.length,
    siSource: sourceMeta.siSource || 'live-api',
  };

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
  let bothDone = 0;
  let neitherDone = 0;

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
    if (detail.prodDone && detail.siDone) bothDone += 1;
    else if (!detail.prodDone && !detail.siDone) neitherDone += 1;
    if (isDiscrepancy(proposal)) discrepancies.push(detail);
    if (detail.prodDone && !detail.siDone) prodToSi.push(detail);
    if (detail.siDone && !detail.prodDone) siToProd.push(detail);
    console.log(
      `[${kind}] ${trackerRow.key} prod=${detail.prodDone ? 'DONE' : detail.prodCompletionStatus}`
      + ` si=${detail.siDone ? 'DONE' : detail.siStatus}`
      + ` -> K=${update.K}${update.L ? ` L=${update.L}` : ''}`,
    );
  }

  summary.workbooks[kind].discrepancies = discrepancies;
  summary.workbooks[kind].writes = writes;
  summary.workbooks[kind].prodToSi = prodToSi;
  summary.workbooks[kind].siToProd = siToProd;
  summary.workbooks[kind].bothDone = bothDone;
  summary.workbooks[kind].neitherDone = neitherDone;
  summary.counts[kind].discrepancies = discrepancies.length;
  summary.counts[kind].writes = writes.length;
  summary.counts[kind].prodToSi = prodToSi.length;
  summary.counts[kind].siToProd = siToProd.length;
  summary.counts[kind].bothDone = bothDone;
  summary.counts[kind].neitherDone = neitherDone;
  console.log(
    `[${kind}] summary bothDone=${bothDone} prodOnly=${prodToSi.length} siOnly=${siToProd.length}`
    + ` neither=${neitherDone} discrepancies=${discrepancies.length}`,
  );

  return { trackerRows, proposalByKey };
}

async function processWorkbook(kind, storeSet, workbookPath, reconcilePeriods, summary) {
  const trackerRows = await loadScopedTrackerRows(kind, storeSet, workbookPath, reconcilePeriods);
  if (!trackerRows.length) {
    return classifyWorkbook(kind, [], [], [], summary);
  }
  const { prodRows, siRows, prodErrors } = await resilientFetchSourceRows(trackerRows, {
    siCsvPath: SI_CSV_PATH,
  });
  return classifyWorkbook(kind, trackerRows, prodRows, siRows, summary, {
    prodErrors,
    siSource: SI_CSV_PATH ? 'csv' : 'live-api',
  });
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

async function pullSiPhotosForSiToProd(rows, api, token, photosRoot, sessions = null) {
  const report = { savedSets: 0, savedImages: 0, items: [], errors: [] };
  let activeToken = token;
  let lastDistrict = null;
  for (const row of rows) {
    const item = { ...row, images: [], folder: null, error: null };
    if (!row.siTaskId) {
      item.error = 'missing siTaskId';
      report.items.push(item);
      continue;
    }
    const district = row.district || districtForStore(row.store) || 'unknown';
    if (sessions?.byDistrict && district !== 'unknown' && district !== lastDistrict) {
      const session = sessions.byDistrict[district];
      if (session) {
        applyReboticsSession(session, api);
        activeToken = session.token;
        lastDistrict = district;
      }
    }
    const setFolder = path.join(
      photosRoot,
      `District_${district}`,
      `Store_${row.store}`,
      `${row.periodWeek}_${row.dbkey}_${safeSegment(row.pogName, 40)}`,
    );
    item.folder = setFolder;
    try {
      await fsp.mkdir(setFolder, { recursive: true });
      const { actions } = await actionsForTask(api, activeToken, row.siTaskId);
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
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const { env: _ignored, ...rest } = opts;
    console.log(`[spawn] node ${args.join(' ')}`);
    if (env.REBOTICS_USERNAME) {
      console.log(`[spawn] REBOTICS_USERNAME=${env.REBOTICS_USERNAME} (token override ${env.REBOTICS_TOKEN ? 'yes' : 'no'})`);
    }
    const child = spawn('node', args, {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: 'inherit',
      windowsHide: true,
      ...rest,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/**
 * Non-blocking operator inbox (does not require the Cursor agent).
 * Drop commands into OPERATOR_COMMANDS.txt (one per line); they are consumed
 * at phase boundaries. Freeform notes go in OPERATOR_NOTES.md.
 *
 * Commands: pause | resume | skip-prod-to-si | skip-si-to-prod | skip-si-photos | abort
 * Flags: PAUSE.flag (wait), ABORT.flag (exit after current phase)
 */
async function honorOperatorInbox(opts, phase) {
  const notesPath = path.join(OUT_DIR, 'OPERATOR_NOTES.md');
  const commandsPath = path.join(OUT_DIR, 'OPERATOR_COMMANDS.txt');
  const processedPath = path.join(OUT_DIR, 'OPERATOR_COMMANDS_processed.log');
  const pauseFlag = path.join(OUT_DIR, 'PAUSE.flag');
  const abortFlag = path.join(OUT_DIR, 'ABORT.flag');
  const actionsLog = path.join(OUT_DIR, 'operator_actions.log');

  const logAction = (msg) => {
    const line = `${new Date().toISOString()} [${phase}] ${msg}`;
    console.log(`[operator] ${line}`);
    try { fs.appendFileSync(actionsLog, `${line}\n`, 'utf8'); } catch { /* ignore */ }
  };

  if (fs.existsSync(notesPath)) {
    try {
      const st = fs.statSync(notesPath);
      logAction(`OPERATOR_NOTES.md present mtime=${st.mtime.toISOString()} (freeform; not auto-applied)`);
    } catch { /* ignore */ }
  }

  const drainCommands = () => {
    if (!fs.existsSync(commandsPath)) return [];
    const raw = fs.readFileSync(commandsPath, 'utf8');
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    fs.writeFileSync(commandsPath, '', 'utf8');
    if (lines.length) {
      try {
        fs.appendFileSync(processedPath, `${new Date().toISOString()} phase=${phase}\n${lines.map((l) => `  ${l}`).join('\n')}\n`, 'utf8');
      } catch { /* ignore */ }
    }
    return lines.map((l) => l.toLowerCase());
  };

  let commands = drainCommands();
  for (const cmd of commands) {
    if (cmd === 'skip-prod-to-si') { opts.skipProdToSi = true; logAction('applied skip-prod-to-si'); }
    else if (cmd === 'skip-si-to-prod') { opts.skipSiToProd = true; logAction('applied skip-si-to-prod'); }
    else if (cmd === 'skip-si-photos') { opts.skipSiPhotos = true; logAction('applied skip-si-photos'); }
    else if (cmd === 'abort') {
      fs.writeFileSync(abortFlag, `abort requested at ${phase}\n`, 'utf8');
      logAction('abort requested');
    }
    else if (cmd === 'pause') {
      fs.writeFileSync(pauseFlag, `pause at ${phase}\n`, 'utf8');
      logAction('pause requested');
    }
    else if (cmd === 'resume') {
      try { fs.unlinkSync(pauseFlag); } catch { /* ignore */ }
      logAction('resume requested');
    }
    else logAction(`unknown command ignored: ${cmd}`);
  }

  while (fs.existsSync(pauseFlag)) {
    logAction('paused — remove PAUSE.flag or drop "resume" into OPERATOR_COMMANDS.txt');
    await new Promise((r) => setTimeout(r, 5000));
    commands = drainCommands();
    for (const cmd of commands) {
      if (cmd === 'resume') {
        try { fs.unlinkSync(pauseFlag); } catch { /* ignore */ }
        logAction('resumed');
      } else if (cmd === 'abort') {
        fs.writeFileSync(abortFlag, `abort while paused at ${phase}\n`, 'utf8');
        try { fs.unlinkSync(pauseFlag); } catch { /* ignore */ }
        logAction('abort while paused');
      } else if (cmd === 'skip-prod-to-si') { opts.skipProdToSi = true; logAction('applied skip-prod-to-si'); }
      else if (cmd === 'skip-si-to-prod') { opts.skipSiToProd = true; logAction('applied skip-si-to-prod'); }
      else if (cmd === 'skip-si-photos') { opts.skipSiPhotos = true; logAction('applied skip-si-photos'); }
      else logAction(`unknown command ignored while paused: ${cmd}`);
    }
  }

  if (fs.existsSync(abortFlag)) {
    const err = new Error(`Operator abort at phase=${phase} (ABORT.flag / abort command)`);
    err.code = 'OPERATOR_ABORT';
    throw err;
  }
}

async function runProdToSiCloseout(outDir, discrepancyPath, opts, sessions = null) {
  const script = path.resolve(__dirname, 'reconcile-d1-d8-prod-to-si.js');
  const closeoutDir = path.join(outDir, 'prod-to-si-closeout');
  const allRows = JSON.parse(fs.readFileSync(discrepancyPath, 'utf8'));
  const results = [];

  for (const district of DISTRICTS) {
    const districtRows = allRows.filter((row) => Number(row.district || districtForStore(row.store)) === Number(district));
    if (!districtRows.length) {
      console.log(`[prod-to-si] D${district}: no discrepancy rows; skip`);
      continue;
    }
    const partialPath = path.join(outDir, `${RUN_LABEL}_prod_to_si_D${district}_discrepancies.json`);
    await fsp.writeFile(partialPath, JSON.stringify(districtRows, null, 2));
    const districtOut = path.join(closeoutDir, `D${district}`);
    const confirmScope = `D${district}`;
    const args = [
      script,
      '--apply-si',
      '--districts', String(district),
      '--confirm-scope', confirmScope,
      '--cutoff', PERIOD_END,
      '--out', districtOut,
      '--discrepancies', partialPath,
    ];
    if (opts.allowBlurry) args.push('--allow-blurry');
    const session = sessions?.byDistrict?.[district];
    const env = session ? envForReboticsSession(session) : {};
    console.log(`[prod-to-si] D${district}: rows=${districtRows.length} user=${session?.username || 'railway-default'}`);
    results.push({
      district,
      username: session?.username || null,
      ...(await spawnNode(args, { env })),
    });
  }

  return { ok: results.every((r) => r.ok), results };
}

async function runSiToProdBackfill(discrepancyPath, outDir, sessions = null) {
  if (!fs.existsSync(BEFORE_PHOTO)) {
    console.warn(`[si-to-prod] Before photo missing (${BEFORE_PHOTO}); skipping backfill apply.`);
    return { ok: false, skipped: true, reason: 'before photo missing' };
  }
  const script = path.resolve(__dirname, 'p06w1-si-to-prod-backfill.js');
  const sitoprodDir = path.join(outDir, 'sitoprod');
  const allRows = JSON.parse(fs.readFileSync(discrepancyPath, 'utf8'));
  const results = [];

  for (const district of DISTRICTS) {
    const districtRows = allRows.filter((row) => Number(row.district || districtForStore(row.store)) === Number(district));
    if (!districtRows.length) {
      console.log(`[si-to-prod] D${district}: no discrepancy rows; skip`);
      continue;
    }
    const partialPath = path.join(outDir, `${RUN_LABEL}_si_to_prod_D${district}_discrepancies.json`);
    await fsp.writeFile(partialPath, JSON.stringify(districtRows, null, 2));
    const districtOut = path.join(sitoprodDir, `D${district}`);
    const session = sessions?.byDistrict?.[district];
    const env = session ? envForReboticsSession(session) : {};
    console.log(`[si-to-prod] D${district}: rows=${districtRows.length} user=${session?.username || 'railway-default'}`);
    results.push({
      district,
      username: session?.username || null,
      ...(await spawnNode([
        script,
        '--apply',
        '--discrepancies', partialPath,
        '--out-root', districtOut,
      ], { env })),
    });
  }

  return { ok: results.every((r) => r.ok), results };
}

function normalizeReconcileKey(key) {
  if (!key) return '';
  const parts = String(key).split('|');
  if (parts.length !== 4) return String(key);
  const [pw, store, cat, dbkey] = parts;
  const normPw = normalizePeriodWeek(pw) || pw;
  return `${normPw}|${String(Number(store))}|${String(Number(cat))}|${dbkey}`;
}

function collectFilesRecursive(rootDir, predicate) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (predicate(ent.name, full)) out.push(full);
    }
  }
  return out;
}

function loadCompletedKeysFromProdToSi(outDir) {
  const closeoutDir = path.join(outDir, 'prod-to-si-closeout');
  const summaryPaths = collectFilesRecursive(closeoutDir, (name) => name === 'summary.json');
  const keys = new Set();
  for (const summaryPath of summaryPaths) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    for (const row of summary.completed || []) {
      keys.add(normalizeReconcileKey(row.key));
    }
    for (const row of summary.trackerWritePlan || []) {
      keys.add(normalizeReconcileKey(row.key));
    }
  }
  return keys;
}

function loadCompletedKeysFromSiToProd(outDir) {
  const sitoprodDir = path.join(outDir, 'sitoprod');
  const files = collectFilesRecursive(
    sitoprodDir,
    (name) => name.startsWith('si-to-prod-backfill_') && name.endsWith('.json'),
  ).sort().reverse();
  const keys = new Set();
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const batch of report.batches || []) {
      for (const set of batch.sets || []) {
        if (set.status === 'completed') keys.add(normalizeReconcileKey(set.key));
      }
    }
  }
  return keys;
}

function loadNeedsLoadedComments(outDir) {
  const sitoprodDir = path.join(outDir, 'sitoprod');
  const files = collectFilesRecursive(
    sitoprodDir,
    (name) => name.startsWith('si-to-prod-backfill_') && name.endsWith('.json'),
  ).sort().reverse();
  const SHIFT_MISS = /No SAS visit|No active lead shift|visit not found|no lead shift|POG not on visit/i;
  const comments = new Map();
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const batch of report.batches || []) {
      for (const set of batch.sets || []) {
        if (set.status === 'completed') continue;
        const reason = set.reason || batch.reason || '';
        if (SHIFT_MISS.test(String(reason))) {
          comments.set(normalizeReconcileKey(set.key), 'needs loaded to PROD');
        }
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
  applyRuntimeConfig(opts);
  console.log(`=== Tracker reconcile: districts=${DISTRICTS.join(',')} label=${RUN_LABEL} out=${OUT_DIR} ===`);
  await fsp.mkdir(OUT_DIR, { recursive: true });

  if (!fs.existsSync(LIVE_ISE)) throw new Error(`Live ISE tracker not found: ${LIVE_ISE}`);
  if (!fs.existsSync(LIVE_BLITZ)) throw new Error(`Live Blitz tracker not found: ${LIVE_BLITZ}`);

  const storeSet = new Set(storesForDistricts(DISTRICTS));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const confirmedCache = await loadOrSeedConfirmedCache();

  const iseCopy = path.join(OUT_DIR, ISE_COPY_NAME);
  const blitzCopy = path.join(OUT_DIR, BLITZ_COPY_NAME);
  await fsp.copyFile(LIVE_ISE, iseCopy);
  await fsp.copyFile(LIVE_BLITZ, blitzCopy);
  console.log(`Copied ISE -> ${iseCopy}`);
  console.log(`Copied Blitz -> ${blitzCopy}`);

  await honorOperatorInbox(opts, 'after-copy');

  const discovery = await discoverPeriodStart(storeSet, confirmedCache);
  if (!discovery.periodStart) {
    console.log(`No eligible district ${DISTRICTS.join(',')} incomplete rows found through ${PERIOD_END}. Nothing to reconcile.`);
    if (Object.keys(confirmedCache.sets || {}).length) {
      await persistConfirmedCache(confirmedCache);
    }
    const emptySummary = {
      generatedAt: new Date().toISOString(),
      districts: DISTRICTS,
      periodRange: null,
      copies: { ise: iseCopy, blitz: blitzCopy },
      discovery,
      confirmedSets: {
        path: CONFIRMED_CACHE_PATH,
        total: Object.keys(confirmedCache.sets || {}).length,
        recheckConfirmed: RECHECK_CONFIRMED,
      },
    };
    await fsp.writeFile(path.join(OUT_DIR, `${RUN_LABEL}_reconcile_summary_${stamp}.json`), JSON.stringify(emptySummary, null, 2));
    return;
  }

  const reconcilePeriods = new Set(periodsInRange(discovery.periodStart, PERIOD_END));
  console.log(`Period window: ${discovery.periodStart}..${PERIOD_END} (${reconcilePeriods.size} weeks)`);
  console.log(`Eligible rows scanned: ise=${discovery.iseCount} blitz=${discovery.blitzCount}`);

  const { api, token, sessions } = await bootstrapAuth();

  const summary = {
    generatedAt: new Date().toISOString(),
    districts: DISTRICTS,
    stores: [...storeSet].sort((a, b) => Number(a) - Number(b)),
    periodRange: `${discovery.periodStart}..${PERIOD_END}`,
    discovery,
    liveSources: { ise: LIVE_ISE, blitz: LIVE_BLITZ },
    siCsv: SI_CSV_PATH,
    yesOnlyWrites: YES_ONLY_WRITES,
    confirmedSets: {
      path: CONFIRMED_CACHE_PATH,
      loaded: Object.keys(confirmedCache.sets || {}).length,
      recheckConfirmed: RECHECK_CONFIRMED,
    },
    reboticsAccounts: {
      district6: sessions?.byDistrict?.[6]?.username || null,
      district8: sessions?.byDistrict?.[8]?.username || null,
    },
    copies: { ise: iseCopy, blitz: blitzCopy },
    counts: {
      ise: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
      blitz: { trackerRows: 0, discrepancies: 0, writes: 0, prodToSi: 0, siToProd: 0 },
    },
    workbooks: {},
  };

  // Shared PROD+SI fetch for ISE+Blitz (union keys once — do not double-fetch).
  // SI live fetch is split by district account (D6=USERNAME2, D8=USERNAME).
  const iseTrackerRows = await loadScopedTrackerRows('ise', storeSet, iseCopy, reconcilePeriods, confirmedCache);
  const blitzTrackerRows = await loadScopedTrackerRows('blitz', storeSet, blitzCopy, reconcilePeriods, confirmedCache);
  const unionTrackerRows = [...iseTrackerRows, ...blitzTrackerRows];
  console.log(`[scope] ise=${iseTrackerRows.length} blitz=${blitzTrackerRows.length} union=${unionTrackerRows.length}`);

  let sharedProdRows = [];
  let sharedSiRows = [];
  let sharedProdErrors = [];
  if (unionTrackerRows.length) {
    const fetched = await resilientFetchSourceRows(unionTrackerRows, {
      siCsvPath: SI_CSV_PATH,
      sessions,
      api,
    });
    sharedProdRows = fetched.prodRows;
    sharedSiRows = fetched.siRows;
    sharedProdErrors = fetched.prodErrors;
  }
  summary.sharedFetch = {
    prodRowCount: sharedProdRows.length,
    siRowCount: sharedSiRows.length,
    prodErrors: sharedProdErrors,
    siSource: SI_CSV_PATH ? 'csv' : 'live-api',
  };

  const sourceMeta = {
    prodErrors: sharedProdErrors,
    siSource: SI_CSV_PATH ? 'csv' : 'live-api',
  };
  classifyWorkbook('ise', iseTrackerRows, sharedProdRows, sharedSiRows, summary, sourceMeta);
  classifyWorkbook('blitz', blitzTrackerRows, sharedProdRows, sharedSiRows, summary, sourceMeta);

  const writesCachePath = path.join(OUT_DIR, `${RUN_LABEL}_writes_cache.json`);
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

  const discrepancyPath = path.join(OUT_DIR, `${RUN_LABEL}_reconcile_discrepancies_${stamp}.json`);
  await fsp.writeFile(discrepancyPath, JSON.stringify(allDiscrepancies, null, 2));
  const prodToSiCount = (summary.workbooks.ise?.prodToSi?.length || 0) + (summary.workbooks.blitz?.prodToSi?.length || 0);
  console.log(`Discrepancies=${allDiscrepancies.length} prodToSi=${prodToSiCount} siToProd=${allSiToProd.length} -> ${discrepancyPath}`);

  await honorOperatorInbox(opts, 'before-prod-to-si');
  if (!opts.skipProdToSi && prodToSiCount) {
    summary.prodToSiCloseout = await runProdToSiCloseout(OUT_DIR, discrepancyPath, opts, sessions);
  } else {
    summary.prodToSiCloseout = { ok: false, skipped: true };
  }

  await honorOperatorInbox(opts, 'before-si-photos');
  if (!opts.skipSiPhotos && allSiToProd.length) {
    const photosRoot = path.join(OUT_DIR, 'si-complete-prod-not-photos');
    const siToProdSorted = [...allSiToProd].sort(
      (a, b) => Number(a.district || districtForStore(a.store) || 0)
        - Number(b.district || districtForStore(b.store) || 0),
    );
    summary.siPhotoReport = await pullSiPhotosForSiToProd(
      siToProdSorted,
      api,
      token,
      photosRoot,
      sessions,
    );
  }

  await honorOperatorInbox(opts, 'before-si-to-prod');
  if (!opts.skipSiToProd && allSiToProd.length) {
    summary.siToProdBackfill = await runSiToProdBackfill(discrepancyPath, OUT_DIR, sessions);
  } else {
    summary.siToProdBackfill = { ok: false, skipped: true };
  }

  await honorOperatorInbox(opts, 'before-tracker-writes');

  const completedKeys = new Set([
    ...loadCompletedKeysFromProdToSi(OUT_DIR),
    ...loadCompletedKeysFromSiToProd(OUT_DIR),
  ]);
  const needsLoadedComments = loadNeedsLoadedComments(OUT_DIR);

  for (const kind of ['ise', 'blitz']) {
    const writes = summary.workbooks[kind]?.writes || [];
    const merged = mergeWrites(writes, completedKeys, needsLoadedComments, new Map());
    // Reports keep full diagnostic K/L; tracker cells:
    // - default: Yes-only (incomplete rows left untouched on the copy)
    // - --write-all-kl: Yes/No with blank L
    const forTracker = YES_ONLY_WRITES
      ? merged.filter((row) => row.K === 'Yes').map((row) => ({ ...row, L: '' }))
      : merged.map((row) => ({ ...row, L: '' }));
    summary.workbooks[kind].finalWrites = forTracker;
    summary.workbooks[kind].reportWrites = merged;
    summary.counts[kind].finalOutcomes = countWriteOutcomes(merged);
    summary.counts[kind].trackerWriteCount = forTracker.length;
  }

  const iseWrite = writeTrackerCells(iseCopy, workbookForKind('ise').sheetName, summary.workbooks.ise?.finalWrites || []);
  const blitzWrite = writeTrackerCells(blitzCopy, workbookForKind('blitz').sheetName, summary.workbooks.blitz?.finalWrites || []);
  summary.writeResults = { ise: iseWrite, blitz: blitzWrite };

  // Also write working copies (user-facing) when requested.
  if (opts.writeWorkingCopies) {
    const iseWorking = path.join(OUT_DIR, `SUPER Tracker ISE V1.3 - ${RUN_LABEL} copy.xlsm`);
    const blitzWorking = path.join(OUT_DIR, `SUPER Tracker Blitz V1.3 - ${RUN_LABEL} copy.xlsx`);
    await fsp.copyFile(iseCopy, iseWorking);
    await fsp.copyFile(blitzCopy, blitzWorking);
    summary.copies.iseWorking = iseWorking;
    summary.copies.blitzWorking = blitzWorking;
    console.log(`Working copies: ${iseWorking}`);
    console.log(`                ${blitzWorking}`);
  }

  const finalOpen = [];
  const markedYes = [];
  for (const kind of ['ise', 'blitz']) {
    for (const row of summary.workbooks[kind]?.reportWrites || []) {
      if (row.K === 'Yes') {
        markedYes.push({ workbookKind: kind, rowIndex: row.rowIndex, key: row.key, K: 'Yes', L: '' });
      } else {
        finalOpen.push({
          workbookKind: kind,
          rowIndex: row.rowIndex,
          key: row.key,
          K: row.K,
          L: row.L,
          reason: row.L || 'unable to confirm complete in both PROD and SI',
        });
      }
    }
  }

  const csvPath = path.join(OUT_DIR, `${RUN_LABEL}_reconcile_discrepancies_${stamp}.csv`);
  const csvHeaders = [
    'district', 'workbookKind', 'rowIndex', 'store', 'periodWeek', 'categoryId', 'dbkey',
    'pogName', 'setType', 'proposedComplete', 'proposedComment', 'prodDone', 'siDone', 'siTaskId', 'bucket', 'bucketReason',
  ];
  await fsp.writeFile(csvPath, toCsv(allDiscrepancies, csvHeaders));

  const openReportPath = path.join(OUT_DIR, `${RUN_LABEL}_unreconciled_${stamp}.json`);
  const yesReportPath = path.join(OUT_DIR, `${RUN_LABEL}_marked_yes_${stamp}.json`);
  await fsp.writeFile(openReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Rows left as-is on tracker copies (not written). Reasons from cross-ref + remediation.',
    count: finalOpen.length,
    rows: finalOpen,
  }, null, 2));
  await fsp.writeFile(yesReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Rows marked Yes on tracker copies (both systems complete, or remediated then complete).',
    count: markedYes.length,
    rows: markedYes,
  }, null, 2));

  // Persist confirmed both-complete keys so later weeks skip PROD/SI lookups.
  const confirmUpsert = upsertConfirmed(confirmedCache, [
    ...markedYes.map((row) => ({
      key: row.key,
      workbookKind: row.workbookKind,
      source: 'reconcile-both-complete',
    })),
    ...[...completedKeys].map((key) => ({
      key,
      source: 'reconcile-remediation-complete',
    })),
  ], { source: 'reconcile', label: RUN_LABEL });
  await persistConfirmedCache(confirmedCache, summary);
  summary.confirmedSets = {
    ...summary.confirmedSets,
    path: CONFIRMED_CACHE_PATH,
    added: confirmUpsert.added,
    updated: confirmUpsert.updated,
    total: confirmUpsert.total,
  };
  console.log(
    `[confirmed-sets] saved ${confirmUpsert.total} keys `
    + `(+${confirmUpsert.added} / ~${confirmUpsert.updated}) -> ${CONFIRMED_CACHE_PATH}`,
  );

  const summaryPath = path.join(OUT_DIR, `${RUN_LABEL}_reconcile_summary_${stamp}.json`);
  summary.paths = {
    discrepancyPath,
    csvPath,
    summaryPath,
    openReportPath,
    yesReportPath,
    confirmedSetsPath: CONFIRMED_CACHE_PATH,
    discrepancyCount: allDiscrepancies.length,
  };
  summary.finalOpenCount = finalOpen.length;
  summary.markedYesCount = markedYes.length;
  await fsp.writeFile(summaryPath, JSON.stringify({
    ...summary,
    workbooks: {
      ise: { ...summary.workbooks.ise, writes: summary.workbooks.ise?.finalWrites },
      blitz: { ...summary.workbooks.blitz, writes: summary.workbooks.blitz?.finalWrites },
    },
  }, null, 2));

  // Human-readable end report
  const textReportPath = path.join(OUT_DIR, `${RUN_LABEL}_reconcile_report_${stamp}.txt`);
  const reportLines = [
    `=== ${RUN_LABEL} District Tracker Reconcile Report ===`,
    `Generated: ${new Date().toISOString()}`,
    `Districts: ${DISTRICTS.join(', ')}`,
    `Period window: ${discovery.periodStart}..${PERIOD_END}`,
    `SI source: ${SI_CSV_PATH || 'live Rebotics API'}`,
    `Yes-only writes: ${YES_ONLY_WRITES}`,
    '',
    `ISE eligible: ${summary.counts.ise.trackerRows}  bothDone@crossref: ${summary.counts.ise.bothDone || 0}  prodOnly: ${summary.counts.ise.prodToSi}  siOnly: ${summary.counts.ise.siToProd}  neither: ${summary.counts.ise.neitherDone || 0}`,
    `Blitz eligible: ${summary.counts.blitz.trackerRows}  bothDone@crossref: ${summary.counts.blitz.bothDone || 0}  prodOnly: ${summary.counts.blitz.prodToSi}  siOnly: ${summary.counts.blitz.siToProd}  neither: ${summary.counts.blitz.neitherDone || 0}`,
    '',
    `Marked Yes (written to copies): ${markedYes.length}`,
    `  ise=${summary.counts.ise.finalOutcomes?.yes || 0} blitz=${summary.counts.blitz.finalOutcomes?.yes || 0}`,
    `Left open (not written): ${finalOpen.length}`,
    `  needs SI: ise=${summary.counts.ise.finalOutcomes?.needsSi || 0} blitz=${summary.counts.blitz.finalOutcomes?.needsSi || 0}`,
    `  needs PROD: ise=${summary.counts.ise.finalOutcomes?.needsProd || 0} blitz=${summary.counts.blitz.finalOutcomes?.needsProd || 0}`,
    `  needs loaded to PROD: ise=${summary.counts.ise.finalOutcomes?.needsLoaded || 0} blitz=${summary.counts.blitz.finalOutcomes?.needsLoaded || 0}`,
    `  unconfirmed: ise=${summary.counts.ise.finalOutcomes?.unconfirmed || 0} blitz=${summary.counts.blitz.finalOutcomes?.unconfirmed || 0}`,
    '',
    `Copies:`,
    `  ${iseCopy}`,
    `  ${blitzCopy}`,
    summary.copies.iseWorking ? `  ${summary.copies.iseWorking}` : '',
    summary.copies.blitzWorking ? `  ${summary.copies.blitzWorking}` : '',
    '',
    `Artifacts:`,
    `  ${summaryPath}`,
    `  ${yesReportPath}`,
    `  ${openReportPath}`,
    `  ${csvPath}`,
  ].filter(Boolean);
  await fsp.writeFile(textReportPath, `${reportLines.join('\n')}\n`);
  summary.paths.textReportPath = textReportPath;

  console.log(`\n=== ${RUN_LABEL} tracker reconcile complete ===`);
  console.log(`Period: ${discovery.periodStart}..${PERIOD_END}`);
  console.log(`Tracker copies: ${iseCopy}`);
  console.log(`                ${blitzCopy}`);
  console.log(`Marked Yes: ise=${summary.counts.ise.finalOutcomes?.yes || 0} blitz=${summary.counts.blitz.finalOutcomes?.yes || 0}`);
  console.log(`Still open (left as-is): ${finalOpen.length}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Report:  ${textReportPath}`);
}

main().catch((err) => {
  if (err && err.code === 'OPERATOR_ABORT') {
    console.warn(String(err.message || err));
    process.exit(2);
  }
  console.error(err.stack || err.message || err);
  process.exit(1);
});
