'use strict';

/**
 * Live SAS PROD schedule for Division 701 survey (Kompass ISE, project 1).
 * Used by survey taker (/me) and survey-admin assignment flows.
 * Falls back callers should use the seed schedule when ok=false.
 */

const { sasGet, isSessionAlive } = require('../sas-bridge');
const { getVisitStoreNumber, filterVisitsByStore } = require('../../lib/sas-store-match');
const { pool } = require('./db');

const KOMPASS_ISE_PROJECT_ID = Number(process.env.SURVEY_SAS_PROJECT_ID || 1);
const CUSTOMER_ID = 2;
const PROGRAM_ID = 1;
const CACHE_TTL_MS = Number(process.env.SURVEY_SAS_CACHE_MS || 120000);

const employeeCache = new Map(); // workdayId -> { id, name, at }
const dayLeadsCache = new Map(); // `${start}|${end}` -> { at, payload }
const cyclesCache = { at: 0, payload: null };
const personSchedCache = new Map(); // `${email}|${start}|${end}` -> { at, payload }

function todayPacificYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function leadKeyFor({ email, name }) {
  const em = String(email || '').trim().toLowerCase();
  if (em) return `email:${em}`;
  const nk = normalizePersonName(name);
  if (nk) return `name:${nk}`;
  return null;
}

function rows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(map, key, payload) {
  map.set(key, { at: Date.now(), payload });
  return payload;
}

async function resolveEmployeeByWorkday(workdayId) {
  const wd = String(workdayId || '').trim();
  if (!wd) return null;
  const cached = cacheGet(employeeCache, wd);
  if (cached) return cached;

  if (!isSessionAlive()) return null;

  try {
    const resp = await sasGet('/api/v1/human-resources/workday-employees/', {
      address_verified: true,
      fields: 'id,person_name,workday_given_id,person',
      page_size: 10,
      q: wd,
      sort: 'person__person_name',
    });
    const list = rows(resp.data);
    const exact = list.find((e) => String(e.workday_given_id || '').trim() === wd) || list[0];
    if (!exact?.id) return null;
    const person = exact.person || {};
    const payload = {
      id: Number(exact.id),
      workdayId: String(exact.workday_given_id || wd),
      name:
        person.person_name ||
        exact.person_name ||
        [person.first_name, person.last_name].filter(Boolean).join(' ') ||
        null,
    };
    return cacheSet(employeeCache, wd, payload);
  } catch (err) {
    console.warn('[survey-sas-prod] workday resolve failed:', err.message);
    return null;
  }
}

function summarizeFieldVisit(visit, { isLead = null, role = null } = {}) {
  const storeNum = Number(getVisitStoreNumber(visit) || visit?.store_name?.number);
  if (!Number.isFinite(storeNum)) return null;
  const date = String(visit.scheduled_date || '').slice(0, 10);
  if (!date) return null;
  const projectId = Number(visit.project?.project_id || visit.project_id || KOMPASS_ISE_PROJECT_ID);
  return {
    storeNum,
    date,
    visitId: visit.id,
    projectId,
    projectName: visit.project?.name || 'Kompass ISE',
    team: visit.team?.name || visit.team_name || null,
    status: visit.current_status || null,
    leadName: visit.visit_lead || null,
    role: role || (isLead ? 'Lead' : null),
    isLead: isLead == null ? null : !!isLead,
  };
}

/**
 * Stores/dates for one survey roster user from live PROD (Kompass ISE).
 */
async function fetchPersonSchedule(surveyUser, { startDate, endDate } = {}) {
  const start = startDate;
  const end = endDate || startDate;
  if (!start || !end) {
    return { ok: false, sessionAlive: isSessionAlive(), error: 'startDate required', assignments: [] };
  }

  const cacheKey = `${String(surveyUser?.email || '').toLowerCase()}|${start}|${end}`;
  const cached = cacheGet(personSchedCache, cacheKey);
  if (cached) return cached;

  if (!isSessionAlive()) {
    return {
      ok: false,
      sessionAlive: false,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      error: 'SAS session is not active on eod-api',
      assignments: [],
    };
  }

  try {
    const emp = await resolveEmployeeByWorkday(surveyUser?.workdayId || surveyUser?.workday_id);
    if (!emp?.id) {
      const payload = {
        ok: false,
        sessionAlive: true,
        source: 'sas-prod',
        projectId: KOMPASS_ISE_PROJECT_ID,
        error: 'Could not resolve SAS employee from workday id',
        assignments: [],
      };
      return cacheSet(personSchedCache, cacheKey, payload);
    }

    const resp = await sasGet('/api/v1/operations/field-data/', {
      customer_id: CUSTOMER_ID,
      merchandiser: emp.id,
      program_id: PROGRAM_ID,
      project_id: KOMPASS_ISE_PROJECT_ID,
      scheduled_dt_from: start,
      scheduled_dt_to: end,
      page: 1,
      page_size: 100,
    });

    const visits = rows(resp.data);
    const assignments = [];
    const seen = new Set();

    for (const visit of visits) {
      const storeId = getVisitStoreNumber(visit);
      if (storeId && !filterVisitsByStore([visit], storeId).length) continue;

      let isLead = null;
      try {
        const sh = await sasGet('/api/v1/team-scheduling/shifts/', {
          page: 1,
          page_size: 50,
          visit: visit.id,
        });
        const shifts = rows(sh.data).filter((s) => String(s.current_status || '') !== 'deleted');
        const mine = shifts.find((s) => Number(s.employee?.id || s.employee) === emp.id);
        if (mine) {
          isLead = mine.is_lead === true || mine.is_lead === 'true' || mine.is_lead === 1;
        }
      } catch (_) {
        /* keep visit without lead flag */
      }

      const row = summarizeFieldVisit(visit, {
        isLead,
        role: isLead ? 'Lead' : 'Member',
      });
      if (!row) continue;
      const k = `${row.date}|${row.storeNum}`;
      if (seen.has(k)) continue;
      seen.add(k);
      assignments.push({
        ...row,
        workdayId: emp.workdayId,
        name: surveyUser.name || emp.name,
        source: 'sas-prod',
      });
    }

    assignments.sort((a, b) => a.date.localeCompare(b.date) || a.storeNum - b.storeNum);

    const payload = {
      ok: true,
      sessionAlive: true,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      employeeId: emp.id,
      syncedAt: new Date().toISOString(),
      error: null,
      startDate: start,
      endDate: end,
      assignments,
    };
    return cacheSet(personSchedCache, cacheKey, payload);
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'SAS PROD person schedule failed';
    return {
      ok: false,
      sessionAlive: isSessionAlive(),
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      error: typeof message === 'string' ? message : JSON.stringify(message),
      assignments: [],
    };
  }
}

async function loadRosterIndex() {
  const { rows: roster } = await pool.query(
    `SELECT email, name, role, team, district, workday_id
       FROM survey_roster
      WHERE active = TRUE`
  );
  const byWorkday = new Map();
  const byName = new Map();
  for (const r of roster) {
    const email = String(r.email).toLowerCase();
    const entry = {
      email,
      name: r.name,
      role: r.role,
      team: r.team,
      district: r.district,
      workdayId: r.workday_id ? String(r.workday_id).trim() : null,
    };
    if (entry.workdayId) byWorkday.set(entry.workdayId, entry);
    const nk = normalizePersonName(r.name);
    if (nk) {
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(entry);
    }
  }
  return { byWorkday, byName };
}

function matchRosterLead(shift, rosterIndex, visitLeadName) {
  const wd = shift?.employee?.workday_given_id
    ? String(shift.employee.workday_given_id).trim()
    : null;
  if (wd && rosterIndex.byWorkday.has(wd)) return rosterIndex.byWorkday.get(wd);

  const person = shift?.employee?.person || {};
  const shiftName =
    person.person_name ||
    person.full_name ||
    [person.first_name, person.last_name].filter(Boolean).join(' ') ||
    shift?.employee?.person_name ||
    visitLeadName ||
    '';
  const nk = normalizePersonName(shiftName);
  if (nk && rosterIndex.byName.has(nk)) {
    const hits = rosterIndex.byName.get(nk);
    return hits.find((h) => h.role === 'lead') || hits[0];
  }
  if (visitLeadName) {
    const vk = normalizePersonName(visitLeadName);
    if (vk && rosterIndex.byName.has(vk)) {
      const hits = rosterIndex.byName.get(vk);
      return hits.find((h) => h.role === 'lead') || hits[0];
    }
  }
  return null;
}

/**
 * Active Kompass ISE project cycles from SAS PROD cycle management.
 */
async function fetchProjectCycles({ refresh = false } = {}) {
  if (!refresh && cyclesCache.payload && Date.now() - cyclesCache.at <= CACHE_TTL_MS) {
    return cyclesCache.payload;
  }

  if (!isSessionAlive()) {
    return {
      ok: false,
      sessionAlive: false,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      error: 'SAS session is not active on eod-api',
      cycles: [],
      current: null,
      next: null,
    };
  }

  try {
    const resp = await sasGet('/api/v1/projects/project-cycles/', {
      current_status: 'active',
      page: 1,
      page_size: 100,
      project: KOMPASS_ISE_PROJECT_ID,
      sort: 'start_date',
    });
    const today = todayPacificYmd();
    const cycles = rows(resp.data)
      .map((c) => {
        const startDate = String(c.start_date || '').slice(0, 10);
        const endDate = String(c.end_date || '').slice(0, 10);
        const name = c.name || c.cycle_name || c.label || `Cycle ${c.id}`;
        return {
          id: Number(c.id),
          name,
          startDate,
          endDate,
          status: c.current_status || null,
          isCurrent: !!(startDate && endDate && startDate <= today && today <= endDate),
        };
      })
      .filter((c) => Number.isFinite(c.id) && c.startDate && c.endDate)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id);

    const current = cycles.find((c) => c.isCurrent) || null;
    const next =
      (current
        ? cycles.find((c) => c.startDate > current.endDate)
        : cycles.find((c) => c.startDate > today)) || null;

    const payload = {
      ok: true,
      sessionAlive: true,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      syncedAt: new Date().toISOString(),
      error: null,
      today,
      cycles,
      current,
      next,
    };
    cyclesCache.at = Date.now();
    cyclesCache.payload = payload;
    return payload;
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'SAS PROD project cycles failed';
    return {
      ok: false,
      sessionAlive: isSessionAlive(),
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      error: typeof message === 'string' ? message : JSON.stringify(message),
      cycles: [],
      current: null,
      next: null,
    };
  }
}

function upsertLeadStore(leadMap, key, base, storeRow) {
  if (!key) return;
  if (!leadMap.has(key)) {
    leadMap.set(key, {
      leadKey: key,
      email: base.email || null,
      name: base.name || null,
      role: base.role || null,
      team: base.team || null,
      district: base.district || null,
      workdayId: base.workdayId || null,
      matched: !!base.matched,
      stores: [],
    });
  }
  const L = leadMap.get(key);
  if (base.email && !L.email) L.email = base.email;
  if (base.name && !L.name) L.name = base.name;
  if (base.matched) L.matched = true;
  if (!L.stores.some((s) => s.storeNum === storeRow.storeNum && s.date === storeRow.date)) {
    L.stores.push(storeRow);
  }
}

/**
 * Kompass ISE visits for a date range with matched + unmatched leads (admin assign).
 */
async function fetchLeadsInRange(startDate, endDate = null) {
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { ok: false, error: 'Invalid date range', leads: [], visits: [] };
  }
  if (end < start) {
    return { ok: false, error: 'endDate before startDate', leads: [], visits: [] };
  }

  const cacheKey = `${start}|${end}`;
  const cached = cacheGet(dayLeadsCache, cacheKey);
  if (cached) return cached;

  if (!isSessionAlive()) {
    return {
      ok: false,
      sessionAlive: false,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      startDate: start,
      endDate: end,
      date: start === end ? start : null,
      error: 'SAS session is not active on eod-api',
      leads: [],
      visits: [],
    };
  }

  try {
    const rosterIndex = await loadRosterIndex();
    const visitsOut = [];
    const leadMap = new Map();

    let page = 1;
    let more = true;
    const maxPages = start === end ? 20 : 60;
    while (more && page <= maxPages) {
      const resp = await sasGet('/api/v1/operations/field-data/', {
        customer_id: CUSTOMER_ID,
        merchandiser: '',
        program_id: PROGRAM_ID,
        project_id: KOMPASS_ISE_PROJECT_ID,
        scheduled_dt_from: start,
        scheduled_dt_to: end,
        page,
        page_size: 100,
      });
      const batch = rows(resp.data);
      if (!batch.length) break;

      for (const visit of batch) {
        const storeId = getVisitStoreNumber(visit);
        if (!storeId) continue;
        if (!filterVisitsByStore([visit], storeId).length) continue;

        const date = String(visit.scheduled_date || '').slice(0, 10) || start;
        let leadShift = null;
        let shifts = [];
        try {
          const sh = await sasGet('/api/v1/team-scheduling/shifts/', {
            page: 1,
            page_size: 50,
            visit: visit.id,
          });
          shifts = rows(sh.data).filter((s) => String(s.current_status || '') !== 'deleted');
          leadShift =
            shifts.find((s) => s.is_lead === true || s.is_lead === 'true' || s.is_lead === 1) ||
            null;
        } catch (_) {
          /* continue with visit_lead name only */
        }

        const matched = matchRosterLead(leadShift, rosterIndex, visit.visit_lead);
        const person = leadShift?.employee?.person || {};
        const shiftLeadName =
          person.person_name ||
          person.full_name ||
          [person.first_name, person.last_name].filter(Boolean).join(' ') ||
          leadShift?.employee?.person_name ||
          null;
        const leadName = matched?.name || visit.visit_lead || shiftLeadName || null;
        const storeNum = Number(storeId);
        const entry = {
          storeNum,
          date,
          visitId: visit.id,
          team: visit.team?.name || visit.team_name || null,
          status: visit.current_status || null,
          leadName,
          leadEmail: matched?.email || null,
          leadRole: matched?.role || null,
          leadTeam: matched?.team || null,
          leadWorkdayId: matched?.workdayId || leadShift?.employee?.workday_given_id || null,
          matched: !!matched,
          employeeCount: shifts.length || visit.emp_count || null,
        };
        visitsOut.push(entry);

        const storeRow = {
          storeNum,
          visitId: visit.id,
          team: entry.team,
          date,
        };
        if (matched?.email) {
          upsertLeadStore(
            leadMap,
            leadKeyFor({ email: matched.email }),
            {
              email: matched.email,
              name: matched.name,
              role: matched.role,
              team: matched.team,
              district: matched.district,
              workdayId: matched.workdayId,
              matched: true,
            },
            storeRow
          );
        } else if (leadName) {
          upsertLeadStore(
            leadMap,
            leadKeyFor({ name: leadName }),
            {
              email: null,
              name: leadName,
              role: 'lead',
              team: entry.team,
              district: null,
              workdayId: entry.leadWorkdayId,
              matched: false,
            },
            storeRow
          );
        }
      }

      more = batch.length >= 100;
      page += 1;
    }

    visitsOut.sort((a, b) => a.date.localeCompare(b.date) || a.storeNum - b.storeNum);
    const leads = [...leadMap.values()].sort((a, b) =>
      String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''))
    );

    const payload = {
      ok: true,
      sessionAlive: true,
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      startDate: start,
      endDate: end,
      date: start === end ? start : null,
      syncedAt: new Date().toISOString(),
      error: null,
      visitCount: visitsOut.length,
      matchedLeadCount: leads.filter((L) => L.matched).length,
      unmatchedLeadCount: leads.filter((L) => !L.matched).length,
      leads,
      visits: visitsOut,
    };
    return cacheSet(dayLeadsCache, cacheKey, payload);
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'SAS PROD leads failed';
    return {
      ok: false,
      sessionAlive: isSessionAlive(),
      source: 'sas-prod',
      projectId: KOMPASS_ISE_PROJECT_ID,
      startDate: start,
      endDate: end,
      date: start === end ? start : null,
      error: typeof message === 'string' ? message : JSON.stringify(message),
      leads: [],
      visits: [],
    };
  }
}

/** Kompass ISE visits for a single date (compat wrapper). */
async function fetchDayLeads(dateStr) {
  return fetchLeadsInRange(dateStr, dateStr);
}

/**
 * Resolve schedule window from cycle management or explicit dates.
 * @param {{ cycleId?: number|string, range?: string, date?: string, startDate?: string, endDate?: string, refresh?: boolean }} opts
 */
async function resolveScheduleWindow(opts = {}) {
  const today = todayPacificYmd();
  const range = String(opts.range || '').toLowerCase();
  let cycleId = opts.cycleId != null && opts.cycleId !== '' ? Number(opts.cycleId) : null;
  if (!Number.isFinite(cycleId)) cycleId = null;

  if (cycleId || range === 'current' || range === 'next' || range === 'cycle') {
    const cycles = await fetchProjectCycles({ refresh: !!opts.refresh });
    if (!cycles.ok) {
      return { ok: false, error: cycles.error, sessionAlive: cycles.sessionAlive, cycles };
    }
    let cycle = null;
    if (cycleId) cycle = (cycles.cycles || []).find((c) => Number(c.id) === cycleId) || null;
    else if (range === 'next') cycle = cycles.next;
    else cycle = cycles.current || cycles.next;
    if (!cycle) {
      return {
        ok: false,
        error: 'No matching Kompass ISE cycle in cycle management',
        sessionAlive: true,
        cycles,
      };
    }
    return {
      ok: true,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      date: null,
      cycle,
      cycles,
      mode: 'cycle',
    };
  }

  if (opts.startDate || opts.endDate) {
    const startDate = String(opts.startDate || opts.endDate || today).slice(0, 10);
    const endDate = String(opts.endDate || opts.startDate || today).slice(0, 10);
    return { ok: true, startDate, endDate, date: startDate === endDate ? startDate : null, mode: 'range' };
  }

  const date = String(opts.date || today).slice(0, 10);
  return { ok: true, startDate: date, endDate: date, date, mode: 'date' };
}

function clearCaches() {
  employeeCache.clear();
  dayLeadsCache.clear();
  personSchedCache.clear();
  cyclesCache.at = 0;
  cyclesCache.payload = null;
}

module.exports = {
  KOMPASS_ISE_PROJECT_ID,
  addDaysYmd,
  fetchPersonSchedule,
  fetchDayLeads,
  fetchLeadsInRange,
  fetchProjectCycles,
  resolveScheduleWindow,
  leadKeyFor,
  resolveEmployeeByWorkday,
  clearCaches,
};
