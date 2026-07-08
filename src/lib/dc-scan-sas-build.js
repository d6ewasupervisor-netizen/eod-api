'use strict';

const axios = require('axios');
const { getHeaders, sasGet, isSessionAlive } = require('../sas-bridge');
const {
  filterVisitsByStore,
  assertVisitStore,
  normalizeStoreNumber,
} = require('../../lib/sas-store-match');
const {
  PROJECT_ID,
  TEAM,
  getStore,
  findVolunteerByEmail,
  weekdayShortPacific,
  normalizeEmail,
} = require('./dc-scan-inventory');
const board = require('./dc-scan-board');

const BASE_URL = 'https://prod.sasretail.com';
const SHIFT_HOURS = 3;

async function sasPost(urlPath, data, refererPath) {
  const headers = getHeaders();
  if (!headers) throw new Error('SAS session not active');
  const opts = {
    headers: {
      ...headers,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    maxBodyLength: Infinity,
    timeout: 60000,
  };
  if (refererPath) {
    opts.headers.Referer = `https://prod.sasretail.com${refererPath}`;
  }
  return axios.post(`${BASE_URL}${urlPath}`, data, opts);
}

function rows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function formatMeridiem(hours, minutes) {
  const h24 = hours;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function parseStartToMinutes(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) {
    return Number(m24[1]) * 60 + Number(m24[2]);
  }
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2]);
    const ap = m12[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }
  return null;
}

function floorStartMinutes(ymd) {
  const wd = weekdayShortPacific(ymd);
  // Wednesday never earlier than 9 AM; other days as early as 6 AM.
  return wd === 'Wed' ? 9 * 60 : 6 * 60;
}

function mileageFlagsForDate(ymd) {
  const wd = weekdayShortPacific(ymd);
  // Wed/Thu: HAR-matched (all on in the captured session). Friday: all on.
  return {
    home_to_store: true,
    store_to_store: true,
    store_to_home: true,
    calculate_mileage: true,
    weekday: wd,
  };
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

function collectOccupiedStarts(visits, ymd) {
  const occupied = new Set();
  for (const v of visits) {
    if (String(v.scheduled_date) !== ymd) continue;
    const teamName = v.team?.name || v.team_name || '';
    const teamId = v.team?.id || v.team_id;
    const isRo8 =
      Number(teamId) === TEAM.id ||
      /RO8\s*DC\s*Scans/i.test(String(teamName));
    if (!isRo8) continue;
    const mins = parseStartToMinutes(v.shift_start_time || v.scheduled_start_time);
    if (mins != null) occupied.add(mins);
  }
  return occupied;
}

function allocateStart(ymd, occupied) {
  let cursor = floorStartMinutes(ymd);
  const latest = 14 * 60; // don't start later than 2 PM for a 3h shift ending by ~5
  while (cursor <= latest) {
    if (!occupied.has(cursor)) {
      occupied.add(cursor);
      const end = cursor + SHIFT_HOURS * 60;
      return {
        startMinutes: cursor,
        endMinutes: end,
        shiftStartTime: formatMeridiem(Math.floor(cursor / 60), cursor % 60),
        shiftEndTime: formatMeridiem(Math.floor(end / 60), end % 60),
        scheduledEndTime: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}:00`,
      };
    }
    cursor += 15;
  }
  throw new Error(`No staggered start slots left on ${ymd} for RO8 DC Scans.`);
}

async function findExistingVisit(visits, storeId, ymd) {
  const forStore = filterVisitsByStore(
    visits.filter((v) => String(v.scheduled_date) === ymd),
    storeId,
  ).filter((v) => {
    const teamId = v.team?.id || v.team_id;
    const teamName = v.team?.name || '';
    return Number(teamId) === TEAM.id || /RO8\s*DC\s*Scans/i.test(String(teamName));
  });
  return forStore[0] || null;
}

async function ensureLeadShift({ visit, employeeId, cycleId, start, end, ymd }) {
  const visitId = visit.id;
  const shiftsResp = await sasGet('/api/v1/team-scheduling/shifts/', {
    page: 1,
    page_size: 50,
    visit: visitId,
  });
  const shifts = rows(shiftsResp.data);
  const existing = shifts.find((s) => Number(s.employee?.id || s.employee) === Number(employeeId));
  if (existing) {
    return { shiftId: existing.id, created: false };
  }

  const mileage = mileageFlagsForDate(ymd);
  const body = {
    home_to_store: mileage.home_to_store,
    store_to_store: mileage.store_to_store,
    store_to_home: mileage.store_to_home,
    calculate_mileage: mileage.calculate_mileage,
    visit: String(visitId),
    employee: Number(employeeId),
    cycle: Number(cycleId),
    shift_start_time: start,
    shift_end_time: end,
    current_status: 'active',
    rate_type: {},
    device_reimbursement: false,
    is_lead: 'true',
  };

  const resp = await sasPost(
    '/api/v1/team-scheduling/shifts/',
    body,
    `/en/sasretail/activation/cycle-services/${cycleId}/manage-shifts/${visitId}`,
  );
  return { shiftId: resp.data?.id, created: true };
}

async function buildOnePledge(pledge, { cycle, visits, occupiedByDate }) {
  const store = getStore(pledge.storeId);
  if (!store) throw new Error(`Unknown store ${pledge.storeId}`);
  const volunteer = findVolunteerByEmail(pledge.email);
  if (!volunteer) throw new Error(`No SAS employee mapping for ${pledge.email}`);

  const ymd = pledge.scheduledDate;
  if (!occupiedByDate.has(ymd)) {
    occupiedByDate.set(ymd, collectOccupiedStarts(visits, ymd));
  }
  const occupied = occupiedByDate.get(ymd);

  let visit = await findExistingVisit(visits, store.id, ymd);
  let startInfo;

  if (visit) {
    assertVisitStore(visit, store.id, 'Existing DC Scan visit');
    const existingStart = parseStartToMinutes(visit.shift_start_time);
    if (existingStart != null) occupied.add(existingStart);
    startInfo = {
      shiftStartTime: visit.shift_start_time,
      shiftEndTime: visit.shift_end_time,
      scheduledEndTime: visit.scheduled_end_time,
    };
  } else {
    startInfo = allocateStart(ymd, occupied);
    const visitBody = {
      cycle: Number(cycle.id),
      store: { id: store.projectStoreId },
      team: { id: TEAM.id, name: TEAM.name, teammates: [] },
      scheduled_date: ymd,
      due_by: ymd,
      shift_start_time: startInfo.shiftStartTime,
      shift_end_time: startInfo.shiftEndTime,
      scheduled_end_time: startInfo.scheduledEndTime,
      estimated_shift_hours: Number(SHIFT_HOURS).toFixed(2),
      current_status: 'active',
    };
    const created = await sasPost(
      '/api/v1/team-scheduling/visits/',
      visitBody,
      `/en/sasretail/activation/cycle-services/${cycle.id}/team-scheduling`,
    );
    visit = created.data;
    assertVisitStore(visit, store.id, 'Created DC Scan visit');
    visits.push(visit);
  }

  const shift = await ensureLeadShift({
    visit,
    employeeId: volunteer.employeeId,
    cycleId: cycle.id,
    start: startInfo.shiftStartTime,
    end: startInfo.shiftEndTime,
    ymd,
  });

  return {
    ok: true,
    visitId: visit.id,
    shiftId: shift.shiftId,
    startTime: startInfo.shiftStartTime,
    endTime: startInfo.shiftEndTime,
    reusedVisit: Boolean(visit && visit.id),
  };
}

async function buildFinalizedPledges(pledges) {
  if (!isSessionAlive()) {
    throw new Error('SAS session is not active. Refresh morning-auth, then retry finalize.');
  }
  const cycle = await resolveActiveCycle();
  const visits = await listCycleVisits(cycle.id);
  const occupiedByDate = new Map();
  const results = [];

  // Stable order by date then store for staggered assignment predictability.
  const ordered = pledges
    .slice()
    .filter((p) => p.buildStatus !== 'built')
    .sort((a, b) => {
      const d = String(a.scheduledDate).localeCompare(String(b.scheduledDate));
      if (d) return d;
      return Number(a.storeId) - Number(b.storeId);
    });

  for (const pledge of ordered) {
    try {
      // Skip rebuild if already has SAS ids
      if (pledge.sasVisitId && pledge.sasShiftId) {
        await board.markPledgeBuildResult(pledge.id, {
          ok: true,
          visitId: pledge.sasVisitId,
          shiftId: pledge.sasShiftId,
        });
        results.push({ pledgeId: pledge.id, ok: true, skipped: true });
        continue;
      }
      const out = await buildOnePledge(pledge, { cycle, visits, occupiedByDate });
      await board.markPledgeBuildResult(pledge.id, out);
      results.push({ pledgeId: pledge.id, storeId: pledge.storeId, ...out });
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        'Build failed';
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      await board.markPledgeBuildResult(pledge.id, { ok: false, error: text });
      results.push({ pledgeId: pledge.id, storeId: pledge.storeId, ok: false, error: text });
    }
  }

  return { cycleId: cycle.id, results };
}

module.exports = {
  buildFinalizedPledges,
  mileageFlagsForDate,
  allocateStart,
  floorStartMinutes,
  parseStartToMinutes,
};
