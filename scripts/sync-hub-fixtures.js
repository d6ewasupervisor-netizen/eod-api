#!/usr/bin/env node
'use strict';

/**
 * Copy FIXTURES from checklanes/index.html into src/data/hub-fixtures/{store}.json
 *
 * Usage:
 *   node scripts/sync-hub-fixtures.js [path/to/checklanes/index.html] [storeNumber]
 *
 * Defaults: ../the-dump-bin/checklanes/index.html (if present) and store 163.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const defaultHtml = path.join(repoRoot, '..', 'the-dump-bin', 'checklanes', 'index.html');
const htmlPath = path.resolve(process.argv[2] || defaultHtml);
const storeNumber = process.argv[3] || '163';

if (!fs.existsSync(htmlPath)) {
  console.error('HTML not found:', htmlPath);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/const FIXTURES = \[([\s\S]*?)\n\];/);
if (!m) {
  console.error('FIXTURES array not found in', htmlPath);
  process.exit(1);
}

const fixtures = eval('[' + m[1] + ']');
const outDir = path.join(repoRoot, 'src', 'data', 'hub-fixtures');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${storeNumber}.json`);
fs.writeFileSync(outPath, JSON.stringify({ storeNumber, fixtures }, null, 2) + '\n');
console.log(`Wrote ${fixtures.length} fixtures → ${outPath}`);
