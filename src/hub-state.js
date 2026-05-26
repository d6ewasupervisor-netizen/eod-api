// Checklane Hub state — snapshot reads, dirty tracking, and write transitions.

const { query } = require('./lib/db');
const { resolveRank, resolveHubUser } = require('./hub-auth');

const STATE_KEYS = [
  'not_started',
  'assigned',
  'in_progress',
  'needs_attention',
  'done_pending_signoff',
  'signed_off',
];

const ACTION_SUMMARIES = {
  help_request: 'Needs assistance',
  missing_tag: 'Missing tag',
  nis: 'Not in store',
};

/** @type {Set<number>} visit_ids with unsent hub changes */
const dirtyVisits = new Set();

function parseVisitId(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }
  return visitIdNum;
}

function markVisitDirty(visitId) {
  dirtyVisits.add(parseVisitId(visitId));
}

function clearVisitDirty(visitId) {
  dirtyVisits.delete(parseVisitId(visitId));
}

function isVisitDirty(visitId) {
  return dirtyVisits.has(parseVisitId(visitId));
}

function getDirtyVisitIds() {
  return [...dirtyVisits];
}

/**
 * Central write path for hub mutations. Runs writeFn against Postgres; on
 * success marks the visit dirty so the 15-minute backup job will email a snapshot.
 * All assign/start/mark-done/sign-off writes should go through here.
 */
async function applyTransition(visitId, writeFn) {
  const visitIdNum = parseVisitId(visitId);
  const result = await writeFn(visitIdNum);
  markVisitDirty(visitIdNum);
  return result;
}

function emptyStats() {
  return {
    total: 0,
    notStarted: 0,
    assigned: 0,
    inProgress: 0,
    needsAttention: 0,
    donePendingSignoff: 0,
    signedOff: 0,
    openTagFlags: 0,
    verifiedUnsentTags: 0,
  };
}

function buildStats(sections) {
  const stats = emptyStats();
  stats.total = sections.length;

  for (const row of sections) {
    switch (row.state) {
      case 'not_started':
        stats.notStarted += 1;
        break;
      case 'assigned':
        stats.assigned += 1;
        break;
      case 'in_progress':
        stats.inProgress += 1;
        break;
      case 'needs_attention':
        stats.needsAttention += 1;
        break;
      case 'done_pending_signoff':
        stats.donePendingSignoff += 1;
        break;
      case 'signed_off':
        stats.signedOff += 1;
        break;
      default:
        break;
    }
  }

  return stats;
}

function summaryForPending(row) {
  const payload = row.payload || {};
  if (payload.summary) return payload.summary;
  if (row.action_type === 'missing_tag' && payload.upc) {
    return `Missing tag: ${payload.upc}`;
  }
  return ACTION_SUMMARIES[row.action_type] || row.action_type;
}

async function getSnapshot(visitId, options = {}) {
  const visitIdNum = parseVisitId(visitId);
  const { user } = options;

  const [sectionResult, tagCountResult, verifiedTagResult, pendingResult] = await Promise.all([
    query(
      `SELECT ss.dbkey, ss.state, ss.assignee_id, ss.reset_id, ss.updated_at,
              hu.name AS assignee_name
       FROM section_state ss
       LEFT JOIN hub_users hu ON hu.id = ss.assignee_id
       WHERE ss.visit_id = $1
       ORDER BY ss.dbkey`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS cnt
       FROM tag_flags
       WHERE visit_id = $1 AND status = 'flagged'`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS cnt
       FROM tag_flags
       WHERE visit_id = $1 AND status = 'verified'`,
      [visitIdNum],
    ),
    query(
      `SELECT pa.id, pa.action_type, pa.dbkey, pa.payload, pa.raised_at, pa.status,
              hu.name AS raised_by_name
       FROM pending_actions pa
       JOIN hub_users hu ON hu.id = pa.raised_by
       WHERE pa.visit_id = $1 AND pa.status = 'pending'
       ORDER BY pa.raised_at ASC`,
      [visitIdNum],
    ),
  ]);

  const sections = sectionResult.rows.map((row) => ({
    dbkey: row.dbkey,
    state: STATE_KEYS.includes(row.state) ? row.state : 'not_started',
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name || null,
    reset_id: row.reset_id != null ? Number(row.reset_id) : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  }));

  const stats = buildStats(sections);
  stats.openTagFlags = tagCountResult.rows[0]?.cnt ?? 0;
  stats.verifiedUnsentTags = verifiedTagResult.rows[0]?.cnt ?? 0;

  const pendingActions = pendingResult.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    dbkey: row.dbkey,
    sectionName: row.dbkey,
    raised_by_name: row.raised_by_name,
    raised_at: row.raised_at ? row.raised_at.toISOString() : null,
    summary: summaryForPending(row),
    status: row.status,
  }));

  let myRank = 1;
  let myUserId = null;
  if (user) {
    myRank = await resolveRank(user, visitIdNum);
    const hubUser = await resolveHubUser(user);
    myUserId = hubUser.id;
  }

  return {
    visitId: visitIdNum,
    generatedAt: new Date().toISOString(),
    sections,
    stats,
    myRank,
    myUserId,
    pendingActions,
  };
}

module.exports = {
  getSnapshot,
  applyTransition,
  markVisitDirty,
  clearVisitDirty,
  isVisitDirty,
  getDirtyVisitIds,
  STATE_KEYS,
  ACTION_SUMMARIES,
};
