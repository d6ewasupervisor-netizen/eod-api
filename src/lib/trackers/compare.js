'use strict';

const { attachPeriodWeek } = require('./date-range');

function normStore(v) {
  const n = parseInt(String(v || ''), 10);
  return Number.isNaN(n) ? String(v || '').trim() : String(n);
}

function normDbkey(v) {
  const s = String(v || '').trim();
  return /^\d{6,10}$/.test(s) ? s : '';
}

function buildKey(row) {
  return `${normStore(row.storeNumber)}|${normDbkey(row.dbkey)}|${row.workDate || ''}`;
}

function summarizeStatus(prodRows, siRows) {
  const prodDone = prodRows.some((r) => String(r.status || '').includes('complete'));
  const siDone = siRows.some((r) => {
    const s = String(r.status || '');
    return s === 'completed' || s === 'complete' || s === 'done';
  });
  if (prodRows.length && siRows.length) {
    if (prodDone && siDone) return 'both_complete';
    if (prodDone && !siDone) return 'complete_in_prod_not_si';
    if (!prodDone && siDone) return 'complete_in_si_not_prod';
    return 'both_incomplete';
  }
  if (prodRows.length) return 'prod_only';
  if (siRows.length) return 'si_only';
  return 'unknown';
}

function compareRows(prodRowsIn, siRowsIn) {
  const prodRows = attachPeriodWeek(prodRowsIn || []);
  const siRows = attachPeriodWeek(siRowsIn || []);
  const grouped = new Map();

  for (const row of prodRows) {
    const key = buildKey(row);
    if (!grouped.has(key)) grouped.set(key, { prod: [], si: [], key });
    grouped.get(key).prod.push(row);
  }
  for (const row of siRows) {
    const key = buildKey(row);
    if (!grouped.has(key)) grouped.set(key, { prod: [], si: [], key });
    grouped.get(key).si.push(row);
  }

  const items = [];
  const images = [];
  for (const bucket of grouped.values()) {
    const sample = bucket.prod[0] || bucket.si[0] || {};
    const storeNumber = normStore(sample.storeNumber);
    const dbkey = normDbkey(sample.dbkey);
    const prodPhotoCount = bucket.prod.reduce((acc, r) => acc + (r.photoCount || 0), 0);
    const siPhotoCount = bucket.si.reduce((acc, r) => acc + (r.photoCount || 0), 0);
    const confidence = storeNumber && dbkey ? 'high' : 'needs_review';
    const notes = [];
    if (!dbkey) notes.push('Missing dbkey');
    if (bucket.prod.length > 1 || bucket.si.length > 1) notes.push('Multiple rows merged for same key');
    if (Math.abs(prodPhotoCount - siPhotoCount) > 0) notes.push('Photo count mismatch');

    const item = {
      storeNumber,
      workDate: sample.workDate || null,
      periodWeek: sample.periodWeek || null,
      projectId: bucket.prod[0]?.projectId || null,
      projectName: bucket.prod[0]?.projectName || null,
      dbkey,
      pog: dbkey || null,
      categorySetLabel: bucket.prod[0]?.categorySetLabel || bucket.si[0]?.categorySetLabel || '',
      prodStatus: summarizeStatus(bucket.prod, []),
      siStatus: summarizeStatus([], bucket.si),
      comparisonStatus: summarizeStatus(bucket.prod, bucket.si),
      prodPhotoCount,
      siPhotoCount,
      confidence,
      notes: notes.join('; '),
      sourceRefs: {
        prod: bucket.prod.map((r) => r.raw).slice(0, 5),
        si: bucket.si.map((r) => r.raw).slice(0, 5),
      },
    };
    items.push(item);

    for (const row of bucket.prod) {
      for (const img of row.images || []) {
        images.push({ ...img, itemKey: bucket.key });
      }
    }
    for (const row of bucket.si) {
      for (const img of row.images || []) {
        images.push({ ...img, itemKey: bucket.key });
      }
    }
  }

  items.sort((a, b) => {
    const byStore = String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true });
    if (byStore) return byStore;
    const byDate = String(a.workDate || '').localeCompare(String(b.workDate || ''));
    if (byDate) return byDate;
    return String(a.dbkey || '').localeCompare(String(b.dbkey || ''));
  });

  const summary = {
    total: items.length,
    byStatus: items.reduce((acc, item) => {
      const k = item.comparisonStatus || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    needsReview: items.filter((i) => i.confidence !== 'high').length,
  };

  return { items, images, summary };
}

module.exports = {
  compareRows,
};
