'use strict';

/**
 * Helpers for POST /api/v1/team-scheduling/visits/
 *
 * Confirmed PROD (2026-06-25): bare integer store/team ids and missing visit_id/due_by
 * cause 500 "'int' object has no attribute 'get'". Use buildVisitCreateBody().
 */

function addMinutesToDisplayTime(display, minutes) {
  const m = String(display || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Invalid display time: ${display}`);
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  let total = hour * 60 + min + Number(minutes);
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const ap2 = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${ap2}`;
}

/**
 * Composite visit_id for a NEW visit (no DB id prefix yet).
 * Pattern from live visits: teamId + accountStoreId + projectId + cycleId.
 */
function buildNewVisitId(sourceVisit) {
  const teamId = sourceVisit.team?.id;
  const accountStoreId = sourceVisit.store?.store?.id;
  const projectId = sourceVisit.store?.project?.id;
  const cycleId = sourceVisit.cycle;
  if (!teamId || !accountStoreId || !projectId || !cycleId) {
    throw new Error('Source visit missing team, account store, project, or cycle for visit_id');
  }
  return String(teamId) + String(accountStoreId) + String(projectId) + String(cycleId);
}

/**
 * @param {object} sourceVisit - full GET /team-scheduling/visits/{id}/
 * @param {string} destDate - YYYY-MM-DD
 * @param {{ startOffsetMinutes?: number, shiftStartTime?: string, shiftEndTime?: string, scheduledEndTime?: string, estimatedShiftHours?: string }} [opts]
 */
function buildVisitCreateBody(sourceVisit, destDate, opts = {}) {
  const startOffset = Number(opts.startOffsetMinutes || 0);
  const shiftStartTime =
    opts.shiftStartTime ||
    (startOffset
      ? addMinutesToDisplayTime(sourceVisit.shift_start_time, startOffset)
      : sourceVisit.shift_start_time);
  const shiftEndTime = opts.shiftEndTime || sourceVisit.shift_end_time;
  const scheduledEndTime = opts.scheduledEndTime || sourceVisit.scheduled_end_time;

  return {
    cycle: sourceVisit.cycle,
    store: { id: sourceVisit.store.id },
    team: sourceVisit.team,
    scheduled_date: destDate,
    due_by: destDate,
    visit_id: buildNewVisitId(sourceVisit),
    shift_start_time: shiftStartTime,
    shift_end_time: shiftEndTime,
    scheduled_end_time: scheduledEndTime,
    estimated_shift_hours: opts.estimatedShiftHours || sourceVisit.estimated_shift_hours || '8.00',
    current_status: 'active',
  };
}

function teamSchedulingReferer(cycleId) {
  return `https://prod.sasretail.com/en/sasretail/activation/cycle-services/${cycleId}/team-scheduling`;
}

module.exports = {
  addMinutesToDisplayTime,
  buildNewVisitId,
  buildVisitCreateBody,
  teamSchedulingReferer,
};
