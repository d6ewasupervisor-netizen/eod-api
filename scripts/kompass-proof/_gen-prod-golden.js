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
const PROD_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-ise-p05w3.raw.csv');
const SI_GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'si-normalized-golden.json');
const GOLDEN_PATH = path.join(ROOT, 'test', 'fixtures', 'prod-normalized-golden.json');
const FIXTURE_URL = 'https://fixture.local/prod-ise-p05w3.raw.csv';

function response({ status = 200, headers = {}, body = '' }) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      },
    },
    async text() {
      return String(body);
    },
    async json() {
      return JSON.parse(String(body));
    },
    async arrayBuffer() {
      return Buffer.from(String(body), 'utf8');
    },
  };
}

function loadProofInlineProdPath(csvText) {
  const proofRequire = createRequire(PROOF_PATH);
  const module = { exports: {} };
  const source = fs.readFileSync(PROOF_PATH, 'utf8');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\(\(error\) => \{\s*console\.error\(`Three-way join proof failed: \$\{error\.message\}`\);\s*process\.exit\(1\);\s*\}\);\s*$/u,
    ''
  );
  if (withoutMain === source) {
    throw new Error('Could not suppress proof main() invocation; refusing to generate PROD golden.');
  }

  const exportSource = `${withoutMain}

module.exports = {
  PROD_WEEK_RANGES,
  pullProdRows,
  pullProdWeek,
};
`;

  const fetchFixture = async (url) => {
    const textUrl = String(url || '');
    if (textUrl.startsWith('https://prod.sasretail.com/api/v1/reports/category-reset-report/')) {
      return response({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_url: FIXTURE_URL, message: 'fixture-backed PROD CSV' }),
      });
    }
    if (textUrl === FIXTURE_URL) {
      return response({
        headers: { 'content-type': 'text/csv' },
        body: csvText,
      });
    }
    throw new Error(`Unexpected fetch in PROD golden generator: ${textUrl}`);
  };

  const context = {
    __dirname: SCRIPT_DIR,
    __filename: PROOF_PATH,
    AbortController,
    Buffer,
    console,
    exports: module.exports,
    fetch: fetchFixture,
    module,
    process,
    require: proofRequire,
    setTimeout,
    clearTimeout,
    URLSearchParams,
  };
  vm.runInNewContext(exportSource, context, { filename: PROOF_PATH });
  return module.exports;
}

async function main() {
  const csvText = await fsp.readFile(PROD_FIXTURE_PATH, 'utf8');
  const siGolden = JSON.parse(await fsp.readFile(SI_GOLDEN_PATH, 'utf8'));
  const inlineProd = loadProofInlineProdPath(csvText);
  const weeks = inlineProd.PROD_WEEK_RANGES || [];
  const result = await inlineProd.pullProdRows('fixture-token');
  const periodWeeks = [...new Set(weeks.map((week) => String(week.periodWeek || '').trim()).filter(Boolean))];
  const periodWeek = periodWeeks.length === 1 ? periodWeeks[0] : periodWeeks.join(',');
  const weekCount = Array.isArray(result.weeks) ? result.weeks.length : weeks.length;

  const golden = {
    meta: {
      transformSource: 'inline (pre-extraction)',
      prodFixture: path.relative(ROOT, PROD_FIXTURE_PATH).replace(/\\/g, '/'),
      periodWeek,
      weekCount,
      generatedAt: new Date().toISOString(),
    },
    prodRows: result.prodRows,
    shiftSignoffs: result.shiftSignoffs,
  };

  await fsp.writeFile(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');

  const counts = {
    rawRows: result.rawRows.length,
    prodRows: result.prodRows.length,
    shiftSignoffs: result.shiftSignoffs.length,
    filteredCarryoverRows: result.filteredCarryoverRows,
    weekCount,
    expected: {
      prodRawRowCount: siGolden.meta.prodRawRowCount,
      prodJoinableRowCount: siGolden.meta.prodJoinableRowCount,
      prodCarryoverRowsFiltered: siGolden.meta.prodCarryoverRowsFiltered,
    },
  };

  console.log(JSON.stringify(counts, null, 2));

  if (
    counts.rawRows !== counts.expected.prodRawRowCount ||
    counts.prodRows !== counts.expected.prodJoinableRowCount ||
    counts.filteredCarryoverRows !== counts.expected.prodCarryoverRowsFiltered
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
