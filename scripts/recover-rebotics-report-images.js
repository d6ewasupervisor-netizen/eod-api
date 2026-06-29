#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeFileVersioned } = require('../src/lib/file-utils');

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const DEFAULT_IDS = [15833766, 15833773, 15833784, 15833786, 15833792, 15833794, 15833797];

function parseArgs(argv) {
  const opts = {
    ids: DEFAULT_IDS,
    store: '391',
    dbkey: '9032258',
    taskId: 39278330,
    outDir: path.join('output', 'rebotics-photo-recovery', `store-391_dbkey-9032258_${new Date().toISOString().replace(/[:.]/g, '-')}`),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ids') opts.ids = argv[++i].split(',').map((id) => Number(id.trim())).filter(Boolean);
    else if (arg === '--store') opts.store = String(argv[++i]);
    else if (arg === '--dbkey') opts.dbkey = String(argv[++i]);
    else if (arg === '--task') opts.taskId = Number(argv[++i]);
    else if (arg === '--out') opts.outDir = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/recover-rebotics-report-images.js',
        '  [--ids 15833766,15833773] [--store 391] [--dbkey 9032258] [--task 39278330]',
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

function loadEnv() {
  const envPath = path.join(REBOTICS_ROOT, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

function loadApi() {
  loadEnv();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function imageUrlForAction(action) {
  return action?.merged_image || action?.image || action?.original_image || action?.file_url || action?.files?.[0]?.url || null;
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('image download returned empty body');
  return buf;
}

async function main() {
  const opts = parseArgs(process.argv);
  const outDir = path.resolve(opts.outDir);
  await fs.promises.mkdir(outDir, { recursive: true });

  const api = loadApi();
  const auth = await api.fetchTokenFromRailway();
  const token = auth.token;
  const summary = {
    store: opts.store,
    dbkey: opts.dbkey,
    taskId: opts.taskId,
    ids: opts.ids,
    auth: auth.username || auth.userId,
    outDir,
    startedAt: new Date().toISOString(),
    recovered: [],
    missingImage: [],
    errors: [],
  };

  console.log(`Recovering ${opts.ids.length} Rebotics images for store ${opts.store} dbkey ${opts.dbkey}`);
  console.log(`Output: ${outDir}`);

  for (const id of opts.ids) {
    try {
      const action = await api.reboticsJson(token, 'GET', `/api/v4/processing/actions/${id}/`);
      const imageUrl = imageUrlForAction(action);
      const actionSummary = {
        id,
        stage: action?.stage || null,
        status: action?.status || null,
        deactivated: Boolean(action?.deactivated),
        rejected: Boolean(action?.rejected),
        capturedAt: action?.captured_at || null,
        categoryId: action?.category_id || action?.category?.id || null,
        sectionId: action?.section_id || action?.section?.id || null,
        sectionName: action?.section_info?.name || action?.section?.name || null,
        storePlanogramId: action?.store_planogram_id || action?.store_planogram?.id || action?.store_planogram || null,
        hasImage: Boolean(imageUrl),
      };
      if (!imageUrl) {
        summary.missingImage.push(actionSummary);
        console.log(`  ${id}: no image URL exposed`);
        continue;
      }

      const buf = await downloadImage(imageUrl);
      const bay = actionSummary.sectionName || actionSummary.sectionId || 'unknown';
      const dest = path.join(outDir, `store-${safeSegment(opts.store)}_dbkey-${safeSegment(opts.dbkey)}_task-${opts.taskId}_bay-${safeSegment(bay)}_action-${id}.jpg`);
      const writtenPath = await writeFileVersioned(dest, buf);
      summary.recovered.push({ ...actionSummary, path: writtenPath, bytes: buf.length });
      console.log(`  ${id}: recovered ${buf.length} bytes -> ${writtenPath}`);
    } catch (error) {
      summary.errors.push({ id, error: error.message, body: error.body || null });
      console.log(`  ${id}: ERROR ${error.message}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.counts = {
    recovered: summary.recovered.length,
    missingImage: summary.missingImage.length,
    errors: summary.errors.length,
  };
  const manifestPath = await writeFileVersioned(path.join(outDir, 'manifest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`manifest: ${manifestPath}`);
  console.log(`recovered=${summary.counts.recovered} missingImage=${summary.counts.missingImage} errors=${summary.counts.errors}`);
  if (summary.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
