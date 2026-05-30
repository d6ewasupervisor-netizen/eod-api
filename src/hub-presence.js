// Checklane Hub — in-memory live presence (who is on which page/store).

const STALE_MS = 90_000;

/** @type {Map<string, object>} */
const sessionsById = new Map();

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function touchSession(sessionId, data) {
  const id = String(sessionId || '').trim();
  if (!id || id.length > 128) return null;

  const now = Date.now();
  const existing = sessionsById.get(id);
  const row = {
    sessionId: id,
    email: normalizeEmail(data.email),
    name: (data.name || '').trim() || null,
    hubUserId: data.hubUserId ?? null,
    page: (data.page || 'unknown').slice(0, 64),
    storeNumber: data.storeNumber ? String(data.storeNumber) : null,
    visitId: data.visitId != null ? String(data.visitId) : null,
    view: data.view ? String(data.view).slice(0, 64) : null,
    detail: data.detail ? String(data.detail).slice(0, 120) : null,
    since: existing?.since || new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    lastSeenMs: now,
  };

  sessionsById.set(id, row);
  return row;
}

function removeSession(sessionId) {
  sessionsById.delete(String(sessionId || '').trim());
}

function pruneStale(nowMs = Date.now()) {
  for (const [id, row] of sessionsById) {
    if (nowMs - row.lastSeenMs > STALE_MS) sessionsById.delete(id);
  }
}

function listSessions() {
  pruneStale();
  return [...sessionsById.values()]
    .sort((a, b) => {
      const pageCmp = (a.page || '').localeCompare(b.page || '');
      if (pageCmp) return pageCmp;
      const storeCmp = (a.storeNumber || '').localeCompare(b.storeNumber || '');
      if (storeCmp) return storeCmp;
      return (a.email || '').localeCompare(b.email || '');
    })
    .map(({ lastSeenMs, ...rest }) => rest);
}

module.exports = {
  touchSession,
  removeSession,
  listSessions,
  STALE_MS,
};
