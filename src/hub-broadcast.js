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

/**
 * SSE comment line. Keeps idle connections alive through proxies/load balancers
 * (e.g. Railway) that would otherwise drop a stream with no traffic.
 */
function writeHeartbeat(res) {
  res.write(`: ping ${Date.now()}\n\n`);
}

function writeChatEvent(res, payload) {
  res.write(`event: chat\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function broadcastChat(visitId, payloadBuilder) {
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
      const payload = typeof payloadBuilder === 'function'
        ? await payloadBuilder(sub.user)
        : payloadBuilder;
      writeChatEvent(sub.res, payload);
    } catch (err) {
      console.error('[hub-broadcast] chat push failed:', err.message);
      dead.push(sub);
    }
  }
  for (const sub of dead) {
    subs.delete(sub);
  }
  if (!subs.size) subscribersByVisit.delete(key);
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
  broadcastChat,
  sendSnapshotToClient,
  writeSnapshotEvent,
  writeChatEvent,
  writeHeartbeat,
};
