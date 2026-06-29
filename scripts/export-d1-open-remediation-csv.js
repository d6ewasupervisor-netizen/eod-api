#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeFileVersioned } = require('../src/lib/file-utils');

const OUT = process.argv[2] || 'C:/Users/tgaut/Downloads/p06w1_district1_tracking';

function norm(k) {
  const parts = String(k).split('|');
  if (parts.length !== 4) return String(k);
  const m = String(parts[0]).match(/^P0?(\d+)W([1-4])$/i);
  const pw = m ? `P${String(Number(m[1])).padStart(2, '0')}W${m[2]}` : parts[0];
  return `${pw}|${Number(parts[1])}|${Number(parts[2])}|${parts[3]}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function errorDetail(row) {
  if (typeof row.body === 'string') return row.body.replace(/\s+/g, ' ').trim();
  if (row.body?.non_field_errors?.[0]) return row.body.non_field_errors[0];
  return row.error || '';
}

async function main() {
  const cache = loadJson(path.join(OUT, 'D1_writes_cache.json'));
  const prod = loadJson(path.join(OUT, 'prod-to-si-closeout/summary.json'));
  const blurry = loadJson(path.join(OUT, 'prod-to-si-blurry-retry/summary.json'));
  const disc = loadJson(path.join(OUT, 'D1_reconcile_discrepancies_2026-06-24T18-06-26.json'));
  const sitoprodFiles = fs.readdirSync(path.join(OUT, 'sitoprod'))
    .filter((f) => f.startsWith('si-to-prod-backfill_') && f.endsWith('.json'))
    .sort()
    .reverse();
  const sitoprod = loadJson(path.join(OUT, 'sitoprod', sitoprodFiles[0]));
  const discByKey = new Map(disc.map((d) => [norm(d.key), d]));

  const completedKeys = new Set([
    ...(prod.completed || []).map((r) => norm(r.key)),
    ...(prod.trackerWritePlan || []).map((r) => norm(r.key)),
    ...(blurry.completed || []).map((r) => norm(r.key)),
    ...(cache.prodOnlyNoSiKeys || []).map(norm),
  ]);
  for (const batch of sitoprod.batches || []) {
    for (const set of batch.sets || []) {
      if (set.status === 'completed') completedKeys.add(norm(set.key));
    }
  }

  const SHIFT = /No SAS visit|No active lead shift|visit not found|no lead shift|POG not on visit/i;
  const needsLoaded = new Map();
  for (const batch of sitoprod.batches || []) {
    for (const set of batch.sets || []) {
      if (set.status === 'completed') continue;
      const reason = set.reason || batch.reason || '';
      if (SHIFT.test(String(reason))) needsLoaded.set(norm(set.key), reason);
    }
  }

  function merge(row) {
    const key = norm(row.key);
    if (completedKeys.has(key)) return { ...row, K: 'Yes', L: '' };
    if (needsLoaded.has(key)) return { ...row, K: 'No', L: 'needs loaded to PROD' };
    return row;
  }

  const prodSiErr = new Map((prod.errors || []).map((r) => [norm(r.key), errorDetail(r)]));
  const prodSiSkip = new Map((prod.skipped || []).map((r) => [norm(r.key), r.reason || '']));

  const sitoprodDetail = new Map();
  for (const batch of sitoprod.batches || []) {
    for (const set of batch.sets || []) {
      if (set.status === 'completed') continue;
      sitoprodDetail.set(norm(set.key), set.reason || batch.reason || set.status || '');
    }
  }

  function reasonForRow(row) {
    const key = norm(row.key);
    const L = String(row.L || '');
    if (L === 'needs SI complete') {
      if (prodSiErr.has(key)) return `PROD to SI error: ${prodSiErr.get(key)}`;
      if (prodSiSkip.has(key)) return `PROD to SI skipped: ${prodSiSkip.get(key)}`;
      return 'PROD to SI: no closeout success recorded';
    }
    if (L === 'needs PROD complete') {
      const br = sitoprodDetail.get(key);
      if (br) return `SI to PROD backfill: ${br}`;
      return 'SI to PROD: backfill did not complete; PROD still open in cross-ref';
    }
    if (L.includes('needs loaded')) {
      return `SI to PROD backfill skipped: ${sitoprodDetail.get(key) || needsLoaded.get(key) || 'no matching visit/shift'}`;
    }
    return '';
  }

  const ise = (cache.ise || []).map(merge);
  const targets = ise.filter((r) => (
    r.L === 'needs SI complete'
    || r.L === 'needs PROD complete'
    || String(r.L).includes('needs loaded')
  ));

  const headers = [
    'workbook', 'row_index', 'store', 'period_week', 'category_id', 'dbkey',
    'pog_name', 'set_type', 'copy_complete', 'copy_comment', 'side',
    'remediation_stage', 'detail_reason', 'si_task_id', 'prod_done', 'si_done',
  ];

  const rows = targets.map((row) => {
    const key = norm(row.key);
    const parts = key.split('|');
    const d = discByKey.get(key) || {};
    const L = String(row.L || '');
    let side = '';
    let stage = '';
    if (L === 'needs SI complete') {
      side = 'PROD done / SI not';
      stage = 'prod-to-si-closeout';
    } else if (L === 'needs PROD complete') {
      side = 'SI done / PROD not';
      stage = 'si-to-prod-backfill';
    } else {
      side = 'SI done / PROD not';
      stage = 'si-to-prod-backfill (visit/shift skip)';
    }
    return {
      workbook: 'ise',
      row_index: row.rowIndex,
      store: parts[1],
      period_week: parts[0],
      category_id: parts[2],
      dbkey: parts[3],
      pog_name: d.pogName || '',
      set_type: d.setType || '',
      copy_complete: row.K,
      copy_comment: L,
      side,
      remediation_stage: stage,
      detail_reason: reasonForRow(row),
      si_task_id: d.siTaskId || '',
      prod_done: d.prodDone ?? '',
      si_done: d.siDone ?? '',
    };
  });

  const order = { 'needs SI complete': 0, 'needs PROD complete': 1, 'needs loaded to PROD': 2 };
  rows.sort((a, b) => {
    const ca = order[a.copy_comment] ?? 9;
    const cb = order[b.copy_comment] ?? 9;
    if (ca !== cb) return ca - cb;
    return Number(a.store) - Number(b.store) || a.period_week.localeCompare(b.period_week);
  });

  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  const csv = `${lines.join('\n')}\n`;

  const desired = path.join(OUT, 'D1_open_remediation_detail.csv');
  const actual = await writeFileVersioned(desired, csv);

  const counts = {};
  for (const r of rows) counts[r.copy_comment] = (counts[r.copy_comment] || 0) + 1;
  console.log(`Wrote ${actual}`);
  console.log(`Rows: ${rows.length}`, counts);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
