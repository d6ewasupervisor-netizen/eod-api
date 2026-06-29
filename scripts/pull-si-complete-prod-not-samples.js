#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { writeFileVersioned } = require('../src/lib/file-utils');

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const DISCREPANCY_JSON = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/P06W1_signoff_verify_discrepancies_2026-06-21T16-36-53.json';
const OUT_DIR = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/samples';
const SAMPLE_SIZE = 30;

function loadEnv() {
  const envPath = path.join(REBOTICS_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function loadApi() {
  loadEnv();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

function safeSegment(value, max = 80) {
  return String(value || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, max) || 'unknown';
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function imageUrlFromPrePhoto(entry) {
  return entry?.file?.file || entry?.merged_image || entry?.image || null;
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty body');
  return buf;
}

async function actionsForTask(api, token, taskId) {
  const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  const fromEmbedded = (task?.result?.pre_photo || [])
    .map((action, idx) => ({
      ...action,
      id: action?.id ?? action?.action_id,
      stage: action?.stage || 'pre_photo',
      bay: idx + 1,
    }))
    .filter((a) => a.id && imageUrlFromPrePhoto(a));
  return { task, actions: fromEmbedded };
}

function usableActions(actions) {
  return (actions || []).filter((action) => Boolean(imageUrlFromPrePhoto(action)));
}

async function main() {
  const discrepancies = JSON.parse(await fsp.readFile(DISCREPANCY_JSON, 'utf8'));
  const candidates = discrepancies.filter((row) => row.proposedComment === 'needs PROD complete' && row.siTaskId);
  if (!candidates.length) throw new Error('No SI-complete/PROD-not rows with siTaskId found.');
  const sample = shuffle(candidates);
  const targetImages = Math.min(SAMPLE_SIZE, candidates.length);

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const api = loadApi();
  const auth = await api.fetchTokenFromRailway();
  const token = auth.token;

  const summary = {
    source: DISCREPANCY_JSON,
    targetImages,
    candidatePool: candidates.length,
    auth: auth.username || auth.userId,
    outDir: OUT_DIR,
    startedAt: new Date().toISOString(),
    items: [],
    errors: [],
  };

  console.log(`Pulling up to ${targetImages} images from ${candidates.length} SI-complete/PROD-not rows`);
  console.log(`Output: ${OUT_DIR}`);

  let saved = 0;
  for (const row of sample) {
    if (saved >= targetImages) break;
    const item = {
      key: row.key,
      store: row.store,
      periodWeek: row.periodWeek,
      categoryId: row.categoryId,
      dbkey: row.dbkey,
      pogName: row.pogName,
      siTaskId: row.siTaskId,
      prodCompletionStatus: row.prodCompletionStatus,
      prodExceptionReason: row.prodExceptionReason,
      images: [],
    };
    try {
      const { task, actions } = await actionsForTask(api, token, row.siTaskId);
      const usable = usableActions(actions);
      if (!usable.length) {
        item.error = 'no usable pre_photo actions';
        summary.items.push(item);
        console.log(`  skip ${row.key}: no actions`);
        continue;
      }

      let downloaded = 0;
      for (const action of usable) {
        const actionId = action.id ?? action.action_id;
        const imageUrl = imageUrlFromPrePhoto(action);
        if (!imageUrl) continue;
        const buf = await downloadImage(imageUrl);
        const bay = action?.bay ?? downloaded + 1;
        const customId = `701-${String(row.store).padStart(5, '0')}`;
        const filename = [
          customId,
          `cat${row.categoryId}`,
          `pog${row.dbkey}`,
          `BAY${safeSegment(bay, 20)}`,
          row.periodWeek,
          `task${row.siTaskId}`,
          `action${actionId}.jpg`,
        ].join('_');
        const dest = path.join(OUT_DIR, filename);
        const writtenPath = await writeFileVersioned(dest, buf);
        item.images.push({
          actionId,
          bay: String(bay),
          path: writtenPath,
          bytes: buf.length,
        });
        saved += 1;
        downloaded += 1;
        break;
      }

      if (!item.images.length) {
        item.error = 'actions found but no downloadable image URL';
        console.log(`  skip ${row.key}: no image URLs`);
      } else {
        console.log(`  ${row.key}: saved task=${row.siTaskId} (${saved}/${targetImages})`);
      }
      item.taskTitle = task?.title || task?.task_def?.title || '';
      item.taskStatus = task?.status?.id || null;
      summary.items.push(item);
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (err) {
      item.error = err.message;
      summary.errors.push({ key: row.key, taskId: row.siTaskId, error: err.message });
      summary.items.push(item);
      console.log(`  ERROR ${row.key}: ${err.message}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.counts = {
    targetImages,
    saved,
    attempted: summary.items.length,
    withImages: summary.items.filter((i) => i.images?.length).length,
    totalImages: summary.items.reduce((n, i) => n + (i.images?.length || 0), 0),
    errors: summary.errors.length,
  };
  const manifestPath = await writeFileVersioned(
    path.join(OUT_DIR, 'samples_manifest.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(`manifest: ${manifestPath}`);
  console.log(`withImages=${summary.counts.withImages} totalImages=${summary.counts.totalImages} errors=${summary.counts.errors}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
