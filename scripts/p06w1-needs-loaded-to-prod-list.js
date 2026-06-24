#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DISTRICT_STORES } = require('../src/lib/trackers/metadata');

const REPORT = process.argv[2]
  || 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/sitoprod/si-to-prod-backfill_2026-06-21T18-25-33-989Z.json';
const OUT_DIR = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/needsloadedtoprod';

const SHIFT_MISS_REASONS = new Set([
  'visit not found',
  'no lead shift',
  'POG not on visit',
  'missing visit date',
]);

const BATCH_SHIFT_MISS = /No SAS visit with matching category resets|No active lead shift on visit/;

const NOT_SHIFT_MISS = new Set([
  'already complete in PROD',
  'no Rebotics after photos',
]);

function districtForStore(store) {
  const s = String(store).replace(/^0+/, '') || '0';
  for (const [d, stores] of Object.entries(DISTRICT_STORES)) {
    if (stores.map(String).includes(s)) return Number(d);
  }
  return null;
}

function csvEscape(value) {
  const v = String(value ?? '');
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowFromSet(batch, set, srcRow) {
  const skipReason = set.reason
    || (BATCH_SHIFT_MISS.test(String(batch.reason || '')) ? batch.reason : '');
  return {
    district: districtForStore(set.store || batch.store),
    store: String(set.store || batch.store),
    periodWeek: set.periodWeek || batch.periodWeek,
    categoryId: set.categoryId || srcRow?.categoryId,
    dbkey: set.dbkey || srcRow?.dbkey,
    pogName: set.pogName || srcRow?.pogName || '',
    setType: srcRow?.setType || '',
    siTaskId: set.siTaskId || srcRow?.siTaskId,
    prodCompletionStatus: srcRow?.prodCompletionStatus || '',
    prodExceptionReason: srcRow?.prodExceptionReason || '',
    prodComment: srcRow?.prodComment || '',
    visitDate: batch.visitDate || '',
    skipReason,
    workbookKind: batch.workbookKind || srcRow?.workbookKind || 'ise',
    key: set.key || srcRow?.key,
    rowIndex: srcRow?.rowIndex ?? null,
  };
}

function isNeedsLoaded(batch, set) {
  if (set.status === 'completed') return false;
  if (NOT_SHIFT_MISS.has(set.reason)) return false;
  if (SHIFT_MISS_REASONS.has(set.reason)) return true;
  if (set.status === 'skipped' && BATCH_SHIFT_MISS.test(String(batch.reason || ''))) return true;
  return false;
}

function main() {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const rows = [];

  for (const batch of report.batches || []) {
    const srcByKey = new Map((batch.rows || []).map((r) => [r.key, r]));
    for (const set of batch.sets || []) {
      if (!isNeedsLoaded(batch, set)) continue;
      const src = srcByKey.get(set.key) || batch.rows?.find((r) => r.key === set.key);
      rows.push(rowFromSet(batch, set, src));
    }
  }

  const seen = new Set();
  const unique = rows.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });

  unique.sort((a, b) => (
    (a.district - b.district)
    || String(a.store).localeCompare(String(b.store), undefined, { numeric: true })
    || a.periodWeek.localeCompare(b.periodWeek)
    || String(a.categoryId).localeCompare(String(b.categoryId), undefined, { numeric: true })
  ));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const byDist = {};
  const byReason = {};
  for (const r of unique) {
    byDist[r.district] = (byDist[r.district] || 0) + 1;
    byReason[r.skipReason] = (byReason[r.skipReason] || 0) + 1;
  }

  const csvHeader = [
    'district', 'store', 'periodWeek', 'categoryId', 'dbkey', 'pogName', 'setType',
    'siTaskId', 'prodCompletionStatus', 'prodExceptionReason', 'prodComment',
    'visitDate', 'skipReason', 'workbookKind', 'rowIndex', 'key',
  ];
  const csv = [
    csvHeader.join(','),
    ...unique.map((r) => csvHeader.map((h) => csvEscape(r[h])).join(',')),
  ].join('\n') + '\n';

  const md = [];
  md.push('# Sets needing PROD load (no category/shift found)');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Source backfill report: \`${path.basename(REPORT)}\``);
  md.push('');
  md.push('Row-by-row listing of **SI complete / PROD not** sets (Districts 1, 6, 8) where the backfill could **not** locate a SAS visit with the matching category reset, or had **no lead shift**, on the fiscal week date.');
  md.push('');
  md.push('## Summary');
  md.push(`- Total rows: **${unique.length}**`);
  md.push(`- By district: ${Object.entries(byDist).sort((a, b) => a[0] - b[0]).map(([d, n]) => `D${d}=${n}`).join(', ')}`);
  md.push(`- By skip reason: ${Object.entries(byReason).map(([k, n]) => `${k} (${n})`).join('; ')}`);
  md.push('');

  for (const d of [1, 6, 8]) {
    const dr = unique.filter((r) => r.district === d);
    md.push(`## District ${d} (${dr.length} sets)`);
    md.push('');
    if (!dr.length) {
      md.push('_None._');
      md.push('');
      continue;
    }
    md.push('| # | Store | Week | Cat | POG | Category name | Set type | SI Task | PROD status | Exception | Visit date | Skip reason |');
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    dr.forEach((r, i) => {
      md.push(`| ${i + 1} | ${r.store} | ${r.periodWeek} | ${r.categoryId} | ${r.dbkey} | ${r.pogName.replace(/\|/g, '/')} | ${r.setType} | ${r.siTaskId} | ${r.prodCompletionStatus} | ${r.prodExceptionReason.replace(/\|/g, '/')} | ${r.visitDate} | ${r.skipReason.replace(/\|/g, '/')} |`);
    });
    md.push('');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceReport: REPORT,
    count: unique.length,
    summary: { byDistrict: byDist, bySkipReason: byReason },
    rows: unique,
  };

  const jsonPath = path.join(OUT_DIR, `needs-loaded-to-prod_${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `needs-loaded-to-prod_${stamp}.csv`);
  const mdPath = path.join(OUT_DIR, `needs-loaded-to-prod_${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(mdPath, `${md.join('\n')}\n`);

  console.log(JSON.stringify({
    count: unique.length,
    jsonPath,
    csvPath,
    mdPath,
    byDist,
    byReason,
  }, null, 2));
}

main();
