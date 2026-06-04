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
const {
  addSubscriber, broadcastVisit, broadcastChat, sendSnapshotToClient, writeHeartbeat,
} = require('../hub-broadcast');

const STREAM_HEARTBEAT_MS = 15000;
// ~2KB of comment padding. Forces buffering proxies (Cloudflare/nginx) to start
// streaming the response immediately instead of holding the first flush.
const STREAM_PREAMBLE = ':' + ' '.repeat(2048) + '\n\nretry: 3000\n\n';
const { sendBackup, markVisitDirtyAndBackupNow } = require('../hub-backup');
const { getTagBatchPreview, sendTagBatch, sendTagBatchForAisle, sendTagBatchForTagIds } = require('../hub-tag-batch');
const {
  getAisleAssignments,
  userAssignedAisleKeys,
  canAccessTagBatch,
  canWorkAisle,
  assignAisleSweep,
  unassignAisleSweep,
  addSweepTag,
  removePendingTag,
} = require('../hub-tag-sweep');
const { sendSectionReopenEmail, sendNisVerifiedEmail, sendHelpVerifiedEmail } = require('../hub-notify');
const { createProdDispatchRequest, isProdDispatchEnabled } = require('../hub-prod-dispatch');
const { parsePogMeta } = require('../lib/pog-meta');
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
const { resolveStoreForVisit, lookupFixture, enrichNisPayload } = require('../lib/hub-fixture-catalog');
const {
  rosterInviteFields,
  sendTeamMemberInvite,
} = require('../hub-team-invite');
const { requireVisitAccess } = require('../hub-store-access');
const { maybePinLiveVisitFromUser } = require('../hub-live-visit');
const {
  loadSectionRow,
  upsertSectionState,
  updateSectionState,
  setNeedsAttention,
  restoreSectionState,
  clearSectionAssignment,
  laneFromRequest,
} = require('../hub-section');
const { setSectionAisleDesignation } = require('../hub-aisle-designation');
const {
  parseBayNum,
  listBayPhotos,
  loadBayPhotoRow,
  upsertBayPhoto,
  assertAllBayPhotosPresent,
  clearBayPhotos,
} = require('../hub-bay-photos');
const {
  parsePhotoDataUrls,
  insertPendingPhotos,
  listPendingPhotos,
  loadPendingPhotoRow,
  loadPendingPhotosForEmail,
} = require('../hub-pending-photos');
const {
  listThreads,
  listRecipients,
  getThreadMessages,
  sendMessage,
  markThreadRead,
} = require('../hub-messages');

const ASSIGNABLE_STATES = ['not_started', 'assigned', 'in_progress', 'needs_attention'];
const UNASSIGNABLE_STATES = ['assigned', 'in_progress', 'needs_attention'];
const REOPENABLE_STATES = ['signed_off', 'not_in_store'];
const MIN_REOPEN_REASON_LENGTH = 10;

function buildNisFlagSummary({ setName, manifestPogId, action, dbkey, lane }) {
  const meta = parsePogMeta({ manifestPogId, action, dbkey });
  const parts = ['Not in store'];
  if (setName) parts.push(setName);
  if (lane) parts.push('lane ' + lane);
  if (meta.category) parts.push('C' + meta.category);
  if (meta.version) parts.push('V' + meta.version);
  if (dbkey) parts.push('DBKey ' + dbkey);
  return parts.join(' · ');
}

function buildHelpFlagSummary({
  issueTypeId,
  issueTypeLabel,
  customLabel,
  setName,
  lane,
}) {
  const label = issueTypeId === 'custom' && customLabel ? customLabel : issueTypeLabel;
  const parts = ['Needs help'];
  if (label) parts.push(label);
  if (setName) parts.push(setName);
  if (lane) parts.push('lane ' + lane);
  return parts.join(' · ');
}

const router = express.Router();

router.use('/:visitId', requireAuth, requireVisitAccess());

async function attachHubContext(req, res, next) {
  try {
    req.hubUser = await resolveHubUser(req.user);
    req.hubRank = await resolveRank(req.user, req.params.visitId);
    if (req.hubRank >= 2) {
      const storeNumber = await resolveStoreForVisit(parseVisitId(req.params.visitId));
      if (storeNumber) {
        maybePinLiveVisitFromUser(
          req.user,
          req.hubUser,
          storeNumber,
          req.params.visitId,
        ).catch((err) => {
          console.error('[hub-live-visit] pin from hub context failed:', err.message);
        });
      }
    }
    next();
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] context failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve hub user' });
  }
}

/**
 * Tag batch access: leads/supervisors (rank>=2) always; a rep may enter the tag
 * batch only if they've been assigned at least one aisle sweep. Sets req.hubUser,
 * req.hubRank, and req.assignedAisleKeys for downstream aisle-scoped checks.
 */
async function requireTagBatchAccess(req, res, next) {
  try {
    req.hubUser = await resolveHubUser(req.user);
    req.hubRank = await resolveRank(req.user, req.params.visitId);
    req.assignedAisleKeys = await userAssignedAisleKeys(req.params.visitId, req.hubUser.id);
    const allowed = await canAccessTagBatch(req.params.visitId, req.hubRank, req.hubUser.id);
    if (!allowed) {
      return res.status(403).json({ error: 'Lead, supervisor, or assigned rep required' });
    }
    next();
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch access failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve tag batch access' });
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

  // Padding + retry hint up front so proxies stream rather than buffer-and-close.
  res.write(STREAM_PREAMBLE);

  addSubscriber(req.params.visitId, res, req.user);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      writeHeartbeat(res);
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, STREAM_HEARTBEAT_MS);
  res.on('close', () => clearInterval(heartbeat));
  res.on('finish', () => clearInterval(heartbeat));

  try {
    await sendSnapshotToClient(res, req.user, req.params.visitId);
  } catch (err) {
    console.error('[hub] stream initial snapshot failed:', err.message);
    clearInterval(heartbeat);
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

router.get('/:visitId/next-actions', requireAuth, async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.visitId, { user: req.user });
    return res.json({
      visitId: snapshot.visitId,
      generatedAt: snapshot.generatedAt,
      nextActions: snapshot.nextActions || [],
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] next-actions failed:', err.message);
    return res.status(500).json({ error: 'Failed to load next actions' });
  }
});

router.get('/:visitId/lane-map', requireAuth, async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.visitId, { user: req.user });
    return res.json({
      visitId: snapshot.visitId,
      generatedAt: snapshot.generatedAt,
      laneMap: snapshot.laneMap || { lanes: [], totals: {} },
      teamAwareness: snapshot.teamAwareness || { occupancy: [], totals: {} },
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] lane-map failed:', err.message);
    return res.status(500).json({ error: 'Failed to load lane map' });
  }
});

router.get('/:visitId/closeout', requireAuth, async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.visitId, { user: req.user });
    return res.json({
      visitId: snapshot.visitId,
      generatedAt: snapshot.generatedAt,
      closeoutChecklist: snapshot.closeoutChecklist || { ready: false, checklist: [] },
      exceptionQueue: snapshot.exceptionQueue || { total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, items: [] },
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] closeout summary failed:', err.message);
    return res.status(500).json({ error: 'Failed to load closeout summary' });
  }
});

router.get('/:visitId/chat/recipients', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await listRecipients(req.params.visitId, req.hubUser.id, req.hubRank);
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] chat recipients failed:', err.message);
    return res.status(500).json({ error: 'Failed to load chat recipients' });
  }
});

router.get('/:visitId/chat/threads', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await listThreads(req.params.visitId, req.hubUser.id, req.hubRank);
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] chat threads failed:', err.message);
    return res.status(500).json({ error: 'Failed to load chat threads' });
  }
});

router.get('/:visitId/chat/threads/:threadId/messages', requireAuth, attachHubContext, async (req, res) => {
  try {
    const threadId = Number(req.params.threadId);
    if (!Number.isFinite(threadId)) return res.status(400).json({ error: 'Invalid threadId' });
    const result = await getThreadMessages(
      req.params.visitId,
      threadId,
      req.hubUser.id,
      req.hubRank,
      { limit: req.query.limit },
    );
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    if (err.message === 'Thread not found') return res.status(404).json({ error: err.message });
    console.error('[hub] chat messages failed:', err.message);
    return res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/:visitId/chat/messages', requireAuth, attachHubContext, async (req, res) => {
  try {
    const result = await sendMessage(req.params.visitId, {
      senderId: req.hubUser.id,
      rank: req.hubRank,
      body: req.body?.body,
      threadId: req.body?.threadId,
      repId: req.body?.repId,
      recipientId: req.body?.recipientId,
      dbkey: req.body?.dbkey,
      messageType: req.body?.messageType,
    });

    await broadcastChat(req.params.visitId, async (user) => {
      const rank = await resolveRank(user, req.params.visitId);
      const hubUser = await resolveHubUser(user);
      const threads = await listThreads(req.params.visitId, hubUser.id, rank);
      return {
        type: 'message',
        threadId: result.thread.id,
        message: result.message,
        chatSummary: { unreadTotal: threads.unreadTotal, threadCount: threads.threads.length },
      };
    });

    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    if (err.message === 'Thread not found') return res.status(404).json({ error: err.message });
    if (err.message === 'Message body required' || err.message.startsWith('Message too long')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'repId or threadId required') {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'Recipient required' || err.message === 'Recipient not found') {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'Invalid recipient') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] chat send failed:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/:visitId/chat/threads/:threadId/read', requireAuth, attachHubContext, async (req, res) => {
  try {
    const threadId = Number(req.params.threadId);
    if (!Number.isFinite(threadId)) return res.status(400).json({ error: 'Invalid threadId' });
    const result = await markThreadRead(
      req.params.visitId,
      threadId,
      req.hubUser.id,
      req.hubRank,
      req.body?.lastMessageId,
    );

    await broadcastChat(req.params.visitId, async (user) => {
      const rank = await resolveRank(user, req.params.visitId);
      const hubUser = await resolveHubUser(user);
      const threads = await listThreads(req.params.visitId, hubUser.id, rank);
      return {
        type: 'read',
        threadId,
        chatSummary: { unreadTotal: threads.unreadTotal, threadCount: threads.threads.length },
      };
    });

    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    if (err.message === 'Thread not found' || err.message === 'Message not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Invalid lastMessageId') return res.status(400).json({ error: err.message });
    console.error('[hub] chat read failed:', err.message);
    return res.status(500).json({ error: 'Failed to mark thread read' });
  }
});

router.get('/:visitId/tag-batch/preview', requireAuth, requireTagBatchAccess, async (req, res) => {
  try {
    // Reps see only their assigned aisles; leads/supervisors see everything.
    const restrictToAisleKeys = req.hubRank >= 2 ? null : req.assignedAisleKeys;
    const preview = await getTagBatchPreview(req.params.visitId, { restrictToAisleKeys });
    return res.json({
      ...preview,
      myRank: req.hubRank,
      myAssignedAisleKeys: req.assignedAisleKeys,
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] tag-batch preview failed:', err.message);
    return res.status(500).json({ error: 'Failed to load tag batch preview' });
  }
});

router.get('/:visitId/tag-batch/assignments', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const assignments = await getAisleAssignments(req.params.visitId);
    return res.json({ visitId: parseVisitId(req.params.visitId), assignments });
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch assignments failed:', err.message);
    return res.status(500).json({ error: 'Failed to load aisle assignments' });
  }
});

router.post('/:visitId/tag-batch/assign', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const result = await assignAisleSweep(req.params.visitId, req.hubUser, {
      aisleKey: req.body?.aisleKey,
      aisleLabel: req.body?.aisleLabel,
      assigneeId: req.body?.assigneeId,
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch assign failed:', err.message);
    return res.status(500).json({ error: 'Failed to assign aisle sweep' });
  }
});

router.post('/:visitId/tag-batch/unassign', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const result = await unassignAisleSweep(req.params.visitId, req.hubUser, {
      aisleKey: req.body?.aisleKey,
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch unassign failed:', err.message);
    return res.status(500).json({ error: 'Failed to unassign aisle sweep' });
  }
});

router.post('/:visitId/tag-batch/sweep-tag', requireAuth, requireTagBatchAccess, async (req, res) => {
  try {
    const aisleKey = String(req.body?.aisleKey ?? '').trim();
    const allowed = await canWorkAisle(req.params.visitId, req.hubRank, req.hubUser.id, aisleKey);
    if (!allowed) {
      return res.status(403).json({ error: 'That aisle is assigned to someone else' });
    }
    const result = await addSweepTag(req.params.visitId, req.hubUser, {
      upc: req.body?.upc,
      description: req.body?.description,
      location: req.body?.location,
      aisleKey: req.body?.aisleKey,
      aisleLabel: req.body?.aisleLabel,
      lane: req.body?.lane,
      dbkey: req.body?.dbkey,
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch sweep-tag failed:', err.message);
    return res.status(500).json({ error: 'Failed to add sweep tag' });
  }
});

router.delete('/:visitId/tag-batch/tag/:tagId', requireAuth, requireTagBatchAccess, async (req, res) => {
  try {
    const result = await removePendingTag(
      req.params.visitId,
      req.hubRank,
      req.hubUser.id,
      req.params.tagId,
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-batch remove tag failed:', err.message);
    return res.status(500).json({ error: 'Failed to remove pending tag' });
  }
});

router.post('/:visitId/sections/:dbkey/aisle-designation', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const result = await setSectionAisleDesignation(
      req.params.visitId,
      req.params.dbkey,
      laneFromRequest(req),
      {
        preset: req.body?.preset,
        custom: req.body?.custom,
      },
      req.hubUser,
    );
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || 'Failed to save aisle designation' });
    }
    return res.json(result);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] aisle-designation failed:', err.message);
    return res.status(500).json({ error: 'Failed to save aisle designation' });
  }
});

router.post('/:visitId/send-tag-batch', requireAuth, requireTagBatchAccess, async (req, res) => {
  try {
    const aisleKey = String(req.body?.aisleKey ?? '').trim();
    let result;
    if (aisleKey) {
      const allowed = await canWorkAisle(req.params.visitId, req.hubRank, req.hubUser.id, aisleKey);
      if (!allowed) {
        return res.status(403).json({ error: 'That aisle is assigned to someone else' });
      }
      result = await sendTagBatchForAisle(req.params.visitId, req.hubUser, aisleKey);
    } else {
      // Send-all is lead/supervisor only.
      if (req.hubRank < 2) {
        return res.status(400).json({ error: 'aisleKey is required' });
      }
      result = await sendTagBatch(req.params.visitId, req.hubUser);
    }
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error || 'Tag batch send failed' });
    }
    return res.json({
      ok: true,
      count: result.count,
      aisleLabel: result.aisleLabel,
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
      { ...(req.body || {}), lane: laneFromRequest(req) },
    );
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
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

router.post('/:visitId/sections/:dbkey/tag-drafts/submit-and-send', requireAuth, attachHubContext, async (req, res) => {
  try {
    const submitResult = await submitSectionTagDrafts(
      req.params.visitId,
      req.params.dbkey,
      req.hubUser,
    );
    if (!submitResult.ok) {
      return res.status(submitResult.status || 400).json({ error: submitResult.error || 'Failed to submit tag drafts' });
    }

    const sendResult = await sendTagBatchForTagIds(
      req.params.visitId,
      req.hubUser,
      submitResult.tagIds || [],
    );
    if (!sendResult.ok) {
      return res.status(sendResult.status || 500).json({ error: sendResult.error || 'Tag print send failed' });
    }

    return res.json({
      ok: true,
      submitted: submitResult.count || 0,
      printed: sendResult.count || 0,
      resendId: sendResult.resendId,
      recipients: sendResult.recipients,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] tag-drafts submit-and-send failed:', err.message);
    return res.status(500).json({ error: 'Failed to submit and send tag drafts' });
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
         AND pa.action_type <> 'missing_tag'
       ORDER BY pa.raised_at ASC`,
      [visitIdNum],
    );

    const items = await Promise.all(rows.map(async (row) => {
      const photos = await listPendingPhotos(visitIdNum, row.id);
      return {
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
        photos: photos.map((p) => ({
          id: p.id,
          content_type: p.content_type,
          url: `/api/hub/${visitIdNum}/pending/${row.id}/photos/${p.id}/image`,
        })),
      };
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

router.get('/:visitId/pending/:id/photos/:photoId/image', requireAuth, requireHubRank(2), async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const pendingId = Number(req.params.id);
    const photoId = Number(req.params.photoId);
    if (!Number.isFinite(pendingId) || !Number.isFinite(photoId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const row = await loadPendingPhotoRow(visitIdNum, pendingId, photoId);
    if (!row) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    const buf = Buffer.from(row.photo_base64, 'base64');
    res.set('Content-Type', row.content_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(buf);
  } catch (err) {
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] pending photo image failed:', err.message);
    return res.status(500).json({ error: 'Failed to load photo' });
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
    let verifiedPending = null;

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

      if (pending.action_type === 'help_request') {
        await restoreSectionState(
          visitIdNum,
          pending.dbkey,
          pending.lane || payload.lane || '',
          payload.prior_state,
        );
      } else if (pending.action_type === 'nis') {
        await upsertSectionState(visitIdNum, pending.dbkey, pending.lane || payload.lane || '', {
          state: 'not_in_store',
        });
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

      verifiedPending = pending;
    });

    let emailResult = null;
    const flagPhotoAttachments = verifiedPending
      ? await loadPendingPhotosForEmail(visitIdNum, pendingId)
      : [];
    if (verifiedPending?.action_type === 'nis') {
      const payload = verifiedPending.payload || {};
      emailResult = await sendNisVerifiedEmail({
        visitId: req.params.visitId,
        dbkey: verifiedPending.dbkey,
        lane: verifiedPending.lane || payload.lane || '',
        payload,
        raiserName: verifiedPending.raised_by_name,
        raiserEmail: verifiedPending.raised_by_email,
        verifier,
        attachments: flagPhotoAttachments,
      });
      if (!emailResult.sent) {
        return res.status(502).json({
          error: emailResult.error || 'Help desk notification email failed',
          emailSent: false,
          id: pendingId,
          status: 'verified',
        });
      }
    } else if (verifiedPending?.action_type === 'help_request') {
      const payload = verifiedPending.payload || {};
      emailResult = await sendHelpVerifiedEmail({
        visitId: req.params.visitId,
        dbkey: verifiedPending.dbkey,
        lane: verifiedPending.lane || payload.lane || '',
        payload,
        raiserName: verifiedPending.raised_by_name,
        raiserEmail: verifiedPending.raised_by_email,
        verifier,
        attachments: flagPhotoAttachments,
      });
      if (!emailResult.sent) {
        return res.status(502).json({
          error: emailResult.error || 'Help desk notification email failed',
          emailSent: false,
          id: pendingId,
          status: 'verified',
        });
      }
    }

    await broadcastVisit(req.params.visitId);
    if (verifiedPending?.action_type === 'nis' || verifiedPending?.action_type === 'help_request') {
      markVisitDirtyAndBackupNow(req.params.visitId).catch((err) => {
        console.error('[hub] nis verify backup failed:', err.message);
      });
    }
    return res.json({
      ok: true,
      id: pendingId,
      status: 'verified',
      emailSent: emailResult?.sent ?? false,
      resendId: emailResult?.resendId,
    });
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
  { email: 'd6ewa.supervisor@gmail.com', name: 'Supervisor Lead', standing_rank: 2 },
  { email: 'hub.rep.a@test.local', name: 'Rep Alex', standing_rank: 1 },
  { email: 'hub.rep.b@test.local', name: 'Rep Bailey', standing_rank: 1 },
  { email: 'hub.lead@test.local', name: 'Lead Casey', standing_rank: 1 },
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
    const storeNumber = await resolveStoreForVisit(visitIdNum);

    let rows;
    if (storeNumber) {
      const storeRoster = await query(
        `SELECT u.id, u.name, u.email, u.login_email, u.hub_invited_at, u.sas_user_id,
                u.standing_rank, a.store_role,
                e.email AS employee_email
         FROM hub_store_assignments a
         JOIN hub_users u ON u.id = a.user_id
         LEFT JOIN employees e ON e.sas_employee_id = u.sas_user_id
         WHERE a.store_number = $1 AND u.is_active = true
         ORDER BY
           CASE a.store_role WHEN 'lead' THEN 0 ELSE 1 END,
           u.name`,
        [storeNumber],
      );
      rows = storeRoster.rows;
    }

    if (!rows?.length) {
      const fallback = await query(
        `SELECT u.id, u.name, u.email, u.login_email, u.hub_invited_at, u.sas_user_id,
                u.standing_rank, u.standing_rank AS store_role,
                e.email AS employee_email
         FROM hub_users u
         LEFT JOIN employees e ON e.sas_employee_id = u.sas_user_id
         WHERE u.is_active = true
         ORDER BY u.name`,
      );
      rows = fallback.rows;
    }

    return res.json({
      visitId: visitIdNum,
      storeNumber: storeNumber || null,
      roster: rows.map((row) => {
        const rank = row.store_role === 'lead' ? 2
          : row.store_role === 'rep' ? 1
          : (Number(row.standing_rank) || 1);
        const invite = rosterInviteFields(row);
        return {
          id: row.id,
          name: row.name,
          rank,
          storeRole: row.store_role || null,
          emailOnFile: invite.emailOnFile,
          loginEmail: invite.loginEmail,
          needsInvite: invite.needsInvite,
          invitedAt: invite.invitedAt,
        };
      }),
      source: storeNumber ? 'store_assignments' : 'hub_users',
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] roster failed:', err.message);
    return res.status(500).json({ error: 'Failed to load roster' });
  }
});

router.post('/:visitId/team-invite', requireAuth, attachHubContext, async (req, res) => {
  try {
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const userId = Number(req.body?.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const useOnFileEmail = req.body?.useOnFileEmail === true
      || req.body?.sendToOnFile === true;
    const customEmail = (req.body?.customEmail || req.body?.email || '').trim();

    if (!useOnFileEmail && !customEmail) {
      return res.status(400).json({ error: 'Choose email on file or enter a custom email' });
    }

    const result = await sendTeamMemberInvite({
      visitId: req.params.visitId,
      userId,
      useOnFileEmail,
      customEmail,
      inviter: {
        id: req.hubUser.id,
        email: req.user.email,
        name: req.hubUser.name,
      },
    });

    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] team-invite failed:', err.message);
    return res.status(500).json({ error: 'Failed to send team invite' });
  }
});

router.post('/:visitId/sections/:dbkey/flag/help', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const note = req.body?.note ?? null;
    const issueTypeId = req.body?.issue_type_id ?? req.body?.issueTypeId ?? null;
    const issueTypeLabel = req.body?.issue_type_label ?? req.body?.issueTypeLabel ?? null;
    const issueDetails = req.body?.issue_details ?? req.body?.issueDetails ?? null;
    const customLabel = req.body?.custom_label ?? req.body?.customLabel ?? null;
    const raiser = req.hubUser;

    if (!issueTypeId || !issueTypeLabel) {
      return res.status(400).json({ error: 'Issue type is required' });
    }
    if (issueTypeId === 'custom' && !customLabel && !issueDetails) {
      return res.status(400).json({ error: 'Custom issue requires a summary and description' });
    }
    if (issueTypeId !== 'custom' && !issueDetails) {
      return res.status(400).json({ error: 'Issue details are required' });
    }

    // Validate any attached photos up front so a bad image never leaves a half-saved flag.
    let parsedPhotos;
    try {
      parsedPhotos = parsePhotoDataUrls(req.body?.photos);
    } catch (photoErr) {
      return res.status(photoErr.status || 400).json({ error: photoErr.message });
    }

    const visitIdNum = parseVisitId(visitId);
    const storeNumber = await resolveStoreForVisit(visitIdNum);
    const fixture = storeNumber ? lookupFixture({ storeNumber, lane, dbkey }) : null;
    const setName = req.body?.set_name ?? req.body?.setName ?? fixture?.name ?? null;
    const manifestPogId = req.body?.manifest_pog_id ?? req.body?.manifestPogId ?? fixture?.manifest_pog_id ?? null;
    const action = req.body?.action ?? fixture?.action ?? null;

    const pendingId = await applyTransition(visitId, async (visitIdNumInner) => {
      const priorState = await setNeedsAttention(visitIdNumInner, dbkey, lane);
      const payload = enrichNisPayload({
        note,
        prior_state: priorState,
        lane,
        summary: buildHelpFlagSummary({
          issueTypeId,
          issueTypeLabel,
          customLabel,
          setName,
          lane,
        }),
        issue_type_id: issueTypeId,
        issue_type_label: issueTypeLabel,
        issue_details: issueDetails,
        custom_label: customLabel,
        set_name: setName,
        manifest_pog_id: manifestPogId,
        action,
      }, fixture);

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, lane, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, $3, 'help_request', $4, $5)
         RETURNING id`,
        [visitIdNumInner, lane, dbkey, JSON.stringify(payload), raiser.id],
      );

      const id = inserted.rows[0].id;
      await insertPendingPhotos(visitIdNumInner, id, parsedPhotos, raiser.id);
      await writeAuditLog(visitIdNumInner, raiser.id, 'flag_raised', dbkey, {
        type: 'help_request',
        pending_id: id,
        issue_type_id: issueTypeId,
        photo_count: parsedPhotos.length,
        note,
      });
      return id;
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, pendingId, photoCount: parsedPhotos.length });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
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

    const lane = laneFromRequest(req);
    const result = await addSectionTagDraft(visitId, dbkey, req.hubUser, {
      upc,
      description,
      location,
      lane,
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
    if (err.status === 409) return res.status(409).json({ error: err.message });
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
    const setName = req.body?.set_name ?? req.body?.setName ?? null;
    const manifestPogId = req.body?.manifest_pog_id ?? req.body?.manifestPogId ?? null;
    const action = req.body?.action ?? null;
    const raiser = req.hubUser;

    let parsedPhotos;
    try {
      parsedPhotos = parsePhotoDataUrls(req.body?.photos);
    } catch (photoErr) {
      return res.status(photoErr.status || 400).json({ error: photoErr.message });
    }

    const pendingId = await applyTransition(visitId, async (visitIdNum) => {
      const priorState = await setNeedsAttention(visitIdNum, dbkey, lane);
      const payload = {
        note,
        prior_state: priorState,
        lane,
        summary: buildNisFlagSummary({
          setName,
          manifestPogId,
          action,
          dbkey,
          lane,
        }),
        set_name: setName,
        manifest_pog_id: manifestPogId,
        action,
      };

      const inserted = await query(
        `INSERT INTO pending_actions (visit_id, lane, dbkey, action_type, payload, raised_by)
         VALUES ($1, $2, $3, 'nis', $4, $5)
         RETURNING id`,
        [visitIdNum, lane, dbkey, JSON.stringify(payload), raiser.id],
      );

      const id = inserted.rows[0].id;
      await insertPendingPhotos(visitIdNum, id, parsedPhotos, raiser.id);
      await writeAuditLog(visitIdNum, raiser.id, 'flag_raised', dbkey, {
        type: 'nis',
        pending_id: id,
        photo_count: parsedPhotos.length,
        note,
      });
      return id;
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, pendingId, photoCount: parsedPhotos.length });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.message === 'Invalid visitId') return res.status(400).json({ error: err.message });
    console.error('[hub] flag/nis failed:', err.message);
    return res.status(500).json({ error: 'Failed to raise not-in-store flag' });
  }
});

router.post('/:visitId/sections/bulk-assign', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId } = req.params;
    const rank = req.hubRank ?? 1;
    if (rank < 2) {
      return res.status(403).json({ error: 'Lead or supervisor required' });
    }

    const assigneeId = Number(req.body?.assigneeId);
    if (!Number.isFinite(assigneeId)) {
      return res.status(400).json({ error: 'assigneeId is required' });
    }

    const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    if (!sections.length) {
      return res.status(400).json({ error: 'sections array is required' });
    }

    const actor = req.hubUser;
    const assignee = await loadHubUserById(assigneeId);
    if (!assignee || !assignee.is_active) {
      return res.status(400).json({ error: 'Unknown or inactive hub user' });
    }

    const results = { assigned: 0, skipped: 0, errors: [] };

    await applyTransition(visitId, async (visitIdNum) => {
      for (const item of sections) {
        const dbkey = String(item?.dbkey || '').trim();
        const lane = laneFromRequest({ body: { lane: item?.lane } });
        if (!dbkey) {
          results.skipped += 1;
          continue;
        }

        try {
          const section = await loadSectionRow(visitIdNum, dbkey, lane);
          if (!ASSIGNABLE_STATES.includes(section.state)) {
            results.skipped += 1;
            results.errors.push({ dbkey, lane, error: `State ${section.state}` });
            continue;
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
            bulk: true,
          });
          results.assigned += 1;
        } catch (err) {
          results.skipped += 1;
          results.errors.push({ dbkey, lane, error: err.message });
        }
      }
    });

    await broadcastVisit(visitId);
    return res.json({ ok: true, ...results });
  } catch (err) {
    return handleTransitionError(err, res, 'Failed to bulk assign sections');
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

router.get('/:visitId/sections/:dbkey/bay-photos', requireAuth, attachHubContext, async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const { dbkey } = req.params;
    const lane = laneFromRequest(req);
    const photos = await listBayPhotos(visitIdNum, dbkey, lane);
    return res.json({
      visitId: visitIdNum,
      dbkey,
      lane: lane || '',
      photos: photos.map((row) => ({
        bay_num: row.bay_num,
        updated_at: row.updated_at,
        url: `/api/hub/${visitIdNum}/sections/${encodeURIComponent(dbkey)}/bay-photos/${row.bay_num}/image?lane=${encodeURIComponent(lane || '')}`,
      })),
    });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] bay-photos list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load bay photos' });
  }
});

router.get('/:visitId/sections/:dbkey/bay-photos/:bayNum/image', requireAuth, async (req, res) => {
  try {
    const visitIdNum = parseVisitId(req.params.visitId);
    const { dbkey } = req.params;
    const bayNum = parseBayNum(req.params.bayNum);
    if (bayNum == null) {
      return res.status(400).json({ error: 'Invalid bay number' });
    }
    const lane = laneFromRequest(req);
    const row = await loadBayPhotoRow(visitIdNum, dbkey, lane, bayNum);
    if (!row) {
      return res.status(404).json({ error: 'Bay photo not found' });
    }
    const buf = Buffer.from(row.photo_base64, 'base64');
    res.set('Content-Type', row.content_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] bay-photo image failed:', err.message);
    return res.status(500).json({ error: 'Failed to load bay photo' });
  }
});

router.post('/:visitId/sections/:dbkey/bay-photos/:bayNum', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const bayNum = parseBayNum(req.params.bayNum);
    if (bayNum == null) {
      return res.status(400).json({ error: 'Invalid bay number' });
    }
    const lane = laneFromRequest(req);
    const actor = req.hubUser;
    const rank = req.hubRank ?? 1;
    const { dataUrl } = req.body || {};
    if (!dataUrl) {
      return res.status(400).json({ error: 'dataUrl is required' });
    }

    await applyTransition(visitId, async (visitIdNum) => {
      const section = await loadSectionRow(visitIdNum, dbkey, lane);
      if (section.state !== 'in_progress') {
        throw Object.assign(
          new Error('Bay photos can only be uploaded while the set is in progress'),
          { status: 409 },
        );
      }
      if (rank < 2 && section.assignee_id !== actor.id) {
        throw Object.assign(new Error('Not your assignment'), { status: 403 });
      }
      await upsertBayPhoto(visitIdNum, dbkey, lane, bayNum, dataUrl, actor.id);
      await writeAuditLog(visitIdNum, actor.id, 'bay_photo_uploaded', dbkey, {
        lane,
        bay_num: bayNum,
      });
    });

    await broadcastVisit(visitId);
    const visitIdNum = parseVisitId(visitId);
    return res.json({
      ok: true,
      bay_num: bayNum,
      url: `/api/hub/${visitIdNum}/sections/${encodeURIComponent(dbkey)}/bay-photos/${bayNum}/image?lane=${encodeURIComponent(lane || '')}`,
    });
  } catch (err) {
    if (err.status === 400 || err.status === 403 || err.status === 409 || err.status === 413) {
      return res.status(err.status).json({ error: err.message, missingBays: err.missingBays });
    }
    console.error('[hub] bay-photo upload failed:', err.message);
    return res.status(500).json({ error: 'Failed to save bay photo' });
  }
});

router.post('/:visitId/sections/:dbkey/mark-done', requireAuth, attachHubContext, async (req, res) => {
  try {
    const { visitId, dbkey } = req.params;
    const lane = laneFromRequest(req);
    const actor = req.hubUser;
    const rank = req.hubRank ?? 1;
    const bayNums = Array.isArray(req.body?.bayNums)
      ? req.body.bayNums.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

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

      await assertAllBayPhotosPresent(visitIdNum, dbkey, lane, bayNums);

      await updateSectionState(visitIdNum, dbkey, lane, {
        state: 'done_pending_signoff',
        completed_at: new Date(),
      });

      await writeAuditLog(visitIdNum, actor.id, 'marked_done', dbkey, {
        lane,
        prior_state: section.state,
        assignee_id: section.assignee_id,
        bay_count: bayNums.length,
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

    let prodDispatch = null;
    if (isProdDispatchEnabled()) {
      try {
        prodDispatch = await createProdDispatchRequest({
          visitIdNum: parseVisitId(visitId),
          lane,
          dbkey,
          actor,
        });
      } catch (err) {
        console.error('[hub] prod dispatch request failed:', err.message);
      }
    }

    return res.json({ ok: true, prodDispatch: prodDispatch ? { id: prodDispatch.request?.id, reviewUrl: prodDispatch.reviewUrl } : null });
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

      await clearBayPhotos(visitIdNum, dbkey, lane);

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
