// Section identity — workflow state keyed by (visit_id, lane, dbkey).

const { query } = require('./lib/db');

function normalizeLane(lane) {
  if (lane == null) return '';
  return String(lane).trim();
}

async function readSectionState(visitIdNum, dbkey, lane) {
  const laneNorm = normalizeLane(lane);
  const { rows } = await query(
    `SELECT state FROM section_state WHERE visit_id = $1 AND dbkey = $2 AND lane = $3`,
    [visitIdNum, dbkey, laneNorm],
  );
  if (rows.length) return rows[0].state;

  if (laneNorm) {
    const legacy = await query(
      `SELECT state FROM section_state WHERE visit_id = $1 AND dbkey = $2 AND lane = ''`,
      [visitIdNum, dbkey],
    );
    if (legacy.rows.length) return legacy.rows[0].state;
  }

  return 'not_started';
}

async function loadSectionRow(visitIdNum, dbkey, lane) {
  const laneNorm = normalizeLane(lane);
  const { rows } = await query(
    `SELECT state, assignee_id, lane FROM section_state
     WHERE visit_id = $1 AND dbkey = $2 AND lane = $3`,
    [visitIdNum, dbkey, laneNorm],
  );
  if (rows.length) return rows[0];

  if (laneNorm) {
    const legacy = await query(
      `SELECT state, assignee_id, lane FROM section_state
       WHERE visit_id = $1 AND dbkey = $2 AND lane = ''`,
      [visitIdNum, dbkey],
    );
    if (legacy.rows.length) return legacy.rows[0];
  }

  return { state: 'not_started', assignee_id: null, lane: laneNorm };
}

async function upsertSectionState(visitIdNum, dbkey, lane, fields) {
  const laneNorm = normalizeLane(lane);
  const {
    state,
    assignee_id: assigneeId = null,
    assigned_by: assignedBy = null,
    started_at: startedAt = null,
    completed_at: completedAt = null,
    signed_off_by: signedOffBy = null,
    signed_off_at: signedOffAt = null,
  } = fields;

  await query(
    `INSERT INTO section_state (
       visit_id, lane, dbkey, state, assignee_id, assigned_by,
       started_at, completed_at, signed_off_by, signed_off_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (visit_id, lane, dbkey) DO UPDATE
       SET state = EXCLUDED.state,
           assignee_id = COALESCE(EXCLUDED.assignee_id, section_state.assignee_id),
           assigned_by = COALESCE(EXCLUDED.assigned_by, section_state.assigned_by),
           started_at = COALESCE(EXCLUDED.started_at, section_state.started_at),
           completed_at = COALESCE(EXCLUDED.completed_at, section_state.completed_at),
           signed_off_by = COALESCE(EXCLUDED.signed_off_by, section_state.signed_off_by),
           signed_off_at = COALESCE(EXCLUDED.signed_off_at, section_state.signed_off_at),
           updated_at = now()`,
    [
      visitIdNum,
      laneNorm,
      dbkey,
      state,
      assigneeId,
      assignedBy,
      startedAt,
      completedAt,
      signedOffBy,
      signedOffAt,
    ],
  );
}

async function updateSectionState(visitIdNum, dbkey, lane, fields) {
  const laneNorm = normalizeLane(lane);
  const sets = [];
  const values = [visitIdNum, laneNorm, dbkey];
  let idx = 4;

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }
  sets.push('updated_at = now()');

  const result = await query(
    `UPDATE section_state SET ${sets.join(', ')}
     WHERE visit_id = $1 AND lane = $2 AND dbkey = $3`,
    values,
  );

  if (result.rowCount === 0 && laneNorm) {
    await upsertSectionState(visitIdNum, dbkey, laneNorm, {
      state: fields.state || 'not_started',
      assignee_id: fields.assignee_id,
      assigned_by: fields.assigned_by,
      started_at: fields.started_at,
      completed_at: fields.completed_at,
      signed_off_by: fields.signed_off_by,
      signed_off_at: fields.signed_off_at,
    });
  }
}

async function setNeedsAttention(visitIdNum, dbkey, lane) {
  const priorState = await readSectionState(visitIdNum, dbkey, lane);
  await upsertSectionState(visitIdNum, dbkey, lane, { state: 'needs_attention' });
  return priorState;
}

async function restoreSectionState(visitIdNum, dbkey, lane, priorState) {
  const state = priorState || 'not_started';
  await upsertSectionState(visitIdNum, dbkey, lane, { state });
}

async function clearSectionAssignment(visitIdNum, dbkey, lane) {
  const laneNorm = normalizeLane(lane);
  const result = await query(
    `UPDATE section_state SET
       state = 'not_started',
       assignee_id = NULL,
       assigned_by = NULL,
       started_at = NULL,
       updated_at = now()
     WHERE visit_id = $1 AND lane = $2 AND dbkey = $3`,
    [visitIdNum, laneNorm, dbkey],
  );

  if (result.rowCount === 0 && laneNorm) {
    const legacy = await query(
      `UPDATE section_state SET
         state = 'not_started',
         assignee_id = NULL,
         assigned_by = NULL,
         started_at = NULL,
         updated_at = now()
       WHERE visit_id = $1 AND lane = '' AND dbkey = $2`,
      [visitIdNum, dbkey],
    );
    if (legacy.rowCount === 0) {
      await upsertSectionState(visitIdNum, dbkey, laneNorm, {
        state: 'not_started',
        assignee_id: null,
        assigned_by: null,
        started_at: null,
      });
    }
  }
}

function laneFromRequest(req) {
  const lane = req.body?.lane ?? req.query?.lane ?? '';
  return normalizeLane(lane);
}

module.exports = {
  normalizeLane,
  readSectionState,
  loadSectionRow,
  upsertSectionState,
  updateSectionState,
  setNeedsAttention,
  restoreSectionState,
  clearSectionAssignment,
  laneFromRequest,
};
