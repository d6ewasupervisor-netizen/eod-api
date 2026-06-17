'use strict';

const { normalizeCategoryId } = require('./prod-row-fields');
const {
  DEFAULT_NOT_IN_STORE_PATTERNS,
  describeNotInStoreMatch,
  isBacklogException,
  isNotInSiClaim,
} = require('./not-in-store-patterns');
const { isSiExcluded } = require('./si-assignment-scope');

function normalizeStore(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) ? String(parsed) : String(value || '').trim();
}

function normalizeDbkey(value) {
  const direct = String(value || '').trim();
  if (/^\d{6,10}$/.test(direct)) return direct;
  const fromPog = direct.match(/^P\d+W\d_(\d+)_/i);
  if (fromPog) return fromPog[1];
  const embedded = direct.match(/\b(\d{6,10})\b/);
  return embedded ? embedded[1] : '';
}

function normalizePeriodWeek(value) {
  const direct = String(value || '').trim().toUpperCase();
  const match = direct.match(/P(\d{1,2})W([1-4])/);
  if (!match) return '';
  return `P${String(parseInt(match[1], 10)).padStart(2, '0')}W${parseInt(match[2], 10)}`;
}

function rowStore(row = {}) {
  return normalizeStore(firstPresent(row.store, row.storeNumber, row.store_number, row['Store#'], row['Store #']));
}

function rowCategoryId(row = {}) {
  return normalizeCategoryId(firstPresent(row.categoryId, row.category_id, row.category, row['Category#'], row['Category #'], row['Category ID']));
}

function rowDbkey(row = {}) {
  return normalizeDbkey(firstPresent(row.dbkey, row.pog, row.pogId, row.planogramId, row.planogram_id, row['POG ID'], row['Planogram ID']));
}

function rowPeriodWeek(row = {}) {
  return firstPeriodWeek(row.periodWeek, row.period_week, row.pogId, row.planogramId, row.planogram_id, row['POG ID'], row['Planogram ID'], row.title, row.raw?.title);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return value;
  }
  return '';
}

function firstPeriodWeek(...values) {
  for (const value of values) {
    const periodWeek = normalizePeriodWeek(value);
    if (periodWeek) return periodWeek;
  }
  return '';
}

function buildReconciliationKey(row = {}) {
  return `${rowPeriodWeek(row)}|${rowStore(row)}|${rowCategoryId(row)}|${rowDbkey(row)}`;
}

function normalizeSiStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return ['complete', 'completed', 'done'].includes(normalized) ? 'done' : 'not_done';
}

function firstByKey(rows = []) {
  const out = new Map();
  for (const row of rows || []) {
    const key = buildReconciliationKey(row);
    const [, store, categoryId, dbkey] = key.split('|');
    if (store && categoryId && dbkey && !out.has(key)) out.set(key, row);
  }
  return out;
}

function rowTime(row = {}) {
  const raw = firstPresent(row.workDate, row.work_date, row.date, row.scheduledDate, row.scheduled_date, row.completedAt, row.completed_at, row.raw?.work_date, row.raw?.date);
  if (!raw) return 0;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isProdDone(row = {}) {
  return row?.categoryCompletionStatus === 'done';
}

function isSiDone(row = {}) {
  return normalizeSiStatus(row?.status) === 'done';
}

function shouldReplaceCollapsedRow(current, candidate, isDone) {
  if (!current) return true;
  const currentDone = isDone(current);
  const candidateDone = isDone(candidate);
  if (candidateDone !== currentDone) return candidateDone;
  return rowTime(candidate) >= rowTime(current);
}

function collapseRowsByKey(rows = [], isDone = () => false) {
  const out = new Map();
  for (const row of rows || []) {
    const key = buildReconciliationKey(row);
    const [, store, categoryId, dbkey] = key.split('|');
    if (!store || !categoryId || !dbkey) continue;
    if (shouldReplaceCollapsedRow(out.get(key), row, isDone)) out.set(key, row);
  }
  return out;
}

function currentFromTracker(tracker) {
  return {
    K: tracker?.K ?? tracker?.k ?? tracker?.completeVerified ?? tracker?.currentK ?? '',
    L: tracker?.L ?? tracker?.l ?? tracker?.notes ?? tracker?.currentL ?? '',
  };
}

function normalizeCellValue(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function proposedEqualsCurrent(proposed, current) {
  if (!proposed) return false;
  return normalizeCellValue(proposed.K).toLowerCase() === normalizeCellValue(current.K).toLowerCase()
    && normalizeCellValue(proposed.L) === normalizeCellValue(current.L);
}

function prodSummary(prod) {
  return {
    completionStatus: prod?.categoryCompletionStatus || (prod ? 'unknown' : 'absent'),
    exceptionReason: prod?.categoryExceptionReason || '',
    comment: prod?.comment || '',
    afterPhotoRequired: Boolean(prod?.afterPhotoRequired),
    afterPictureUrls: Array.isArray(prod?.afterPictureUrls) ? prod.afterPictureUrls : [],
  };
}

function siSummary(si) {
  return {
    present: Boolean(si),
    status: si ? normalizeSiStatus(si.status) : 'absent',
    currentTask: Boolean(si?.currentTask || si?.isCurrentTask),
    taskId: si?.taskId ?? si?.raw?.taskId ?? null,
    scanStatus: si?.scanStatus ?? si?.scan_status ?? null,
    actionsCount: si?.actionsCount ?? si?.actions_count ?? null,
    hasPrePhoto: Boolean(si?.hasPrePhoto || si?.has_pre_photo),
  };
}

function makeProposal({ key, tracker = null, prod = null, si = null, bucket, reason, proposed = null, candidatePhrase = null }) {
  const [periodWeek, store, categoryId, dbkey] = key.split('|');
  const proposal = {
    key,
    periodWeek,
    rowIndex: tracker?.rowIndex ?? null,
    workbookKind: tracker?.workbookKind ?? tracker?.routedWorkbookKind ?? '',
    store,
    categoryId,
    dbkey,
    setType: tracker?.setType ?? tracker?.set_type ?? prod?.setType ?? si?.setType ?? '',
    bucket,
    reason,
    current: currentFromTracker(tracker),
    proposed,
    prod: prodSummary(prod),
    si: siSummary(si),
  };
  if (candidatePhrase) proposal.candidatePhrase = candidatePhrase;
  return proposal;
}

function writeProposal(bucket, reason, proposed) {
  return { bucket, reason, proposed };
}

function noWrite(bucket, reason, extra = {}) {
  return { bucket, reason, proposed: null, ...extra };
}

function actionsCountTotal(si = {}) {
  const actionsCount = si.actionsCount || si.actions_count || {};
  if (!actionsCount || typeof actionsCount !== 'object') return 0;
  return Object.values(actionsCount).reduce((sum, value) => {
    const parsed = parseInt(value, 10);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

function hasSiCaptureActivity(si = {}) {
  return actionsCountTotal(si) > 0
    || Boolean(si.hasPrePhoto || si.has_pre_photo)
    || (Array.isArray(si.images) && si.images.length > 0)
    || (parseInt(si.photoCount, 10) || 0) > 0
    || !['', 'NO_CAPTURE', 'no_capture'].includes(String(si.scanStatus || si.scan_status || '').trim());
}

function prodToSiMirrorBucket(si) {
  if (!si || !(si.currentTask || si.isCurrentTask)) {
    return noWrite('mirror_si_stale_or_absent', 'PROD is complete; no current-date SI task was resolved.');
  }
  if (hasSiCaptureActivity(si)) {
    return noWrite('mirror_si_simple_close', 'PROD is complete; current SI task has scan/photo/action activity and may only need close.');
  }
  return noWrite('mirror_si_photo_push', 'PROD is complete; current SI task is empty and would need PROD photos before close.');
}

function resolveBucket({ prod = null, si = null, notInStorePatterns = DEFAULT_NOT_IN_STORE_PATTERNS }) {
  const prodStatus = prod?.categoryCompletionStatus || (prod ? 'unknown' : 'absent');
  const exceptionReason = prod?.categoryExceptionReason || '';
  const comment = prod?.comment || '';
  const siPresent = Boolean(si);
  const siDone = siPresent && normalizeSiStatus(si.status) === 'done';
  let reclassificationNote = '';

  if (!prod && !si) {
    return noWrite('no_match', 'Tracker row has no matching PROD or SI row.');
  }

  if (isBacklogException(exceptionReason)) {
    return noWrite('leave_alone_backlog', 'PROD is marked Backlog - Revisit Needed.');
  }

  if (isNotInSiClaim(comment)) {
    if (!siPresent) {
      return writeProposal('confirmed_not_in_si', 'PROD comment says not in SI and SI has no matching task.', {
        K: 'Yes',
        L: 'confirmed not in SI',
      });
    }
    reclassificationNote = normalizeSiStatus(si.status) === 'done'
      ? 'PROD comment says not in SI, but SI has a matching completed task; reclassified by live SI status.'
      : 'PROD comment says not in SI, but SI has a matching incomplete task; reclassified by live SI status.';
  }

  if (prodStatus === 'not_done') {
    const match = describeNotInStoreMatch(comment, notInStorePatterns);
    if (match.state === 'confirmed') {
      return writeProposal('not_in_store_closeout', 'PROD comment confirms this is not in store.', {
        K: 'Yes',
        L: comment,
      });
    }
    if (match.state === 'candidate') {
      return noWrite('not_in_store_candidate', 'Comment may mean not in store, but needs approval before it can write.', {
        candidatePhrase: match.phrase,
      });
    }
  }

  if (prodStatus === 'unknown') {
    return noWrite('judgment_call', 'PROD completion blank/unknown - needs review.');
  }

  if (prodStatus === 'done' && siDone) {
    return writeProposal('matched_both', 'PROD and SI both show complete.', { K: 'Yes', L: '' });
  }

  if (prodStatus === 'done' && !siDone) {
    if (reclassificationNote) {
      const bucket = prodToSiMirrorBucket(si);
      return noWrite(bucket.bucket, reclassificationNote);
    }
    return prodToSiMirrorBucket(si);
  }

  if (siDone && prodStatus !== 'done') {
    return noWrite('mirror_si_to_prod', reclassificationNote || 'SI is complete; PROD would need Phase 2 completion.');
  }

  if (reclassificationNote) {
    return noWrite('judgment_call', reclassificationNote);
  }

  return noWrite('judgment_call', 'Ambiguous PROD/SI state needs manual review.');
}

function keyStoreIsSiExcluded(key) {
  const store = String(key).split('|')[1];
  if (!store) return false;
  return isSiExcluded(`701-${store.padStart(5, '0')}`);
}

function classifyReconciliation({
  trackerRows = [],
  prodRows = [],
  siRows = [],
  notInStorePatterns = DEFAULT_NOT_IN_STORE_PATTERNS,
  projectMode = true,
  ignoredKeys = [],
  suppressAlreadySatisfied = true,
} = {}) {
  const prodByKey = collapseRowsByKey(prodRows, isProdDone);
  const siByKey = collapseRowsByKey(siRows, isSiDone);
  const trackerByKey = firstByKey(trackerRows);
  const ignoredKeySet = new Set((ignoredKeys || []).filter(Boolean));
  const proposals = [];
  const pendingPatternCandidates = [];
  const byBucket = {};
  let alreadySatisfied = 0;
  const siExcludedKeys = new Set();
  function add(proposal) {
    if (suppressAlreadySatisfied && proposedEqualsCurrent(proposal.proposed, proposal.current)) {
      alreadySatisfied += 1;
      return;
    }
    proposals.push(proposal);
    byBucket[proposal.bucket] = (byBucket[proposal.bucket] || 0) + 1;
    if (proposal.bucket === 'not_in_store_candidate' && proposal.candidatePhrase) {
      pendingPatternCandidates.push({
        key: proposal.key,
        phrase: proposal.candidatePhrase,
      });
    }
  }
  for (const [key, tracker] of trackerByKey.entries()) {
    if (ignoredKeySet.has(key)) continue;
    if (keyStoreIsSiExcluded(key)) {
      siExcludedKeys.add(key);
      const prod = prodByKey.get(key) || null;
      const si = siByKey.get(key) || null;
      add(makeProposal({
        key,
        tracker,
        prod,
        si,
        bucket: 'si_excluded',
        reason: 'Store is not assigned to this login in Store Intelligence; SI comparison intentionally skipped (PROD-only).',
        proposed: null,
      }));
      continue;
    }
    const prod = prodByKey.get(key) || null;
    const si = siByKey.get(key) || null;
    const bucket = resolveBucket({ prod, si, notInStorePatterns, projectMode });
    add(makeProposal({ key, tracker, prod, si, ...bucket }));
  }
  for (const key of new Set([...prodByKey.keys(), ...siByKey.keys()])) {
    if (ignoredKeySet.has(key)) continue;
    if (trackerByKey.has(key)) continue;
    if (siExcludedKeys.has(key)) continue;
    if (keyStoreIsSiExcluded(key)) {
      const prod = prodByKey.get(key) || null;
      const si = siByKey.get(key) || null;
      add(makeProposal({
        key,
        prod,
        si,
        bucket: 'si_excluded',
        reason: 'Store is not assigned to this login in Store Intelligence; SI comparison intentionally skipped (PROD-only).',
        proposed: null,
      }));
      continue;
    }
    const prod = prodByKey.get(key) || null;
    const si = siByKey.get(key) || null;
    const reason = prod && si
      ? 'PROD and SI rows have no matching tracker row.'
      : prod
        ? 'PROD row has no matching tracker row.'
        : 'SI row has no matching tracker row.';
    add(makeProposal({ key, prod, si, bucket: 'no_match', reason, proposed: null }));
  }
  return { proposals, byBucket, pendingPatternCandidates, alreadySatisfied };
}

module.exports = {
  buildReconciliationKey,
  classifyReconciliation,
  normalizeDbkey,
  normalizePeriodWeek,
  normalizeSiStatus,
  normalizeStore,
  resolveBucket,
};
