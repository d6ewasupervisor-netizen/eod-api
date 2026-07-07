// Resolve hub overseer (supervisor email) and display order for Checklane store hub.

const { query } = require('./db');

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Default overseer order — matches KOMPASS_SUPERVISOR_EMAILS in .env.example */
const DEFAULT_OVERSEER_EMAILS = [
  'tyson.gauthier@retailodyssey.com',
  'amanda.mathews@retailodyssey.com',
  'seth.newman@retailodyssey.com',
  'mashabranner@retailodyssey.com',
  'richard.beck@fredmeyer.com',
  'aiyana.natarisalazar@retailodyssey.com',
];

const OVERSEER_WORKDAY_BY_EMAIL = new Map([
  ['tyson.gauthier@retailodyssey.com', '800175315'],
  ['amanda.mathews@retailodyssey.com', '800556154'],
  ['seth.newman@retailodyssey.com', '800263453'],
  ['mashabranner@retailodyssey.com', '800165906'],
  ['richard.beck@fredmeyer.com', '800184474'],
  ['rbeck@retailodyssey.com', '800184474'],
]);

function hubOverseerEmails() {
  const fromEnv = parseEmailList(process.env.KOMPASS_SUPERVISOR_EMAILS);
  return fromEnv.length ? fromEnv : DEFAULT_OVERSEER_EMAILS;
}

function hubOverseerWorkdayIds() {
  const emails = hubOverseerEmails();
  const ids = new Set();
  for (const email of emails) {
    const wd = OVERSEER_WORKDAY_BY_EMAIL.get(email);
    if (wd) ids.add(wd);
  }
  return ids;
}

function normalizeToken(value) {
  return (value || '').trim().toLowerCase();
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeToken(value));
}

function nameTokens(value) {
  return normalizeToken(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function namesLikelyMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const overlap = ta.filter((t) => tb.includes(t));
  return overlap.length >= Math.min(2, Math.min(ta.length, tb.length));
}

async function loadEmployeeLookup() {
  const { rows } = await query(
    `SELECT sas_employee_id, workday_id, name, email, supervisor_id, supervisor_name
     FROM employees
     WHERE workday_id IS NOT NULL OR email IS NOT NULL OR name IS NOT NULL`,
  );

  const byWorkday = new Map();
  const byEmail = new Map();
  const byName = new Map();

  for (const row of rows) {
    const entry = {
      workdayId: row.workday_id ? String(row.workday_id) : null,
      email: normalizeToken(row.email),
      name: row.name || '',
      supervisorId: row.supervisor_id ? String(row.supervisor_id) : null,
      supervisorName: row.supervisor_name || '',
    };
    if (entry.workdayId) byWorkday.set(entry.workdayId, entry);
    if (entry.email) byEmail.set(entry.email, entry);
    const nameKey = normalizeToken(entry.name);
    if (nameKey) byName.set(nameKey, entry);
  }

  return { byWorkday, byEmail, byName, rows };
}

function findEmployeeByHint(hint, lookup) {
  const token = normalizeToken(hint);
  if (!token) return null;
  if (looksLikeEmail(token)) return lookup.byEmail.get(token) || null;

  const direct = lookup.byName.get(token);
  if (direct) return direct;

  for (const row of lookup.rows) {
    if (namesLikelyMatch(token, row.name)) return {
      workdayId: row.workday_id ? String(row.workday_id) : null,
      email: normalizeToken(row.email),
      name: row.name || '',
      supervisorId: row.supervisor_id ? String(row.supervisor_id) : null,
      supervisorName: row.supervisor_name || '',
    };
  }
  return null;
}

function overseerEmailForWorkday(workdayId, lookup) {
  const overseerIds = hubOverseerWorkdayIds();
  const overseerEmails = hubOverseerEmails();
  const emailByWorkday = new Map();
  for (const [email, wd] of OVERSEER_WORKDAY_BY_EMAIL) {
    if (overseerEmails.includes(email)) emailByWorkday.set(wd, email);
  }

  let current = workdayId ? String(workdayId) : null;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (overseerIds.has(current)) {
      return emailByWorkday.get(current)
        || overseerEmails.find((e) => OVERSEER_WORKDAY_BY_EMAIL.get(e) === current)
        || null;
    }
    const emp = lookup.byWorkday.get(current);
    if (!emp?.supervisorId) break;
    current = emp.supervisorId;
  }
  return null;
}

/**
 * Map a field-data supervisor string or visit lead to a hub overseer email.
 */
function resolveHubOverseerEmail({ supervisorRaw, visitLead }, lookup) {
  const overseerEmails = hubOverseerEmails();

  const supRaw = normalizeToken(supervisorRaw);
  if (supRaw && looksLikeEmail(supRaw)) {
    if (overseerEmails.includes(supRaw)) return supRaw;
    const emp = lookup.byEmail.get(supRaw);
    if (emp?.workdayId) {
      const resolved = overseerEmailForWorkday(emp.workdayId, lookup);
      if (resolved) return resolved;
    }
  }

  if (supervisorRaw) {
    const supEmp = findEmployeeByHint(supervisorRaw, lookup);
    if (supEmp?.workdayId) {
      const resolved = overseerEmailForWorkday(supEmp.workdayId, lookup);
      if (resolved) return resolved;
    }
    if (namesLikelyMatch(supervisorRaw, 'Tyson Gauthier')) return 'tyson.gauthier@retailodyssey.com';
    if (namesLikelyMatch(supervisorRaw, 'Amanda Mathews')) return 'amanda.mathews@retailodyssey.com';
    if (namesLikelyMatch(supervisorRaw, 'Seth Newman')) return 'seth.newman@retailodyssey.com';
    if (namesLikelyMatch(supervisorRaw, 'Michael Ashabranner')) return 'mashabranner@retailodyssey.com';
    if (namesLikelyMatch(supervisorRaw, 'Richard Beck')) return 'richard.beck@fredmeyer.com';
  }

  if (visitLead) {
    const leadEmp = findEmployeeByHint(visitLead, lookup);
    if (leadEmp?.supervisorId) {
      const resolved = overseerEmailForWorkday(leadEmp.supervisorId, lookup);
      if (resolved) return resolved;
    }
    if (leadEmp?.workdayId) {
      const resolved = overseerEmailForWorkday(leadEmp.workdayId, lookup);
      if (resolved) return resolved;
    }
  }

  return overseerEmails[0] || null;
}

function supervisorSortIndex(supervisorKey) {
  const key = normalizeToken(supervisorKey);
  if (!key || key === '__unassigned__') return 9999;
  const order = hubOverseerEmails();
  const idx = order.indexOf(key);
  return idx >= 0 ? idx : 9000 + key.charCodeAt(0);
}

function formatPersonLabel(value) {
  const s = (value || '').trim();
  if (!s) return null;
  if (s.includes('@')) {
    const local = s.split('@')[0];
    return local
      .split(/[._+-]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }
  return s;
}

function supervisorGroupKey(supervisor) {
  const s = normalizeToken(supervisor);
  if (!s) return '__unassigned__';
  return s;
}

function pacificTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

/** Today (PT) through end of calendar week (Sunday) or +6 days, whichever is sooner. */
function remainderOfWeekWindow(fromIso) {
  const from = fromIso || pacificTodayIso();
  const start = new Date(`${from}T12:00:00`);
  const day = start.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const end = new Date(start);
  end.setDate(end.getDate() + Math.max(daysUntilSunday, 0));
  const cap = new Date(start);
  cap.setDate(cap.getDate() + 6);
  const toDate = end > cap ? cap : end;
  return {
    from,
    to: toDate.toISOString().slice(0, 10),
  };
}

module.exports = {
  hubOverseerEmails,
  loadEmployeeLookup,
  findEmployeeByHint,
  resolveHubOverseerEmail,
  supervisorSortIndex,
  supervisorGroupKey,
  formatPersonLabel,
  pacificTodayIso,
  remainderOfWeekWindow,
};
