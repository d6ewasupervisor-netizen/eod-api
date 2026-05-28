/**
 * Physical lane names — maps manifest register numbers (601–624) to store floor labels.
 * Original lane IDs are retained; physical_name is an additive human-readable label.
 */

const { query } = require('./lib/db');
const { parseVisitId, writeAuditLog } = require('./hub-auth');
const { applyTransition } = require('./hub-state');
const { broadcastVisit } = require('./hub-broadcast');

function normalizeLane(lane) {
  if (lane == null) return '';
  return String(lane).trim();
}

function normalizePhysicalName(name) {
  if (name == null) return '';
  return String(name).trim();
}

async function getLaneNamesMap(visitId) {
  const visitIdNum = parseVisitId(visitId);
  const { rows } = await query(
    `SELECT lane, physical_name
     FROM lane_physical_names
     WHERE visit_id = $1
     ORDER BY lane`,
    [visitIdNum],
  );
  /** @type {Record<string, string>} */
  const map = {};
  for (const row of rows) {
    const lane = normalizeLane(row.lane);
    const name = normalizePhysicalName(row.physical_name);
    if (lane && name) map[lane] = name;
  }
  return map;
}

async function setLanePhysicalName(visitId, lane, physicalName, actor) {
  const visitIdNum = parseVisitId(visitId);
  const laneNorm = normalizeLane(lane);
  if (!laneNorm) {
    return { ok: false, status: 400, error: 'lane is required' };
  }

  const nameTrim = normalizePhysicalName(physicalName);

  await applyTransition(visitIdNum, async () => {
    if (!nameTrim) {
      await query(
        `DELETE FROM lane_physical_names WHERE visit_id = $1 AND lane = $2`,
        [visitIdNum, laneNorm],
      );
      await writeAuditLog(visitIdNum, actor.id, 'lane_name_cleared', laneNorm, {});
      return;
    }

    await query(
      `INSERT INTO lane_physical_names (visit_id, lane, physical_name, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (visit_id, lane) DO UPDATE SET
         physical_name = EXCLUDED.physical_name,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [visitIdNum, laneNorm, nameTrim, actor.id],
    );
    await writeAuditLog(visitIdNum, actor.id, 'lane_name_set', laneNorm, {
      physical_name: nameTrim,
    });
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, lane: laneNorm, physicalName: nameTrim || null };
}

async function bulkSetLanePhysicalNames(visitId, names, actor) {
  const visitIdNum = parseVisitId(visitId);
  if (!names || typeof names !== 'object' || Array.isArray(names)) {
    return { ok: false, status: 400, error: 'names object is required' };
  }

  const entries = Object.entries(names)
    .map(([lane, physicalName]) => [normalizeLane(lane), normalizePhysicalName(physicalName)])
    .filter(([lane]) => lane);

  let updated = 0;
  let cleared = 0;

  await applyTransition(visitIdNum, async () => {
    for (const [lane, nameTrim] of entries) {
      if (!nameTrim) {
        const del = await query(
          `DELETE FROM lane_physical_names WHERE visit_id = $1 AND lane = $2 RETURNING id`,
          [visitIdNum, lane],
        );
        if (del.rows.length) cleared += 1;
        continue;
      }

      await query(
        `INSERT INTO lane_physical_names (visit_id, lane, physical_name, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (visit_id, lane) DO UPDATE SET
           physical_name = EXCLUDED.physical_name,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [visitIdNum, lane, nameTrim, actor.id],
      );
      updated += 1;
    }

    await writeAuditLog(visitIdNum, actor.id, 'lane_names_bulk', null, {
      updated,
      cleared,
      lanes: entries.map(([lane]) => lane),
    });
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, updated, cleared, laneNames: await getLaneNamesMap(visitIdNum) };
}

module.exports = {
  getLaneNamesMap,
  setLanePhysicalName,
  bulkSetLanePhysicalNames,
};
