'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const {
  normalizeProdCsv,
} = require('../src/lib/trackers/prod-csv-adapter');

const ROOT = path.resolve(__dirname, '..');
const PROOF_PATH = path.join(ROOT, 'scripts', 'kompass-proof', 'three-way-join-proof.js');
const PROD_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-ise-p05w3.raw.csv');
const SI_GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'si-normalized-golden.json');
const PROD_GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-normalized-golden.json');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadProofSharedFunctions() {
  const proofRequire = createRequire(PROOF_PATH);
  const module = { exports: {} };
  const source = fs.readFileSync(PROOF_PATH, 'utf8');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\(\(error\) => \{\s*console\.error\(`Three-way join proof failed: \$\{error\.message\}`\);\s*process\.exit\(1\);\s*\}\);\s*$/u,
    ''
  );
  if (withoutMain === source) {
    throw new Error('Could not suppress proof main() invocation for shared function load.');
  }

  const exportSource = `${withoutMain}

module.exports = {
  collapseRowsByKey,
  isProdDone,
};
`;

  vm.runInNewContext(exportSource, {
    __dirname: path.dirname(PROOF_PATH),
    __filename: PROOF_PATH,
    AbortController,
    Buffer,
    clearTimeout,
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

test('normalizes frozen PROD CSV through the PROD adapter', () => {
  const meta = loadJson(SI_GOLDEN_PATH).meta;
  const prodGolden = loadJson(PROD_GOLDEN_PATH);
  const csvText = fs.readFileSync(PROD_FIXTURE_PATH, 'utf8');
  const result = normalizeProdCsv(csvText, { periodWeek: prodGolden.meta.periodWeek });

  assert.equal(result.rawRows.length, meta.prodRawRowCount);
  assert.equal(result.prodRows.length, meta.prodJoinableRowCount);
  assert.equal(result.filteredCarryoverRows, meta.prodCarryoverRowsFiltered);
  assert.equal(
    result.rawRows.length,
    result.prodRows.length + result.filteredCarryoverRows + result.shiftSignoffs.length
  );
  assert.deepEqual(result.prodRows, prodGolden.prodRows);
  assert.deepEqual(result.shiftSignoffs, prodGolden.shiftSignoffs);
});

test('feeds the shared proof key collapse with the frozen PROD keyed count', () => {
  const meta = loadJson(SI_GOLDEN_PATH).meta;
  const prodGolden = loadJson(PROD_GOLDEN_PATH);
  const csvText = fs.readFileSync(PROD_FIXTURE_PATH, 'utf8');
  const result = normalizeProdCsv(csvText, { periodWeek: prodGolden.meta.periodWeek });
  const proofFns = loadProofSharedFunctions();
  const prodByKey = proofFns.collapseRowsByKey(result.prodRows, proofFns.isProdDone);

  assert.equal(prodByKey.size, meta.prodKeyedCount);
});
