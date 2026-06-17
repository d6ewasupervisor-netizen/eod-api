#!/usr/bin/env node
'use strict';

/**
 * Reassign visit lead(s) in SAS PROD for a target date.
 *
 * Usage:
 *   node reassign-lead-by-date.js --date 2026-06-17 --from "Alexandra Wright" --to "Aiyana Natarisalazar" --store 28
 *   node reassign-lead-by-date.js --from "Alexandra Wright" --to "Aiyana Natarisalazar" --dry-run
 *
 * Auth: sas-auth/.sas-session/auth-state.json (see sas-auth-prod-session skill)
 */

const fs = require('fs');
const {
  getVisitStoreNumber,
  storesMatch,
} = require('./sas-store-match');

const DEFAULT_STATE = 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
const BASE = 'https://prod.sasretail.com/api/v1';
const PROJECTS = [1, 1668, 1715, 3568];

function parseArgs(argv) {
  const opts = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--from') opts.fromName = argv[++i];
    else if (arg === '--to') opts.toName = argv[++i];
    else if (arg === '--store') opts.storeNumber = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function usage() {
  console.log(`Usage:
  node reassign-lead-by-date.js --from "Old Lead" --to "New Lead" [--date YYYY-MM-DD] [--store N] [--dry-run]

Defaults date to tomorrow. Scans Kompass projects 1, 1668, 1715, 3568.
When --store is set, only visits whose store number exactly matches N are included.`);
}

function loadSession() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const token = state?.auth?.auth_token;
  if (!token) throw new Error(`No auth_token in ${statePath}`);
  return {
    token: String(token),
    csrf: state.csrfToken || state.cookies?.csrftoken || '',
    cookieHeader: state.cookieHeader || '',
  };
}

function rows(data) {
  return Array.isArray(data) ? data : data?.results || [];
}

function isLead(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function empId(shift) {
  return shift.employee?.id ?? shift.employee;
}

function empName(shiftOrEmp) {
  const e = shiftOrEmp.employee || shiftOrEmp;
  return e.person?.person_name || e.person_name || '';
}

function visitIdFromShift(shift) {
  return typeof shift.visit === 'object' ? shift.visit.id : shift.visit;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.fromName || !opts.toName) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const targetDate = opts.date || tomorrowIso();
  const session = loadSession();

  async function sas(method, apiPath, body) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Token ${session.token}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (session.csrf) headers['X-CSRFToken'] = session.csrf;
      if (session.cookieHeader) headers.Cookie = session.cookieHeader;
    }
    const res = await fetch(BASE + apiPath, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(`${method} ${apiPath} ${res.status}: ${String(text).slice(0, 400)}`);
    }
    return data;
  }

  async function searchEmployee(q) {
    const encoded = encodeURIComponent(`"${q}"`);
    const data = await sas(
      'GET',
      `/human-resources/workday-employees/?address_verified=true&fields=id,person_name,workday_given_id,person&page_size=10&q=${encoded}&sort=person__person_name`
    );
    const list = rows(data);
    const needle = q.toLowerCase();
    const exact = list.find((e) => empName(e).toLowerCase() === needle);
    const partial = list.find((e) => empName(e).toLowerCase().includes(needle));
    return exact || partial || list[0] || null;
  }

  async function fetchAllPages(path) {
    const all = [];
    for (let page = 1; page <= 50; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await sas('GET', `${path}${sep}page=${page}&page_size=500`);
      const chunk = rows(data);
      all.push(...chunk);
      if (chunk.length < 500) break;
    }
    return all;
  }

  const oldLead = await searchEmployee(opts.fromName);
  const newLead = await searchEmployee(opts.toName);
  if (!oldLead) throw new Error(`Could not resolve employee: ${opts.fromName}`);
  if (!newLead) throw new Error(`Could not resolve employee: ${opts.toName}`);

  const oldId = oldLead.id;
  const newId = newLead.id;
  console.log(`Date: ${targetDate}`);
  if (opts.storeNumber) console.log(`Store filter (exact): ${opts.storeNumber}`);
  console.log(`From: ${empName(oldLead)} (id=${oldId})`);
  console.log(`To:   ${empName(newLead)} (id=${newId})`);
  if (opts.dryRun) console.log('Mode: dry-run (no mutations)');

  const byVisit = new Map();

  for (const projectId of PROJECTS) {
    const cycles = rows(
      await sas(
        'GET',
        `/projects/project-cycles/?current_status=active&page=1&page_size=100&project=${projectId}&sort=start_date`
      )
    );
    const cycle = cycles.find(
      (c) => String(c.start_date || '') <= targetDate && String(c.end_date || '') >= targetDate
    );
    if (!cycle) continue;

    const shifts = await fetchAllPages(
      `/team-scheduling/shifts/?current_status=active&cycle=${cycle.id}&employee=${oldId}`
    );
    for (const shift of shifts) {
      if (!isLead(shift.is_lead)) continue;
      const visitId = visitIdFromShift(shift);
      if (byVisit.has(Number(visitId))) continue;

      const visit = await sas('GET', `/team-scheduling/visits/${visitId}/`);
      if (String(visit.scheduled_date) !== targetDate) continue;
      if (!['active', 'in-progress'].includes(String(visit.current_status || ''))) continue;
      if (opts.storeNumber && !storesMatch(getVisitStoreNumber(visit), opts.storeNumber)) continue;

      const storeNum = getVisitStoreNumber(visit) || '?';
      const projectName =
        visit.store?.project?.name || visit.project?.name || `project ${projectId}`;
      byVisit.set(Number(visitId), {
        projectId,
        projectName,
        cycleId: cycle.id,
        visitId,
        storeNum,
        shiftId: shift.id,
        visit,
      });
    }
  }

  const matches = [...byVisit.values()];
  console.log(`Found ${matches.length} visit(s) with ${opts.fromName} as lead`);
  for (const m of matches) {
    console.log(` - ${m.projectName} store ${m.storeNum} visit ${m.visitId} shift ${m.shiftId}`);
  }

  if (matches.length === 0 || opts.dryRun) return;

  const results = [];
  for (const m of matches) {
    const visit = m.visit;
    const visitShifts = rows(
      await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${m.visitId}`)
    );
    const active = visitShifts.filter((s) => s.current_status === 'active');
    const newLeadShift = active.find((s) => Number(empId(s)) === Number(newId));

    try {
      await sas('PATCH', `/team-scheduling/shifts/${m.shiftId}/`, { current_status: 'deleted' });
      if (newLeadShift) {
        await sas('PATCH', `/team-scheduling/shifts/${newLeadShift.id}/`, {
          current_status: 'deleted',
        });
      }
      const created = await sas('POST', '/team-scheduling/shifts/', {
        home_to_store: true,
        store_to_store: true,
        store_to_home: true,
        calculate_mileage: true,
        visit: String(m.visitId),
        employee: Number(newId),
        cycle: Number(m.cycleId),
        shift_start_time: visit.shift_start_time,
        shift_end_time: visit.shift_end_time,
        current_status: 'active',
        rate_type: {},
        device_reimbursement: false,
        is_lead: 'true',
      });
      results.push({
        project: m.projectName,
        store: m.storeNum,
        visitId: m.visitId,
        ok: true,
        newShiftId: created?.id,
      });
    } catch (err) {
      results.push({
        project: m.projectName,
        store: m.storeNum,
        visitId: m.visitId,
        ok: false,
        error: err.message,
      });
    }
  }

  console.log('Results:', JSON.stringify(results, null, 2));

  const fieldVisits = rows(
    await sas(
      'GET',
      `/operations/field-data/?customer_id=2&program_id=1&scheduled_dt_from=${targetDate}&scheduled_dt_to=${targetDate}&page=1&page_size=500&merchandiser=&supervisor_id=`
    )
  );
  const oldCount = fieldVisits.filter((v) =>
    String(v.visit_lead || '').toLowerCase().includes(opts.fromName.toLowerCase())
  ).length;
  const newCount = fieldVisits.filter((v) =>
    String(v.visit_lead || '').toLowerCase().includes(opts.toName.toLowerCase())
  ).length;
  console.log(`Field-data check: ${oldCount} old-lead visit(s), ${newCount} new-lead visit(s) on ${targetDate}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
