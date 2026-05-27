// Hub API — snapshot, SSE stream, rep flags, lead verify gate, backup.

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { getSnapshot, applyTransition } = require('../hub-state');
const {
  resolveHubUser,
  resolveRank,
  requireHubRank,
  writeAuditLog,
  parseVisitId,
} = require('../hub-auth');
const { addSubscriber, broadcastVisit, sendSnapshotToClient } = require('../hub-broadcast');
const { sendBackup, markVisitDirtyAndBackupNow } = require('../hub-backup');
const { getTagBatchPreview, sendTagBatch } = require('../hub-tag-batch');
const { sendSectionReopenEmail } = require('../hub-notify');
const {
  getSectionTagDrafts,
  addSectionTagDraft,
  removeSectionTagDraft,
  bulkAddSectionTagDrafts,
  submitSectionTagDrafts,
  gatherMissingTags,
  verifyMissingTagsBulk,
} = require('../hub-missing-tags');
const { query } = require('../lib/db');
const {
  loadSectionRow,
  upsertSectionState,
  updateSectionState,
  setNeedsAttention,
  restoreSectionState,
  clearSectionAssignment,
  laneFromRequest,
} = require('../hub-section');

const ASSIGNABLE_STATES = ['not_started', 'assigned', 'in_progress', 'needs_attention'];
const UNASSIGNABLE_STATES = ['assigned', 'in_progress', 'needs_attention'];
const REOPENABLE_STATES = ['done_pending_signoff', 'signed_off'];
const MIN_REOPEN_REASON_LENGTH = 10;

const router = express.Router();

async function attachHubContext(req, res, next) {
  try {
    req.hubUser = await resolveHubUser(req.user);
    req.hubRank = await resolveRank(req.user, req.params.visitId);
    next();
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] context failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve hub user' });
  }
}

router.get('/:visitId/stream', requireAuth, async (req, res) => {
  try {
    parseVisitId(req.params.visitId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  addSubscriber(req.params.visitId, res, req.user);

  try {
    await sendSnapshotToClient(res, req.user, req.params.visitId);
  } catch (err) {
    console.error('[hub] stream initial snapshot failed:', err.message);
    res.end();
  }
});

router.get('/:visitId/snapshot', requireAuth, async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.visitId, { user: req.user });
    return res.json(snapshot);
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] snapshot failed:', err.message);
    return res.status(500).json({ error: 'Failed to load hub snapshot' });
  }
});

router.get('/:visitId/tag-batch/preview', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const preview = await getTagBatchPreview(req.params.visitId);
    return res.json(preview);
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] tag-batch preview failed:', err.message);
    return res.status(500).json({ error: 'Failed to load tag batch preview' });
  }
});

router.post('/:visitId/send-tag-batch', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const result = await sendTagBatch(req.params.visitId, req.hubUser);
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error || 'Tag batch send failed' });
    }
    return res.json({
      ok: true,
      count: result.count,
      resendId: result.resendId,
      recipients: result.recipients,
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] send-tag-batch failed:', err.message);
    return res.status(500).json({ error: 'Failed to send tag batch' });
  }
});

router.get('/:visitId/missing-tags/gather', requireAuth, attachHubContext, async (req, res) => {
  try {
    const gather = await gatherMissingTags(req.params.visitId, {
      statusFilter: req.query.status,
    });
    return res.json(gather);
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] missing-tags gather failed:', err.message);
    return res.status(500).json({ error: 'Failed to gather missing tags' });
  }
});

router.post('/:visitId/missing-tags/verify-bulk', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const result = await verifyMissingTagsBulk(req.params.visitId, req.hubUser, {
      dbkey: req.body?.dbkey,
      tagIds: req.body?.tagIds,
    });
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error || 'Bulk verify failed' });
    }
    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] missing-tags verify-bulk failed:', err.message);
    return res.status(500).json({ error: 'Failed to bulk verify missing tags' });
  }
});

router.get('/:visitId/sections/:dbkey/tag-drafts', requireAuth, attachHubContext, async (req, res) => {
  try {
    const drafts = await getSectionTagDrafts(req.params.visitId, req.params.dbkey);
    return res.json(drafts);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-drafts list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load tag drafts' });
  }
});

router.post('/:visitId/sections/:dbkey/tag-drafts', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await addSectionTagDraft(
      req.params.visitId,
      req.params.dbkey,
      req.hubUser,
      req.body || {},
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-draft add failed:', err.message);
    return res.status(500).json({ error: 'Failed to add tag draft' });
  }
});

router.post('/:visitId/sections/:dbkey/tag-drafts/bulk', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await bulkAddSectionTagDrafts(
      req.params.visitId,
      req.params.dbkey,
      req.hubUser,
      req.body?.tags,
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-draft bulk add failed:', err.message);
    return res.status(500).json({ error: 'Failed to bulk add tag drafts' });
  }
});

router.post('/:visitId/sections/:dbkey/tag-drafts/submit', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await submitSectionTagDrafts(
      req.params.visitId,
      req.params.dbkey,
      req.hubUser,
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-drafts submit failed:', err.message);
    return res.status(500).json({ error: 'Failed to submit tag drafts' });
  }
});

router.delete('/:visitId/sections/:dbkey/tag-drafts/:tagId', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await removeSectionTagDraft(
      req.params.visitId,
      req.params.dbkey,
      req.params.tagId,
      req.hubUser,
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-draft remove failed:', err.message);
    return res.status(500).json({ error: 'Failed to remove tag draft' });
  }
});

router.get('/:visitId/pending', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const { rows } = await query(
      `SELECT pa.*, hu.name AS raised_by_name, hu.email AS raised_by_email
       FROM pending_actions pa
       JOIN hub_users hu ON hu.id = pa.raised_by
       WHERE pa.visit_id = $1 AND pa.status = 'pending'
       ORDER BY pa.raised_at ASC`,
      [visitIdNum],
    );

    const items = rows.map((row) => ({
      id: row.id,
      visit_id: Number(row.visit_id),
      dbkey: row.dbkey,
      action_type: row.action_type,
      payload: row.payload || {},
      raised_by: row.raised_by,
      raised_by_name: row.raised_by_name,
      raised_by_email: row.raised_by_email,
      raised_at: row.raised_at ? row.raised_at.toISOString() : null,
      verified_by: row.verified_by,
      verified_at: row.verified_at ? row.verified_at.toISOString() : null,
      status: row.status,
    }));

    return res.json({ visitId: visitIdNum, pending: items });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] pending list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load pending actions' });
  }
});

async function loadPendingAction(visitIdNum, pendingId) {
  const { rows } = await query(
    `SELECT pa.*, raiser.name AS raised_by_name, raiser.email AS raised_by_email
     FROM pending_actions pa
     JOIN hub_users raiser ON raiser.id = pa.raised_by
     WHERE pa.id = $1 AND pa.visit_id = $2`,
    [pendingId, visitIdNum],
  );
  return rows[0] || null;
}

router.post('/:visitId/pending/:id/verify', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const pendingId = Number(req.params.id);
    if (!Number.isFinite(pendingId)) {
      return res.status(400).json({ error: 'Invalid pending action id' });
    }

    const verifier = req.hubUser;

    await applyTransition(req.params.visitId, async () => {
      const pending = await loadPendingAction(visitIdNum, pendingId);
      if (!pending) {
        throw Object.assign(new Error('Pending action not found'), { status: 404 });
      }
      if (pending.status !== 'pending') {
        throw Object.assign(new Error('Pending action is not pending'), { status: 409 });
      }

      await query(
        `UPDATE pending_actions
         SET status = 'verified', verified_by = $1, verified_at = now()
         WHERE id = $2`,
        [verifier.id, pendingId],
      );

      const payload = pending.payload || {};

      if (pending.action_type === 'help_request' || pending.action_type === 'nis') {
        await restoreSectionState(
          visitIdNum,
          pending.dbkey,
          pending.lane || payload.lane || '',
          payload.prior_state,
        );
      } else if (pending.action_type === 'missing_tag') {
        const tagFlagId = payload.tag_flag_id;
        if (tagFlagId) {
          await query(
            `UPDATE tag_flags
             SET status = 'verified', verified_by = $1, verified_at = now()
             WHERE id = $2 AND visit_id = $3`,
            [verifier.id, tagFlagId, visitIdNum],
          );
        }
      }

      await writeAuditLog(visitIdNum, verifier.id, 'flag_verified', pending.dbkey, {
        pending_id: pendingId,
        action_type: pending.action_type,
        raised_by: pending.raised_by,
        raised_by_name: pending.raised_by_name,
        raised_by_email: pending.raised_by_email,
        verified_by: verifier.id,
        verified_by_name: verifier.name,
        verified_by_email: verifier.email,
      });
    });

    await broadcastVisit(req.params.visitId);
    return res.json({ ok: true, id: pendingId, status: 'verified' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] verify failed:', err.message);
    return res.status(500).json({ error: 'Failed to verify pending action' });
  }
});

router.post('/:visitId/pending/:id/reject', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const pendingId = Number(req.params.id);
    if (!Number.isFinite(pendingId)) {
      return res.status(400).json({ error: 'Invalid pending action id' });
    }

    const verifier = req.hubUser;
    const reason = req.body?.reason ?? null;

    await applyTransition(req.params.visitId, async () => {
      const pending = await loadPendingAction(visitIdNum, pendingId);
      if (!pending) {
        throw Object.assign(new Error('Pending action not found'), { status: 404 });
      }
      if (pending.status !== 'pending') {
        throw Object.assign(new Error('Pending action is not pending'), { status: 409 });
      }

      const payload = { ...(pending.payload || {}), reason };

      await query(
        `UPDATE pending_actions
         SET status = 'rejected', verified_by = $1, verified_at = now(), payload = $2
         WHERE id = $3`,
        [verifier.id, JSON.stringify(payload), pendingId],
      );

      if (pending.action_type === 'help_request' || pending.action_type === 'nis') {
        await restoreSectionState(
          visitIdNum,
          pending.dbkey,
          pending.lane || payload.lane || '',
          payload.prior_state,
        );
      } else if (pending.action_type === 'missing_tag') {
        const tagFlagId = payload.tag_flag_id;
        if (tagFlagId) {
          await query(
            `UPDATE tag_flags SET status = 'rejected' WHERE id = $1 AND visit_id = $2`,
            [tagFlagId, visitIdNum],
          );
        }
      }

      await writeAuditLog(visitIdNum, verifier.id, 'flag_rejected', pending.dbkey, {
        pending_id: pendingId,
        action_type: pending.action_type,
        reason,
        raised_by: pending.raised_by,
        raised_by_name: pending.raised_by_name,
        raised_by_email: pending.raised_by_email,
        verified_by: verifier.id,
        verified_by_name: verifier.name,
        verified_by_email: verifier.email,
      });
    });

    await broadcastVisit(req.params.visitId);
    return res.json({ ok: true, id: pendingId, status: 'rejected' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] reject failed:', err.message);
    return res.status(500).json({ error: 'Failed to reject pending action' });
  }
});

async function loadHubUserById(userId) {
  const { rows } = await query(
    `SELECT id, name, email, is_active FROM hub_users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/** Demo roster until SAS employee pull backs GET /roster (response shape stays stable). */
const HUB_ROSTER_SEED = [
  { email: 'hub.rep.a@test.local', name: 'Rep Alex', standing_rank: 1 },
  { email: 'hub.rep.b@test.local', name: 'Rep Bailey', standing_rank: 1 },
  { email: 'hub.lead@test.local', name: 'Lead Casey', standing_rank: 2 },
  { email: 'retail.odyssey.supervisor@gmail.com', name: 'Retail Odyssey Supervisor', standing_rank: 1 },
];

async function ensureHubRosterSeeded() {
  for (const user of HUB_ROSTER_SEED) {
    await query(
      `INSERT INTO hub_users (email, name, standing_rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [user.email, user.name, user.standing_rank],
    );
  }
}

function handleTransitionError(err, res, label) {
  if (err.status === 403) return res.status(403).json({ error: err.message });
  if (err.status === 404) return res.status(404).json({ error: err.message });
  if (err.status === 409) return res.status(409).json({ error: err.message });
  if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
  console.error(`[hub] ${label} failed:`, err.message);
  return res.status(500).json({ error: label });
}

router.get('/:visitId/roster', requireAuth, attachHubContext, async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    await ensureHubRosterSeeded();
    const { rows } = await query(
      `SELECT id, name, standing_rank
       FROM hub_users
       WHERE is_active = true
       ORDER BY name`,
    );
    return res.json({
      visitId: visitIdNum,
      roster: rows.map((row) => ({
        id: row.id,
        name: row.name,
        rank: Number(row.standing_rank) || 1,
      })),
      source: 'hub_users',
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] roster failed:', err.message);
    return res.status(500).json({ error: 'Failed to load roster' });
  }
});

router.post('/:visitId/sections/:dbkey/flag/help', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const note = req.body?.note ?? null;
    const raiser = req.hubUser;

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const priorState = await setNeedsAttention(visitIdNum, dbkey, lane);
      const payload = { note, prior_state: priorState, lane, summary: 'Needs assistance' };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, lane, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, $3, 'help_request', $4, $5)
         RETURNING id`,
        [visitIdNum, lane, dbkey, JSON.stringify(payload), raiser.id],
      );

      const id = inserted.rows[0].id;
      await writeAuditLog(visitIdNum, raiser.id, 'flag_raised', dbkey, {
        type: 'help_request',
        pending_id: id,
        note,
      });
      return id;
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, pendingId });
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] flag/help failed:', err.message);
    return res.status(500).json({ error: 'Failed to raise help flag' });
  }
});

router.post('/:visitId/sections/:dbkey/flag/missing-tag', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const upc = (req.body?.upc || '').toString().trim();
    const description = req.body?.description ?? null;
    const location = req.body?.location ?? null;

    if (!upc) {
      return res.status(400).json({ error: 'UPC is required for missing-tag flags' });
    }

    const result = await addSectionTagDraft(visitId, dbkey, req.hubUser, {
      upc,
      description,
      location,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }

    if (req.body?.submit) {
      const submitResult = await submitSectionTagDrafts(visitId, dbkey, req.hubUser);
      return res.json({ ok: true, tagId: result.id, submitted: submitResult.count });
    }

    return res.json({ ok: true, tagId: result.id, draft: true });
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] flag/missing-tag failed:', err.message);
    return res.status(500).json({ error: 'Failed to raise missing-tag flag' });
  }
});

router.post('/:visitId/sections/:dbkey/flag/nis', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const note = req.body?.note ?? null;
    const raiser = req.hubUser;

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const priorState = await setNeedsAttention(visitIdNum, dbkey, lane);
      const payload = { note, prior_state: priorState, lane, summary: 'Not in store' };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, lane, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, $3, 'nis', $4, $5)
         RETURNING id`,
        [visitIdNum, lane, dbkey, JSON.stringify(payload), raiser.id],
      );

      const id = inserted.rows[0].id;
      await writeAuditLog(visitIdNum, raiser.id, 'flag_raised', dbkey, {
        type: 'nis',
        pending_id: id,
        note,
      });
      return id;
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, pendingId });
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] flag/nis failed:', err.message);
    return res.status(500).json({ error: 'Failed to raise not-in-store flag' });
  }
});

router.post('/:visitId/sections/:dbkey/assign', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const assigneeId = Number(req.body?.assigneeId);
    if (!Number.isFinite(assigneeId)) {
      return res.status(400).json({ error: 'assigneeId is required' });
    }

    const actor = req.hubUser;
    const assignee = await loadHubUserById(assigneeId);
    if (!assignee || !assignee.is_active) {
      return res.status(400).json({ error: 'Unknown or inactive hub user' });
    }

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (!ASSIGNABLE_STATES.includes(section.state)) {
        throw Object.assign(
          new Error(`Cannot assign a section in state ${section.state}`),
          { status: 409 },
        );
      }

      const fields = {
        state: 'assigned',
        assignee_id: assigneeId,
        assigned_by: actor.id,
      };
      if (section.state === 'in_progress') {
        fields.started_at = null;
      }

      await updateSectionState(visitIdNum, dbkey, lane, fields);

      const action = section.assignee_id != null ? 'reassigned' : 'assigned';
      await writeAuditLog(visitIdNum, actor.id, action, dbkey, {
        lane,
        assignee: assigneeId,
        assignee_name: assignee.name,
        prior_assignee_id: section.assignee_id,
        prior_state: section.state,
        by: actor.id,
        by_name: actor.name,
      });
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to assign section');
  }
});

router.post('/:visitId/sections/:dbkey/unassign', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const actor = req.hubUser;

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (!UNASSIGNABLE_STATES.includes(section.state)) {
        throw Object.assign(
          new Error(`Cannot unassign a section in state ${section.state}`),
          { status: 409 },
        );
      }
      if (section.assignee_id == null) {
        throw Object.assign(new Error('Section is not assigned'), { status: 409 });
      }

      await clearSectionAssignment(visitIdNum, dbkey, lane);

      await writeAuditLog(visitIdNum, actor.id, 'unassigned', dbkey, {
        lane,
        prior_assignee_id: section.assignee_id,
        prior_state: section.state,
        by: actor.id,
        by_name: actor.name,
      });
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to unassign section');
  }
});

router.post('/:visitId/sections/:dbkey/start', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const actor = req.hubUser;
    const rank = req.hubRank ?? 1;

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (section.state !== 'assigned') {
        throw Object.assign(
          new Error('Cannot start a section that is not assigned'),
          { status: 409 },
        );
      }
      if (rank < 2 && section.assignee_id !== actor.id) {
        throw Object.assign(new Error('Not your assignment'), { status: 403 });
      }

      await updateSectionState(visitIdNum, dbkey, lane, {
        state: 'in_progress',
        started_at: new Date(),
      });

      await writeAuditLog(visitIdNum, actor.id, 'started', dbkey, {
        lane,
        assignee_id: section.assignee_id,
      });
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to start section');
  }
});

router.post('/:visitId/sections/:dbkey/mark-done', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const actor = req.hubUser;
    const rank = req.hubRank ?? 1;

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (section.state !== 'in_progress') {
        throw Object.assign(
          new Error('Cannot mark done a section that is not in progress'),
          { status: 409 },
        );
      }
      if (rank < 2 && section.assignee_id !== actor.id) {
        throw Object.assign(new Error('Not your assignment'), { status: 403 });
      }

      await updateSectionState(visitIdNum, dbkey, lane, {
        state: 'done_pending_signoff',
        completed_at: new Date(),
      });

      await writeAuditLog(visitIdNum, actor.id, 'marked_done', dbkey, {
        lane,
        prior_state: section.state,
        assignee_id: section.assignee_id,
      });
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to mark section done');
  }
});

router.post('/:visitId/sections/:dbkey/signoff', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const actor = req.hubUser;

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (section.state !== 'done_pending_signoff') {
        throw Object.assign(
          new Error('Cannot sign off a section that is not done pending sign-off'),
          { status: 409 },
        );
      }

      await updateSectionState(visitIdNum, dbkey, lane, {
        state: 'signed_off',
        signed_off_by: actor.id,
        signed_off_at: new Date(),
      });

      await writeAuditLog(visitIdNum, actor.id, 'signed_off', dbkey, {
        lane,
        prior_state: section.state,
      });
    });

    await broadcastVisit(visitId);
    markVisitDirtyAndBackupNow(visitId).catch((err) => {
      console.error('[hub] signoff backup failed:', err.message);
    });
    return res.json({ ok: true });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to sign off section');
  }
});

router.post('/:visitId/sections/:dbkey/reopen', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MIN_REOPEN_REASON_LENGTH) {
      return res.status(400).json({
        error: `An explanation of at least ${MIN_REOPEN_REASON_LENGTH} characters is required to reopen a completed set`,
      });
    }

    const actor = req.hubUser;

    const sectionPreview = await loadSectionRow(parseVisitId(visitId), dbkey, lane);
    if (!REOPENABLE_STATES.includes(sectionPreview.state)) {
      return res.status(409).json({
        error: `Cannot reopen a section in state ${sectionPreview.state}`,
      });
    }

    const emailResult = await sendSectionReopenEmail({
      visitId,
      lane,
      dbkey,
      priorState: sectionPreview.state,
      reason,
      actor,
    });

    if (!emailResult.sent) {
      return res.status(502).json({
        error: emailResult.error || 'Notification email failed — set was not reopened',
        emailSent: false,
      });
    }

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (!REOPENABLE_STATES.includes(section.state)) {
        throw Object.assign(
          new Error(`Cannot reopen a section in state ${section.state}`),
          { status: 409 },
        );
      }

      await updateSectionState(visitIdNum, dbkey, lane, {
        state: 'in_progress',
        completed_at: null,
        signed_off_by: null,
        signed_off_at: null,
      });

      await writeAuditLog(visitIdNum, actor.id, 'reopened', dbkey, {
        lane,
        prior_state: section.state,
        reason,
        assignee_id: section.assignee_id,
        resend_id: emailResult.resendId,
      });
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, emailSent: true, resendId: emailResult.resendId });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to reopen section');
  }
});

router.post('/:visitId/backup-now', requireAuth, async (req, res) => {
  try {
    const result = await sendBackup(req.params.visitId, 'interval', { sentBy: 0 });
    if (!result.sent) {
      return res.status(502).json({
        sent: false,
        error: result.error || 'Backup send failed',
        sequence: result.sequence,
      });
    }
    return res.json({ sent: true, sequence: result.sequence });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] backup-now failed:', err.message);
    return res.status(500).json({ error: 'Failed to send hub backup' });
  }
});

module.exports = router;
