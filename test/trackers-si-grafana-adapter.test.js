'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const {
  normalizeQuery46Rows,
} = require('../src/lib/trackers/si-grafana-adapter');
const {
  normalizeProdCsv,
} = require('../src/lib/trackers/prod-csv-adapter');

const ROOT = path.resolve(__dirname, '..');
const PROOF_PATH = path.join(ROOT, 'scripts', 'kompass-proof', 'three-way-join-proof.js');
const SI_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'si-p05w3-query46.raw.json');
const PROD_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-ise-p05w3.raw.csv');
const GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'si-normalized-golden.json');
const TARGET_PERIOD_WEEK = 'P05W3';

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadProofProdInlineFunctions() {
  const proofRequire = createRequire(PROOF_PATH);
  const module = { exports: {} };
  const source = fs.readFileSync(PROOF_PATH, 'utf8');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\(\(error\) => \{\s*console\.error\(`Three-way join proof failed: \$\{error\.message\}`\);\s*process\.exit\(1\);\s*\}\);\s*$/u,
    ''
  );
  if (withoutMain === source) {
    throw new Error('Could not suppress proof main() invocation for PROD inline function load.');
  }

  const exportSource = `${withoutMain}

module.exports = {
  collapseRowsByKey,
  isProdDone,
  isSiDone,
  buildReconciliationKey,
};
`;

  vm.runInNewContext(exportSource, {
    __dirname: path.dirname(PROOF_PATH),
    __filename: PROOF_PATH,
    Buffer,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    require: proofRequire,
    setTimeout,
    URLSearchParams,
  }, { filename: PROOF_PATH });

  return module.exports;
}

function sortedRows(rows, buildReconciliationKey) {
  return rows
    .map((row, index) => ({ row, index, key: buildReconciliationKey(row) }))
    .sort((a, b) => {
      const byKey = a.key.localeCompare(b.key, undefined, { numeric: true });
      return byKey === 0 ? a.index - b.index : byKey;
    })
    .map((item) => item.row);
}

function buildFrozenProdRows(proofFns) {
  const prodCsv = fs.readFileSync(PROD_FIXTURE_PATH, 'utf8');
  return normalizeProdCsv(prodCsv, { periodWeek: TARGET_PERIOD_WEEK }).prodRows;
}

test('normalizes Query 46 fixture rows through the SI adapter', () => {
  const siPayload = loadJson(SI_FIXTURE_PATH);
  const rows = normalizeQuery46Rows(siPayload);

  assert.equal(rows.length, 2306);
});

test('normalizes 055-BAG SNACKS commodity prefix to shared category 55', () => {
  const siPayload = loadJson(SI_FIXTURE_PATH);
  const rows = normalizeQuery46Rows(siPayload);
  const bagSnacks = rows.find((row) => /^055-BAG SNACKS/i.test(String(row.raw?.grafana?.Commodity || '')));

  assert.ok(bagSnacks, 'expected a 055-BAG SNACKS Query 46 row in fixture');
  assert.equal(bagSnacks.categoryId, '55');
});

test('matches the frozen full-payload SI golden', () => {
  const proofFns = loadProofProdInlineFunctions();
  const siPayload = loadJson(SI_FIXTURE_PATH);
  const golden = loadJson(GOLDEN_PATH);
  const rows = sortedRows(normalizeQuery46Rows(siPayload), proofFns.buildReconciliationKey);

  assert.deepEqual(rows, golden.rows);
});

test('recomputes the frozen PROD/SI intersection count', () => {
  const proofFns = loadProofProdInlineFunctions();
  const siPayload = loadJson(SI_FIXTURE_PATH);
  const golden = loadJson(GOLDEN_PATH);
  const siRows = normalizeQuery46Rows(siPayload);
  const prodRows = buildFrozenProdRows(proofFns);
  const siByKey = proofFns.collapseRowsByKey(siRows, proofFns.isSiDone);
  const prodByKey = proofFns.collapseRowsByKey(prodRows, proofFns.isProdDone);
  const sharedKeyCount = [...siByKey.keys()].filter((key) => prodByKey.has(key)).length;

  assert.equal(sharedKeyCount, golden.meta.sharedKeyCount);
});
