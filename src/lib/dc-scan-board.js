'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const {
  findProdVisit,
  findProdVisitInWeek,
  volunteerEmailForEmployeeId,
} = require('./dc-scan-sas-prod');
const { getLiveProd, startDcScanProdSync } = require('./dc-scan-sas-sync');
const {
  STORES,
  VOLUNTEERS,
  normalizeEmail,
  normalizeStoreId,
  getStore,
  isVolunteerEmail,
  isSupervisorEmail,
  findVolunteerByEmail,
  weekContext,
  wedThuFriDates,
  thisWeekSlotId,
  ongoingSlotId,
  parseSlotId,
  fridayDeadlineIso,
  pacificYmd,
  weekdayShortPacific,
} = require('./dc-scan-inventory');

const bus = new EventEmitter();
bus.setMaxListeners(200);

let pool = null;
let state = null;
let mutationChain = Promise.resolve();

function emptyState() {
  return {
    version: 1,
    pledges: [],
    changeRequests: [],
    finalizations: {},
    updatedAt: new Date().toISOString(),
  };
}

function queueMutation(fn) {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dc_scan_board_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadState() {
  const { rows } = await pool.query(
    'SELECT state FROM dc_scan_board_state WHERE id = 1',
  );
  if (!rows.length) {
    const fresh = emptyState();
    await pool.query(
      `INSERT INTO dc_scan_board_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(fresh)],
    );
    return fresh;
  }
  const raw = rows[0].state || {};
  return {
    ...emptyState(),
    ...raw,
    pledges: Array.isArray(raw.pledges) ? raw.pledges : [],
    changeRequests: Array.isArray(raw.changeRequests) ? raw.changeRequests : [],
    finalizations:
      raw.finalizations && typeof raw.finalizations === 'object'
        ? raw.finalizations
        : {},
  };
}

async function persist() {
  state.updatedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO dc_scan_board_state (id, state, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
       SET state = EXCLUDED.state, updated_at = NOW()`,
    [JSON.stringify(state)],
  );
}

function pledgeId() {
  return `p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function requestId() {
  return crypto.randomUUID();
}

function displayNameForEmail(email) {
  const v = findVolunteerByEmail(email);
  if (!v) return String(email || '').split('@')[0] || 'Volunteer';
  return v.preferredName || v.name || v.displayName;
}

function seedIfNeeded(ctx) {
  const seeds = [
    {
      storeId: '31',
      email: 'aiyana.natarisalazar@retailodyssey.com',
      name: 'Wolf',
      scheduledDate: ctx.todayYmd,
      note: 'Pre-seeded: Wolf already on store 31 today',
      finalized: true,
      sasVisitId: 27034474,
      sasShiftId: 44474494,
      buildStatus: 'built',
    },
    {
      storeId: '53',
      email: 'james.duchene@retailodyssey.com',
      name: 'James Duchene',
      scheduledDate: ctx.todayYmd,
      note: 'Pre-seeded: James already on store 53 today',
      finalized: true,
      sasVisitId: 27034491,
      sasShiftId: 44474532,
      buildStatus: 'built',
    },
  ];

  let changed = false;
  for (const seed of seeds) {
    const slotId = thisWeekSlotId(seed.storeId);
    if (!slotId) continue;
    const existing = state.pledges.find((p) => p.slotId === slotId && !p.releasedAt);
    if (existing) {
      if (syncPledgeToBuiltSeed(existing, seed)) changed = true;
      continue;
    }
    state.pledges.push({
      id: pledgeId(),
      slotId,
      scope: 'thisWeek',
      weekKey: ctx.thisWeekKey,
      storeId: seed.storeId,
      name: seed.name,
      email: normalizeEmail(seed.email),
      scheduledDate: seed.scheduledDate,
      pledgedAt: new Date().toISOString(),
      source: 'seed',
      note: seed.note,
      finalized: Boolean(seed.finalized),
      buildStatus: seed.buildStatus || 'pending',
      sasVisitId: seed.sasVisitId || null,
      sasShiftId: seed.sasShiftId || null,
      sasError: null,
      releasedAt: null,
      builtAt: seed.buildStatus === 'built' ? new Date().toISOString() : null,
    });
    changed = true;
  }
  return changed;
}

function syncPledgeToBuiltSeed(pledge, seed) {
  if (seed.buildStatus !== 'built') return false;
  let changed = false;
  if (pledge.buildStatus !== 'built') {
    pledge.buildStatus = 'built';
    pledge.builtAt = pledge.builtAt || new Date().toISOString();
    changed = true;
  }
  if (seed.finalized && !pledge.finalized) {
    pledge.finalized = true;
    changed = true;
  }
  if (seed.sasVisitId && pledge.sasVisitId !== seed.sasVisitId) {
    pledge.sasVisitId = seed.sasVisitId;
    changed = true;
  }
  if (seed.sasShiftId && pledge.sasShiftId !== seed.sasShiftId) {
    pledge.sasShiftId = seed.sasShiftId;
    changed = true;
  }
  if (pledge.sasError) {
    pledge.sasError = null;
    changed = true;
  }
  if (seed.note && pledge.note !== seed.note) {
    pledge.note = seed.note;
    changed = true;
  }
  return changed;
}

function activePledges() {
  return state.pledges.filter((p) => !p.releasedAt);
}

function activePledgeForSlot(slotId) {
  return activePledges().find((p) => p.slotId === slotId) || null;
}

function pendingChangeForSlot(slotId) {
  return (state.changeRequests || []).find(
    (r) => r.slotId === slotId && r.status === 'pending',
  );
}

function validateScheduledDate(ymd, allowedDates, todayYmd) {
  const date = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Pick a valid date (YYYY-MM-DD).');
  }
  if (!allowedDates.includes(date)) {
    throw new Error('Scans must be scheduled Wednesday, Thursday, or Friday of that week.');
  }
  if (date < todayYmd) {
    throw new Error('That date is already past. Pick today or a later day this window.');
  }
  const wd = weekdayShortPacific(date);
  if (!['Wed', 'Thu', 'Fri'].includes(wd)) {
    throw new Error('Scans must land on Wednesday, Thursday, or Friday.');
  }
  return date;
}

function prodSummaryForStore(storeId, scope, weekMeta, liveProd) {
  if (!liveProd?.ok) return null;
  if (scope === 'thisWeek') {
    return findProdVisitInWeek(liveProd, storeId, weekMeta.startDate, weekMeta.endDate);
  }
  return findProdVisitInWeek(liveProd, storeId, weekMeta.startDate, weekMeta.endDate);
}

function formatProdSchedule(prod) {
  if (!prod) return null;
  const parts = [];
  if (prod.shiftStartTime) {
    parts.push(prod.shiftStartTime);
    if (prod.shiftEndTime) parts.push('–', prod.shiftEndTime);
  }
  return {
    scheduledDate: prod.scheduledDate,
    shiftStartTime: prod.shiftStartTime,
    shiftEndTime: prod.shiftEndTime,
    scheduleLabel: parts.join(' ').trim() || null,
    visitId: prod.visitId,
    visitStatus: prod.visitStatus,
    shiftId: prod.lead?.shiftId || null,
    shiftStatus: prod.lead?.shiftStatus || null,
    leadName: prod.lead?.name || null,
    leadEmployeeId: prod.lead?.employeeId || null,
    shiftCount: prod.shiftCount || 0,
  };
}

function buildPanel(scope, weekMeta, todayYmd, liveProd) {
  const allowedDates = wedThuFriDates(weekMeta.startDate, weekMeta.endDate);
  const stores = STORES.map((store) => {
    const slotId =
      scope === 'thisWeek'
        ? thisWeekSlotId(store.id)
        : ongoingSlotId(weekMeta.weekKey, store.id);
    const pledge = activePledgeForSlot(slotId);
    const pending = pendingChangeForSlot(slotId);
    const prodRaw = prodSummaryForStore(store.id, scope, weekMeta, liveProd);
    const prod = formatProdSchedule(prodRaw);
    const prodForPledge = pledge
      ? formatProdSchedule(findProdVisit(liveProd, store.id, pledge.scheduledDate))
      : null;
    const prodDisplay = prodForPledge || prod;

    let status = 'open';
    if (pledge) {
      if (pledge.buildStatus === 'built' || (prodForPledge?.shiftId && prodForPledge?.visitId)) {
        status = 'built';
      } else if (pledge.finalized) {
        status = 'finalized';
      } else {
        status = 'pledged';
      }
    } else if (prod?.visitId && prod?.leadName) {
      status = 'scheduled';
    }

    return {
      id: store.id,
      label: store.label,
      city: store.city,
      state: store.state,
      slotId,
      status,
      prod,
      pledge: pledge
        ? {
            id: pledge.id,
            name: pledge.name,
            email: pledge.email,
            scheduledDate: pledge.scheduledDate,
            pledgedAt: pledge.pledgedAt,
            finalized: Boolean(pledge.finalized),
            buildStatus: pledge.buildStatus || 'pending',
            sasVisitId: pledge.sasVisitId || prodForPledge?.visitId || null,
            sasShiftId: pledge.sasShiftId || prodForPledge?.shiftId || null,
            sasStartTime: pledge.sasStartTime || prodForPledge?.shiftStartTime || null,
            sasEndTime: pledge.sasEndTime || prodForPledge?.shiftEndTime || null,
            sasError: pledge.sasError || null,
            source: pledge.source || 'claim',
            prod: prodForPledge,
          }
        : prodDisplay?.leadName
          ? {
              id: null,
              name: prodDisplay.leadName,
              email: volunteerEmailForEmployeeId(prodDisplay.leadEmployeeId),
              scheduledDate: prodDisplay.scheduledDate,
              finalized: true,
              buildStatus: 'built',
              sasVisitId: prodDisplay.visitId,
              sasShiftId: prodDisplay.shiftId,
              sasStartTime: prodDisplay.shiftStartTime,
              sasEndTime: prodDisplay.shiftEndTime,
              source: 'prod',
              prod: prodDisplay,
            }
          : null,
      pendingChange: pending
        ? {
            id: pending.id,
            type: pending.type,
            requestedBy: pending.requestedByEmail,
            requestedAt: pending.requestedAt,
            note: pending.note || '',
            swapToStoreId: pending.swapToStoreId || null,
            swapToDate: pending.swapToDate || null,
          }
        : null,
    };
  });

  const stats = {
    total: stores.length,
    open: stores.filter((s) => s.status === 'open').length,
    pledged: stores.filter((s) => s.status === 'pledged').length,
    finalized: stores.filter((s) => s.status === 'finalized').length,
    built: stores.filter((s) => s.status === 'built' || s.status === 'scheduled').length,
    scheduled: stores.filter((s) => s.status === 'scheduled').length,
  };
  stats.remaining = stats.open;

  return {
    scope,
    weekKey: weekMeta.weekKey,
    startDate: weekMeta.startDate,
    endDate: weekMeta.endDate,
    deadline: fridayDeadlineIso(weekMeta.endDate),
    allowedDates:
      scope === 'thisWeek'
        ? allowedDates.filter((d) => d >= todayYmd)
        : allowedDates,
    stores,
    stats,
  };
}

function buildSnapshot() {
  const ctx = weekContext(new Date());
  const liveProd = getLiveProd();
  const thisWeek = buildPanel('thisWeek', ctx.thisWeek, ctx.todayYmd, liveProd);
  const ongoing = buildPanel('ongoing', ctx.ongoingWeek, ctx.todayYmd, liveProd);
  const pledges = activePledges()
    .slice()
    .sort((a, b) => String(a.storeId).localeCompare(String(b.storeId)))
    .map((p) => ({
      ...p,
      prod: formatProdSchedule(findProdVisit(liveProd, p.storeId, p.scheduledDate)),
    }));

  return {
    updatedAt: state.updatedAt,
    nowMs: Date.now(),
    todayYmd: ctx.todayYmd,
    prod: {
      ok: Boolean(liveProd?.ok),
      sessionAlive: Boolean(liveProd?.sessionAlive),
      projectId: liveProd?.projectId || 8081,
      cycleId: liveProd?.cycleId || null,
      syncedAt: liveProd?.syncedAt || null,
      error: liveProd?.error || null,
      visitCount: (liveProd?.visits || []).length,
    },
    volunteers: VOLUNTEERS.map((v) => ({
      name: v.preferredName || v.name,
      email: v.email,
      displayName: v.displayName,
    })),
    approvedEmails: [...require('./dc-scan-inventory').volunteerEmails()].sort(),
    supervisorEmails: [...require('./dc-scan-inventory').supervisorEmails()].sort(),
    thisWeek,
    ongoing,
    pledges,
    changeRequests: (state.changeRequests || [])
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        id: r.id,
        type: r.type,
        slotId: r.slotId,
        storeId: r.storeId,
        scope: r.scope,
        weekKey: r.weekKey,
        requestedByEmail: r.requestedByEmail,
        requestedByName: r.requestedByName,
        note: r.note || '',
        swapToStoreId: r.swapToStoreId || null,
        swapToDate: r.swapToDate || null,
        requestedAt: r.requestedAt,
      })),
    finalizations: state.finalizations || {},
  };
}

function broadcast() {
  const snapshot = buildSnapshot();
  bus.emit('update', snapshot);
  return snapshot;
}

async function reconcileFromProd(liveProd) {
  if (!liveProd?.ok || !liveProd.visits?.length) return { changed: false };
  return queueMutation(async () => {
    let changed = false;
    for (const prod of liveProd.visits) {
      if (!prod.lead?.shiftId || !prod.visitId) continue;

      const slotId = thisWeekSlotId(prod.storeId);
      const pledge = activePledges().find(
        (p) =>
          p.slotId === slotId ||
          (p.storeId === prod.storeId && p.scheduledDate === prod.scheduledDate),
      );

      if (!pledge) continue;

      if (pledge.buildStatus !== 'built') {
        pledge.buildStatus = 'built';
        pledge.builtAt = pledge.builtAt || new Date().toISOString();
        changed = true;
      }
      if (!pledge.finalized) {
        pledge.finalized = true;
        changed = true;
      }
      if (pledge.sasVisitId !== prod.visitId) {
        pledge.sasVisitId = prod.visitId;
        changed = true;
      }
      if (pledge.sasShiftId !== prod.lead.shiftId) {
        pledge.sasShiftId = prod.lead.shiftId;
        changed = true;
      }
      if (prod.shiftStartTime && pledge.sasStartTime !== prod.shiftStartTime) {
        pledge.sasStartTime = prod.shiftStartTime;
        changed = true;
      }
      if (prod.shiftEndTime && pledge.sasEndTime !== prod.shiftEndTime) {
        pledge.sasEndTime = prod.shiftEndTime;
        changed = true;
      }
      if (pledge.sasError) {
        pledge.sasError = null;
        changed = true;
      }
    }
    if (changed) await persist();
    return { changed };
  });
}

async function init(dbPool) {
  pool = dbPool;
  await ensureTable();
  state = await loadState();
  const ctx = weekContext(new Date());
  if (seedIfNeeded(ctx)) {
    await persist();
  }
  startDcScanProdSync({
    broadcast: () => broadcast(),
    reconcileFromProd,
  });
  return broadcast();
}

function requireActor(email) {
  const em = normalizeEmail(email);
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    throw new Error('Signed-in email is required.');
  }
  if (!isVolunteerEmail(em) && !isSupervisorEmail(em)) {
    throw new Error('Your account is not on the DC Scan signup allowlist.');
  }
  return em;
}

async function addPledge({ email, scope, storeId, scheduledDate, forceName }) {
  return queueMutation(async () => {
    const em = requireActor(email);
    const ctx = weekContext(new Date());
    const store = normalizeStoreId(storeId);
    if (!store) throw new Error('Invalid store number.');

    const scopeNorm = scope === 'ongoing' ? 'ongoing' : 'thisWeek';
    const weekMeta = scopeNorm === 'thisWeek' ? ctx.thisWeek : ctx.ongoingWeek;
    const slotId =
      scopeNorm === 'thisWeek'
        ? thisWeekSlotId(store)
        : ongoingSlotId(weekMeta.weekKey, store);
    if (!slotId) throw new Error('Invalid slot.');

    const allowed = wedThuFriDates(weekMeta.startDate, weekMeta.endDate);
    const dateFloor = scopeNorm === 'thisWeek' ? ctx.todayYmd : weekMeta.startDate;
    const date = validateScheduledDate(scheduledDate, allowed, dateFloor);

    const existing = activePledgeForSlot(slotId);
    if (existing) {
      throw new Error(
        `FM ${store} is already claimed by ${existing.name}. Request a swap/release if you need it.`,
      );
    }

    const volunteer = findVolunteerByEmail(em);
    const name =
      forceName ||
      (volunteer && (volunteer.preferredName || volunteer.name)) ||
      displayNameForEmail(em);

    const pledge = {
      id: pledgeId(),
      slotId,
      scope: scopeNorm,
      weekKey: weekMeta.weekKey,
      storeId: store,
      name,
      email: em,
      scheduledDate: date,
      pledgedAt: new Date().toISOString(),
      source: 'claim',
      note: null,
      finalized: false,
      buildStatus: 'pending',
      sasVisitId: null,
      sasShiftId: null,
      sasError: null,
      releasedAt: null,
    };

    // Claiming after a prior finalize puts the user back into draft for those slots.
    if (state.finalizations[em]) {
      // keep finalization record but new pledges start unfinalized
    }

    state.pledges.push(pledge);
    await persist();
    return { snapshot: broadcast(), pledge };
  });
}

async function requestChange({
  email,
  pledgeId: pid,
  type,
  note,
  swapToStoreId,
  swapToDate,
}) {
  return queueMutation(async () => {
    const em = requireActor(email);
    const id = String(pid || '').trim();
    if (!id) throw new Error('Missing pledge id.');
    const changeType = type === 'swap' ? 'swap' : 'release';

    const pledge = activePledges().find((p) => p.id === id);
    if (!pledge) throw new Error('Commitment not found. It may already be released.');
    if (normalizeEmail(pledge.email) !== em && !isSupervisorEmail(em)) {
      throw new Error('You can only request changes on your own commitments.');
    }
    if (pendingChangeForSlot(pledge.slotId)) {
      throw new Error('A change request is already pending for this store.');
    }

    let swapStore = null;
    let swapDate = null;
    if (changeType === 'swap') {
      swapStore = normalizeStoreId(swapToStoreId);
      if (!swapStore) throw new Error('Pick a store to swap into.');
      if (swapStore === pledge.storeId) {
        throw new Error('Pick a different store to swap into.');
      }
      const ctx = weekContext(new Date());
      const weekMeta =
        pledge.scope === 'ongoing'
          ? ctx.ongoingWeek
          : ctx.thisWeek;
      const targetSlot =
        pledge.scope === 'ongoing'
          ? ongoingSlotId(weekMeta.weekKey, swapStore)
          : thisWeekSlotId(swapStore);
      const taken = activePledgeForSlot(targetSlot);
      if (taken) {
        throw new Error(`FM ${swapStore} is already claimed by ${taken.name}.`);
      }
      const allowed = wedThuFriDates(weekMeta.startDate, weekMeta.endDate);
      const dateFloor = pledge.scope === 'thisWeek' ? ctx.todayYmd : weekMeta.startDate;
      swapDate = validateScheduledDate(
        swapToDate || pledge.scheduledDate,
        allowed,
        dateFloor,
      );
    }

    const req = {
      id: requestId(),
      type: changeType,
      status: 'pending',
      pledgeId: pledge.id,
      slotId: pledge.slotId,
      scope: pledge.scope,
      weekKey: pledge.weekKey,
      storeId: pledge.storeId,
      scheduledDate: pledge.scheduledDate,
      requestedByEmail: em,
      requestedByName: displayNameForEmail(em),
      note: String(note || '').trim().slice(0, 500),
      swapToStoreId: swapStore,
      swapToDate: swapDate,
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };

    state.changeRequests.push(req);
    await persist();
    return { snapshot: broadcast(), request: req, pledge };
  });
}

async function applyChangeDecision(requestIdRaw, decision, resolvedBy) {
  return queueMutation(async () => {
    const id = String(requestIdRaw || '').trim();
    const req = (state.changeRequests || []).find((r) => r.id === id);
    if (!req) return { ok: false, error: 'not_found' };
    if (req.status !== 'pending') {
      return { ok: true, status: req.status, snapshot: buildSnapshot() };
    }

    const now = new Date().toISOString();
    if (decision === 'denied') {
      req.status = 'denied';
      req.resolvedAt = now;
      req.resolvedBy = normalizeEmail(resolvedBy) || null;
      await persist();
      return { ok: true, status: 'denied', snapshot: broadcast(), request: req };
    }

    if (decision !== 'approved') {
      return { ok: false, error: 'invalid_decision' };
    }

    const pledge = activePledges().find((p) => p.id === req.pledgeId);
    if (!pledge) {
      req.status = 'approved';
      req.resolvedAt = now;
      req.resolvedBy = normalizeEmail(resolvedBy) || null;
      await persist();
      return { ok: true, status: 'approved', snapshot: broadcast(), request: req };
    }

    if (req.type === 'release') {
      pledge.releasedAt = now;
      if (pledge.finalized && !pledge.sasVisitId) {
        pledge.finalized = false;
      }
    } else if (req.type === 'swap') {
      const swapStore = normalizeStoreId(req.swapToStoreId);
      const targetSlot =
        pledge.scope === 'ongoing'
          ? ongoingSlotId(pledge.weekKey, swapStore)
          : thisWeekSlotId(swapStore);
      const conflict = activePledgeForSlot(targetSlot);
      if (conflict && conflict.id !== pledge.id) {
        req.status = 'denied';
        req.resolvedAt = now;
        req.resolvedBy = normalizeEmail(resolvedBy) || null;
        req.note = `${req.note || ''} [auto-denied: target claimed]`.trim();
        await persist();
        return { ok: true, status: 'denied', snapshot: broadcast(), request: req };
      }
      pledge.storeId = swapStore;
      pledge.slotId = targetSlot;
      pledge.scheduledDate = req.swapToDate || pledge.scheduledDate;
      pledge.buildStatus = 'pending';
      pledge.sasVisitId = null;
      pledge.sasShiftId = null;
      pledge.sasError = null;
      pledge.finalized = false;
    }

    req.status = 'approved';
    req.resolvedAt = now;
    req.resolvedBy = normalizeEmail(resolvedBy) || null;
    await persist();
    return { ok: true, status: 'approved', snapshot: broadcast(), request: req, pledge };
  });
}

async function finalizeSelections({ email }) {
  return queueMutation(async () => {
    const em = requireActor(email);
    if (!isVolunteerEmail(em) && !isSupervisorEmail(em)) {
      throw new Error('Only sign-up volunteers can finalize selections.');
    }

    const mine = activePledges().filter((p) => normalizeEmail(p.email) === em);
    if (!mine.length) {
      throw new Error('Claim at least one store before finalizing.');
    }

    const pending = (state.changeRequests || []).filter(
      (r) =>
        r.status === 'pending' &&
        (normalizeEmail(r.requestedByEmail) === em ||
          mine.some((p) => p.id === r.pledgeId)),
    );
    if (pending.length) {
      throw new Error(
        'You have a pending release/swap request. Wait for approval (or cancel it) before finalizing.',
      );
    }

    const now = new Date().toISOString();
    for (const p of mine) {
      p.finalized = true;
      if (p.buildStatus !== 'built') p.buildStatus = 'queued';
    }

    state.finalizations[em] = {
      email: em,
      name: displayNameForEmail(em),
      finalizedAt: now,
      pledgeIds: mine.map((p) => p.id),
    };

    await persist();
    return {
      snapshot: broadcast(),
      pledges: mine,
      finalization: state.finalizations[em],
    };
  });
}

async function markPledgeBuildResult(pledgeIdRaw, result) {
  return queueMutation(async () => {
    const pledge = state.pledges.find((p) => p.id === String(pledgeIdRaw || ''));
    if (!pledge) return { ok: false, error: 'not_found' };
    if (result.ok) {
      pledge.buildStatus = 'built';
      pledge.sasVisitId = result.visitId || pledge.sasVisitId;
      pledge.sasShiftId = result.shiftId || pledge.sasShiftId;
      pledge.sasError = null;
      pledge.builtAt = new Date().toISOString();
      if (result.startTime) pledge.sasStartTime = result.startTime;
      if (result.endTime) pledge.sasEndTime = result.endTime;
    } else {
      pledge.buildStatus = 'error';
      pledge.sasError = String(result.error || 'Build failed');
    }
    await persist();
    return { ok: true, snapshot: broadcast(), pledge };
  });
}

function getChangeRequest(id) {
  return (state.changeRequests || []).find((r) => r.id === String(id || '')) || null;
}

function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const snap = buildSnapshot();
  res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
  const onUpdate = (data) => {
    res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
  };
  bus.on('update', onUpdate);
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);
  res.on('close', () => {
    clearInterval(keepAlive);
    bus.off('update', onUpdate);
  });
}

module.exports = {
  init,
  buildSnapshot,
  broadcast,
  addPledge,
  requestChange,
  applyChangeDecision,
  finalizeSelections,
  markPledgeBuildResult,
  reconcileFromProd,
  getChangeRequest,
  subscribe,
  activePledges,
  displayNameForEmail,
  getStore,
  parseSlotId,
};
