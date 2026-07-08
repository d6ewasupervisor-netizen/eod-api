'use strict';

const { sasGet, isSessionAlive } = require('../sas-bridge');
const { filterVisitsByStore, getVisitStoreNumber } = require('../../lib/sas-store-match');
const {
  PROJECT_ID,
  TEAM,
  STORE_IDS,
  VOLUNTEERS,
} = require('./dc-scan-inventory');

function rows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function isRo8Visit(visit) {
  const teamId = visit?.team?.id || visit?.team_id;
  const teamName = visit?.team?.name || visit?.team_name || '';
  return Number(teamId) === TEAM.id || /RO8\s*DC\s*Scans/i.test(String(teamName));
}

function employeeDisplay(shift) {
  const emp = shift?.employee;
  if (!emp || typeof emp === 'number') {
    const id = Number(emp || shift?.employee_id);
    const vol = VOLUNTEERS.find((v) => Number(v.employeeId) === id);
    if (vol) return vol.preferredName || vol.name;
    return id ? `Employee ${id}` : 'Lead';
  }
  const person = emp.person || {};
  const vol = VOLUNTEERS.find((v) => Number(v.employeeId) === Number(emp.id));
  if (vol) return vol.preferredName || vol.name;
  return (
    person.preferred_name ||
    person.full_name ||
    [person.first_name, person.last_name].filter(Boolean).join(' ') ||
    emp.work_email ||
    'Lead'
  );
}

function normalizeVisitStatus(raw) {
  const s = String(raw || 'active').toLowerCase();
  if (s === 'completed' || s === 'complete') return 'completed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return s;
}

async function resolveActiveCycle() {
  const resp = await sasGet('/api/v1/projects/project-cycles/', {
    current_status: 'active',
    page: 1,
    page_size: 10,
    project: PROJECT_ID,
    sort: 'start_date',
  });
  const list = rows(resp.data);
  if (!list.length) throw new Error('No active cycle found for project 8081.');
  return list[0];
}

async function listCycleVisits(cycleId) {
  const resp = await sasGet('/api/v1/team-scheduling/visits/', {
    cycle: cycleId,
    page: 1,
    page_size: 500,
  });
  return rows(resp.data);
}

async function listVisitShifts(visitId) {
  const resp = await sasGet('/api/v1/team-scheduling/shifts/', {
    page: 1,
    page_size: 50,
    visit: visitId,
  });
  return rows(resp.data);
}

function summarizeVisit(visit, shifts) {
  const storeId = getVisitStoreNumber(visit);
  if (!storeId || !STORE_IDS.has(storeId)) return null;

  const leadShift =
    shifts.find((s) => s.is_lead === true || s.is_lead === 'true' || s.is_lead === 1) ||
    shifts[0] ||
    null;

  return {
    storeId,
    scheduledDate: String(visit.scheduled_date || ''),
    visitId: visit.id,
    visitStatus: normalizeVisitStatus(visit.current_status),
    shiftStartTime: visit.shift_start_time || visit.scheduled_start_time || null,
    shiftEndTime: visit.shift_end_time || visit.scheduled_end_time || null,
    teamName: visit.team?.name || visit.team_name || TEAM.name,
    lead: leadShift
      ? {
          shiftId: leadShift.id,
          employeeId: Number(leadShift.employee?.id || leadShift.employee),
          name: employeeDisplay(leadShift),
          shiftStatus: normalizeVisitStatus(leadShift.current_status),
          isLead: true,
        }
      : null,
    shiftCount: shifts.length,
  };
}

/**
 * Pull RO8 DC Scan visits + lead shifts from SAS PROD project 8081
 * for stores in the board inventory within [startDate, endDate].
 */
async function fetchProdSchedule({ startDate, endDate }) {
  if (!isSessionAlive()) {
    return {
      ok: false,
      sessionAlive: false,
      projectId: PROJECT_ID,
      error: 'SAS session is not active on eod-api.',
      visits: [],
      byStoreDate: {},
    };
  }

  try {
    const cycle = await resolveActiveCycle();
    const allVisits = await listCycleVisits(cycle.id);
    const inRange = allVisits.filter((v) => {
      const ymd = String(v.scheduled_date || '');
      if (!ymd || ymd < startDate || ymd > endDate) return false;
      if (!isRo8Visit(v)) return false;
      const storeId = getVisitStoreNumber(v);
      return storeId && STORE_IDS.has(storeId);
    });

    const visits = [];
    for (const visit of inRange) {
      const storeId = getVisitStoreNumber(visit);
      const exact = filterVisitsByStore([visit], storeId);
      if (!exact.length) continue;
      const shifts = await listVisitShifts(visit.id);
      const summary = summarizeVisit(visit, shifts);
      if (summary) visits.push(summary);
    }

    visits.sort((a, b) => {
      const d = a.scheduledDate.localeCompare(b.scheduledDate);
      if (d) return d;
      return Number(a.storeId) - Number(b.storeId);
    });

    const byStoreDate = {};
    for (const v of visits) {
      byStoreDate[`${v.storeId}:${v.scheduledDate}`] = v;
    }

    return {
      ok: true,
      sessionAlive: true,
      projectId: PROJECT_ID,
      cycleId: cycle.id,
      cycleStatus: cycle.current_status || null,
      syncedAt: new Date().toISOString(),
      error: null,
      visits,
      byStoreDate,
    };
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'SAS PROD fetch failed';
    return {
      ok: false,
      sessionAlive: isSessionAlive(),
      projectId: PROJECT_ID,
      error: typeof message === 'string' ? message : JSON.stringify(message),
      visits: [],
      byStoreDate: {},
    };
  }
}

function findProdVisit(liveProd, storeId, scheduledDate) {
  if (!liveProd?.byStoreDate) return null;
  return liveProd.byStoreDate[`${storeId}:${scheduledDate}`] || null;
}

function findProdVisitInWeek(liveProd, storeId, weekStart, weekEnd) {
  if (!liveProd?.visits?.length) return null;
  const matches = liveProd.visits.filter(
    (v) =>
      v.storeId === storeId &&
      v.scheduledDate >= weekStart &&
      v.scheduledDate <= weekEnd,
  );
  if (!matches.length) return null;
  return matches.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
}

function volunteerNameForEmployeeId(employeeId) {
  const vol = VOLUNTEERS.find((v) => Number(v.employeeId) === Number(employeeId));
  return vol ? vol.preferredName || vol.name : null;
}

function volunteerEmailForEmployeeId(employeeId) {
  const vol = VOLUNTEERS.find((v) => Number(v.employeeId) === Number(employeeId));
  return vol?.email || null;
}

module.exports = {
  PROJECT_ID,
  fetchProdSchedule,
  findProdVisit,
  findProdVisitInWeek,
  volunteerNameForEmployeeId,
  volunteerEmailForEmployeeId,
  isRo8Visit,
  resolveActiveCycle,
  listCycleVisits,
};
