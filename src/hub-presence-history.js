// Checklane Hub — persisted presence history (location segments per session).

const { query } = require('./lib/db');
const { STALE_MS } = require('./hub-presence');

const DEFAULT_HISTORY_HOURS = 72;
const MAX_HISTORY_HOURS = 168;
const DEFAULT_HISTORY_LIMIT = 150;
const MAX_HISTORY_LIMIT = 500;

function locationKey(row) {
  return [
    row.page || '',
    row.storeNumber || row.store_number || '',
    row.visitId != null ? row.visitId : (row.visit_id != null ? row.visit_id : ''),
    row.view || '',
    row.detail || '',
  ].join('|');
}

function rowLocationKey(row) {
  return locationKey({
    page: row.page,
    store_number: row.store_number,
    visit_id: row.visit_id,
    view: row.view,
    detail: row.detail,
  });
}

async function closeStaleOpenSegments() {
  const staleSeconds = Math.ceil(STALE_MS / 1000);
  await query(
    `UPDATE hub_presence_history
     SET ended_at = last_seen_at
     WHERE ended_at IS NULL
       AND last_seen_at < now() - ($1 || ' seconds')::interval`,
    [String(staleSeconds)],
  );
}

async function insertSegment(session) {
  const lastSeen = session.lastSeen || new Date().toISOString();
  const startedAt = session.since || lastSeen;
  await query(
    `INSERT INTO hub_presence_history (
       session_id, hub_user_id, email, name, page, store_number,
       visit_id, view, detail, started_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      session.sessionId,
      session.hubUserId ?? null,
      session.email,
      session.name || null,
      session.page || null,
      session.storeNumber || null,
      session.visitId != null ? Number(session.visitId) : null,
      session.view || null,
      session.detail || null,
      startedAt,
      lastSeen,
    ],
  );
}

async function recordPresenceHistory(session) {
  if (!session?.sessionId || !session.email) return;

  await closeStaleOpenSegments();

  const { rows } = await query(
    `SELECT id, page, store_number, visit_id, view, detail, started_at
     FROM hub_presence_history
     WHERE session_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1`,
    [session.sessionId],
  );

  const open = rows[0];
  const newKey = locationKey(session);

  if (!open) {
    await insertSegment(session);
    return;
  }

  if (newKey !== rowLocationKey(open)) {
    const lastSeen = session.lastSeen || new Date().toISOString();
    await query(
      `UPDATE hub_presence_history
       SET ended_at = $2, last_seen_at = $2
       WHERE id = $1`,
      [open.id, lastSeen],
    );
    await insertSegment({
      ...session,
      since: lastSeen,
    });
    return;
  }

  await query(
    `UPDATE hub_presence_history
     SET last_seen_at = $2,
         name = COALESCE($3, name),
         hub_user_id = COALESCE($4, hub_user_id)
     WHERE id = $1`,
    [
      open.id,
      session.lastSeen || new Date().toISOString(),
      session.name || null,
      session.hubUserId ?? null,
    ],
  );
}

async function closeSessionHistory(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  await query(
    `UPDATE hub_presence_history
     SET ended_at = last_seen_at
     WHERE session_id = $1 AND ended_at IS NULL`,
    [id],
  );
}

function clampHistoryHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_HOURS;
  return Math.min(Math.round(n), MAX_HISTORY_HOURS);
}

function clampHistoryLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.round(n), MAX_HISTORY_LIMIT);
}

async function listPresenceHistory(options = {}) {
  await closeStaleOpenSegments();

  const hours = clampHistoryHours(options.hours);
  const limit = clampHistoryLimit(options.limit);
  const storeNumber = options.storeNumber
    ? String(options.storeNumber).replace(/\D/g, '') || null
    : null;
  const email = (options.email || '').trim().toLowerCase() || null;

  const params = [hours];
  let where = `h.started_at >= now() - ($1::int * interval '1 hour')`;

  if (storeNumber) {
    params.push(storeNumber);
    where += ` AND h.store_number = $${params.length}`;
  }
  if (email) {
    params.push(email);
    where += ` AND lower(h.email) = $${params.length}`;
  }

  params.push(limit);
  const limitIdx = params.length;

  const { rows } = await query(
    `SELECT
       h.id,
       h.session_id,
       h.hub_user_id,
       h.email,
       h.name,
       h.page,
       h.store_number,
       h.visit_id,
       h.view,
       h.detail,
       h.started_at,
       h.ended_at,
       h.last_seen_at,
       hs.name AS store_name
     FROM hub_presence_history h
     LEFT JOIN hub_stores hs ON hs.store_number = h.store_number
     WHERE ${where}
     ORDER BY h.started_at DESC
     LIMIT $${limitIdx}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    hubUserId: row.hub_user_id,
    email: row.email,
    name: row.name,
    page: row.page,
    storeNumber: row.store_number,
    storeName: row.store_name || (row.store_number
      ? `Store ${String(row.store_number).padStart(5, '0')}`
      : null),
    visitId: row.visit_id != null ? String(row.visit_id) : null,
    view: row.view,
    detail: row.detail,
    startedAt: row.started_at?.toISOString?.() || row.started_at,
    endedAt: row.ended_at?.toISOString?.() || row.ended_at || null,
    lastSeenAt: row.last_seen_at?.toISOString?.() || row.last_seen_at,
    isOpen: !row.ended_at,
  }));
}

module.exports = {
  recordPresenceHistory,
  closeSessionHistory,
  listPresenceHistory,
  closeStaleOpenSegments,
};
