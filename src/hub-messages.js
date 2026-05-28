// Checklane Hub — visit-scoped rep ↔ lead/supervisor messaging.

const { query } = require('./lib/db');
const { parseVisitId } = require('./hub-auth');
const { resolveStoreForVisit } = require('./lib/hub-fixture-catalog');

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

  return { threads, unreadTotal };
}

async function getThreadMessages(visitId, threadId, userId, rank, options = {}) {
  const visitIdNum = parseVisitId(visitId);
  const thread = await loadThreadForVisit(threadId, visitIdNum);
  if (!canAccessThread(rank, userId, thread)) {
    throw new Error('Thread not found');
  }

  const limit = Math.min(Number(options.limit) || DEFAULT_MESSAGE_LIMIT, 200);
  const { rows } = await query(
    `SELECT m.id, m.body, m.dbkey, m.message_type, m.sender_id, m.created_at,
            hu.name AS sender_name
     FROM hub_messages m
     JOIN hub_users hu ON hu.id = m.sender_id
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

async function sendMessage(visitId, { senderId, rank, body, threadId, repId, dbkey, messageType }) {
  const visitIdNum = parseVisitId(visitId);
  const text = trimBody(body);
  const type = messageType === 'request_next_set' ? 'request_next_set' : 'chat';

  let thread;
  if (threadId) {
    thread = await loadThreadForVisit(threadId, visitIdNum);
    if (!canAccessThread(rank, senderId, thread)) {
      throw new Error('Thread not found');
    }
  } else if (rank >= 2 && repId) {
    thread = await ensureThread(visitIdNum, repId);
    thread = await loadThreadForVisit(thread.id, visitIdNum);
  } else if (rank < 2) {
    thread = await ensureThread(visitIdNum, senderId);
    thread = await loadThreadForVisit(thread.id, visitIdNum);
  } else {
    throw new Error('repId or threadId required');
  }

  const { rows } = await query(
    `INSERT INTO hub_messages (thread_id, sender_id, body, dbkey, message_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, thread_id, sender_id, body, dbkey, message_type, created_at`,
    [thread.id, senderId, text, dbkey || null, type],
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
  const { threads, unreadTotal } = await listThreads(visitId, userId, rank);
  return { unreadTotal, threadCount: threads.length };
}

module.exports = {
  listThreads,
  getThreadMessages,
  sendMessage,
  markThreadRead,
  getChatSummary,
  ensureThread,
};
