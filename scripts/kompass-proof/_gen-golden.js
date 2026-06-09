// HISTORICAL ONE-SHOT — provenance tool. Generated test/fixtures/si-normalized-golden.json
// from the PRE-EXTRACTION inline SI transform in three-way-join-proof.js. After the SI
// adapter rewire (si-grafana-adapter.js) the inline SI declarations no longer exist in the
// proof, so this script is NOT expected to be rerunnable. Kept only to document how the
// frozen golden was produced. Do not resurrect; regenerating the golden would require the
// pre-extraction proof source.
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const SCRIPT_DIR = __dirname;
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const PROOF_PATH = path.join(SCRIPT_DIR, 'three-way-join-proof.js');
const SI_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'si-p05w3-query46.raw.json');
const PROD_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-ise-p05w3.raw.csv');
const GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'si-normalized-golden.json');
const TARGET_PERIOD_WEEK = 'P05W3';

function loadProofInlineTransforms() {
  const proofRequire = createRequire(PROOF_PATH);
  const module = { exports: {} };
  const source = fs.readFileSync(PROOF_PATH, 'utf8');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\(\(error\) => \{\s*console\.error\(`Three-way join proof failed: \$\{error\.message\}`\);\s*process\.exit\(1\);\s*\}\);\s*$/u,
    ''
  );
  if (withoutMain === source) {
    throw new Error('Could not suppress proof main() invocation; refusing to generate golden.');
  }

  const exportSource = `${withoutMain}

module.exports = {
  rowsFromGrafanaFrame,
  parseCsv,
  siRowToEngine,
  prodRowToEngine,
  collapseRowsByKey,
  isProdDone,
  isSiDone,
  buildReconciliationKey,
};
`;

  const context = {
    __dirname: SCRIPT_DIR,
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
  };
  vm.runInNewContext(exportSource, context, { filename: PROOF_PATH });
  return module.exports;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function keyFor(row, buildReconciliationKey) {
  return buildReconciliationKey(row);
}

function sortedRows(rows, buildReconciliationKey) {
  return rows
    .map((row, index) => ({ row, index, key: keyFor(row, buildReconciliationKey) }))
    .sort((a, b) => {
      const byKey = a.key.localeCompare(b.key, undefined, { numeric: true });
      return byKey === 0 ? a.index - b.index : byKey;
    })
    .map((item) => item.row);
}

async function main() {
  const transforms = loadProofInlineTransforms();
  const siPayload = readJson(SI_FIXTURE_PATH);
  const siRawRows = transforms.rowsFromGrafanaFrame(siPayload?.results?.A?.frames?.[0]).rows;
  const siRows = siRawRows
    .map(transforms.siRowToEngine)
    .filter((row) => row && row.periodWeek === TARGET_PERIOD_WEEK);
  const sortedSiRows = sortedRows(siRows, transforms.buildReconciliationKey);

  const prodCsv = await fsp.readFile(PROD_FIXTURE_PATH, 'utf8');
  const prodParsed = transforms.parseCsv(prodCsv);
  const prodRows = [];
  let filteredCarryoverRows = 0;
  for (const csvRow of prodParsed.rows) {
    const mapped = transforms.prodRowToEngine(csvRow);
    if (!mapped.joinable) continue;
    if (mapped.row.periodWeek === TARGET_PERIOD_WEEK) prodRows.push(mapped.row);
    else filteredCarryoverRows += 1;
  }

  const siByKey = transforms.collapseRowsByKey(siRows, transforms.isSiDone);
  const prodByKey = transforms.collapseRowsByKey(prodRows, transforms.isProdDone);
  const sharedKeyCount = [...siByKey.keys()].filter((key) => prodByKey.has(key)).length;
  const generatedAt = new Date().toISOString();

  const golden = {
    meta: {
      siRowCount: sortedSiRows.length,
      siKeyedCount: siByKey.size,
      prodRawRowCount: prodParsed.rows.length,
      prodJoinableRowCount: prodRows.length,
      prodKeyedCount: prodByKey.size,
      prodCarryoverRowsFiltered: filteredCarryoverRows,
      sharedKeyCount,
      siFixture: path.relative(ROOT, SI_FIXTURE_PATH).replace(/\\/g, '/'),
      prodFixture: path.relative(ROOT, PROD_FIXTURE_PATH).replace(/\\/g, '/'),
      generatedAt,
      transformSource: 'inline (pre-extraction)',
    },
    rows: sortedSiRows,
  };

  await fsp.writeFile(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(golden.meta, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
