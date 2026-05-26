// Read-only Checklane Hub snapshot assembler (section_state only for now).

const { query } = require('./lib/db');

const STATE_KEYS = [
  'not_started',
  'assigned',
  'in_progress',
  'needs_attention',
  'done_pending_signoff',
  'signed_off',
];

function emptyStats() {
  return {
    total: 0,
    notStarted: 0,
    assigned: 0,
    inProgress: 0,
    needsAttention: 0,
    donePendingSignoff: 0,
    signedOff: 0,
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

async function getSnapshot(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }

  const { rows } = await query(
    `SELECT dbkey, state, assignee_id, reset_id, updated_at
     FROM section_state
     WHERE visit_id = $1
     ORDER BY dbkey`,
    [visitIdNum],
  );

  const sections = rows.map((row) => ({
    dbkey: row.dbkey,
    state: STATE_KEYS.includes(row.state) ? row.state : 'not_started',
    assignee_id: row.assignee_id,
    reset_id: row.reset_id != null ? Number(row.reset_id) : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  }));

  return {
    visitId: visitIdNum,
    generatedAt: new Date().toISOString(),
    sections,
    stats: buildStats(sections),
  };
}

module.exports = { getSnapshot, STATE_KEYS };
