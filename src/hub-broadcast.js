// Checklane Hub — SSE broadcast of per-client snapshots after mutations.

const { getSnapshot } = require('./hub-state');
const { parseVisitId } = require('./hub-auth');

/** @type {Map<string, Set<{ res: import('express').Response, user: object }>>} */
const subscribersByVisit = new Map();

function addSubscriber(visitId, res, user) {
  const key = String(parseVisitId(visitId));
  const entry = { res, user };

  if (!subscribersByVisit.has(key)) {
    subscribersByVisit.set(key, new Set());
  }
  subscribersByVisit.get(key).add(entry);

  const cleanup = () => {
    const set = subscribersByVisit.get(key);
    if (!set) return;
    set.delete(entry);
    if (!set.size) subscribersByVisit.delete(key);
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);
  return cleanup;
}

function writeSnapshotEvent(res, snapshot) {
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

async function sendSnapshotToClient(res, user, visitId) {
  const snapshot = await getSnapshot(visitId, { user });
  writeSnapshotEvent(res, snapshot);
}

async function broadcastVisit(visitId) {
  const key = String(parseVisitId(visitId));
  const subs = subscribersByVisit.get(key);
  if (!subs || !subs.size) return;

  const dead = [];
  for (const sub of subs) {
    try {
      if (sub.res.writableEnded || sub.res.destroyed) {
        dead.push(sub);
        continue;
      }
      await sendSnapshotToClient(sub.res, sub.user, visitId);
    } catch (err) {
      console.error('[hub-broadcast] client push failed:', err.message);
      dead.push(sub);
    }
  }
  for (const sub of dead) {
    subs.delete(sub);
  }
  if (!subs.size) subscribersByVisit.delete(key);
}

module.exports = {
  addSubscriber,
  broadcastVisit,
  sendSnapshotToClient,
  writeSnapshotEvent,
};
