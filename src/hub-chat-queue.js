// Checklane Hub — intelligent lead chat queue (rep work context + wait order).

const { query } = require('./lib/db');

const PRIORITY = {
  REQUEST_NEXT_SET: 1000,
  NEEDS_ATTENTION: 800,
  PENDING_SIGNOFF: 600,
  UNREAD_CHAT: 400,
};

function shortSetLabel(dbkey, lane) {
  const key = String(dbkey || '').trim();
  if (!key) return 'Set';
  const lanePart = String(lane || '').trim();
  if (lanePart) return `${lanePart} · ${key.length > 28 ? `${key.slice(0, 25)}…` : key}`;
  return key.length > 36 ? `${key.slice(0, 33)}…` : key;
}

function buildRepContext(rows) {
  const counts = {
    inProgress: 0,
    assigned: 0,
    needsAttention: 0,
    pendingSignoff: 0,
    signedOff: 0,
    notStarted: 0,
  };
  let currentSet = null;
  let currentUpdated = 0;

  for (const row of rows) {
    switch (row.state) {
      case 'in_progress':
        counts.inProgress += 1;
        break;
      case 'assigned':
        counts.assigned += 1;
        break;
      case 'needs_attention':
        counts.needsAttention += 1;
        break;
      case 'done_pending_signoff':
        counts.pendingSignoff += 1;
        break;
      case 'signed_off':
        counts.signedOff += 1;
        break;
      case 'not_started':
        counts.notStarted += 1;
        break;
      default:
        break;
    }
    if (row.state === 'in_progress') {
      const updated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      if (!currentSet || updated >= currentUpdated) {
        currentSet = { dbkey: row.dbkey, lane: row.lane || '', label: shortSetLabel(row.dbkey, row.lane) };
        currentUpdated = updated;
      }
    }
  }

  let status = 'between_sets';
  let statusLabel = 'Between sets';

  if (counts.inProgress > 0 && currentSet) {
    status = 'working';
    statusLabel = `Working on ${currentSet.label}`;
  } else if (counts.needsAttention > 0) {
    status = 'needs_attention';
    statusLabel = `${counts.needsAttention} set${counts.needsAttention === 1 ? '' : 's'} need attention`;
  } else if (counts.pendingSignoff > 0) {
    status = 'awaiting_signoff';
    statusLabel = `${counts.pendingSignoff} set${counts.pendingSignoff === 1 ? '' : 's'} awaiting sign-off`;
  } else if (counts.assigned > 0) {
    status = 'assigned_idle';
    statusLabel = `${counts.assigned} set${counts.assigned === 1 ? '' : 's'} assigned, not started`;
  } else if (counts.signedOff > 0 && counts.assigned === 0 && counts.inProgress === 0) {
    status = 'wrapped';
    statusLabel = 'Sets signed off';
  }

  return {
    status,
    statusLabel,
    currentSet,
    counts,
  };
}

async function loadRepWorkContexts(visitIdNum, repIds) {
  const ids = [...new Set(repIds.filter((id) => Number.isFinite(Number(id))))].map(Number);
  if (!ids.length) return new Map();

  const { rows } = await query(
    `SELECT assignee_id, dbkey, lane, state, updated_at
     FROM section_state
     WHERE visit_id = $1 AND assignee_id = ANY($2::int[])`,
    [visitIdNum, ids],
  );

  const byRep = new Map();
  for (const id of ids) byRep.set(id, []);
  for (const row of rows) {
    const list = byRep.get(row.assignee_id);
    if (list) list.push(row);
  }

  const contexts = new Map();
  for (const [repId, repRows] of byRep) {
    contexts.set(repId, buildRepContext(repRows));
  }
  return contexts;
}

async function loadUnreadSignals(visitIdNum, leadUserId, threadIds) {
  if (!threadIds.length) return new Map();

  const { rows } = await query(
    `SELECT m.thread_id,
            MIN(m.created_at) AS oldest_unread_at,
            BOOL_OR(m.message_type = 'request_next_set') AS has_request_next_set,
            COUNT(*)::int AS unread_count
     FROM hub_messages m
     LEFT JOIN hub_message_reads r ON r.thread_id = m.thread_id AND r.user_id = $1
     WHERE m.thread_id = ANY($2::int[])
       AND m.sender_id <> $1
       AND m.id > COALESCE(r.last_read_message_id, 0)
     GROUP BY m.thread_id`,
    [leadUserId, threadIds],
  );

  return new Map(rows.map((r) => [r.thread_id, {
    oldestUnreadAt: r.oldest_unread_at,
    hasRequestNextSet: !!r.has_request_next_set,
    unreadCount: r.unread_count,
  }]));
}

function waitingForLead(lastMessage, repId) {
  if (!lastMessage || !repId) return false;
  return Number(lastMessage.senderId) === Number(repId);
}

function priorityEntry({
  repId, repName, threadId, unreadCount, lastMessage, repContext, unreadSignals,
}) {
  const signals = unreadSignals || {};
  const needsLeadAttention = (unreadCount || 0) > 0;
  const isWaiting = waitingForLead(lastMessage, repId);
  const hasRequest = signals.hasRequestNextSet
    || (lastMessage && lastMessage.messageType === 'request_next_set' && isWaiting);

  let score = 0;
  if (hasRequest && needsLeadAttention) score += PRIORITY.REQUEST_NEXT_SET;
  if (repContext.counts.needsAttention > 0) score += PRIORITY.NEEDS_ATTENTION;
  if (repContext.counts.pendingSignoff > 0) score += PRIORITY.PENDING_SIGNOFF;
  if (needsLeadAttention) score += PRIORITY.UNREAD_CHAT;

  const oldestUnreadAt = signals.oldestUnreadAt
    || (isWaiting && lastMessage ? lastMessage.createdAt : null);

  let waitReason = 'New message';
  if (hasRequest && isWaiting) waitReason = 'Ready for next set';
  else if (repContext.status === 'awaiting_signoff') waitReason = 'Awaiting sign-off';
  else if (repContext.status === 'needs_attention') waitReason = 'Needs attention';

  return {
    repId,
    repName,
    threadId,
    queuePosition: null,
    priorityScore: score,
    oldestUnreadAt,
    needsLeadAttention,
    waitingForLead: isWaiting,
    waitReason,
    repContext,
    unreadCount: unreadCount || 0,
  };
}

function sortQueueEntries(entries) {
  return entries.slice().sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const ta = a.oldestUnreadAt ? new Date(a.oldestUnreadAt).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.oldestUnreadAt ? new Date(b.oldestUnreadAt).getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
}

/**
 * Enrich thread list with rep work context and lead queue ordering.
 * @returns {{ threads: object[], chatQueue: object|null, myQueueStatus: object|null }}
 */
async function enrichThreadsForVisit(visitIdNum, userId, rank, threads) {
  const repIds = threads.map((t) => t.repId).filter(Boolean);
  const repContexts = await loadRepWorkContexts(visitIdNum, repIds);

  const threadIds = threads.map((t) => t.id).filter(Boolean);
  const unreadSignals = rank >= 2
    ? await loadUnreadSignals(visitIdNum, userId, threadIds)
    : new Map();

  const queueCandidates = [];

  for (const thread of threads) {
    const repContext = repContexts.get(thread.repId) || buildRepContext([]);
    thread.repContext = repContext;
    thread.waitingForLead = waitingForLead(thread.lastMessage, thread.repId);

    if (rank >= 2 && thread.needsLeadAttention == null) {
      const signals = thread.id ? unreadSignals.get(thread.id) : null;
      thread.needsLeadAttention = (thread.unreadCount || 0) > 0;
      if (thread.needsLeadAttention) {
        queueCandidates.push(priorityEntry({
          repId: thread.repId,
          repName: thread.repName,
          threadId: thread.id,
          unreadCount: thread.unreadCount,
          lastMessage: thread.lastMessage,
          repContext,
          unreadSignals: signals,
        }));
      }
    }
  }

  let chatQueue = null;
  let myQueueStatus = null;

  if (rank >= 2 && queueCandidates.length) {
    const ordered = sortQueueEntries(queueCandidates);
    ordered.forEach((entry, idx) => {
      entry.queuePosition = idx + 1;
      const match = threads.find((t) => Number(t.repId) === Number(entry.repId));
      if (match) {
        match.queuePosition = entry.queuePosition;
        match.waitReason = entry.waitReason;
      }
    });
    chatQueue = {
      waitingCount: ordered.length,
      focusRepId: ordered[0]?.repId ?? null,
      focusRepName: ordered[0]?.repName ?? null,
      focusReason: ordered[0]?.waitReason ?? null,
      ordered: ordered.map((e) => ({
        repId: e.repId,
        repName: e.repName,
        threadId: e.threadId,
        queuePosition: e.queuePosition,
        waitReason: e.waitReason,
        unreadCount: e.unreadCount,
        repContext: e.repContext,
      })),
    };
  }

  return { threads, chatQueue, myQueueStatus };
}

/**
 * Compute queue position for a rep (requires full visit thread set).
 */
async function getRepQueueStatus(visitIdNum, repUserId, allThreads) {
  const repIds = allThreads.map((t) => t.repId).filter(Boolean);
  const repContexts = await loadRepWorkContexts(visitIdNum, repIds);

  const candidates = [];
  for (const thread of allThreads) {
    if (!thread.id || !waitingForLead(thread.lastMessage, thread.repId)) continue;
    const repContext = repContexts.get(thread.repId) || buildRepContext([]);
    const hasRequest = thread.lastMessage?.messageType === 'request_next_set';
    candidates.push(priorityEntry({
      repId: thread.repId,
      repName: thread.repName,
      threadId: thread.id,
      unreadCount: 1,
      lastMessage: thread.lastMessage,
      repContext,
      unreadSignals: {
        hasRequestNextSet: hasRequest,
        oldestUnreadAt: thread.lastMessage?.createdAt,
      },
    }));
  }

  const ordered = sortQueueEntries(candidates);
  ordered.forEach((entry, idx) => { entry.queuePosition = idx + 1; });

  const mine = ordered.find((e) => Number(e.repId) === Number(repUserId));
  const myThread = allThreads.find((t) => Number(t.repId) === Number(repUserId));
  const repContext = repContexts.get(repUserId) || buildRepContext([]);

  if (!mine) {
    return {
      waitingForLead: myThread ? waitingForLead(myThread.lastMessage, repUserId) : false,
      position: null,
      waitingCount: ordered.length,
      statusLabel: repContext.statusLabel,
      leadFocus: ordered[0]
        ? { repName: ordered[0].repName, reason: ordered[0].waitReason }
        : null,
    };
  }

  const ahead = mine.queuePosition - 1;
  let statusLabel = repContext.statusLabel;
  if (ahead > 0) {
    const focus = ordered[0];
    statusLabel = `#${mine.queuePosition} in line · ${focus.repName} is first (${focus.waitReason})`;
  } else if (mine.queuePosition === 1) {
    statusLabel = `You're first in line · ${repContext.statusLabel}`;
  }

  return {
    waitingForLead: true,
    position: mine.queuePosition,
    waitingCount: ordered.length,
    aheadCount: ahead,
    statusLabel,
    repContext,
    leadFocus: ordered[0] && ordered[0].queuePosition !== mine.queuePosition
      ? { repName: ordered[0].repName, reason: ordered[0].waitReason }
      : null,
  };
}

module.exports = {
  buildRepContext,
  loadRepWorkContexts,
  enrichThreadsForVisit,
  getRepQueueStatus,
  waitingForLead,
  shortSetLabel,
};
