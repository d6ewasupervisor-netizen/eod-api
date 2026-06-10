'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeCategoryId } = require('./prod-row-fields');
const { buildReconciliationKey, classifyReconciliation, normalizeDbkey, normalizePeriodWeek, normalizeStore } = require('./sheet-reconciliation');
const { DEFAULT_NOT_IN_STORE_PATTERNS } = require('./not-in-store-patterns');
const { normalizeDistricts, storesForDistricts } = require('./metadata');
const {
  TRACKER_COLUMNS,
  resolveWorkbookPath,
  workbookForKind,
  workbookKindForSetType,
} = require('./tracker-workbooks');

function pythonCommand() {
  return process.env.PYTHON || process.env.PYTHON_EXE || (process.platform === 'win32' ? 'python' : 'python3');
}

function assertReadableFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tracker workbook is not synced or does not exist: ${filePath}`);
  }
  fs.accessSync(filePath, fs.constants.R_OK);
}

function readTrackerWorkbookRaw(kind, options = {}) {
  const workbook = workbookForKind(kind);
  const workbookPath = options.workbookPath || resolveWorkbookPath(kind, options);
  assertReadableFile(workbookPath);
  const scriptPath = path.resolve(__dirname, '../../../scripts/read_tracker.py');
  const args = [
    scriptPath,
    workbookPath,
    workbook.sheetName,
    '--header-row',
    String(options.headerRow || 1),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Tracker workbook read failed (${workbook.fileName}): ${stderr || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch (err) {
        reject(new Error(`Tracker workbook reader returned invalid JSON: ${err.message}`));
      }
    });
  });
}

function storesForScope(scope = {}) {
  const stores = new Set();
  const explicit = Array.isArray(scope.store)
    ? scope.store
    : Array.isArray(scope.stores)
      ? scope.stores
      : String(scope.store || scope.stores || '').split(',');
  for (const store of explicit) {
    const normalized = normalizeStore(store);
    if (normalized) stores.add(normalized);
  }
  for (const store of storesForDistricts(normalizeDistricts(scope.district ?? scope.districts))) {
    stores.add(normalizeStore(store));
  }
  return stores;
}

function periodWeeksForScope(scope = {}) {
  const raw = Array.isArray(scope.periodWeek)
    ? scope.periodWeek
    : Array.isArray(scope.periodWeeks)
      ? scope.periodWeeks
      : String(scope.periodWeek || scope.periodWeeks || '').split(',');
  return new Set(raw.map(normalizePeriodWeek).filter(Boolean));
}

function isAlreadyDone(row = {}) {
  return String(row.currentK ?? row.K ?? '').trim().toLowerCase() === 'yes';
}

function normalizeTrackerRow(row, kind) {
  const store = normalizeStore(row.store);
  const categoryId = normalizeCategoryId(row.categoryNumber);
  const dbkey = normalizeDbkey(row.pogId);
  const periodWeek = normalizePeriodWeek(row.pogId);
  const setType = row.setType || '';
  return {
    rowIndex: row.rowIndex,
    workbookKind: kind,
    periodWeek,
    store,
    categoryId,
    dbkey,
    pogName: row.pogName || '',
    pogId: row.pogId || '',
    setType,
    currentK: row.currentK || '',
    currentL: row.currentL || '',
    K: row.currentK || '',
    L: row.currentL || '',
    key: buildReconciliationKey({ periodWeek, store, categoryId, dbkey }),
    routedWorkbookKind: workbookKindForSetType(setType),
  };
}

async function readTrackerRowsWithStats(kind, scope = {}, options = {}) {
  const rawRows = await readTrackerWorkbookRaw(kind, options);
  return filterTrackerRowsForScope(rawRows, kind, scope);
}

function filterTrackerRowsForScope(rawRows, kind, scope = {}) {
  const wantedStores = storesForScope(scope);
  const wantedPeriods = periodWeeksForScope(scope);
  const stats = {
    rawRows: rawRows.length,
    invalidKey: 0,
    excludedStore: 0,
    excludedWrongPeriod: 0,
    excludedAlreadyDone: 0,
    excludedAlreadyDoneKeys: [],
    included: 0,
  };
  const rows = [];
  for (const rawRow of rawRows) {
    const row = normalizeTrackerRow(rawRow, workbookForKind(kind).kind);
    if (!row.store || !row.categoryId || !row.dbkey) {
      stats.invalidKey += 1;
      continue;
    }
    if (wantedStores.size && !wantedStores.has(row.store)) {
      stats.excludedStore += 1;
      continue;
    }
    if (wantedPeriods.size && !wantedPeriods.has(row.periodWeek)) {
      stats.excludedWrongPeriod += 1;
      continue;
    }
    if (isAlreadyDone(row)) {
      stats.excludedAlreadyDone += 1;
      stats.excludedAlreadyDoneKeys.push(row.key);
      continue;
    }
    rows.push(row);
  }
  stats.included = rows.length;
  return { rows, stats };
}

async function readTrackerRows(kind, scope = {}, options = {}) {
  return (await readTrackerRowsWithStats(kind, scope, options)).rows;
}

async function classifyTrackerScopeReadOnly({
  kind,
  scope = {},
  prodRows = [],
  siRows = [],
  notInStorePatterns = DEFAULT_NOT_IN_STORE_PATTERNS,
  projectMode = true,
  readerOptions = {},
} = {}) {
  const { rows: trackerRows, stats } = await readTrackerRowsWithStats(kind, scope, readerOptions);
  const result = classifyReconciliation({
    trackerRows,
    prodRows,
    siRows,
    notInStorePatterns,
    projectMode,
    ignoredKeys: stats.excludedAlreadyDoneKeys,
  });
  return { ...result, trackerRows, readerStats: stats };
}

module.exports = {
  TRACKER_COLUMNS,
  assertReadableFile,
  classifyTrackerScopeReadOnly,
  filterTrackerRowsForScope,
  normalizeTrackerRow,
  readTrackerRows,
  readTrackerRowsWithStats,
  readTrackerWorkbookRaw,
  periodWeeksForScope,
  isAlreadyDone,
  storesForScope,
};
