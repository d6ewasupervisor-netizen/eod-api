// Checklane Hub — SSE broadcast of per-client snapshots after mutations.

const { parseVisitId } = require('./hub-auth');

/** @type {Map<string, Set<{ res: import('express').Response, user: object }>>} */
const subscribersByVisit = new Map();

/** @type {Set<{ res: import('express').Response, user: object, cleanup: Function }>} */
const prodDispatchAdminSubs = new Set();

function writeProdDispatchEvent(res, payload) {
  res.write(`event: prod_dispatch\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function maybeRegisterProdDispatchAdmin(res, user) {
  try {
    const { isProdDispatchEnabled, isProdDispatchApprover } = require('./hub-prod-dispatch');
    if (!isProdDispatchEnabled() || !isProdDispatchApprover(user?.email)) return null;
    const entry = { res, user };
    prodDispatchAdminSubs.add(entry);
    const cleanup = () => {
      prodDispatchAdminSubs.delete(entry);
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    entry.cleanup = cleanup;
    return cleanup;
  } catch (err) {
    console.error('[hub-broadcast] prod dispatch admin register failed:', err.message);
    return null;
  }
}

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
  maybeRegisterProdDispatchAdmin(res, user);
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
  // Lazy require: hub-state <-> hub-broadcast form a require cycle. Pulling
  // getSnapshot at module load time can capture `undefined` (it isn't exported
  // yet mid-cycle), which silently breaks every snapshot push. Requiring it at
  // call time guarantees hub-state has finished initializing.
  const { getSnapshot } = require('./hub-state');
  const snapshot = await getSnapshot(visitId, { user });
  writeSnapshotEvent(res, snapshot);
}

async function broadcastProdDispatch(payload) {
  const dead = [];
  for (const sub of prodDispatchAdminSubs) {
    try {
      if (sub.res.writableEnded || sub.res.destroyed) {
        dead.push(sub);
        continue;
      }
      writeProdDispatchEvent(sub.res, payload);
    } catch (err) {
      console.error('[hub-broadcast] prod_dispatch push failed:', err.message);
      dead.push(sub);
    }
  }
  for (const sub of dead) {
    prodDispatchAdminSubs.delete(sub);
  }

  const visitKey = payload.visitId != null ? String(parseVisitId(payload.visitId)) : null;
  if (!visitKey) return;
  const subs = subscribersByVisit.get(visitKey);
  if (!subs || !subs.size) return;

  const visitDead = [];
  for (const sub of subs) {
    try {
      const { isProdDispatchApprover } = require('./hub-prod-dispatch');
      if (!isProdDispatchApprover(sub.user?.email)) continue;
      if (sub.res.writableEnded || sub.res.destroyed) {
        visitDead.push(sub);
        continue;
      }
      writeProdDispatchEvent(sub.res, payload);
    } catch (err) {
      visitDead.push(sub);
    }
  }
  for (const sub of visitDead) {
    subs.delete(sub);
  }
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
  broadcastProdDispatch,
  broadcastChat,
  sendSnapshotToClient,
  writeSnapshotEvent,
  writeChatEvent,
  writeProdDispatchEvent,
  writeHeartbeat,
};
