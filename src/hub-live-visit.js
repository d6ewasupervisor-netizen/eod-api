// Resolve and pin the single live visit per store so leads, reps, and supervisors align.

const { query } = require('./lib/db');
const { listSessions } = require('./hub-presence');

function normalizeStoreNumber(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? String(n) : digits.replace(/^0+/, '') || '0';
}

const ACTIVE_STATUSES = new Set([
  'active',
  'in-progress',
  'in_progress',
  'started',
  'open',
]);

const TERMINAL_STATUSES = new Set([
  'completed',
  'complete',
  'deleted',
  'cancelled',
  'canceled',
]);

function todayLocalDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function isActiveScheduleStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return true;
  if (TERMINAL_STATUSES.has(s)) return false;
  if (ACTIVE_STATUSES.has(s)) return true;
  return !TERMINAL_STATUSES.has(s);
}

function normalizeLeadToken(value) {
  return (value || '').trim().toLowerCase();
}

function leadMatchesSchedule(hubLeadEmail, hubLeadName, visitLead) {
  const lead = normalizeLeadToken(visitLead);
  if (!lead) return false;
  const email = normalizeLeadToken(hubLeadEmail);
  if (email && (lead.includes(email) || email.includes(lead.split('@')[0]))) return true;
  const name = normalizeLeadToken(hubLeadName);
  if (name && lead.includes(name.replace(/\s+/g, ''))) return true;
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length && parts.every((p) => lead.includes(p))) return true;
  }
  return false;
}

async function loadStoreVisitMeta(storeNumbers) {
  const sns = [...new Set(storeNumbers.map(normalizeStoreNumber).filter(Boolean))];
  const meta = new Map();
  if (!sns.length) return meta;

  const numericIds = sns.map((sn) => Number(sn)).filter((n) => Number.isFinite(n));

  const { rows: hubRows } = await query(
    `SELECT store_number, default_visit_id, live_visit_id, live_visit_pinned_at
     FROM hub_stores
     WHERE store_number = ANY($1::text[])`,
    [sns],
  );
  for (const row of hubRows) {
    meta.set(normalizeStoreNumber(row.store_number), {
      defaultVisitId: row.default_visit_id != null ? Number(row.default_visit_id) : null,
      liveVisitId: row.live_visit_id != null ? Number(row.live_visit_id) : null,
      liveVisitPinnedAt: row.live_visit_pinned_at,
    });
  }

  const { rows: leadRows } = await query(
    `SELECT a.store_number, u.email, u.name
     FROM hub_store_assignments a
     JOIN hub_users u ON u.id = a.user_id
     WHERE a.store_role = 'lead'
       AND a.store_number = ANY($1::text[])
       AND u.is_active = true`,
    [sns],
  );
  const leadByStore = new Map();
  for (const row of leadRows) {
    leadByStore.set(normalizeStoreNumber(row.store_number), {
      email: row.email,
      name: row.name,
    });
  }

  const today = todayLocalDate();
  const scheduleRows = numericIds.length
    ? (await query(
      `SELECT visit_id, store_number, visit_lead, supervisor, scheduled_date,
              shift_start_time, shift_end_time, current_status
       FROM schedules
       WHERE store_number = ANY($1::int[])
         AND scheduled_date >= ($2::date - INTERVAL '1 day')
         AND scheduled_date <= ($2::date + INTERVAL '7 days')
       ORDER BY store_number, scheduled_date ASC, visit_id ASC`,
      [numericIds, today],
    )).rows
    : [];

  const schedulesByStore = new Map();
  for (const row of scheduleRows) {
    const sn = normalizeStoreNumber(row.store_number);
    if (!schedulesByStore.has(sn)) schedulesByStore.set(sn, []);
    schedulesByStore.get(sn).push(row);
  }

  let activityRows = [];
  if (numericIds.length) {
    const activityResult = await query(
      `SELECT s.store_number, ss.visit_id,
              MAX(ss.updated_at) AS last_activity,
              COUNT(*) FILTER (
                WHERE ss.state NOT IN ('not_started', 'signed_off')
              )::int AS active_sections
       FROM section_state ss
       JOIN schedules s ON s.visit_id = ss.visit_id
       WHERE s.store_number = ANY($1::int[])
       GROUP BY s.store_number, ss.visit_id
       ORDER BY s.store_number, active_sections DESC, last_activity DESC`,
      [numericIds],
    );
    activityRows = activityResult.rows;
  }

  const activityByStore = new Map();
  for (const row of activityRows) {
    const sn = normalizeStoreNumber(row.store_number);
    if (!activityByStore.has(sn)) activityByStore.set(sn, []);
    activityByStore.get(sn).push(row);
  }

  const presenceByStore = new Map();
  for (const session of listSessions()) {
    if (!session.storeNumber || !session.visitId) continue;
    const sn = normalizeStoreNumber(session.storeNumber);
    if (!sns.includes(sn)) continue;
    if (!presenceByStore.has(sn)) presenceByStore.set(sn, []);
    presenceByStore.get(sn).push(session);
  }

  for (const sn of sns) {
    meta.set(sn, {
      ...(meta.get(sn) || { defaultVisitId: null, liveVisitId: null, liveVisitPinnedAt: null }),
      hubLead: leadByStore.get(sn) || null,
      schedules: schedulesByStore.get(sn) || [],
      activity: activityByStore.get(sn) || [],
      presence: presenceByStore.get(sn) || [],
    });
  }

  return meta;
}

function scheduleRowForVisit(schedules, visitId) {
  const id = Number(visitId);
  if (!Number.isFinite(id)) return null;
  const matches = schedules.filter((r) => Number(r.visit_id) === id);
  if (!matches.length) return null;
  return matches[matches.length - 1];
}

function pickTodaySchedule(schedules, hubLead) {
  const today = todayLocalDate();
  const todayRows = schedules.filter((r) => {
    const d = r.scheduled_date instanceof Date
      ? r.scheduled_date.toISOString().slice(0, 10)
      : String(r.scheduled_date).slice(0, 10);
    return d === today && isActiveScheduleStatus(r.current_status);
  });
  if (!todayRows.length) return null;

  if (hubLead) {
    const leadMatch = todayRows.find((r) =>
      leadMatchesSchedule(hubLead.email, hubLead.name, r.visit_lead),
    );
    if (leadMatch) return leadMatch;
  }

  return todayRows[0];
}

function resolveFromMeta(sn, bundle) {
  const schedules = bundle.schedules || [];
  const hubLead = bundle.hubLead || null;

  const describe = (visitId, source, sched) => ({
    visitId: visitId != null ? String(visitId) : null,
    source,
    schedule: sched || null,
  });

  if (bundle.liveVisitId) {
    const sched = scheduleRowForVisit(schedules, bundle.liveVisitId);
    if (sched && isActiveScheduleStatus(sched.current_status)) {
      return describe(bundle.liveVisitId, 'lead_pinned', sched);
    }
    if ((bundle.activity || []).some((a) => Number(a.visit_id) === bundle.liveVisitId)) {
      return describe(bundle.liveVisitId, 'lead_pinned', sched);
    }
  }

  for (const row of bundle.activity || []) {
    const visitId = Number(row.visit_id);
    if (!Number.isFinite(visitId)) continue;
    if (Number(row.active_sections) > 0) {
      return describe(visitId, 'hub_activity', scheduleRowForVisit(schedules, visitId));
    }
  }

  const leadPresence = (bundle.presence || []).find((s) =>
    s.page === 'hub' && s.visitId,
  );
  if (leadPresence) {
    const visitId = Number(leadPresence.visitId);
    if (Number.isFinite(visitId)) {
      return describe(visitId, 'presence', scheduleRowForVisit(schedules, visitId));
    }
  }

  const todaySched = pickTodaySchedule(schedules, hubLead);
  if (todaySched) {
    return describe(Number(todaySched.visit_id), 'today_schedule', todaySched);
  }

  if (bundle.defaultVisitId) {
    const sched = scheduleRowForVisit(schedules, bundle.defaultVisitId);
    if (!sched || isActiveScheduleStatus(sched.current_status)) {
      return describe(bundle.defaultVisitId, 'default_visit', sched);
    }
  }

  const fallback = schedules.filter((r) => isActiveScheduleStatus(r.current_status)).pop()
    || schedules[schedules.length - 1];
  if (fallback) {
    return describe(Number(fallback.visit_id), 'latest_schedule', fallback);
  }

  if (bundle.defaultVisitId) {
    return describe(bundle.defaultVisitId, 'default_visit', null);
  }

  return describe(null, 'none', null);
}

async function resolveLiveVisitForStore(storeNumber) {
  const sn = normalizeStoreNumber(storeNumber);
  if (!sn) return { visitId: null, source: 'none', schedule: null };
  const meta = await loadStoreVisitMeta([sn]);
  return resolveFromMeta(sn, meta.get(sn) || { schedules: [], activity: [], presence: [] });
}

async function resolveLiveVisitsBatch(storeNumbers) {
  const meta = await loadStoreVisitMeta(storeNumbers);
  const out = new Map();
  for (const [sn, bundle] of meta) {
    out.set(sn, resolveFromMeta(sn, bundle));
  }
  return out;
}

async function pinLiveVisit(storeNumber, visitId, pinnedByUserId) {
  const sn = normalizeStoreNumber(storeNumber);
  const visitIdNum = Number(visitId);
  if (!sn || !Number.isFinite(visitIdNum)) {
    throw new Error('Invalid store or visit');
  }

  await query(
    `INSERT INTO hub_stores (store_number, name)
     VALUES ($1, $2)
     ON CONFLICT (store_number) DO NOTHING`,
    [sn, `Store ${String(sn).padStart(5, '0')}`],
  );

  await query(
    `UPDATE hub_stores
     SET live_visit_id = $2,
         live_visit_pinned_at = now(),
         live_visit_pinned_by = $3,
         default_visit_id = $2
     WHERE store_number = $1`,
    [sn, visitIdNum, pinnedByUserId || null],
  );

  return { storeNumber: sn, visitId: String(visitIdNum) };
}

async function maybePinLiveVisitFromUser(user, hubUser, storeNumber, visitId) {
  const sn = normalizeStoreNumber(storeNumber);
  const visitIdNum = Number(visitId);
  if (!sn || !Number.isFinite(visitIdNum) || !hubUser?.id) return null;

  const { rows } = await query(
    `SELECT store_role FROM hub_store_assignments
     WHERE store_number = $1 AND user_id = $2`,
    [sn, hubUser.id],
  );
  const isLead = rows.length && rows[0].store_role === 'lead';
  if (!isLead) return null;

  return pinLiveVisit(sn, visitIdNum, hubUser.id);
}

async function applyLiveVisitsToStores(stores) {
  if (!stores.length) return;
  const resolved = await resolveLiveVisitsBatch(stores.map((s) => s.storeNumber));
  for (const store of stores) {
    const live = resolved.get(store.storeNumber);
    if (!live?.visitId) continue;
    store.defaultVisitId = live.visitId;
    store.liveVisitId = live.visitId;
    store.liveVisitSource = live.source;
    if (store.shift) {
      store.shift.visitId = live.visitId;
      store.shift.liveVisitSource = live.source;
    }
  }
}

module.exports = {
  todayLocalDate,
  resolveLiveVisitForStore,
  resolveLiveVisitsBatch,
  pinLiveVisit,
  maybePinLiveVisitFromUser,
  applyLiveVisitsToStores,
  isActiveScheduleStatus,
};
