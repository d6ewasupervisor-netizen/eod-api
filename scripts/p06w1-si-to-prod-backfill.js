#!/usr/bin/env node
'use strict';

/**
 * P06W1 signoff verify — SI complete / PROD not backfill for Districts 1, 6, 8.
 *
 * Per visit batch (store + period week + workbook kind):
 *   - Upload fixed before photo + Rebotics after photos (bay-aligned)
 *   - Assign visit lead at 0m, mark set complete, recomplete visit once
 *
 * Usage:
 *   node scripts/p06w1-si-to-prod-backfill.js --dry-run
 *   node scripts/p06w1-si-to-prod-backfill.js --apply
 *   node scripts/p06w1-si-to-prod-backfill.js --apply --store 49 --limit 1
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sasBridge = require('../src/sas-bridge');
const { writeFileVersioned } = require('../src/lib/file-utils');
const { DISTRICT_STORES } = require('../src/lib/trackers/metadata');
const { loadSasSession } = require('../../kompass-netcap/lib/sas-session');
const { weekToDate } = require('../../kompass-netcap/lib/reference-data');
const { pogFromSasPlanogramId } = require('../../kompass-netcap/lib/image-sync/pog-match');
const {
  assertVisitStore,
  getFieldDataStoreNumber,
  normalizeStoreNumber,
} = require('../../kompass-netcap/lib/sas-store-match');

const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const DISCREPANCY_JSON = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/P06W1_signoff_verify_discrepancies_2026-06-21T16-36-53.json';
const BEFORE_PHOTO = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/samples/701-00661_cat4_pog9011792_BAY1_P05W3_task39166297_action23580254.jpg';
let OUT_ROOT = 'C:/Users/tgaut/Downloads/p06w1_signoff_verify/sitoprod';
const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const DISTRICTS = [1, 6, 8];
const PROJECT_BY_KIND = {
  ise: [1, 1668, 3568],
  blitz: [1715],
};
const PAUSE_MS = 350;

function parseArgs(argv) {
  const opts = {
    apply: false,
    dryRun: true,
    store: null,
    limit: null,
    discrepancyPath: DISCREPANCY_JSON,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') { opts.apply = true; opts.dryRun = false; }
    else if (a === '--dry-run') { opts.dryRun = true; opts.apply = false; }
    else if (a === '--store') opts.store = normalizeStoreNumber(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--discrepancies') opts.discrepancyPath = argv[++i];
    else if (a === '--out-root') opts.outRoot = argv[++i];
  }
  if (opts.outRoot) OUT_ROOT = opts.outRoot;
  return opts;
}

function districtStoreSet() {
  const out = new Set();
  for (const d of DISTRICTS) {
    for (const store of DISTRICT_STORES[d] || []) out.add(String(store));
  }
  return out;
}

function districtForStore(store) {
  const n = normalizeStoreNumber(store);
  for (const d of DISTRICTS) {
    if ((DISTRICT_STORES[d] || []).map(String).includes(n)) return d;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadReboticsEnv() {
  const envPath = path.join(REBOTICS_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function loadReboticsApi() {
  loadReboticsEnv();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

async function bootstrapAuth() {
  const sas = await loadSasSession();
  if (!sas.token) throw new Error('SAS auth_token missing; refresh sas-auth session.');
  if (sas.cookieHeader && sas.csrfToken) {
    sasBridge.applySession({
      cookieHeader: sas.cookieHeader,
      csrfToken: sas.csrfToken,
      source: sas.source,
    });
  }
  const api = loadReboticsApi();
  const auth = await api.fetchTokenFromRailway();
  if (!auth?.token) throw new Error('Rebotics token unavailable.');
  return { sasToken: sas.token, reboticsApi: api, reboticsToken: auth.token };
}

async function sasRequest(token, method, apiPath, body) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Token ${token}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  let url = `${SAS_BASE}${apiPath}`;
  let payload = body;
  if (method === 'GET' && body && typeof body === 'object' && !Array.isArray(body)) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(body).filter(([, v]) => v != null && v !== '')),
    ).toString();
    url = `${url}${apiPath.includes('?') ? '&' : '?'}${qs}`;
    payload = undefined;
  } else if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`SAS ${method} ${apiPath} -> ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function getFieldVisits(token, storeNumber, dateIso, projectId) {
  const data = await sasRequest(token, 'GET', '/operations/field-data/', {
    customer_id: 2,
    program_id: 1,
    project_id: projectId,
    scheduled_dt_from: dateIso,
    scheduled_dt_to: dateIso,
    page: 1,
    page_size: 50,
  });
  const rows = Array.isArray(data) ? data : (data.results || data.data || []);
  return rows.filter((row) => normalizeStoreNumber(getFieldDataStoreNumber(row)) === normalizeStoreNumber(storeNumber));
}

async function getFullResets(token, visitId) {
  const data = await sasRequest(token, 'GET', `/field-app/visits/${visitId}/category-resets/`);
  return data?.category_resets || [];
}

function pickLeadShift(shifts) {
  const usable = (shifts || []).filter(
    (s) => !['deleted', 'cancelled'].includes(String(s.current_status || '').toLowerCase()),
  );
  return usable.find((s) => s.is_lead === true || s.is_lead === 'true' || s.is_lead === 1)
    || usable[0]
    || null;
}

async function getVisitShifts(token, visitId) {
  const data = await sasRequest(token, 'GET', '/team-scheduling/shifts/', {
    visit: visitId,
    page: 1,
    page_size: 50,
  });
  return Array.isArray(data) ? data : (data.results || data.data || []);
}

function summarizeReset(reset) {
  return {
    id: reset.id,
    name: reset.name,
    planogramId: reset.planogram_id,
    pog: pogFromSasPlanogramId(reset.planogram_id),
    resetType: reset.reset_type,
    completed: Boolean(reset.completed),
    categoryCompletion: Boolean(reset.category_completion),
    beforeCount: reset.state?.before?.count || 0,
    afterCount: reset.state?.after?.count || 0,
    team: Array.isArray(reset.team) ? reset.team : [],
  };
}

async function resolveVisitForBatch(token, store, visitDate, workbookKind, dbkeys) {
  const projects = PROJECT_BY_KIND[workbookKind] || PROJECT_BY_KIND.ise;
  const wanted = new Set(dbkeys.map(String));
  let best = null;

  for (const projectId of projects) {
    const visits = await getFieldVisits(token, store, visitDate, projectId);
    for (const visit of visits) {
      const visitId = visit.id;
      const storeNum = getFieldDataStoreNumber(visit);
      if (normalizeStoreNumber(storeNum) !== normalizeStoreNumber(store)) continue;
      const resets = (await getFullResets(token, visitId))
        .filter((r) => r.reset_type !== 'MAINTENANCE' && wanted.has(pogFromSasPlanogramId(r.planogram_id)));
      if (!resets.length) continue;
      const candidate = {
        visitId,
        projectId,
        status: visit.current_status || visit.status,
        scheduledDate: visit.scheduled_date || visitDate,
        matchedPogs: resets.map((r) => pogFromSasPlanogramId(r.planogram_id)),
      };
      if (!best || candidate.matchedPogs.length > best.matchedPogs.length) best = candidate;
    }
  }
  return best;
}

function imageUrlFromPrePhoto(entry) {
  return entry?.file?.file || entry?.merged_image || entry?.image || null;
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty image');
  return buf;
}

async function siAfterPhotos(reboticsApi, token, taskId) {
  const task = await reboticsApi.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  const actions = (task?.result?.pre_photo || [])
    .map((action, idx) => ({
      actionId: action?.id ?? action?.action_id,
      bay: Number.parseInt(action?.section_info?.name, 10) || idx + 1,
      url: imageUrlFromPrePhoto(action),
    }))
    .filter((a) => a.actionId && a.url);
  return { task, actions };
}

async function uploadResetPhoto(token, visitId, resetId, slot, buffer, filename) {
  return sasRequest(token, 'PATCH', `/field-app/visits/${visitId}/category-resets/${resetId}/`, {
    [slot]: {
      image: {
        filetype: 'image/jpeg',
        filename,
        filesize: buffer.length,
        base64: buffer.toString('base64'),
      },
    },
    compress_image: true,
  });
}

async function assignLeadZeroHours(token, visitId, resetId, leadShiftId, teamRowId) {
  const body = {
    shift_id: leadShiftId,
    spent_time: '0m',
    spent_time_reason: null,
  };
  if (teamRowId) body.id = teamRowId;
  return sasRequest(token, 'PATCH', `/field-app/visits/${visitId}/category-resets/${resetId}/`, body);
}

async function validateSpentTime(token, visitId, resetId, leadShiftId, teamRowId) {
  const body = {
    shift_id: leadShiftId,
    spent_time: '0m',
    spent_time_reason: null,
  };
  if (teamRowId) body.id = teamRowId;
  return sasRequest(
    token,
    'PATCH',
    `/field-app/visits/${visitId}/category-resets/${resetId}/validate-spent-time-reason/`,
    body,
  );
}

async function recompleteVisit(token, visitId) {
  const data = await getFullResets(token, visitId);
  const maintenance = data.find((r) => r.reset_type === 'MAINTENANCE' || r.name === 'KOMPASS MAINTENANCE');
  if (!maintenance) throw new Error(`MAINTENANCE reset missing for visit ${visitId}`);
  const body = {
    'category-reset': [{ ...maintenance, filetype: 'image', exceptionType: [] }],
    complete_shift_final: {
      team_lead_feedback: null,
      allowed_truncation: false,
      allowed_overlap: false,
      allowed_missing_ques: false,
    },
  };
  return sasRequest(token, 'POST', `/field-app/visits/${visitId}/recomplete/`, body);
}

function safeFilename(parts) {
  return parts.join('_').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function groupCandidates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.store}|${row.periodWeek}|${row.workbookKind || 'ise'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        store: row.store,
        periodWeek: row.periodWeek,
        workbookKind: row.workbookKind || 'ise',
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => {
    const s = String(a.store).localeCompare(String(b.store));
    return s || String(a.periodWeek).localeCompare(String(b.periodWeek));
  });
}

async function processBatch(ctx, batch) {
  const visitDate = weekToDate(batch.periodWeek);
  if (!visitDate) {
    return {
      ...batch,
      status: 'skipped',
      reason: `No calendar date for ${batch.periodWeek}`,
      sets: batch.rows.map((row) => ({ ...row, status: 'skipped', reason: 'missing visit date' })),
    };
  }

  const dbkeys = batch.rows.map((r) => r.dbkey);
  const visit = await resolveVisitForBatch(ctx.sasToken, batch.store, visitDate, batch.workbookKind, dbkeys);
  if (!visit) {
    return {
      ...batch,
      visitDate,
      status: 'skipped',
      reason: 'No SAS visit with matching category resets',
      sets: batch.rows.map((row) => ({ ...row, status: 'skipped', reason: 'visit not found' })),
    };
  }

  const shifts = await getVisitShifts(ctx.sasToken, visit.visitId);
  const leadShift = pickLeadShift(shifts);
  if (!leadShift) {
    return {
      ...batch,
      visitDate,
      visit,
      status: 'skipped',
      reason: 'No active lead shift on visit',
      sets: batch.rows.map((row) => ({ ...row, status: 'skipped', reason: 'no lead shift' })),
    };
  }

  const beforeBuffer = fs.readFileSync(BEFORE_PHOTO);
  const resetList = (await getFullResets(ctx.sasToken, visit.visitId)).map(summarizeReset);
  const resetByPog = new Map(resetList.filter((r) => r.pog).map((r) => [r.pog, r]));
  const setResults = [];

  for (const row of batch.rows) {
    const setResult = {
      key: row.key,
      store: row.store,
      periodWeek: row.periodWeek,
      categoryId: row.categoryId,
      dbkey: row.dbkey,
      pogName: row.pogName,
      siTaskId: row.siTaskId,
      status: 'pending',
      beforeUploaded: false,
      afterUploaded: 0,
      assignedZeroHours: false,
      markedComplete: false,
      errors: [],
    };

    try {
      const reset = resetByPog.get(String(row.dbkey));
      if (!reset) {
        setResult.status = 'skipped';
        setResult.reason = 'POG not on visit';
        setResults.push(setResult);
        continue;
      }
      setResult.resetId = reset.id;

      if (reset.completed && reset.categoryCompletion) {
        setResult.status = 'skipped';
        setResult.reason = 'already complete in PROD';
        setResults.push(setResult);
        continue;
      }

      const { actions } = await siAfterPhotos(ctx.reboticsApi, ctx.reboticsToken, row.siTaskId);
      if (!actions.length) {
        setResult.status = 'skipped';
        setResult.reason = 'no Rebotics after photos';
        setResults.push(setResult);
        continue;
      }

      if (ctx.dryRun) {
        setResult.status = 'dry-run';
        setResult.afterPhotoCount = actions.length;
        setResult.visitId = visit.visitId;
        setResult.leadShiftId = leadShift.id;
        setResults.push(setResult);
        await sleep(PAUSE_MS);
        continue;
      }

      const beforeName = safeFilename(['SI', batch.store, `DBKEY-${row.dbkey}`, 'before-placeholder.jpg']);
      await uploadResetPhoto(ctx.sasToken, visit.visitId, reset.id, 'before', beforeBuffer, beforeName);
      setResult.beforeUploaded = true;
      await sleep(PAUSE_MS);

      for (const action of actions) {
        const buf = await downloadImage(action.url);
        const afterName = safeFilename([
          'SI', batch.store, `DBKEY-${row.dbkey}`, `bay-${String(action.bay).padStart(2, '0')}`,
          `task${row.siTaskId}`, `action${action.actionId}.jpg`,
        ]);
        await uploadResetPhoto(ctx.sasToken, visit.visitId, reset.id, 'after', buf, afterName);
        setResult.afterUploaded += 1;
        await sleep(PAUSE_MS);
      }

      const fresh = summarizeReset(
        (await getFullResets(ctx.sasToken, visit.visitId)).find((r) => r.id === reset.id),
      );
      const teamRowId = fresh.team[0]?.id || null;
      await assignLeadZeroHours(ctx.sasToken, visit.visitId, reset.id, leadShift.id, teamRowId);
      setResult.assignedZeroHours = true;
      await sleep(PAUSE_MS);

      try {
        await validateSpentTime(ctx.sasToken, visit.visitId, reset.id, leadShift.id, teamRowId);
      } catch (err) {
        setResult.errors.push(`validate-spent-time: ${err.message}`);
      }
      await sleep(PAUSE_MS);

      const after = summarizeReset(
        (await getFullResets(ctx.sasToken, visit.visitId)).find((r) => r.id === reset.id),
      );
      setResult.beforeCount = after.beforeCount;
      setResult.afterCount = after.afterCount;
      setResult.completed = after.completed;
      setResult.categoryCompletion = after.categoryCompletion;
      setResult.markedComplete = after.completed || after.categoryCompletion;
      setResult.status = setResult.markedComplete ? 'completed' : 'partial';
      if (!setResult.markedComplete) {
        setResult.reason = 'photos/time applied but reset not marked complete';
      }
    } catch (err) {
      setResult.status = 'error';
      setResult.errors.push(err.message);
    }
    setResults.push(setResult);
    await sleep(PAUSE_MS);
  }

  let recomplete = null;
  const appliedSets = setResults.filter((s) => s.beforeUploaded || s.afterUploaded);
  if (!ctx.dryRun && appliedSets.length) {
    try {
      recomplete = await recompleteVisit(ctx.sasToken, visit.visitId);
      recomplete = { success: recomplete?.success === true, message: recomplete?.message || null };
    } catch (err) {
      recomplete = { success: false, error: err.message };
    }
  }

  return {
    ...batch,
    visitDate,
    visit,
    leadShift: { id: leadShift.id, employeeId: leadShift.employee?.id || leadShift.employee_id },
    status: ctx.dryRun ? 'dry-run' : 'processed',
    sets: setResults,
    recomplete,
  };
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push('# SI → PROD Backfill Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Districts: ${report.districts.join(', ')}`);
  lines.push(`Source: ${report.source}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Visit batches: ${report.summary.batches}`);
  lines.push(`- Sets attempted: ${report.summary.setsAttempted}`);
  lines.push(`- Sets completed: ${report.summary.setsCompleted}`);
  lines.push(`- Sets skipped: ${report.summary.setsSkipped}`);
  lines.push(`- Sets partial/error: ${report.summary.setsPartial}`);
  lines.push(`- Visits recompleted: ${report.summary.visitsRecompleted}`);
  lines.push('');

  for (const district of report.districts) {
    lines.push(`## District ${district}`);
    const batches = report.byDistrict[district] || [];
    if (!batches.length) {
      lines.push('- No work performed in this district.');
      lines.push('');
      continue;
    }
    for (const batch of batches) {
      lines.push(`### Store ${batch.store} — ${batch.periodWeek} (${batch.workbookKind})`);
      lines.push(`- Visit date: ${batch.visitDate || 'n/a'}`);
      lines.push(`- Visit id: ${batch.visit?.visitId || 'n/a'} (project ${batch.visit?.projectId || 'n/a'})`);
      lines.push(`- Batch status: ${batch.status}${batch.reason ? ` — ${batch.reason}` : ''}`);
      if (batch.recomplete) {
        lines.push(`- Recomplete: ${batch.recomplete.success ? 'OK' : 'FAILED'}${batch.recomplete.error ? ` (${batch.recomplete.error})` : ''}`);
      }
      lines.push('');
      lines.push('| Category | POG | SI Task | Result | After photos | Notes |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const set of batch.sets) {
        const notes = [set.reason, ...(set.errors || [])].filter(Boolean).join('; ') || '';
        lines.push(`| ${set.categoryId} ${set.pogName || ''} | ${set.dbkey} | ${set.siTaskId || ''} | ${set.status} | ${set.afterUploaded ?? set.afterPhotoCount ?? 0} | ${notes.replace(/\|/g, '/')} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(BEFORE_PHOTO)) throw new Error(`Before photo missing: ${BEFORE_PHOTO}`);
  if (!fs.existsSync(opts.discrepancyPath)) throw new Error(`Discrepancies missing: ${opts.discrepancyPath}`);

  const allowedStores = districtStoreSet();
  let rows = JSON.parse(await fsp.readFile(opts.discrepancyPath, 'utf8'))
    .filter((row) => row.proposedComment === 'needs PROD complete' && row.siTaskId)
    .filter((row) => allowedStores.has(String(row.store)));
  if (opts.store) rows = rows.filter((row) => normalizeStoreNumber(row.store) === opts.store);

  const groups = groupCandidates(rows);
  const limitedGroups = opts.limit ? groups.slice(0, opts.limit) : groups;

  await fsp.mkdir(OUT_ROOT, { recursive: true });
  const ctx = await bootstrapAuth();
  ctx.dryRun = opts.dryRun;

  console.log(`${opts.dryRun ? 'DRY-RUN' : 'APPLY'}: ${limitedGroups.length} visit batches / ${rows.length} sets in D1,D6,D8`);

  const results = [];
  for (const batch of limitedGroups) {
    console.log(`\n=== Store ${batch.store} ${batch.periodWeek} ${batch.workbookKind} (${batch.rows.length} sets) ===`);
    const result = await processBatch(ctx, batch);
    results.push(result);
    const done = result.sets.filter((s) => s.status === 'completed' || s.status === 'dry-run').length;
    console.log(`  -> ${result.status}${result.reason ? `: ${result.reason}` : ''}; sets ok=${done}/${result.sets.length}`);
  }

  const byDistrict = {};
  for (const d of DISTRICTS) byDistrict[d] = [];
  for (const batch of results) {
    const d = districtForStore(batch.store);
    if (d) byDistrict[d].push(batch);
  }

  const allSets = results.flatMap((b) => b.sets);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: opts.dryRun ? 'dry-run' : 'apply',
    districts: DISTRICTS,
    source: opts.discrepancyPath,
    summary: {
      batches: results.length,
      setsAttempted: allSets.length,
      setsCompleted: allSets.filter((s) => s.status === 'completed').length,
      setsDryRun: allSets.filter((s) => s.status === 'dry-run').length,
      setsSkipped: allSets.filter((s) => s.status === 'skipped').length,
      setsPartial: allSets.filter((s) => ['partial', 'error'].includes(s.status)).length,
      visitsRecompleted: results.filter((b) => b.recomplete?.success).length,
    },
    byDistrict,
    batches: results,
  };

  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = await writeFileVersioned(path.join(OUT_ROOT, `si-to-prod-backfill_${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const mdPath = await writeFileVersioned(path.join(OUT_ROOT, `si-to-prod-backfill_${stamp}.md`), buildMarkdownReport(report));
  console.log(`\nReport JSON: ${jsonPath}`);
  console.log(`Report MD:   ${mdPath}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
