/**
 * Checklane Hub — aisle-by-aisle missing-tag sweep.
 *
 * A lead/supervisor (or a rep they assign) walks each store aisle at the end of a
 * reset, scans the printed shelf barcodes that need tags, and sends/prints the
 * batch per aisle. This module owns:
 *   - per-aisle sweep assignments (tag_sweep_assignments)
 *   - access helpers (who may sweep / send a given aisle)
 *   - sweep-added tags (tag_flags with source='sweep', aisle frozen via aisle_label)
 */

const { query } = require('./lib/db');
const { validateUpc } = require('./lib/barcode');
const { writeAuditLog, parseVisitId } = require('./hub-auth');
const { applyTransition } = require('./hub-state');
const { broadcastVisit } = require('./hub-broadcast');
const { normalizeLane } = require('./hub-section');

function normalizeAisleKey(key) {
  return String(key ?? '').trim();
}

function normalizeAisleLabel(label) {
  return String(label ?? '').trim().slice(0, 120);
}

async function getAisleAssignments(visitId) {
  const visitIdNum = parseVisitId(visitId);
  const { rows } = await query(
    `SELECT a.aisle_key, a.aisle_label, a.assignee_id, a.assigned_by, a.assigned_at,
            hu.name AS assignee_name
     FROM tag_sweep_assignments a
     JOIN hub_users hu ON hu.id = a.assignee_id
     WHERE a.visit_id = $1
     ORDER BY a.aisle_label ASC`,
    [visitIdNum],
  );
  return rows.map((row) => ({
    aisleKey: row.aisle_key,
    aisleLabel: row.aisle_label,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
  }));
}

/** @returns {Promise<Record<string, { assigneeId:number, assigneeName:string }>>} */
async function getAssignmentsMap(visitId) {
  const list = await getAisleAssignments(visitId);
  const map = {};
  for (const a of list) {
    map[a.aisleKey] = { assigneeId: a.assigneeId, assigneeName: a.assigneeName };
  }
  return map;
}

async function userAssignedAisleKeys(visitId, userId) {
  const visitIdNum = parseVisitId(visitId);
  if (!userId) return [];
  const { rows } = await query(
    `SELECT aisle_key FROM tag_sweep_assignments
     WHERE visit_id = $1 AND assignee_id = $2`,
    [visitIdNum, userId],
  );
  return rows.map((r) => r.aisle_key);
}

/**
 * May this actor read/work the tag batch at all?
 * Leads/supervisors (rank>=2) always; reps only if assigned at least one aisle.
 */
async function canAccessTagBatch(visitId, rank, userId) {
  if (rank >= 2) return true;
  const keys = await userAssignedAisleKeys(visitId, userId);
  return keys.length > 0;
}

/** May this actor sweep/send a specific aisle? Leads always; reps only their aisle. */
async function canWorkAisle(visitId, rank, userId, aisleKey) {
  if (rank >= 2) return true;
  const keys = await userAssignedAisleKeys(visitId, userId);
  return keys.includes(normalizeAisleKey(aisleKey));
}

async function loadHubUserById(userId) {
  const { rows } = await query(
    `SELECT id, name, email, is_active FROM hub_users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

async function assignAisleSweep(visitId, actor, { aisleKey, aisleLabel, assigneeId }) {
  const visitIdNum = parseVisitId(visitId);
  const key = normalizeAisleKey(aisleKey);
  const label = normalizeAisleLabel(aisleLabel) || key;
  if (!key) return { ok: false, status: 400, error: 'aisleKey is required' };

  const assigneeNum = Number(assigneeId);
  if (!Number.isFinite(assigneeNum)) {
    return { ok: false, status: 400, error: 'assigneeId is required' };
  }
  const assignee = await loadHubUserById(assigneeNum);
  if (!assignee || !assignee.is_active) {
    return { ok: false, status: 400, error: 'Unknown or inactive hub user' };
  }

  await applyTransition(visitIdNum, async () => {
    await query(
      `INSERT INTO tag_sweep_assignments (visit_id, aisle_key, aisle_label, assignee_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (visit_id, aisle_key) DO UPDATE SET
         aisle_label = EXCLUDED.aisle_label,
         assignee_id = EXCLUDED.assignee_id,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = now()`,
      [visitIdNum, key, label, assigneeNum, actor.id],
    );
    await writeAuditLog(visitIdNum, actor.id, 'tag_sweep_assigned', null, {
      aisle_key: key,
      aisle_label: label,
      assignee_id: assigneeNum,
      assignee_name: assignee.name,
    });
  });

  await broadcastVisit(visitIdNum);
  return {
    ok: true,
    aisleKey: key,
    aisleLabel: label,
    assigneeId: assigneeNum,
    assigneeName: assignee.name,
  };
}

async function unassignAisleSweep(visitId, actor, { aisleKey }) {
  const visitIdNum = parseVisitId(visitId);
  const key = normalizeAisleKey(aisleKey);
  if (!key) return { ok: false, status: 400, error: 'aisleKey is required' };

  await applyTransition(visitIdNum, async () => {
    await query(
      `DELETE FROM tag_sweep_assignments WHERE visit_id = $1 AND aisle_key = $2`,
      [visitIdNum, key],
    );
    await writeAuditLog(visitIdNum, actor.id, 'tag_sweep_unassigned', null, { aisle_key: key });
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, aisleKey: key };
}

/**
 * Add a tag during an aisle sweep. The aisle is frozen on the row (aisle_label) so
 * it groups and sends with that aisle even when not tied to a single planogram.
 */
async function addSweepTag(visitId, actor, { upc, description, location, aisleKey, aisleLabel, lane, dbkey }) {
  const visitIdNum = parseVisitId(visitId);
  const upcTrim = String(upc || '').trim();
  if (!upcTrim) return { ok: false, status: 400, error: 'UPC is required' };

  const label = normalizeAisleLabel(aisleLabel);
  if (!label) return { ok: false, status: 400, error: 'aisleLabel is required' };
  const key = normalizeAisleKey(aisleKey) || label;

  const validation = validateUpc(upcTrim);

  const id = await applyTransition(visitIdNum, async () => {
    const inserted = await query(
      `INSERT INTO tag_flags (visit_id, dbkey, lane, upc, description, location, aisle_key, aisle_label, flagged_by, flagged_at, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), 'flagged', 'sweep')
       RETURNING id`,
      [
        visitIdNum,
        dbkey ? String(dbkey).trim() : null,
        normalizeLane(lane),
        upcTrim,
        description ?? null,
        location ?? null,
        key,
        label,
        actor.id,
      ],
    );
    const tagId = inserted.rows[0].id;
    await writeAuditLog(visitIdNum, actor.id, 'tag_sweep_added', dbkey || null, {
      tag_id: tagId,
      upc: upcTrim,
      aisle_label: label,
    });
    return tagId;
  });

  await broadcastVisit(visitIdNum);
  return {
    ok: true,
    id,
    valid: validation.valid,
    reason: validation.reason || null,
    displayDigits: validation.displayDigits || null,
  };
}

/**
 * Remove a pending (flagged/verified) tag from the batch — e.g. a mis-scan during
 * a sweep. Leads/supervisors may remove any; a rep may remove only tags frozen to
 * an aisle assigned to them.
 */
async function removePendingTag(visitId, rank, userId, tagId) {
  const visitIdNum = parseVisitId(visitId);
  const idNum = Number(tagId);
  if (!Number.isFinite(idNum)) return { ok: false, status: 400, error: 'Invalid tag id' };

  const { rows } = await query(
    `SELECT id, aisle_label FROM tag_flags
     WHERE id = $1 AND visit_id = $2 AND status IN ('flagged', 'verified')`,
    [idNum, visitIdNum],
  );
  const tag = rows[0];
  if (!tag) return { ok: false, status: 404, error: 'Pending tag not found' };

  if (rank < 2) {
    const keys = await userAssignedAisleKeys(visitIdNum, userId);
    const tagKey = String(tag.aisle_label || '').trim();
    if (!tagKey || !keys.includes(tagKey)) {
      return { ok: false, status: 403, error: 'That tag is in an aisle assigned to someone else' };
    }
  }

  await applyTransition(visitIdNum, async () => {
    await query(`DELETE FROM tag_flags WHERE id = $1 AND visit_id = $2`, [idNum, visitIdNum]);
    await writeAuditLog(visitIdNum, userId, 'tag_pending_removed', null, { tag_id: idNum });
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, id: idNum };
}

module.exports = {
  normalizeAisleKey,
  normalizeAisleLabel,
  removePendingTag,
  getAisleAssignments,
  getAssignmentsMap,
  userAssignedAisleKeys,
  canAccessTagBatch,
  canWorkAisle,
  assignAisleSweep,
  unassignAisleSweep,
  addSweepTag,
};
