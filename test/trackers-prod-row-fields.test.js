'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractProdFields,
  normalizeCategoryCompletionStatus,
  normalizeCategoryId,
  parseAfterPictureUrls,
  rowValue,
} = require('../src/lib/trackers/prod-row-fields');
const { categoryIdFromTask } = require('../src/lib/trackers/rebotics-reports');

const PROD_LATEST = 'C:/Users/tgaut/Downloads/category_report_data_export_20260607220713523287.csv';
const PROD_SUB100 = 'C:/Users/tgaut/Downloads/category_report_data_export_20260601220859700277.csv';
const SI_LATEST = 'C:/Users/tgaut/Downloads/_-data-2026-06-07 15_11_07.csv';
const SI_P05W2 = 'C:/Users/tgaut/Downloads/_-data-2026-06-05 12_39_34.csv';

function parseCsv(text) {
  const records = [];
  let record = [];
  let cur = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      record.push(cur);
      cur = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      record.push(cur);
      cur = '';
      if (record.some((value) => String(value).trim())) records.push(record);
      record = [];
      continue;
    }
    cur += ch;
  }
  record.push(cur);
  if (record.some((value) => String(value).trim())) records.push(record);
  if (records.length < 2) return [];
  const header = records[0];
  return records.slice(1).map((cols) => Object.fromEntries(header.map((name, index) => [name, cols[index] || ''])));
}

function readRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required real CSV fixture is missing: ${filePath}`);
  }
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

function dbkeyFromPlanogram(planogramId) {
  const match = String(planogramId || '').match(/^P\d+W\d_(\d+)_/i);
  return match ? match[1] : '';
}

function taskFromExportRow(row) {
  return {
    title: rowValue(row, ['Task Name']),
    category: { name: rowValue(row, ['Category']) },
  };
}

test('normalizeCategoryId strips leading zeros and tolerates blanks', () => {
  assert.equal(normalizeCategoryId('055'), '55');
  assert.equal(normalizeCategoryId('82'), '82');
  assert.equal(normalizeCategoryId(201), '201');
  assert.equal(normalizeCategoryId(' 052 '), '52');
  assert.equal(normalizeCategoryId(null), '');
  assert.equal(normalizeCategoryId(''), '');
});

test('PROD real CSV normalizes completion, exceptions, comments, and after pictures', () => {
  const rows = readRows(PROD_LATEST);
  const normalized = rows.map((row) => ({
    ...extractProdFields(row),
    store: rowValue(row, ['Store #']),
    dbkey: dbkeyFromPlanogram(rowValue(row, ['Planogram ID'])),
  }));

  assert.equal(normalizeCategoryCompletionStatus('True'), 'done');
  assert.equal(normalizeCategoryCompletionStatus('False'), 'not_done');
  assert.equal(normalizeCategoryCompletionStatus(''), 'unknown');

  const done = normalized.find((row) => row.categoryCompletionStatus === 'done');
  const notDone = normalized.find((row) => row.categoryCompletionStatus === 'not_done');
  const unknown = normalized.find((row) => row.categoryCompletionStatus === 'unknown');
  assert.equal(done.categoryCompletionStatus, 'done');
  assert.equal(notDone.categoryCompletionStatus, 'not_done');
  assert.equal(unknown.categoryCompletionStatus, 'unknown');

  const backlog = normalized.find((row) => row.categoryExceptionReason === 'Backlog - Revisit Needed');
  const notExecutable = normalized.find((row) => row.categoryExceptionReason === 'Not an Executable KOMPASS event');
  const notInStore = normalized.find((row) => row.store === '19' && row.dbkey === '9009204');
  assert.equal(backlog.categoryExceptionReason, 'Backlog - Revisit Needed');
  assert.equal(notExecutable.categoryExceptionReason, 'Not an Executable KOMPASS event');
  assert.equal(notInStore.categoryExceptionReason, 'Not an Executable KOMPASS event');
  assert.equal(notInStore.comment, 'not in store');

  const multiline = normalized.find((row) => row.comment.includes('\n'));
  assert.match(multiline.comment, /training\s*\nmultiple instances of com/);

  const multiPhoto = normalized.find((row) => row.afterPictureUrls.length > 1);
  const singlePhoto = normalized.find((row) => row.afterPictureUrls.length === 1);
  const emptyPhoto = normalized.find((row) => row.afterPictureUrls.length === 0);
  assert.ok(multiPhoto.afterPictureUrls.length > 1);
  assert.ok(multiPhoto.afterPictureUrls.every((url) => url.startsWith('https://')));
  assert.equal(singlePhoto.afterPictureUrls.length, 1);
  assert.deepEqual(emptyPhoto.afterPictureUrls, []);
});

test('parseAfterPictureUrls returns arrays for Python-style URL lists', () => {
  assert.deepEqual(parseAfterPictureUrls("['https://a.test/m', 'https://b.test/m']"), ['https://a.test/m', 'https://b.test/m']);
  assert.deepEqual(parseAfterPictureUrls("['https://a.test/m']"), ['https://a.test/m']);
  assert.deepEqual(parseAfterPictureUrls(''), []);
});

test('real PROD and SI CSV categories normalize identically for sub-100 and 3-digit values', () => {
  const prodSub100 = readRows(PROD_SUB100)
    .map((row) => ({ ...extractProdFields(row), planogramId: rowValue(row, ['Planogram ID']) }))
    .find((row) => row.categoryId === '82');
  const siSub100 = readRows(SI_P05W2)
    .map((row) => categoryIdFromTask(taskFromExportRow(row)))
    .find((categoryId) => categoryId === '82');
  assert.equal(prodSub100.categoryId, '82');
  assert.equal(siSub100, '82');

  const prodThreeDigit = readRows(PROD_LATEST).map(extractProdFields).find((row) => row.categoryId === '201');
  const siThreeDigit = readRows(SI_LATEST)
    .map((row) => categoryIdFromTask(taskFromExportRow(row)))
    .find((categoryId) => categoryId === '201');
  assert.equal(prodThreeDigit.categoryId, '201');
  assert.equal(siThreeDigit, '201');
});

test('SI title parser handles sub-100 and 3-digit category ids', () => {
  assert.equal(categoryIdFromTask({ title: 'P05W3-2026 9014910 055-BAG SNACKS D701 S02 NII' }), '55');
  assert.equal(categoryIdFromTask({ title: 'P05W3-2026 9088146 201-CANDY - CHECKLANE 417 Reset' }), '201');
  assert.equal(categoryIdFromTask({ title: 'bad title', category: { name: '082-SINGLE SERVE BEVERAGE' } }), '82');
});

test('real CSV fixture paths stay anchored outside the repository', () => {
  assert.equal(path.isAbsolute(PROD_LATEST), true);
  assert.equal(fs.existsSync(PROD_LATEST), true);
  assert.equal(fs.existsSync(SI_LATEST), true);
});
