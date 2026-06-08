'use strict';

const { normalizeCategoryId } = require('./prod-row-fields');
const {
  DEFAULT_NOT_IN_STORE_PATTERNS,
  describeNotInStoreMatch,
  isBacklogException,
  isNotInSiClaim,
} = require('./not-in-store-patterns');

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
    return noWrite('mirror_prod_to_si', reclassificationNote || 'PROD is complete; SI would need Phase 2 push.');
  }

  if (siDone && prodStatus !== 'done') {
    return noWrite('mirror_si_to_prod', reclassificationNote || 'SI is complete; PROD would need Phase 2 completion.');
  }

  if (reclassificationNote) {
    return noWrite('judgment_call', reclassificationNote);
  }

  return noWrite('judgment_call', 'Ambiguous PROD/SI state needs manual review.');
}

function classifyReconciliation({
  trackerRows = [],
  prodRows = [],
  siRows = [],
  notInStorePatterns = DEFAULT_NOT_IN_STORE_PATTERNS,
  projectMode = true,
  ignoredKeys = [],
} = {}) {
  const prodByKey = firstByKey(prodRows);
  const siByKey = firstByKey(siRows);
  const trackerByKey = firstByKey(trackerRows);
  const ignoredKeySet = new Set((ignoredKeys || []).filter(Boolean));
  const proposals = [];
  const pendingPatternCandidates = [];
  const byBucket = {};
  let alreadySatisfied = 0;

  function add(proposal) {
    if (proposedEqualsCurrent(proposal.proposed, proposal.current)) {
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
    const prod = prodByKey.get(key) || null;
    const si = siByKey.get(key) || null;
    const bucket = resolveBucket({ prod, si, notInStorePatterns, projectMode });
    add(makeProposal({ key, tracker, prod, si, ...bucket }));
  }

  for (const key of new Set([...prodByKey.keys(), ...siByKey.keys()])) {
    if (ignoredKeySet.has(key)) continue;
    if (trackerByKey.has(key)) continue;
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
