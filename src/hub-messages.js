// Checklane Hub — visit-scoped rep ↔ lead/supervisor messaging.

const { query } = require('./lib/db');
const { parseVisitId } = require('./hub-auth');
const { resolveStoreForVisit } = require('./lib/hub-fixture-catalog');
const { enrichThreadsForVisit, getRepQueueStatus } = require('./hub-chat-queue');

const MAX_BODY_LENGTH = 2000;
const DEFAULT_MESSAGE_LIMIT = 100;

function trimBody(body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Message body required');
  if (text.length > MAX_BODY_LENGTH) {
    throw new Error(`Message too long (max ${MAX_BODY_LENGTH} characters)`);
  }
  return text;
}

async function ensureThread(visitIdNum, repId) {
  const existing = await query(
    `SELECT id, visit_id, rep_id, created_at
     FROM hub_message_threads
     WHERE visit_id = $1 AND rep_id = $2`,
    [visitIdNum, repId],
  );
  if (existing.rows.length) return existing.rows[0];

  const inserted = await query(
    `INSERT INTO hub_message_threads (visit_id, rep_id)
     VALUES ($1, $2)
     RETURNING id, visit_id, rep_id, created_at`,
    [visitIdNum, repId],
  );
  return inserted.rows[0];
}

async function loadThreadForVisit(threadId, visitIdNum) {
  const { rows } = await query(
    `SELECT t.id, t.visit_id, t.rep_id, t.created_at, hu.name AS rep_name
     FROM hub_message_threads t
     JOIN hub_users hu ON hu.id = t.rep_id
     WHERE t.id = $1 AND t.visit_id = $2`,
    [threadId, visitIdNum],
  );
  return rows[0] || null;
}

function canAccessThread(rank, userId, thread) {
  if (!thread) return false;
  if (rank >= 2) return true;
  return thread.rep_id === userId;
}

async function listRecipients(visitId, userId, rank) {
  const visitIdNum = parseVisitId(visitId);
  const storeNumber = await resolveStoreForVisit(visitIdNum);
  let rows = [];

  if (storeNumber) {
    const result = await query(
      `SELECT u.id, u.name, a.store_role
       FROM hub_store_assignments a
       JOIN hub_users u ON u.id = a.user_id
       WHERE a.store_number = $1 AND u.is_active = true
       ORDER BY u.name`,
      [storeNumber],
    );
    rows = result.rows;
  }

  if (!rows.length) {
    const fallback = await query(
      `SELECT id, name, standing_rank AS store_role
       FROM hub_users
       WHERE is_active = true
       ORDER BY name`,
    );
    rows = fallback.rows;
  }

  const toRank = (row) => {
    if (row.store_role === 'lead') return 2;
    if (row.store_role === 'rep') return 1;
    return Number(row.standing_rank) || 1;
  };

  const recipients = [];
  for (const row of rows) {
    const personRank = toRank(row);
    if (Number(row.id) === Number(userId)) continue;

    if (rank >= 2) {
      if (personRank < 2) {
        recipients.push({
          id: row.id,
          name: row.name,
          role: 'rep',
          roleLabel: 'Rep',
        });
      }
    } else if (personRank >= 2) {
      recipients.push({
        id: row.id,
        name: row.name,
        role: personRank >= 3 ? 'supervisor' : 'lead',
        roleLabel: personRank >= 3 ? 'Supervisor' : 'Lead',
      });
    }
  }

  recipients.sort((a, b) => a.name.localeCompare(b.name));
  return { recipients };
}

async function listThreads(visitId, userId, rank) {
  const visitIdNum = parseVisitId(visitId);

  let threadRows;
  if (rank >= 2) {
    const result = await query(
      `SELECT t.id, t.rep_id, t.created_at, hu.name AS rep_name
       FROM hub_message_threads t
       JOIN hub_users hu ON hu.id = t.rep_id
       WHERE t.visit_id = $1`,
      [visitIdNum],
    );
    threadRows = result.rows;

    const storeNumber = await resolveStoreForVisit(visitIdNum);
    if (storeNumber) {
      const rosterResult = await query(
        `SELECT u.id AS rep_id, u.name AS rep_name
         FROM hub_store_assignments a
         JOIN hub_users u ON u.id = a.user_id
         WHERE a.store_number = $1 AND a.store_role = 'rep' AND u.is_active = true`,
        [storeNumber],
      );
      const byRep = new Map(threadRows.map((r) => [r.rep_id, r]));
      for (const rep of rosterResult.rows) {
        if (!byRep.has(rep.rep_id)) {
          threadRows.push({ id: null, rep_id: rep.rep_id, rep_name: rep.rep_name, created_at: null });
        }
      }
      threadRows.sort((a, b) => (a.rep_name || '').localeCompare(b.rep_name || ''));
    }
  } else {
    const thread = await ensureThread(visitIdNum, userId);
    const result = await query(
      `SELECT t.id, t.rep_id, t.created_at, hu.name AS rep_name
       FROM hub_message_threads t
       JOIN hub_users hu ON hu.id = t.rep_id
       WHERE t.id = $1`,
      [thread.id],
    );
    threadRows = result.rows;
  }

  if (!threadRows.length) {
    return { threads: [], unreadTotal: 0 };
  }

  const threadIds = threadRows.map((r) => r.id).filter(Boolean);
  const lastMsgResult = threadIds.length
    ? await query(
      `SELECT DISTINCT ON (m.thread_id)
              m.thread_id, m.id AS message_id, m.body, m.message_type, m.sender_id,
              m.created_at, su.name AS sender_name
       FROM hub_messages m
       JOIN hub_users su ON su.id = m.sender_id
       WHERE m.thread_id = ANY($1::int[])
       ORDER BY m.thread_id, m.id DESC`,
      [threadIds],
    )
    : { rows: [] };

  const unreadResult = threadIds.length
    ? await query(
      `SELECT m.thread_id, COUNT(*)::int AS cnt
       FROM hub_messages m
       LEFT JOIN hub_message_reads r ON r.thread_id = m.thread_id AND r.user_id = $1
       WHERE m.thread_id = ANY($2::int[])
         AND m.sender_id <> $1
         AND m.id > COALESCE(r.last_read_message_id, 0)
       GROUP BY m.thread_id`,
      [userId, threadIds],
    )
    : { rows: [] };

  const lastByThread = new Map(lastMsgResult.rows.map((r) => [r.thread_id, r]));
  const unreadByThread = new Map(unreadResult.rows.map((r) => [r.thread_id, r.cnt]));

  let unreadTotal = 0;
  const threads = [];

  for (const row of threadRows) {
    const last = row.id ? lastByThread.get(row.id) : null;
    const unreadCount = row.id ? (unreadByThread.get(row.id) || 0) : 0;
    unreadTotal += unreadCount;

    threads.push({
      id: row.id,
      repId: row.rep_id,
      repName: row.rep_name,
      unreadCount,
      lastMessage: last
        ? {
            id: last.message_id,
            body: last.body,
            messageType: last.message_type,
            senderId: last.sender_id,
            senderName: last.sender_name,
            createdAt: last.created_at.toISOString(),
          }
        : null,
    });
  }

  threads.sort((a, b) => {
    const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
    const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
    return tb - ta;
  });

  const enriched = await enrichThreadsForVisit(visitIdNum, userId, rank, threads);
  let myQueueStatus = null;

  if (rank < 2) {
    const allForQueue = await loadLeadThreadSummaries(visitIdNum);
    myQueueStatus = await getRepQueueStatus(visitIdNum, userId, allForQueue);
    const mine = enriched.threads.find((t) => Number(t.repId) === Number(userId)) || enriched.threads[0];
    if (mine) {
      mine.waitingForLead = myQueueStatus.waitingForLead;
      if (myQueueStatus.position != null) mine.queuePosition = myQueueStatus.position;
    }
  }

  return {
    threads: enriched.threads,
    unreadTotal,
    chatQueue: enriched.chatQueue,
    myQueueStatus,
  };
}

/** All rep threads on a visit (for rep-side queue position). */
async function loadLeadThreadSummaries(visitIdNum) {
  const result = await query(
    `SELECT t.id, t.rep_id, t.created_at, hu.name AS rep_name
     FROM hub_message_threads t
     JOIN hub_users hu ON hu.id = t.rep_id
     WHERE t.visit_id = $1`,
    [visitIdNum],
  );
  const threadRows = result.rows;
  if (!threadRows.length) return [];

  const threadIds = threadRows.map((r) => r.id).filter(Boolean);
  const lastMsgResult = await query(
    `SELECT DISTINCT ON (m.thread_id)
            m.thread_id, m.id AS message_id, m.body, m.message_type, m.sender_id,
            m.created_at, su.name AS sender_name
     FROM hub_messages m
     JOIN hub_users su ON su.id = m.sender_id
     WHERE m.thread_id = ANY($1::int[])
     ORDER BY m.thread_id, m.id DESC`,
    [threadIds],
  );
  const lastByThread = new Map(lastMsgResult.rows.map((r) => [r.thread_id, r]));

  return threadRows.map((row) => {
    const last = lastByThread.get(row.id);
    return {
      id: row.id,
      repId: row.rep_id,
      repName: row.rep_name,
      unreadCount: 0,
      lastMessage: last
        ? {
            id: last.message_id,
            body: last.body,
            messageType: last.message_type,
            senderId: last.sender_id,
            senderName: last.sender_name,
            createdAt: last.created_at.toISOString(),
          }
        : null,
    };
  });
}

async function getThreadMessages(visitId, threadId, userId, rank, options = {}) {
  const visitIdNum = parseVisitId(visitId);
  const thread = await loadThreadForVisit(threadId, visitIdNum);
  if (!canAccessThread(rank, userId, thread)) {
    throw new Error('Thread not found');
  }

  const limit = Math.min(Number(options.limit) || DEFAULT_MESSAGE_LIMIT, 200);
  const { rows } = await query(
    `SELECT m.id, m.body, m.dbkey, m.message_type, m.sender_id, m.recipient_id, m.created_at,
            hu.name AS sender_name,
            ru.name AS recipient_name
     FROM hub_messages m
     JOIN hub_users hu ON hu.id = m.sender_id
     LEFT JOIN hub_users ru ON ru.id = m.recipient_id
     WHERE m.thread_id = $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [threadId, limit],
  );

  const messages = rows.reverse().map((row) => ({
    id: row.id,
    body: row.body,
    dbkey: row.dbkey,
    messageType: row.message_type,
    senderId: row.sender_id,
    senderName: row.sender_name,
    recipientId: row.recipient_id,
    recipientName: row.recipient_name || null,
    createdAt: row.created_at.toISOString(),
  }));

  return {
    thread: {
      id: thread.id,
      repId: thread.rep_id,
      repName: thread.rep_name,
    },
    messages,
  };
}

async function sendMessage(visitId, {
  senderId, rank, body, threadId, repId, recipientId, dbkey, messageType,
}) {
  const visitIdNum = parseVisitId(visitId);
  const text = trimBody(body);
  const type = messageType === 'request_next_set' ? 'request_next_set' : 'chat';
  const recipientNum = recipientId != null ? Number(recipientId) : null;
  if (!Number.isFinite(recipientNum) || recipientNum < 1) {
    throw new Error('Recipient required');
  }

  const { recipients } = await listRecipients(visitId, senderId, rank);
  const allowed = recipients.some((r) => Number(r.id) === recipientNum);
  if (!allowed) {
    throw new Error('Invalid recipient');
  }

  let thread;
  if (threadId) {
    thread = await loadThreadForVisit(threadId, visitIdNum);
    if (!canAccessThread(rank, senderId, thread)) {
      throw new Error('Thread not found');
    }
  } else if (rank >= 2) {
    thread = await ensureThread(visitIdNum, recipientNum);
    thread = await loadThreadForVisit(thread.id, visitIdNum);
  } else if (rank < 2) {
    thread = await ensureThread(visitIdNum, senderId);
    thread = await loadThreadForVisit(thread.id, visitIdNum);
  } else {
    throw new Error('repId or threadId required');
  }

  const { rows: recipientRows } = await query(
    `SELECT id, name FROM hub_users WHERE id = $1 AND is_active = true`,
    [recipientNum],
  );
  if (!recipientRows.length) {
    throw new Error('Recipient not found');
  }

  const { rows } = await query(
    `INSERT INTO hub_messages (thread_id, sender_id, recipient_id, body, dbkey, message_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, thread_id, sender_id, recipient_id, body, dbkey, message_type, created_at`,
    [thread.id, senderId, recipientNum, text, dbkey || null, type],
  );
  const msg = rows[0];

  const { rows: senderRows } = await query(
    `SELECT name FROM hub_users WHERE id = $1`,
    [senderId],
  );

  return {
    message: {
      id: msg.id,
      threadId: msg.thread_id,
      body: msg.body,
      dbkey: msg.dbkey,
      messageType: msg.message_type,
      senderId: msg.sender_id,
      senderName: senderRows[0]?.name || 'User',
      recipientId: msg.recipient_id,
      recipientName: recipientRows[0]?.name || null,
      createdAt: msg.created_at.toISOString(),
    },
    thread: {
      id: thread.id,
      repId: thread.rep_id,
      repName: thread.rep_name,
    },
  };
}

async function markThreadRead(visitId, threadId, userId, rank, lastMessageId) {
  const visitIdNum = parseVisitId(visitId);
  const thread = await loadThreadForVisit(threadId, visitIdNum);
  if (!canAccessThread(rank, userId, thread)) {
    throw new Error('Thread not found');
  }

  const msgId = Number(lastMessageId);
  if (!Number.isFinite(msgId) || msgId < 1) {
    throw new Error('Invalid lastMessageId');
  }

  const { rows: msgRows } = await query(
    `SELECT id FROM hub_messages WHERE id = $1 AND thread_id = $2`,
    [msgId, threadId],
  );
  if (!msgRows.length) {
    throw new Error('Message not found');
  }

  await query(
    `INSERT INTO hub_message_reads (thread_id, user_id, last_read_message_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (thread_id, user_id)
     DO UPDATE SET last_read_message_id = GREATEST(
       hub_message_reads.last_read_message_id, EXCLUDED.last_read_message_id
     ), updated_at = now()`,
    [threadId, userId, msgId],
  );

  return { ok: true };
}

async function getChatSummary(visitId, userId, rank) {
  const { threads, unreadTotal, chatQueue, myQueueStatus } = await listThreads(visitId, userId, rank);
  return {
    unreadTotal,
    threadCount: threads.length,
    queueWaitingCount: chatQueue?.waitingCount ?? myQueueStatus?.waitingCount ?? 0,
    myQueuePosition: myQueueStatus?.position ?? null,
  };
}

module.exports = {
  listThreads,
  listRecipients,
  getThreadMessages,
  sendMessage,
  markThreadRead,
  getChatSummary,
  ensureThread,
};
