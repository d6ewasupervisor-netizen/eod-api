'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  resolveWorkbookPath,
  workbookForKind,
} = require('./tracker-workbooks');

const PHASE1D_WRITABLE_BUCKETS = new Set(['matched_both', 'confirmed_not_in_si']);

function pythonCommand() {
  return process.env.PYTHON || process.env.PYTHON_EXE || (process.platform === 'win32' ? 'python' : 'python3');
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
}

function titleCaseNote(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bSi\b/g, 'SI')
    .replace(/\bN\/a\b/g, 'N/A');
}

function normalizeTrackerNote(value) {
  const normalized = normalizeWhitespace(value);
  const lower = normalized.toLowerCase();
  if (!lower) return '';
  if (lower === 'not in store') return 'Not in Store';
  if (/^confirmed\s*-?\s*not\s+in\s+si$/.test(lower)) return 'Confirmed - not in SI';
  return titleCaseNote(normalized);
}

function normalizedK(value) {
  const lower = normalizeWhitespace(value).toLowerCase();
  if (lower === 'yes') return 'Yes';
  if (lower === 'no') return 'No';
  return normalizeWhitespace(value);
}

function normalizedSiStatus(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return ['complete', 'completed', 'done'].includes(normalized) ? 'done' : normalized || 'absent';
}

function phase1dTargetFor(proposal) {
  if (proposal.bucket === 'matched_both') return { K: 'Yes', L: '' };
  if (proposal.bucket === 'confirmed_not_in_si') return { K: 'Yes', L: 'Confirmed - not in SI' };
  return null;
}

function changeTypeFor(current = {}, target = {}) {
  const currentK = normalizedK(current.K);
  const currentL = normalizeTrackerNote(current.L);
  const targetK = normalizedK(target.K);
  const targetL = normalizeTrackerNote(target.L);
  const kChanges = currentK !== targetK;
  const lChanges = currentL !== targetL;
  if (!kChanges && !lChanges) return 'no_op';
  if (kChanges && !lChanges) return 'K_only';
  return 'K_and_L';
}

function materializeWrite(proposal, target, changeType) {
  return {
    rowIndex: proposal.rowIndex,
    workbookKind: proposal.workbookKind,
    key: proposal.key,
    bucket: proposal.bucket,
    reason: proposal.reason || '',
    changeType,
    current: proposal.current,
    target,
    prod: proposal.prod || {},
    si: proposal.si || {},
    K: target.K,
    L: changeType === 'K_only' ? normalizeWhitespace(proposal.current?.L) : normalizeTrackerNote(target.L),
  };
}

function buildPhase1dPreview(proposals = []) {
  const eligible = [];
  const deferred = [];
  const writeRows = [];
  const byBucket = {};
  const changeTypes = { K_only: 0, K_and_L: 0, no_op: 0 };
  let alreadySatisfied = 0;

  for (const proposal of proposals || []) {
    byBucket[proposal.bucket] = (byBucket[proposal.bucket] || 0) + 1;
    const target = phase1dTargetFor(proposal);
    if (!target) {
      // TODO(phase2): deferred system buckets may flip tracker K/L only after the
      // required SI/PROD push succeeds and the target system re-reads complete.
      // Tracker-Yes must remain the final step, never a precursor to system work.
      deferred.push(proposal);
      continue;
    }
    const changeType = changeTypeFor(proposal.current, target);
    changeTypes[changeType] += 1;
    const diff = materializeWrite(proposal, target, changeType);
    eligible.push(diff);
    if (changeType === 'no_op') {
      alreadySatisfied += 1;
      continue;
    }
    writeRows.push(diff);
  }

  return {
    writeRows,
    eligible,
    deferred,
    byBucket,
    changeTypes,
    alreadySatisfied,
  };
}

function validateWritableRow(row) {
  if (!PHASE1D_WRITABLE_BUCKETS.has(row.bucket)) {
    throw new Error(`Phase 1d refuses to write bucket ${row.bucket}.`);
  }
  if (row.changeType === 'no_op') {
    throw new Error(`Phase 1d refuses to write no-op row ${row.key || row.rowIndex}.`);
  }
  const rowIndex = Number(row.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    throw new Error(`Invalid tracker rowIndex: ${row.rowIndex}`);
  }
  const target = phase1dTargetFor(row);
  const recomputedChangeType = changeTypeFor(row.current, target);
  if (recomputedChangeType !== row.changeType) {
    throw new Error(`Phase 1d refuses inconsistent changeType for ${row.key || rowIndex}: expected ${recomputedChangeType}, got ${row.changeType}.`);
  }
  if (normalizedK(row.K ?? row.target?.K) !== target.K) {
    throw new Error(`Phase 1d refuses inconsistent K target for ${row.key || rowIndex}.`);
  }
  const proposedL = row.L ?? row.target?.L ?? row.proposed?.L ?? '';
  if (row.changeType === 'K_and_L' && normalizeTrackerNote(proposedL) !== normalizeTrackerNote(target.L)) {
    throw new Error(`Phase 1d refuses inconsistent Notes target for ${row.key || rowIndex}.`);
  }
  if (row.changeType === 'K_only' && normalizeTrackerNote(proposedL) !== normalizeTrackerNote(row.current?.L)) {
    throw new Error(`Phase 1d refuses noisy Notes rewrite for K_only row ${row.key || rowIndex}.`);
  }
  if (row.bucket === 'matched_both') {
    const prodDone = row.prod?.completionStatus === 'done';
    const siDone = row.si?.present === true && normalizedSiStatus(row.si?.status) === 'done';
    if (!prodDone || !siDone) {
      throw new Error(`Phase 1d refuses matched_both without PROD done and SI done evidence for ${row.key || rowIndex}.`);
    }
  }
  if (row.bucket === 'confirmed_not_in_si') {
    const siAbsent = row.si?.present === false || normalizedSiStatus(row.si?.status) === 'absent';
    const notInSiEvidence = /not\s+in\s+si/i.test(`${row.reason || ''} ${row.prod?.comment || ''}`);
    if (!siAbsent || !notInSiEvidence) {
      throw new Error(`Phase 1d refuses confirmed_not_in_si without absent-SI evidence for ${row.key || rowIndex}.`);
    }
  }
  return {
    rowIndex,
    K: row.K ?? row.target?.K ?? row.proposed?.K,
    L: row.L ?? row.target?.L ?? row.proposed?.L ?? '',
  };
}

function writeApprovedRows(kind, sheetName, rows = [], options = {}) {
  if (options.approved !== true) {
    throw new Error('Explicit approval is required before writing tracker rows.');
  }
  const workbook = workbookForKind(kind);
  const workbookPath = options.workbookPath || resolveWorkbookPath(kind, options);
  const scriptPath = path.resolve(__dirname, '../../../scripts/write_tracker.py');
  const payloadRows = rows.map(validateWritableRow);
  const args = [scriptPath, workbookPath, sheetName || workbook.sheetName];

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Tracker workbook write failed (${workbook.fileName}): ${stderr || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (err) {
        reject(new Error(`Tracker workbook writer returned invalid JSON: ${err.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ rows: payloadRows }));
  });
}

module.exports = {
  PHASE1D_WRITABLE_BUCKETS,
  buildPhase1dPreview,
  changeTypeFor,
  normalizeTrackerNote,
  writeApprovedRows,
};
