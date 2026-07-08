'use strict';

const {
  getPeriodWeekForDate,
  calculateNextWeek,
  formatPeriodWeek,
} = require('./fiscal-calendar');

const PROJECT_ID = 8081;
const PROGRAM_ID = 134;
const TEAM = {
  id: 1802206,
  name: 'RO8 DC Scans',
};

const STORES = [
  { id: '19', label: 'FM 19', city: 'Auburn', state: 'WA', projectStoreId: 2008461 },
  { id: '28', label: 'FM 28', city: 'Burien', state: 'WA', projectStoreId: 2008456 },
  { id: '31', label: 'FM 31', city: 'Renton', state: 'WA', projectStoreId: 2008454 },
  { id: '53', label: 'FM 53', city: 'Covington', state: 'WA', projectStoreId: 2008448 },
  { id: '215', label: 'FM 215', city: 'Kent', state: 'WA', projectStoreId: 2008410 },
  { id: '459', label: 'FM 459', city: 'Renton', state: 'WA', projectStoreId: 2008375 },
  { id: '682', label: 'FM 682', city: 'Maple Valley', state: 'WA', projectStoreId: 2008339 },
];

const STORE_IDS = new Set(STORES.map((s) => s.id));

const VOLUNTEERS = [
  {
    name: 'Ruth Northcutt',
    displayName: 'Ruth Northcutt M',
    email: 'ruth.northcutt@sasretailservices.com',
    alternateEmails: ['ruth.northcutt@advantagesolutions.net'],
    workdayId: '800258911',
    employeeId: 76141,
  },
  {
    name: 'James Duchene',
    displayName: 'James Duchene Ryan',
    email: 'james.duchene@retailodyssey.com',
    workdayId: '800627385',
    employeeId: 394407,
  },
  {
    name: 'Aiyana Natarisalazar',
    displayName: 'Aiyana Natarisalazar Maiingowan',
    preferredName: 'Wolf',
    email: 'aiyana.natarisalazar@retailodyssey.com',
    workdayId: '800386271',
    employeeId: 155473,
  },
];

const DEFAULT_SUPERVISOR_EMAIL = 'tyson.gauthier@retailodyssey.com';

/** Emails granted via supervisor-approved DC Scan access requests. */
const grantedVolunteerEmails = new Set();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailsForVolunteer(volunteer) {
  const out = new Set();
  if (!volunteer) return out;
  const primary = normalizeEmail(volunteer.email);
  if (primary) out.add(primary);
  for (const alt of volunteer.alternateEmails || []) {
    const em = normalizeEmail(alt);
    if (em) out.add(em);
  }
  return out;
}

function normalizeStoreId(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const id = String(Number(digits));
  return STORE_IDS.has(id) ? id : null;
}

function getStore(storeId) {
  const id = normalizeStoreId(storeId);
  return STORES.find((s) => s.id === id) || null;
}

function volunteerEmails() {
  const extra = String(process.env.DC_SCAN_VOLUNTEER_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  const fromVolunteers = VOLUNTEERS.flatMap((v) => [...emailsForVolunteer(v)]);
  return new Set([...fromVolunteers, ...extra, ...grantedVolunteerEmails]);
}

function addGrantedVolunteerEmail(email) {
  const em = normalizeEmail(email);
  if (em) grantedVolunteerEmails.add(em);
}

function setGrantedVolunteerEmails(emails) {
  grantedVolunteerEmails.clear();
  for (const email of emails || []) {
    addGrantedVolunteerEmail(email);
  }
}

function supervisorEmails() {
  const base = [
    DEFAULT_SUPERVISOR_EMAIL,
    process.env.OVERRIDE_APPROVER_EMAIL,
    process.env.SHIFT_REQUEST_APPROVER_EMAIL,
    process.env.DC_SCAN_APPROVER_EMAIL,
  ]
    .map(normalizeEmail)
    .filter(Boolean);
  const extra = String(process.env.DC_SCAN_SUPERVISOR_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  return new Set([...base, ...extra]);
}

function isVolunteerEmail(email) {
  return volunteerEmails().has(normalizeEmail(email));
}

function isSupervisorEmail(email) {
  return supervisorEmails().has(normalizeEmail(email));
}

function findVolunteerByEmail(email) {
  const em = normalizeEmail(email);
  return VOLUNTEERS.find((v) => emailsForVolunteer(v).has(em)) || null;
}

function canParticipateInDcScan(email) {
  return isVolunteerEmail(email) || isSupervisorEmail(email);
}

function pacificYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function weekdayShortPacific(ymd) {
  const noonUtc = new Date(`${ymd}T19:00:00.000Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  }).format(noonUtc);
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekContext(forDate = new Date()) {
  const current = getPeriodWeekForDate(forDate);
  if (!current) throw new Error('Unable to resolve fiscal week.');
  const next = calculateNextWeek(current.period, current.week);
  const weekKey = formatPeriodWeek(current.period, current.week);
  const nextWeekKey = formatPeriodWeek(next.period, next.week);

  // Resolve next week date range from the fiscal calendar using a day inside it.
  const probe = addDaysYmd(current.endDate, 1);
  let nextMeta = getPeriodWeekForDate(new Date(`${probe}T12:00:00`));
  if (!nextMeta || formatPeriodWeek(nextMeta.period, nextMeta.week) !== nextWeekKey) {
    // Walk forward a little in case of gaps.
    let cursor = probe;
    nextMeta = null;
    for (let i = 0; i < 14; i += 1) {
      const meta = getPeriodWeekForDate(new Date(`${cursor}T12:00:00`));
      if (meta && formatPeriodWeek(meta.period, meta.week) === nextWeekKey) {
        nextMeta = meta;
        break;
      }
      cursor = addDaysYmd(cursor, 1);
    }
  }

  return {
    thisWeekKey: weekKey,
    ongoingWeekKey: nextWeekKey,
    thisWeek: {
      weekKey,
      startDate: current.startDate,
      endDate: current.endDate,
      period: current.period,
      week: current.week,
    },
    ongoingWeek: {
      weekKey: nextWeekKey,
      startDate: nextMeta?.startDate || addDaysYmd(current.endDate, 1),
      endDate: nextMeta?.endDate || addDaysYmd(current.endDate, 7),
      period: next.period,
      week: next.week,
    },
    todayYmd: pacificYmd(forDate),
  };
}

/** Wed/Thu/Fri dates inside a fiscal week window (Sun–Sat). */
function wedThuFriDates(weekStartYmd, weekEndYmd) {
  const out = [];
  let cursor = weekStartYmd;
  while (cursor <= weekEndYmd) {
    const wd = weekdayShortPacific(cursor);
    if (wd === 'Wed' || wd === 'Thu' || wd === 'Fri') out.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return out;
}

function thisWeekSlotId(storeId) {
  const id = normalizeStoreId(storeId);
  return id ? `thisWeek:${id}` : null;
}

function ongoingSlotId(weekKey, storeId) {
  const id = normalizeStoreId(storeId);
  const wk = String(weekKey || '').trim();
  return id && wk ? `ongoing:${wk}:${id}` : null;
}

function parseSlotId(slotId) {
  const raw = String(slotId || '').trim();
  if (raw.startsWith('thisWeek:')) {
    const storeId = normalizeStoreId(raw.slice('thisWeek:'.length));
    return storeId ? { scope: 'thisWeek', weekKey: null, storeId, slotId: thisWeekSlotId(storeId) } : null;
  }
  if (raw.startsWith('ongoing:')) {
    const rest = raw.slice('ongoing:'.length);
    const idx = rest.lastIndexOf(':');
    if (idx <= 0) return null;
    const weekKey = rest.slice(0, idx);
    const storeId = normalizeStoreId(rest.slice(idx + 1));
    if (!storeId || !weekKey) return null;
    return { scope: 'ongoing', weekKey, storeId, slotId: ongoingSlotId(weekKey, storeId) };
  }
  return null;
}

function fridayDeadlineIso(weekEndYmd) {
  // Prefer Friday of that week at 5pm Pacific.
  let cursor = weekEndYmd;
  for (let i = 0; i < 7; i += 1) {
    if (weekdayShortPacific(cursor) === 'Fri') {
      return `${cursor}T17:00:00-07:00`;
    }
    cursor = addDaysYmd(cursor, -1);
  }
  return `${weekEndYmd}T17:00:00-07:00`;
}

module.exports = {
  PROJECT_ID,
  PROGRAM_ID,
  TEAM,
  STORES,
  STORE_IDS,
  VOLUNTEERS,
  DEFAULT_SUPERVISOR_EMAIL,
  normalizeEmail,
  normalizeStoreId,
  getStore,
  volunteerEmails,
  supervisorEmails,
  isVolunteerEmail,
  isSupervisorEmail,
  canParticipateInDcScan,
  emailsForVolunteer,
  addGrantedVolunteerEmail,
  setGrantedVolunteerEmails,
  findVolunteerByEmail,
  pacificYmd,
  weekdayShortPacific,
  addDaysYmd,
  weekContext,
  wedThuFriDates,
  thisWeekSlotId,
  ongoingSlotId,
  parseSlotId,
  fridayDeadlineIso,
};
