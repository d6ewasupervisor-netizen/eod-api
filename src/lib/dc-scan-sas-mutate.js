'use strict';

/**
 * SAS PROD mutations for DC Scan board self-serve changes:
 * - reschedule visit dates (scheduled_date + due_by)
 * - reassign lead (delete old lead shift, create new lead)
 */

const axios = require('axios');
const { getHeaders, sasGet, sasPatch, isSessionAlive } = require('../sas-bridge');
const { assertVisitStore } = require('../../lib/sas-store-match');
const { weekdayShortPacific } = require('./dc-scan-inventory');

const BASE_URL = 'https://prod.sasretail.com';

function mileageFlagsForDate(ymd) {
  const wd = weekdayShortPacific(ymd);
  return {
    home_to_store: true,
    store_to_store: true,
    store_to_home: true,
    calculate_mileage: true,
    weekday: wd,
  };
}

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

async function getVisit(visitId) {
  const resp = await sasGet(`/api/v1/team-scheduling/visits/${visitId}/`);
  return resp.data;
}

async function listVisitShifts(visitId) {
  const resp = await sasGet('/api/v1/team-scheduling/shifts/', {
    page: 1,
    page_size: 50,
    visit: visitId,
  });
  return rows(resp.data);
}

/**
 * Cycle management: change scheduled_date and due_by on the visit.
 */
async function rescheduleVisitDates({ visitId, storeId, newDate }) {
  if (!isSessionAlive()) {
    throw new Error('SAS session is not active. Use Resync SAS PROD, then retry.');
  }
  const visit = await getVisit(visitId);
  if (!visit?.id) throw new Error(`Visit ${visitId} not found in SAS PROD.`);
  assertVisitStore(visit, storeId, 'Reschedule DC Scan visit');

  const cycleId = visit.cycle?.id || visit.cycle;
  const body = {
    scheduled_date: newDate,
    due_by: newDate,
  };

  const resp = await sasPatch(`/api/v1/team-scheduling/visits/${visitId}/`, body);
  return {
    ok: true,
    visitId: Number(visitId),
    scheduledDate: newDate,
    cycleId: cycleId || null,
    data: resp.data || null,
  };
}

/**
 * Reassign lead: soft-delete old lead shift, create new lead for taker.
 * Does not cancel the visit — only swaps who owns the lead shift.
 */
async function reassignVisitLead({
  visitId,
  storeId,
  fromEmployeeId,
  toEmployeeId,
  shiftId,
  scheduledDate,
}) {
  if (!isSessionAlive()) {
    throw new Error('SAS session is not active. Use Resync SAS PROD, then retry.');
  }
  const visit = await getVisit(visitId);
  if (!visit?.id) throw new Error(`Visit ${visitId} not found in SAS PROD.`);
  assertVisitStore(visit, storeId, 'Reassign DC Scan visit lead');

  const cycleId = Number(visit.cycle?.id || visit.cycle);
  if (!cycleId) throw new Error('Visit is missing cycle id.');

  const shifts = await listVisitShifts(visitId);
  const active = shifts.filter((s) => String(s.current_status || '') === 'active');
  let oldLead =
    (shiftId && active.find((s) => Number(s.id) === Number(shiftId))) ||
    active.find((s) => {
      const emp = Number(s.employee?.id || s.employee);
      return (
        (s.is_lead === true || s.is_lead === 'true' || s.is_lead === 1) &&
        emp === Number(fromEmployeeId)
      );
    }) ||
    active.find((s) => Number(s.employee?.id || s.employee) === Number(fromEmployeeId));

  if (!oldLead) {
    throw new Error(
      `Could not find active lead shift for employee ${fromEmployeeId} on visit ${visitId}.`,
    );
  }

  const existingTaker = active.find(
    (s) => Number(s.employee?.id || s.employee) === Number(toEmployeeId),
  );

  await sasPatch(`/api/v1/team-scheduling/shifts/${oldLead.id}/`, {
    current_status: 'deleted',
  });

  if (existingTaker && Number(existingTaker.id) !== Number(oldLead.id)) {
    await sasPatch(`/api/v1/team-scheduling/shifts/${existingTaker.id}/`, {
      current_status: 'deleted',
    });
  }

  const ymd = scheduledDate || String(visit.scheduled_date || '');
  const mileage = mileageFlagsForDate(ymd);
  const start = visit.shift_start_time || '9:00 AM';
  const end = visit.shift_end_time || '12:00 PM';

  const created = await sasPost(
    '/api/v1/team-scheduling/shifts/',
    {
      home_to_store: mileage.home_to_store,
      store_to_store: mileage.store_to_store,
      store_to_home: mileage.store_to_home,
      calculate_mileage: mileage.calculate_mileage,
      visit: String(visitId),
      employee: Number(toEmployeeId),
      cycle: cycleId,
      shift_start_time: start,
      shift_end_time: end,
      current_status: 'active',
      rate_type: {},
      device_reimbursement: false,
      is_lead: 'true',
    },
    `/en/sasretail/activation/cycle-services/${cycleId}/manage-shifts/${visitId}`,
  );

  return {
    ok: true,
    visitId: Number(visitId),
    oldShiftId: oldLead.id,
    newShiftId: created.data?.id || null,
    toEmployeeId: Number(toEmployeeId),
  };
}

module.exports = {
  rescheduleVisitDates,
  reassignVisitLead,
  getVisit,
};
