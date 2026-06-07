'use strict';

const { attachPeriodWeek } = require('./date-range');

// Tracker compare done model:
// Done is status-based. Photo count is not part of done.
// PROD done: completed SAS report row exists and status normalizes to complete/completed.
// PROD absent: no completed row for store|dbkey.
// PROD not_done is not observable in Phase 1 because PROD rows are completed-only.
// SI done: Rebotics task exists and status normalizes to complete/completed/done.
// SI not_done: Rebotics task exists, status is not complete.
// SI absent: no SI task for store|dbkey.
// TODO(phase2): add PROD roster rows so scheduled-but-incomplete can become observable.
const PHASE2_ROSTER_NOTE = 'Scheduled-but-incomplete planograms are not tracked until the PROD roster is integrated (Phase 2).';

function normStore(v) {
  const n = parseInt(String(v || ''), 10);
  return Number.isNaN(n) ? String(v || '').trim() : String(n);
}

function normDbkey(v) {
  const s = String(v || '').trim();
  return /^\d{6,10}$/.test(s) ? s : '';
}

function buildKey(row) {
  return `${normStore(row.storeNumber)}|${normDbkey(row.dbkey)}`;
}

function normalizeProdStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'complete' || s === 'completed' ? 'done' : 'not_done';
}

function normalizeSiStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'complete' || s === 'completed' || s === 'done' ? 'done' : 'not_done';
}

function rowTime(row) {
  const time = row?.workDate ? new Date(`${row.workDate}T00:00:00Z`).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function pickMostComplete(rows, normalizer) {
  return [...(rows || [])].sort((a, b) => {
    const doneDelta = (normalizer(b.status) === 'done' ? 1 : 0) - (normalizer(a.status) === 'done' ? 1 : 0);
    if (doneDelta) return doneDelta;
    const photoDelta = (Number(b.photoCount || 0)) - (Number(a.photoCount || 0));
    if (photoDelta) return photoDelta;
    return rowTime(b) - rowTime(a);
  })[0] || null;
}

function representativeDate(rows) {
  const dates = (rows || []).map((r) => r.workDate).filter(Boolean).sort();
  return dates[dates.length - 1] || null;
}

function reasonFor(rowState, { prodPhotoCount = 0, siPhotoCount = 0 } = {}) {
  switch (rowState) {
    case 'matched_done':
      return 'Both systems show this planogram complete.';
    case 'done_photo_mismatch':
      return `Both complete; photo counts differ (PROD ${prodPhotoCount} / SI ${siPhotoCount}).`;
    case 'si_incomplete':
      return 'In project scope; SI has a task for it but it is not complete.';
    case 'missing_in_si':
      return 'In project scope; PROD shows it complete but SI has no task for it.';
    case 'missing_in_prod':
      return 'In project scope; SI shows complete but PROD has no completed row in this run.';
    case 'off_scope_si':
      return "SI captured this; dbkey not in the selected project's scope.";
    case 'missing_in_both':
      return 'Expected by the project roster, but neither system shows completion.';
    default:
      return 'No comparison result was available.';
  }
}

function compareRows(prodRowsIn, siRowsIn, options = {}) {
  const {
    expectedProdRows = [],
    projectMode = true,
    includeOffScope = false,
  } = options;
  const prodRows = attachPeriodWeek(prodRowsIn || []);
  const siRows = attachPeriodWeek(siRowsIn || []);
  const expectedRows = attachPeriodWeek(expectedProdRows || []);
  const comparableProdRows = prodRows.filter((row) => normDbkey(row.dbkey));
  const comparableSiRows = siRows.filter((row) => normDbkey(row.dbkey));
  const nonPlanogramProdRows = prodRows.filter((row) => !normDbkey(row.dbkey));
  const nonPlanogramSiRows = siRows.filter((row) => !normDbkey(row.dbkey));
  const scopeDbkeys = new Set([...comparableProdRows, ...expectedRows].map((row) => normDbkey(row.dbkey)).filter(Boolean));
  const grouped = new Map();

  for (const row of comparableProdRows) {
    const key = buildKey(row);
    if (!grouped.has(key)) grouped.set(key, { prod: [], si: [], key });
    grouped.get(key).prod.push(row);
  }
  for (const row of comparableSiRows) {
    const key = buildKey(row);
    if (!grouped.has(key)) grouped.set(key, { prod: [], si: [], key });
    grouped.get(key).si.push(row);
  }

  const items = [];
  const images = [];
  let offScopeHidden = 0;
  function expectationForDbkey(dbkey) {
    if (!projectMode) return 'in_project_scope';
    return dbkey && scopeDbkeys.has(dbkey) ? 'in_project_scope' : 'off_scope';
  }
  function addBucket(bucket) {
    const allRows = [...bucket.prod, ...bucket.si];
    const prodSample = pickMostComplete(bucket.prod, normalizeProdStatus);
    const siSample = pickMostComplete(bucket.si, normalizeSiStatus);
    const sample = prodSample || siSample || allRows[0] || {};
    const storeNumber = normStore(sample.storeNumber);
    const dbkey = normDbkey(sample.dbkey);
    const prodPhotoCount = bucket.prod.reduce((acc, r) => acc + (r.photoCount || 0), 0);
    const siPhotoCount = bucket.si.reduce((acc, r) => acc + (r.photoCount || 0), 0);
    const prodPresenceState = prodSample && normalizeProdStatus(prodSample.status) === 'done' ? 'done' : 'absent';
    const siPresenceState = siSample ? normalizeSiStatus(siSample.status) : 'absent';
    const expectation = expectationForDbkey(dbkey);
    const notes = [];
    if (!dbkey) notes.push('Missing dbkey');
    if (!bucket.prod.length || !bucket.si.length) notes.push(bucket.prod.length ? 'Missing SI match' : 'Missing PROD match');
    if (bucket.prod.length > 1 || bucket.si.length > 1) notes.push('Multiple rows merged for same key');
    if (Math.abs(prodPhotoCount - siPhotoCount) > 0) notes.push('Photo count mismatch');
    let rowState = 'missing_in_both';
    if (expectation === 'off_scope' && siSample) rowState = 'off_scope_si';
    else if (siPresenceState === 'not_done') rowState = 'si_incomplete';
    else if (prodPresenceState === 'done' && siPresenceState === 'done' && prodPhotoCount !== siPhotoCount) rowState = 'done_photo_mismatch';
    else if (prodPresenceState === 'done' && siPresenceState === 'done') rowState = 'matched_done';
    else if (prodPresenceState === 'done' && siPresenceState === 'absent') rowState = 'missing_in_si';
    else if (expectation === 'in_project_scope' && prodPresenceState === 'absent' && siPresenceState === 'done') rowState = 'missing_in_prod';
    // TODO(phase2): missing_in_both requires expectedProdRows from the PROD roster.
    // With Phase 1's completed-only PROD rows, this state should not be emitted.
    if (rowState === 'missing_in_both' && !expectedRows.length) rowState = bucket.si.length ? 'missing_in_prod' : 'missing_in_si';
    const confidence = notes.length || !storeNumber || !dbkey ? 'needs_review' : 'high';
    const itemKey = `${storeNumber}|${dbkey}`;
    const workDate = representativeDate(allRows);

    const item = {
      itemKey,
      storeNumber,
      workDate,
      periodWeek: sample.periodWeek || null,
      projectId: prodSample?.projectId || null,
      projectName: prodSample?.projectName || null,
      dbkey,
      pog: dbkey || null,
      categorySetLabel: prodSample?.categorySetLabel || siSample?.categorySetLabel || '',
      prodStatus: prodPresenceState,
      siStatus: siPresenceState,
      comparisonStatus: rowState,
      expectation,
      prodPresenceState,
      siPresenceState,
      rowState,
      reason: reasonFor(rowState, { prodPhotoCount, siPhotoCount }),
      prodPhotoCount,
      siPhotoCount,
      confidence,
      notes: notes.join('; '),
      sourceRefs: {
        prod: bucket.prod.map((r) => r.raw).slice(0, 5),
        si: bucket.si.map((r) => r.raw).slice(0, 5),
      },
    };
    if (expectation === 'off_scope' && !includeOffScope) {
      offScopeHidden += 1;
      return;
    }
    items.push(item);

    for (const row of bucket.prod) {
      for (const img of row.images || []) {
        images.push({ ...img, itemKey });
      }
    }
    for (const row of bucket.si) {
      for (const img of row.images || []) {
        images.push({ ...img, itemKey });
      }
    }
  }
  for (const bucket of grouped.values()) addBucket(bucket);

  items.sort((a, b) => {
    const byStore = String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true });
    if (byStore) return byStore;
    const byDate = String(a.workDate || '').localeCompare(String(b.workDate || ''));
    if (byDate) return byDate;
    return String(a.dbkey || '').localeCompare(String(b.dbkey || ''));
  });

  const notes = [PHASE2_ROSTER_NOTE];
  if (nonPlanogramProdRows.length) {
    notes.push(`${nonPlanogramProdRows.length} non-planogram PROD row${nonPlanogramProdRows.length === 1 ? '' : 's'} excluded from planogram comparison.`);
  }
  if (nonPlanogramSiRows.length) {
    notes.push(`${nonPlanogramSiRows.length} non-planogram SI row${nonPlanogramSiRows.length === 1 ? '' : 's'} excluded from planogram comparison.`);
  }

  const summary = {
    total: items.length,
    byStatus: items.reduce((acc, item) => {
      const k = item.rowState || item.comparisonStatus || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    needsReview: items.filter((i) => i.confidence !== 'high').length,
    notes,
    offScopeHidden,
    nonPlanogramProdRows: nonPlanogramProdRows.length,
    nonPlanogramSiRows: nonPlanogramSiRows.length,
  };

  return { items, images, summary };
}

module.exports = {
  compareRows,
  normalizeProdStatus,
  normalizeSiStatus,
  PHASE2_ROSTER_NOTE,
};
