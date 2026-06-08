'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  TRACKER_COLUMNS,
  WORKBOOKS,
  isBlitzSetType,
  normalizeWorkbookKind,
  resolveWorkbookPath,
  workbookForKind,
  workbookKindForSetType,
} = require('../src/lib/trackers/tracker-workbooks');
const {
  filterTrackerRowsForScope,
  isAlreadyDone,
  normalizeTrackerRow,
  periodWeeksForScope,
} = require('../src/lib/trackers/tracker-sheet-reader');

test('tracker workbook metadata matches live workbook names and sheets', () => {
  assert.equal(WORKBOOKS.blitz.fileName, 'SUPER Tracker Blitz V1.3.xlsx');
  assert.equal(WORKBOOKS.blitz.sheetName, 'BLITZ TRACKER');
  assert.equal(WORKBOOKS.ise.fileName, 'SUPER Tracker ISE V1.3.xlsm');
  assert.equal(WORKBOOKS.ise.sheetName, 'ISE & CUT TRACKER');
});

test('tracker column map keeps write columns isolated to K/L metadata', () => {
  assert.equal(TRACKER_COLUMNS.store, 3);
  assert.equal(TRACKER_COLUMNS.categoryNumber, 4);
  assert.equal(TRACKER_COLUMNS.pogName, 5);
  assert.equal(TRACKER_COLUMNS.pogId, 8);
  assert.equal(TRACKER_COLUMNS.setType, 9);
  assert.equal(TRACKER_COLUMNS.currentK, 11);
  assert.equal(TRACKER_COLUMNS.currentL, 12);
});

test('workbook kind normalization and routing separates Blitz from ISE/Cut', () => {
  assert.equal(normalizeWorkbookKind('BLITZ'), 'blitz');
  assert.equal(normalizeWorkbookKind('ise_cut'), 'ise');
  assert.equal(workbookForKind('cut').kind, 'ise');
  assert.equal(isBlitzSetType('Blitz'), true);
  assert.equal(workbookKindForSetType('P05W2 Blitz'), 'blitz');
  assert.equal(workbookKindForSetType('Kompass ISE'), 'ise');
  assert.equal(workbookKindForSetType('Cut In'), 'ise');
});

test('resolveWorkbookPath is env-driven and does not hardcode a user path', () => {
  const baseDir = path.join('C:', 'fake', 'Trackers');
  assert.equal(resolveWorkbookPath('blitz', { baseDir }), path.join(baseDir, 'SUPER Tracker Blitz V1.3.xlsx'));
  assert.equal(resolveWorkbookPath('ise', { baseDir }), path.join(baseDir, 'SUPER Tracker ISE V1.3.xlsm'));
  assert.throws(() => resolveWorkbookPath('ise', { baseDir: '' }), /TRACKER_ONEDRIVE_DIR/);
});

test('tracker row normalization extracts period, category, dbkey, and four-part key', () => {
  const row = normalizeTrackerRow({
    rowIndex: 5,
    store: 19,
    categoryNumber: '082',
    pogName: '082 SINGLE SERVE BEVERAGE',
    pogId: 'P05W2_9007685_D701_L00000_D01_C082_V861_I024_MX',
    setType: 'UPDATE',
    currentK: 'No',
    currentL: 'Needs check',
  }, 'ise');
  assert.equal(row.periodWeek, 'P05W2');
  assert.equal(row.categoryId, '82');
  assert.equal(row.dbkey, '9007685');
  assert.equal(row.key, 'P05W2|19|82|9007685');
});

test('period scope and eligibility filters include No/blank and exclude Yes/wrong-period', () => {
  const rawRows = [
    { rowIndex: 1, store: 19, categoryNumber: 201, pogId: 'P05W2_1000001_D701_L00000_D03_C201_V001_MX', setType: 'BLITZ', currentK: 'Yes', currentL: '' },
    { rowIndex: 2, store: 19, categoryNumber: 201, pogId: 'P05W2_1000002_D701_L00000_D03_C201_V001_MX', setType: 'BLITZ', currentK: 'No', currentL: 'stuck note' },
    { rowIndex: 3, store: 19, categoryNumber: 201, pogId: 'P05W2_1000003_D701_L00000_D03_C201_V001_MX', setType: 'BLITZ', currentK: '', currentL: '' },
    { rowIndex: 4, store: 19, categoryNumber: 201, pogId: 'P04W4_1000004_D701_L00000_D03_C201_V001_MX', setType: 'BLITZ', currentK: 'No', currentL: '' },
    { rowIndex: 5, store: 23, categoryNumber: 201, pogId: 'P05W2_1000005_D701_L00000_D03_C201_V001_MX', setType: 'BLITZ', currentK: 'No', currentL: '' },
  ];
  const result = filterTrackerRowsForScope(rawRows, 'blitz', { store: 19, periodWeek: 'P05W2' });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.dbkey), ['1000002', '1000003']);
  assert.equal(result.stats.excludedAlreadyDone, 1);
  assert.deepEqual(result.stats.excludedAlreadyDoneKeys, ['P05W2|19|201|1000001']);
  assert.equal(result.stats.excludedWrongPeriod, 1);
  assert.equal(result.stats.excludedStore, 1);
});

test('periodWeeksForScope and isAlreadyDone normalize inputs', () => {
  assert.deepEqual([...periodWeeksForScope({ periodWeeks: ['p5w2', 'P04W4'] })], ['P05W2', 'P04W4']);
  assert.equal(isAlreadyDone({ currentK: ' yes ' }), true);
  assert.equal(isAlreadyDone({ currentK: 'No' }), false);
  assert.equal(isAlreadyDone({ currentK: '' }), false);
});
