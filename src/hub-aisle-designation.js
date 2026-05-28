/**
 * Store aisle designations per planogram section (visit + lane + dbkey).
 */

const { query } = require('./lib/db');
const {
  resolveAisleLabel,
  validateAisleDesignation,
  sectionDesignationKey,
} = require('./lib/aisle-designations');
const { parseVisitId, writeAuditLog } = require('./hub-auth');
const { applyTransition } = require('./hub-state');
const { broadcastVisit } = require('./hub-broadcast');
const { normalizeLane } = require('./hub-section');

async function getSectionDesignationsMap(visitId) {
  const visitIdNum = parseVisitId(visitId);
  const { rows } = await query(
    `SELECT lane, dbkey, aisle_preset, aisle_custom
     FROM section_state
     WHERE visit_id = $1`,
    [visitIdNum],
  );

  /** @type {Record<string, string>} */
  const bySection = {};
  /** @type {Record<string, string[]>} */
  const byDbkey = {};

  for (const row of rows) {
    const label = resolveAisleLabel(row.aisle_preset, row.aisle_custom);
    if (!label) continue;
    const key = sectionDesignationKey(row.lane, row.dbkey);
    bySection[key] = label;
    const dk = String(row.dbkey || '').trim();
    if (!dk) continue;
    if (!byDbkey[dk]) byDbkey[dk] = [];
    if (!byDbkey[dk].includes(label)) byDbkey[dk].push(label);
  }

  /** @type {Record<string, string>} */
  const byDbkeyUnique = {};
  for (const [dk, labels] of Object.entries(byDbkey)) {
    if (labels.length === 1) byDbkeyUnique[dk] = labels[0];
  }

  return { bySection, byDbkeyUnique };
}

function lookupStoreAisleLabel({ dbkey, lane, location }, designations) {
  const laneFromMeta = normalizeLane(lane);
  if (laneFromMeta && dbkey) {
    const key = sectionDesignationKey(laneFromMeta, dbkey);
    if (designations.bySection[key]) return designations.bySection[key];
  }
  if (dbkey && designations.byDbkeyUnique[dbkey]) {
    return designations.byDbkeyUnique[dbkey];
  }
  return null;
}

async function setSectionAisleDesignation(visitId, dbkey, lane, { preset, custom }, actor) {
  const visitIdNum = parseVisitId(visitId);
  const dbkeyTrim = String(dbkey || '').trim();
  const laneNorm = normalizeLane(lane);
  if (!dbkeyTrim) {
    return { ok: false, status: 400, error: 'dbkey is required' };
  }

  const validated = validateAisleDesignation(preset, custom);
  if (!validated.ok) return validated;

  await applyTransition(visitIdNum, async () => {
    await query(
      `INSERT INTO section_state (visit_id, lane, dbkey, state, aisle_preset, aisle_custom, updated_at)
       VALUES ($1, $2, $3, 'not_started', $4, $5, now())
       ON CONFLICT (visit_id, lane, dbkey) DO UPDATE SET
         aisle_preset = EXCLUDED.aisle_preset,
         aisle_custom = EXCLUDED.aisle_custom,
         updated_at = now()`,
      [visitIdNum, laneNorm, dbkeyTrim, validated.preset, validated.custom],
    );

    await writeAuditLog(visitIdNum, actor.id, 'aisle_designation_set', dbkeyTrim, {
      lane: laneNorm,
      aisle_preset: validated.preset,
      aisle_custom: validated.custom,
      aisle_label: validated.label,
    });
  });

  await broadcastVisit(visitIdNum);
  return {
    ok: true,
    lane: laneNorm,
    dbkey: dbkeyTrim,
    aisle_preset: validated.preset,
    aisle_custom: validated.custom,
    aisle_label: validated.label,
  };
}

module.exports = {
  getSectionDesignationsMap,
  lookupStoreAisleLabel,
  setSectionAisleDesignation,
  resolveAisleLabel,
};
