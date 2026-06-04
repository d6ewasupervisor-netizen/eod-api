// Hub store listing + assignment management (before /:visitId routes).

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { resolveHubUser } = require('../hub-auth');
const {
  listAccessibleStores,
  canManageStore,
  canViewHubPresence,
  listStoreAssignments,
  upsertStoreAssignment,
  removeStoreAssignment,
  normalizeStoreNumber,
} = require('../hub-store-access');
const { listFixturesForStore } = require('../lib/hub-fixture-catalog');
const { touchSession, removeSession, listSessions } = require('../hub-presence');
const {
  recordPresenceHistory,
  closeSessionHistory,
  listPresenceHistory,
} = require('../hub-presence-history');

const { query } = require('../lib/db');
const {
  resolveLiveVisitForStore,
  maybePinLiveVisitFromUser,
} = require('../hub-live-visit');
const { getSnapshot } = require('../hub-state');

const router = express.Router();

router.post('/presence', requireAuth, async (req, res) => {
  try {
    const sessionId = (req.body?.sessionId || '').trim();
    if (!sessionId || sessionId.length > 128) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const hubUser = await resolveHubUser(req.user);
    const session = touchSession(sessionId, {
      email: req.user.email,
      name: hubUser.name || req.user.email,
      hubUserId: hubUser.id,
      page: req.body?.page,
      storeNumber: req.body?.storeNumber,
      visitId: req.body?.visitId,
      view: req.body?.view,
      detail: req.body?.detail,
    });
    if (session?.storeNumber && session?.visitId && session.page === 'hub') {
      maybePinLiveVisitFromUser(req.user, hubUser, session.storeNumber, session.visitId)
        .catch((err) => {
          console.error('[hub-live-visit] pin from presence failed:', err.message);
        });
    }
    if (session) {
      recordPresenceHistory(session).catch((err) => {
        console.error('[hub-presence] history record failed:', err.message);
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[hub-presence] touch failed:', err.message);
    return res.status(500).json({ error: 'Failed to update presence' });
  }
});

router.delete('/presence', requireAuth, async (req, res) => {
  const sessionId = (req.body?.sessionId || req.query?.sessionId || '').trim();
  if (sessionId) {
    removeSession(sessionId);
    closeSessionHistory(sessionId).catch((err) => {
      console.error('[hub-presence] history close failed:', err.message);
    });
  }
  return res.json({ ok: true });
});

router.get('/presence/history', requireAuth, async (req, res) => {
  try {
    if (!canViewHubPresence(req.user)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const entries = await listPresenceHistory({
      hours: req.query.hours,
      limit: req.query.limit,
      storeNumber: req.query.storeNumber,
      email: req.query.email,
    });

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      hours: req.query.hours,
      entries,
    });
  } catch (err) {
    console.error('[hub-presence] history list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load presence history' });
  }
});

router.get('/presence', requireAuth, async (req, res) => {
  try {
    if (!canViewHubPresence(req.user)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const sessions = listSessions();
    const storeNumbers = [...new Set(sessions.map((s) => s.storeNumber).filter(Boolean))];
    const storeNames = new Map();

    if (storeNumbers.length) {
      const { rows } = await query(
        `SELECT store_number, name FROM hub_stores WHERE store_number = ANY($1::text[])`,
        [storeNumbers],
      );
      for (const row of rows) {
        storeNames.set(String(row.store_number), row.name);
      }
    }

    const enriched = sessions.map((session) => {
      const sn = session.storeNumber;
      const padded = sn ? String(sn).padStart(5, '0') : null;
      return {
        ...session,
        storeName: sn
          ? (storeNames.get(sn) || storeNames.get(String(Number(sn))) || `Store ${padded}`)
          : null,
      };
    });

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      sessions: enriched,
    });
  } catch (err) {
    console.error('[hub-presence] list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load presence' });
  }
});

router.get('/stores', requireAuth, async (req, res) => {
  try {
    const data = await listAccessibleStores(req.user);
    return res.json({
      ok: true,
      email: req.user.email,
      isAdmin: data.isAdmin,
      isSupervisor: data.isSupervisor,
      canViewPresence: data.canViewPresence,
      organizeBySupervisor: data.organizeBySupervisor,
      storeHubFilters: data.storeHubFilters,
      blitzWeek: data.blitzWeek,
      stores: data.stores,
    });
  } catch (err) {
    console.error('[hub-stores] list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load stores' });
  }
});

router.get('/command-center', requireAuth, async (req, res) => {
  try {
    if (!canViewHubPresence(req.user)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const data = await listAccessibleStores(req.user);
    const sessions = listSessions();
    const sessionsByStore = new Map();
    for (const session of sessions) {
      if (!session?.storeNumber) continue;
      const key = String(session.storeNumber);
      if (!sessionsByStore.has(key)) sessionsByStore.set(key, []);
      sessionsByStore.get(key).push(session);
    }

    const storeSummaries = await Promise.all((data.stores || []).map(async (store) => {
      const activeSessions = sessionsByStore.get(String(store.storeNumber)) || [];
      if (!store.liveVisitId) {
        return {
          storeNumber: store.storeNumber,
          name: store.name,
          liveVisitId: null,
          progressPct: 0,
          stats: null,
          blockers: 0,
          pendingSignoff: 0,
          closeoutReady: false,
          activePeople: activeSessions.length,
          activeSessions: activeSessions.map((s) => ({
            email: s.email,
            name: s.name,
            detail: s.detail,
            view: s.view,
            updatedAt: s.updatedAt,
          })),
        };
      }

      const snapshot = await getSnapshot(store.liveVisitId, { user: req.user });
      const total = snapshot.stats?.total || 0;
      const terminal = (snapshot.stats?.signedOff || 0) + (snapshot.stats?.notInStore || 0);
      const progressPct = total ? Math.round((terminal / total) * 100) : 0;

      return {
        storeNumber: store.storeNumber,
        name: store.name,
        liveVisitId: store.liveVisitId,
        progressPct,
        stats: snapshot.stats || null,
        blockers: (snapshot.exceptionQueue?.total || 0) + (snapshot.stats?.needsAttention || 0),
        pendingSignoff: snapshot.stats?.donePendingSignoff || 0,
        closeoutReady: !!snapshot.closeoutChecklist?.ready,
        activePeople: activeSessions.length,
        activeSessions: activeSessions.map((s) => ({
          email: s.email,
          name: s.name,
          detail: s.detail,
          view: s.view,
          updatedAt: s.updatedAt,
        })),
        nextActions: snapshot.nextActions || [],
      };
    }));

    storeSummaries.sort((a, b) => {
      if (b.blockers !== a.blockers) return b.blockers - a.blockers;
      if (a.closeoutReady !== b.closeoutReady) return a.closeoutReady ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      stores: storeSummaries,
      totals: {
        storeCount: storeSummaries.length,
        activeStores: storeSummaries.filter((store) => store.liveVisitId).length,
        atRiskStores: storeSummaries.filter((store) => store.blockers > 0).length,
        closeoutReadyStores: storeSummaries.filter((store) => store.closeoutReady).length,
      },
    });
  } catch (err) {
    console.error('[hub-command-center] load failed:', err.message);
    return res.status(500).json({ error: 'Failed to load command center' });
  }
});

router.get('/stores/:storeNumber/live-visit', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    if (!storeNumber) return res.status(400).json({ error: 'Invalid store number' });

    const storesPayload = await listAccessibleStores(req.user);
    const allowedStore = storesPayload.stores.some((s) => s.storeNumber === storeNumber);
    if (!allowedStore && !storesPayload.isAdmin) {
      return res.status(403).json({ error: 'Not allowed to view this store' });
    }

    const live = await resolveLiveVisitForStore(storeNumber);
    return res.json({
      storeNumber,
      visitId: live.visitId,
      source: live.source,
      schedule: live.schedule
        ? {
          visitId: String(live.schedule.visit_id),
          scheduledDate: live.schedule.scheduled_date,
          visitLead: live.schedule.visit_lead,
          status: live.schedule.current_status,
          shiftStart: live.schedule.shift_start_time,
          shiftEnd: live.schedule.shift_end_time,
        }
        : null,
    });
  } catch (err) {
    console.error('[hub-stores] live-visit failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve live visit' });
  }
});

router.get('/stores/:storeNumber/fixtures', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    if (!storeNumber) return res.status(400).json({ error: 'Invalid store number' });

    const fixtures = listFixturesForStore(storeNumber);
    if (!fixtures) {
      return res.status(404).json({ error: 'No fixture catalog for this store' });
    }

    return res.json({
      storeNumber,
      fixtures,
      fixtureCount: fixtures.length,
      laneCount: new Set(fixtures.map((f) => f.lane)).size,
    });
  } catch (err) {
    console.error('[hub-stores] fixtures failed:', err.message);
    return res.status(500).json({ error: 'Failed to load store fixtures' });
  }
});

router.get('/stores/:storeNumber/assignments', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    if (!storeNumber) return res.status(400).json({ error: 'Invalid store number' });

    const allowed = await canManageStore(req.user, storeNumber);
    if (!allowed) {
      return res.status(403).json({ error: 'Not allowed to view store assignments' });
    }

    const members = await listStoreAssignments(storeNumber);
    return res.json({ storeNumber, members });
  } catch (err) {
    console.error('[hub-stores] assignments list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }
});

router.post('/stores/:storeNumber/assignments', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    if (!storeNumber) return res.status(400).json({ error: 'Invalid store number' });

    const allowed = await canManageStore(req.user, storeNumber);
    if (!allowed) {
      return res.status(403).json({ error: 'Not allowed to manage store assignments' });
    }

    const email = (req.body?.email || '').trim();
    const role = req.body?.role === 'lead' ? 'lead' : 'rep';
    if (!email) return res.status(400).json({ error: 'email is required' });

    const hubUser = await resolveHubUser(req.user);
    const result = await upsertStoreAssignment({
      storeNumber,
      email,
      role,
      assignedById: hubUser.id,
    });

    const members = await listStoreAssignments(storeNumber);
    return res.json({ ok: true, assignment: result, members });
  } catch (err) {
    console.error('[hub-stores] assign failed:', err.message);
    return res.status(500).json({ error: 'Failed to assign user' });
  }
});

router.patch('/stores/:storeNumber/assignments/:userId', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    const userId = Number(req.params.userId);
    if (!storeNumber || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid store or user id' });
    }

    const allowed = await canManageStore(req.user, storeNumber);
    if (!allowed) {
      return res.status(403).json({ error: 'Not allowed to manage store assignments' });
    }

    const role = req.body?.role === 'lead' ? 'lead' : 'rep';
    const { rows } = await query(
      'SELECT email FROM hub_users WHERE id = $1',
      [userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const hubUser = await resolveHubUser(req.user);
    await upsertStoreAssignment({
      storeNumber,
      email: rows[0].email,
      role,
      assignedById: hubUser.id,
    });

    const members = await listStoreAssignments(storeNumber);
    return res.json({ ok: true, members });
  } catch (err) {
    console.error('[hub-stores] patch assignment failed:', err.message);
    return res.status(500).json({ error: 'Failed to update assignment' });
  }
});

router.delete('/stores/:storeNumber/assignments/:userId', requireAuth, async (req, res) => {
  try {
    const storeNumber = normalizeStoreNumber(req.params.storeNumber);
    const userId = Number(req.params.userId);
    if (!storeNumber || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid store or user id' });
    }

    const allowed = await canManageStore(req.user, storeNumber);
    if (!allowed) {
      return res.status(403).json({ error: 'Not allowed to manage store assignments' });
    }

    const removed = await removeStoreAssignment(storeNumber, userId);
    if (!removed) return res.status(404).json({ error: 'Assignment not found' });

    const members = await listStoreAssignments(storeNumber);
    return res.json({ ok: true, members });
  } catch (err) {
    console.error('[hub-stores] remove assignment failed:', err.message);
    return res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

module.exports = router;
