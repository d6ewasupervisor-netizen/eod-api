'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildPhase1dPreview,
  changeTypeFor,
  normalizeTrackerNote,
  writeApprovedRows,
} = require('../src/lib/trackers/tracker-sheet-writer');

function pythonCommand() {
  return process.env.PYTHON || process.env.PYTHON_EXE || (process.platform === 'win32' ? 'python' : 'python3');
}

function runPython(code, args = []) {
  const result = spawnSync(pythonCommand(), ['-c', code, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Python exited ${result.status}`);
  }
  return result.stdout;
}

function makeTempWorkbook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-writer-'));
  const workbookPath = path.join(dir, 'Tracker Copy.xlsx');
  runPython(`
import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "TRACKER"
ws["A1"] = "=1+1"
ws["K2"] = "No"
ws["L2"] = "old note"
ws["K3"] = "No"
ws["L3"] = "Confirmed - not in SI"
wb.save(sys.argv[1])
`, [workbookPath]);
  return { dir, workbookPath };
}

function readCells(workbookPath, sheetName = 'TRACKER') {
  const stdout = runPython(`
import json
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=False)
ws = wb[sys.argv[2]]
print(json.dumps({
  "K2": ws["K2"].value,
  "L2": ws["L2"].value,
  "K3": ws["K3"].value,
  "L3": ws["L3"].value,
  "A1": ws["A1"].value,
}))
`, [workbookPath, sheetName]);
  return JSON.parse(stdout);
}

function proposal(overrides = {}) {
  return {
    key: 'P05W2|19|201|9009204',
    rowIndex: 2,
    workbookKind: 'blitz',
    bucket: 'matched_both',
    current: { K: 'No', L: '' },
    proposed: { K: 'Yes', L: '' },
    prod: { completionStatus: 'done', comment: '' },
    si: { present: true, status: 'done' },
    reason: 'PROD and SI both show complete.',
    ...overrides,
  };
}

test('normalizeTrackerNote follows tracker house casing', () => {
  assert.equal(normalizeTrackerNote('not in store'), 'Not in Store');
  assert.equal(normalizeTrackerNote(' confirmed not in si '), 'Confirmed - not in SI');
  assert.equal(normalizeTrackerNote('confirmed - not in SI'), 'Confirmed - not in SI');
  assert.equal(normalizeTrackerNote('lots of product movement'), 'Lots Of Product Movement');
});

test('changeTypeFor distinguishes K_only, K_and_L, and no_op', () => {
  assert.equal(changeTypeFor({ K: 'No', L: '' }, { K: 'Yes', L: '' }), 'K_only');
  assert.equal(changeTypeFor({ K: 'No', L: 'old note' }, { K: 'Yes', L: '' }), 'K_and_L');
  assert.equal(changeTypeFor({ K: 'Yes', L: 'confirmed not in si' }, { K: 'Yes', L: 'Confirmed - not in SI' }), 'no_op');
});

test('buildPhase1dPreview writes only matched_both and confirmed_not_in_si', () => {
  const preview = buildPhase1dPreview([
    proposal({ bucket: 'matched_both', current: { K: 'No', L: '' } }),
    proposal({
      key: 'P05W2|19|201|9009205',
      rowIndex: 3,
      bucket: 'confirmed_not_in_si',
      current: { K: 'No', L: 'confirmed not in si' },
      proposed: { K: 'Yes', L: 'confirmed not in SI' },
      prod: { completionStatus: 'not_done', comment: 'not in SI' },
      si: { present: false, status: 'absent' },
      reason: 'PROD comment says not in SI and SI has no matching task.',
    }),
    proposal({
      key: 'P05W2|19|201|9009206',
      rowIndex: 4,
      bucket: 'not_in_store_closeout',
      current: { K: 'No', L: 'Not in Store' },
      proposed: { K: 'Yes', L: 'not in store' },
    }),
    proposal({
      key: 'P05W2|19|201|9009207',
      rowIndex: 5,
      bucket: 'confirmed_not_in_si',
      current: { K: 'Yes', L: 'Confirmed - not in SI' },
      proposed: { K: 'Yes', L: 'confirmed not in SI' },
      prod: { completionStatus: 'not_done', comment: 'not in SI' },
      si: { present: false, status: 'absent' },
      reason: 'PROD comment says not in SI and SI has no matching task.',
    }),
  ]);
  assert.equal(preview.writeRows.length, 2);
  assert.equal(preview.deferred.length, 1);
  assert.equal(preview.alreadySatisfied, 1);
  assert.deepEqual(preview.changeTypes, { K_only: 2, K_and_L: 0, no_op: 1 });
  assert.equal(preview.writeRows[1].L, 'confirmed not in si');
});

test('writeApprovedRows requires approval and refuses unsafe buckets', async () => {
  const row = {
    rowIndex: 2,
    bucket: 'matched_both',
    changeType: 'K_only',
    current: { K: 'No', L: '' },
    prod: { completionStatus: 'done' },
    si: { present: true, status: 'done' },
    K: 'Yes',
    L: '',
  };
  assert.throws(() => writeApprovedRows('blitz', 'TRACKER', [row]), /approval/i);
  assert.throws(
    () => writeApprovedRows('blitz', 'TRACKER', [{ ...row, bucket: 'not_in_store_closeout' }], { approved: true, workbookPath: 'unused.xlsx' }),
    /refuses to write bucket/
  );
  assert.throws(
    () => writeApprovedRows('blitz', 'TRACKER', [{ ...row, changeType: 'no_op' }], { approved: true, workbookPath: 'unused.xlsx' }),
    /no-op/
  );
  assert.throws(
    () => writeApprovedRows('blitz', 'TRACKER', [{
      rowIndex: 3219,
      key: 'P05W2|19|201|9009204',
      bucket: 'matched_both',
      changeType: 'K_and_L',
      current: { K: 'No', L: 'Not in Store' },
      prod: { completionStatus: 'not_done', comment: 'not in store' },
      si: { present: true, status: 'not_done' },
      K: 'Yes',
      L: '',
    }], { approved: true, workbookPath: 'unused.xlsx' }),
    /without PROD done and SI done evidence/
  );
});

test('writeApprovedRows backs up then writes only K/L for eligible rows on a temp workbook', async () => {
  const { workbookPath } = makeTempWorkbook();
  const result = await writeApprovedRows('blitz', 'TRACKER', [
    {
      rowIndex: 2,
      bucket: 'matched_both',
      changeType: 'K_and_L',
      current: { K: 'No', L: 'old note' },
      prod: { completionStatus: 'done' },
      si: { present: true, status: 'done' },
      K: 'Yes',
      L: '',
    },
    {
      rowIndex: 3,
      bucket: 'confirmed_not_in_si',
      changeType: 'K_only',
      current: { K: 'No', L: 'Confirmed - not in SI' },
      prod: { completionStatus: 'not_done', comment: 'not in SI' },
      si: { present: false, status: 'absent' },
      reason: 'PROD comment says not in SI and SI has no matching task.',
      K: 'Yes',
      L: 'Confirmed - not in SI',
    },
  ], { approved: true, workbookPath });

  assert.deepEqual(result.written, [2, 3]);
  assert.ok(result.backupPath.endsWith('.xlsx'));
  assert.ok(fs.existsSync(result.backupPath));
  assert.deepEqual(readCells(workbookPath), {
    K2: 'Yes',
    L2: null,
    K3: 'Yes',
    L3: 'Confirmed - not in SI',
    A1: '=1+1',
  });
  assert.deepEqual(readCells(result.backupPath), {
    K2: 'No',
    L2: 'old note',
    K3: 'No',
    L3: 'Confirmed - not in SI',
    A1: '=1+1',
  });
});

test('writeApprovedRows aborts when owner lock file is present', async () => {
  const { workbookPath } = makeTempWorkbook();
  const lockPath = path.join(path.dirname(workbookPath), `~$${path.basename(workbookPath)}`);
  fs.writeFileSync(lockPath, 'locked');
  await assert.rejects(
    () => writeApprovedRows('blitz', 'TRACKER', [
      {
        rowIndex: 2,
        bucket: 'matched_both',
        changeType: 'K_and_L',
        current: { K: 'No', L: 'old note' },
        prod: { completionStatus: 'done' },
        si: { present: true, status: 'done' },
        K: 'Yes',
        L: '',
      },
    ], { approved: true, workbookPath }),
    /locked/
  );
  assert.equal(fs.readdirSync(path.dirname(workbookPath)).filter((name) => name.includes('.bak-')).length, 0);
  assert.equal(readCells(workbookPath).K2, 'No');
});
