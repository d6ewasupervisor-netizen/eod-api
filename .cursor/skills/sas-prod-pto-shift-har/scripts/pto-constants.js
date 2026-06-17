'use strict';

/** HAR source: sas-har-20260617-150709.json (sick shift, Alexandra Wright, 2026-06-17). */

module.exports = {
  DEFAULT_PROJECT_ID: 147,
  DEFAULT_PROJECT_NAME: 'Fred Meyer InHouse NonBillable Admin',
  DEFAULT_PROGRAM_ID: 92,
  DEFAULT_STORE_NUMBER: 999,
  DEFAULT_TEAM_ID: 989886,
  DEFAULT_TEAM_NAME: 'PTO',
  DEFAULT_SHIFT_START: '07:00 AM',
  DEFAULT_SHIFT_END: '03:00 PM',
  DEFAULT_SCHEDULED_END_TIME: '15:00:00',
  DEFAULT_ESTIMATED_HOURS: '8.00',
  /** shift-break-reasons from HAR GET /team-scheduling/shift-break-reasons/ */
  BREAK_REASONS: {
    sick: 4,
    holiday: 5,
    vacation: 6,
    bereavement: 7,
    jury_duty: 8,
  },
  /** operations/time-change-reason/?is_admin=true — HAR used id 5 */
  DEFAULT_TIME_CHANGE_REASON: 5,
  DEFAULT_TIME_CHANGE_COMMENT: 'Supervisor PTO entry',
};
