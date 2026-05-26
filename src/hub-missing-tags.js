/**
 * Checklane Hub — missing-tag drafts, bulk submit, and cross-planogram gather.
 *
 * tag_flags.status lifecycle (extended):
 *   draft   → rep building list per planogram (no pending action yet)
 *   flagged → submitted, awaiting lead verify
 *   verified → lead approved (ready for tag batch)
 *   sent / rejected → terminal
 */

const { query } = require('./lib/db');
const { validateUpc } = require('./lib/barcode');
const { sortTagsByAisle, groupTagsByAisle } = require('./lib/tag-location');
const { writeAuditLog, parseVisitId } = require('./hub-auth');
const { applyTransition } = require('./hub-state');
const { broadcastVisit } = require('./hub-broadcast');

function rowToTag(row) {
  const validation = validateUpc(row.upc);
  return {
    id: row.id,
    visit_id: Number(row.visit_id),
    dbkey: row.dbkey,
    upc: row.upc,
    description: row.description,
    location: row.location,
    status: row.status,
    flagged_by: row.flagged_by,
    flagged_by_name: row.flagged_by_name || null,
    flagged_at: row.flagged_at ? row.flagged_at.toISOString() : null,
    valid: validation.valid,
    reason: validation.reason || null,
    displayDigits: validation.displayDigits || null,
    symbology: validation.symbology || null,
  };
}

async function loadDraftTags(visitIdNum, dbkey) {
  const { rows } = await query(
    `SELECT tf.*, hu.name AS flagged_by_name
     FROM tag_flags tf
     JOIN hub_users hu ON hu.id = tf.flagged_by
     WHERE tf.visit_id = $1 AND tf.dbkey = $2 AND tf.status = 'draft'
     ORDER BY tf.id ASC`,
    [visitIdNum, dbkey],
  );
  return rows.map(rowToTag);
}

async function getSectionTagDrafts(visitId, dbkey) {
  const visitIdNum = parseVisitId(visitId);
  const tags = await loadDraftTags(visitIdNum, dbkey);
  return { visitId: visitIdNum, dbkey, count: tags.length, tags };
}

async function addSectionTagDraft(visitId, dbkey, actor, { upc, description, location }) {
  const visitIdNum = parseVisitId(visitId);
  const upcTrim = String(upc || '').trim();
  if (!upcTrim) {
    return { ok: false, status: 400, error: 'UPC is required' };
  }

  const id = await applyTransition(visitId, async () => {
    const dup = await query(
      `SELECT id FROM tag_flags
       WHERE visit_id = $1 AND dbkey = $2 AND status = 'draft'
         AND upc = $3 AND COALESCE(location, '') = COALESCE($4, '')
       LIMIT 1`,
      [visitIdNum, dbkey, upcTrim, location ?? null],
    );
    if (dup.rows.length) return dup.rows[0].id;

    const inserted = await query(
      `INSERT INTO tag_flags (visit_id, dbkey, upc, description, location, flagged_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING id`,
      [visitIdNum, dbkey, upcTrim, description ?? null, location ?? null, actor.id],
    );
    const tagId = inserted.rows[0].id;
    await writeAuditLog(visitIdNum, actor.id, 'tag_draft_added', dbkey, {
      tag_id: tagId,
      upc: upcTrim,
    });
    return tagId;
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, id };
}

async function removeSectionTagDraft(visitId, dbkey, tagId, actor) {
  const visitIdNum = parseVisitId(visitId);
  const tagIdNum = Number(tagId);
  if (!Number.isFinite(tagIdNum)) {
    return { ok: false, status: 400, error: 'Invalid tag id' };
  }

  await applyTransition(visitId, async () => {
    const { rowCount } = await query(
      `DELETE FROM tag_flags
       WHERE id = $1 AND visit_id = $2 AND dbkey = $3 AND status = 'draft'`,
      [tagIdNum, visitIdNum, dbkey],
    );
    if (!rowCount) {
      throw Object.assign(new Error('Draft tag not found'), { status: 404 });
    }
    await writeAuditLog(visitIdNum, actor.id, 'tag_draft_removed', dbkey, { tag_id: tagIdNum });
  });

  await broadcastVisit(visitIdNum);
  return { ok: true };
}

async function bulkAddSectionTagDrafts(visitId, dbkey, actor, items) {
  const visitIdNum = parseVisitId(visitId);
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return { ok: false, status: 400, error: 'No tags to add' };
  }

  let added = 0;
  let skipped = 0;

  await applyTransition(visitId, async () => {
    for (const item of list) {
      const upcTrim = String(item?.upc || '').trim();
      if (!upcTrim) {
        skipped += 1;
        continue;
      }
      const description = item?.description ?? null;
      const location = item?.location ?? null;

      const dup = await query(
        `SELECT id FROM tag_flags
         WHERE visit_id = $1 AND dbkey = $2 AND status = 'draft'
           AND upc = $3 AND COALESCE(location, '') = COALESCE($4, '')
         LIMIT 1`,
        [visitIdNum, dbkey, upcTrim, location],
      );
      if (dup.rows.length) {
        skipped += 1;
        continue;
      }

      await query(
        `INSERT INTO tag_flags (visit_id, dbkey, upc, description, location, flagged_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft')
         RETURNING id`,
        [visitIdNum, dbkey, upcTrim, description, location, actor.id],
      );
      added += 1;
    }

    if (added) {
      await writeAuditLog(visitIdNum, actor.id, 'tag_draft_bulk_added', dbkey, {
        added,
        skipped,
        total: list.length,
      });
    }
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, added, skipped };
}

async function submitSectionTagDrafts(visitId, dbkey, actor) {
  const visitIdNum = parseVisitId(visitId);

  const result = await applyTransition(visitId, async () => {
    const { rows: drafts } = await query(
      `SELECT id, upc, description, location
       FROM tag_flags
       WHERE visit_id = $1 AND dbkey = $2 AND status = 'draft'
       ORDER BY id ASC`,
      [visitIdNum, dbkey],
    );

    if (!drafts.length) {
      throw Object.assign(new Error('No draft tags to submit'), { status: 400 });
    }

    const pendingIds = [];

    for (const draft of drafts) {
      await query(
        `UPDATE tag_flags SET status = 'flagged', flagged_at = now()
         WHERE id = $1 AND visit_id = $2 AND status = 'draft'`,
        [draft.id, visitIdNum],
      );

      const summary = `Missing tag: ${draft.upc}`;
      const payload = {
        upc: draft.upc,
        description: draft.description,
        location: draft.location,
        tag_flag_id: draft.id,
        summary,
      };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, 'missing_tag', $3, $4)
         RETURNING id`,
        [visitIdNum, dbkey, JSON.stringify(payload), actor.id],
      );
      pendingIds.push(inserted.rows[0].id);
    }

    await writeAuditLog(visitIdNum, actor.id, 'tag_drafts_submitted', dbkey, {
      count: drafts.length,
      tag_ids: drafts.map((d) => d.id),
      pending_ids: pendingIds,
    });

    return { count: drafts.length, pendingIds };
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, ...result };
}

async function gatherMissingTags(visitId, { statusFilter } = {}) {
  const visitIdNum = parseVisitId(visitId);
  const allowed = ['draft', 'flagged', 'verified'];
  const statuses = statusFilter
    ? String(statusFilter).split(',').map((s) => s.trim()).filter((s) => allowed.includes(s))
    : allowed;

  const { rows } = await query(
    `SELECT tf.*, hu.name AS flagged_by_name
     FROM tag_flags tf
     JOIN hub_users hu ON hu.id = tf.flagged_by
     WHERE tf.visit_id = $1 AND tf.status = ANY($2::text[])
     ORDER BY tf.dbkey ASC, tf.id ASC`,
    [visitIdNum, statuses],
  );

  const tags = rows.map(rowToTag);
  const sorted = sortTagsByAisle(tags);
  const byAisle = groupTagsByAisle(sorted);

  const byDbkey = {};
  for (const tag of tags) {
    const key = tag.dbkey || 'unknown';
    if (!byDbkey[key]) byDbkey[key] = [];
    byDbkey[key].push(tag);
  }

  return {
    visitId: visitIdNum,
    count: tags.length,
    tags: sorted,
    byAisle,
    byDbkey,
    stats: {
      draft: tags.filter((t) => t.status === 'draft').length,
      flagged: tags.filter((t) => t.status === 'flagged').length,
      verified: tags.filter((t) => t.status === 'verified').length,
      invalid: tags.filter((t) => !t.valid).length,
    },
  };
}

async function verifyMissingTagsBulk(visitId, actor, { dbkey, tagIds } = {}) {
  const visitIdNum = parseVisitId(visitId);

  const result = await applyTransition(visitId, async () => {
    let pendingRows;

    if (Array.isArray(tagIds) && tagIds.length) {
      const { rows } = await query(
        `SELECT pa.*, (pa.payload->>'tag_flag_id')::int AS tag_flag_id
         FROM pending_actions pa
         WHERE pa.visit_id = $1 AND pa.status = 'pending' AND pa.action_type = 'missing_tag'
           AND (pa.payload->>'tag_flag_id')::int = ANY($2::int[])`,
        [visitIdNum, tagIds.map(Number)],
      );
      pendingRows = rows;
    } else if (dbkey) {
      const { rows } = await query(
        `SELECT pa.*, (pa.payload->>'tag_flag_id')::int AS tag_flag_id
         FROM pending_actions pa
         WHERE pa.visit_id = $1 AND pa.status = 'pending' AND pa.action_type = 'missing_tag'
           AND pa.dbkey = $2`,
        [visitIdNum, dbkey],
      );
      pendingRows = rows;
    } else {
      const { rows } = await query(
        `SELECT pa.*, (pa.payload->>'tag_flag_id')::int AS tag_flag_id
         FROM pending_actions pa
         WHERE pa.visit_id = $1 AND pa.status = 'pending' AND pa.action_type = 'missing_tag'`,
        [visitIdNum],
      );
      pendingRows = rows;
    }

    if (!pendingRows.length) {
      throw Object.assign(new Error('No pending missing tags to verify'), { status: 400 });
    }

    for (const pending of pendingRows) {
      await query(
        `UPDATE pending_actions
         SET status = 'verified', verified_by = $1, verified_at = now()
         WHERE id = $2`,
        [actor.id, pending.id],
      );

      if (pending.tag_flag_id) {
        await query(
          `UPDATE tag_flags
           SET status = 'verified', verified_by = $1, verified_at = now()
           WHERE id = $2 AND visit_id = $3 AND status = 'flagged'`,
          [actor.id, pending.tag_flag_id, visitIdNum],
        );
      }
    }

    await writeAuditLog(visitIdNum, actor.id, 'missing_tags_bulk_verified', dbkey || null, {
      count: pendingRows.length,
      dbkey: dbkey || null,
      pending_ids: pendingRows.map((r) => r.id),
    });

    return { count: pendingRows.length };
  });

  await broadcastVisit(visitIdNum);
  return { ok: true, ...result };
}

module.exports = {
  getSectionTagDrafts,
  addSectionTagDraft,
  removeSectionTagDraft,
  bulkAddSectionTagDrafts,
  submitSectionTagDrafts,
  gatherMissingTags,
  verifyMissingTagsBulk,
};
