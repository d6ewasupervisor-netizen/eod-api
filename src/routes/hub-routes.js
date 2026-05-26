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
const { sendBackup } = require('../hub-backup');
const { getTagBatchPreview, sendTagBatch } = require('../hub-tag-batch');
const { query } = require('../lib/db');

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

async function restoreSectionState(visitIdNum, dbkey, priorState) {
  const state = priorState || 'not_started';
  await query(
    `INSERT INTO section_state (visit_id, dbkey, state, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (visit_id, dbkey) DO UPDATE
       SET state = EXCLUDED.state, updated_at = now()`,
    [visitIdNum, dbkey, state],
  );
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
        await restoreSectionState(visitIdNum, pending.dbkey, payload.prior_state);
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
        await restoreSectionState(visitIdNum, pending.dbkey, payload.prior_state);
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

async function readSectionState(visitIdNum, dbkey) {
  const { rows } = await query(
    `SELECT state FROM section_state WHERE visit_id = $1 AND dbkey = $2`,
    [visitIdNum, dbkey],
  );
  return rows.length ? rows[0].state : 'not_started';
}

async function setNeedsAttention(visitIdNum, dbkey) {
  const priorState = await readSectionState(visitIdNum, dbkey);
  await query(
    `INSERT INTO section_state (visit_id, dbkey, state, updated_at)
     VALUES ($1, $2, 'needs_attention', now())
     ON CONFLICT (visit_id, dbkey) DO UPDATE
       SET state = 'needs_attention', updated_at = now()`,
    [visitIdNum, dbkey],
  );
  return priorState;
}

router.post('/:visitId/sections/:dbkey/flag/help', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const note = req.body?.note ?? null;
    const raiser = req.hubUser;

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const priorState = await setNeedsAttention(visitIdNum, dbkey);
      const payload = { note, prior_state: priorState, summary: 'Needs assistance' };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, 'help_request', $3, $4)
         RETURNING id`,
        [visitIdNum, dbkey, JSON.stringify(payload), raiser.id],
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

    const raiser = req.hubUser;

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const tagInsert = await query(
        `INSERT INTO tag_flags (visit_id, dbkey, upc, description, location, flagged_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'flagged')
         RETURNING id`,
        [visitIdNum, dbkey, upc, description, location, raiser.id],
      );
      const tagFlagId = tagInsert.rows[0].id;

      const summary = `Missing tag: ${upc}`;
      const payload = { upc, description, location, tag_flag_id: tagFlagId, summary };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, 'missing_tag', $3, $4)
         RETURNING id`,
        [visitIdNum, dbkey, JSON.stringify(payload), raiser.id],
      );

      const id = inserted.rows[0].id;
      await writeAuditLog(visitIdNum, raiser.id, 'flag_raised', dbkey, {
        type: 'missing_tag',
        pending_id: id,
        tag_flag_id: tagFlagId,
        upc,
      });
      return id;
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, pendingId });
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] flag/missing-tag failed:', err.message);
    return res.status(500).json({ error: 'Failed to raise missing-tag flag' });
  }
});

router.post('/:visitId/sections/:dbkey/flag/nis', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const note = req.body?.note ?? null;
    const raiser = req.hubUser;

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const priorState = await setNeedsAttention(visitIdNum, dbkey);
      const payload = { note, prior_state: priorState, summary: 'Not in store' };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, 'nis', $3, $4)
         RETURNING id`,
        [visitIdNum, dbkey, JSON.stringify(payload), raiser.id],
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
