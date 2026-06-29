#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileVersioned } = require('../src/lib/file-utils');
const { loadSasSession } = require('C:/Users/tgaut/kompass-netcap/lib/sas-session');

const AUDIT_JSON = path.join(process.cwd(), 'output', 'jim-carr-backlog-audit', 'jim-carr-backlog-audit version 2.json');
const OUT_DIR = path.join(process.cwd(), 'output', 'jim-carr-backlog-audit');
const REBOTICS_ENV = 'C:/Users/tgaut/rebotics-carry-forward/.env';

function clean(value) {
  return String(value ?? '').trim();
}

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function prodPhotoInstants(urls = []) {
  return urls.map((url) => {
    const match = String(url || '').match(/\/media\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: `${match[4]}:${match[5]}:${match[6]}`,
      sourceUrl: url,
    };
  }).filter(Boolean);
}

async function fetchSasVisitDate(token, visitId) {
  if (!visitId) return '';
  const res = await fetch(`https://prod.sasretail.com/api/v1/team-scheduling/visits/${encodeURIComponent(visitId)}/`, {
    headers: {
      Authorization: `Token ${token}`,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) return '';
  const body = await res.json().catch(() => null);
  return clean(body?.scheduled_date || body?.date || body?.reported_date || body?.visit_date);
}

function usableAction(action) {
  if (!action) return false;
  if (action.stage && action.stage !== 'pre_photo') return false;
  if (action.deactivated || action.rejected) return false;
  return Boolean(action.merged_image || action.id || action.action_id || action.actionId);
}

async function fetchSiPhotoInstants(reboticsApi, token, taskId) {
  if (!taskId) return [];
  const actions = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const data = await reboticsApi.reboticsJson(
      token,
      'GET',
      `/api/v1/tasks/${encodeURIComponent(taskId)}/processing/actions/?show_actions=below&limit=${limit}&offset=${offset}`
    );
    const chunk = Array.isArray(data) ? data : (data?.results || []);
    actions.push(...chunk);
    if (!data?.next || chunk.length < limit) break;
    offset += limit;
  }
  return actions.filter(usableAction).map((action) => {
    const raw = clean(action.captured_at || action.created_at || action.created);
    const date = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
    const time = raw.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] || '';
    return {
      actionId: action.id ?? action.action_id ?? action.actionId ?? null,
      date,
      time,
      capturedAt: raw,
      mergedImage: action.merged_image || '',
    };
  });
}

function cleanupBucket(row) {
  if (row.canSignOut === 'Likely after status cleanup') {
    return {
      bucket: 'photos_in_both_closeout',
      action: 'Clean up scan/actions, close SI task, verify PROD remains complete, then sign out.',
    };
  }
  if (row.canSignOut === 'Needs SI photo load') {
    return {
      bucket: 'prod_to_si_photo_load',
      action: 'Pull PROD after images, upload them to the matching SI task, then close SI and sign out.',
    };
  }
  if (row.canSignOut === 'Needs PROD photo load') {
    return {
      bucket: 'si_to_prod_photo_load',
      action: 'Pull SI photo, upload it to the matching PROD visit/category reset, then close both systems.',
    };
  }
  return null;
}

function compactTaskName(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function sourceShiftStartDates(prodInstants, siInstants) {
  return unique([
    ...prodInstants.map((item) => item.date),
    ...siInstants.map((item) => item.date),
  ]).sort();
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  const headers = [
    'bucket',
    'periodWeek',
    'store',
    'dbkey',
    'categoryId',
    'cleanupAction',
    'sourceShiftStartDates',
    'prodVisitId',
    'prodPhotoCount',
    'prodPhotoDates',
    'siTaskId',
    'siPhotoCount',
    'siPhotoDates',
    'prodStatus',
    'siStatus',
    'prodPlanogram',
    'siTaskName',
    'notes',
  ];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n';
}

function markdownFor(rows) {
  const lines = [];
  lines.push('# Jim Carr Backlog Cleanup Worklist');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Scope: Jim Carr / 701-James cleanup rows from the PROD/SI backlog audit.');
  lines.push('');

  const sections = [
    ['photos_in_both_closeout', 'Photos In Both: Clean Up And Close Out'],
    ['prod_to_si_photo_load', 'PROD To SI: Pull Images From PROD, Upload To SI, Close Out'],
    ['si_to_prod_photo_load', 'SI To PROD: Pull Image From SI, Upload To PROD, Close Out'],
  ];

  for (const [bucket, title] of sections) {
    const bucketRows = rows.filter((row) => row.bucket === bucket);
    if (!bucketRows.length) continue;
    lines.push(`## ${title} (${bucketRows.length})`);
    lines.push('');
    for (const row of bucketRows) {
      lines.push(`- ${row.periodWeek} store ${row.store} dbkey ${row.dbkey} cat ${row.categoryId || 'unknown'}`);
      lines.push(`  - Action: ${row.cleanupAction}`);
      lines.push(`  - Starting shift/photo date(s): ${row.sourceShiftStartDates || 'unknown'}`);
      lines.push(`  - PROD: status=${row.prodStatus || 'not found'}, visit=${row.prodVisitId || 'n/a'}, photos=${row.prodPhotoCount}, planogram=${row.prodPlanogram || 'n/a'}`);
      lines.push(`  - SI: status=${row.siStatus || 'not found'}, task=${row.siTaskId || 'n/a'}, photos=${row.siPhotoCount}, task name=${row.siTaskName || 'n/a'}`);
      if (row.notes) lines.push(`  - Notes: ${row.notes}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const audit = JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));
  const cleanupRows = audit.results.filter((row) => {
    return ['Likely after status cleanup', 'Needs SI photo load', 'Needs PROD photo load'].includes(row.canSignOut);
  });

  parseDotEnv(REBOTICS_ENV);
  const reboticsApi = require('C:/Users/tgaut/rebotics-carry-forward/lib/rebotics-api');
  const auth = await reboticsApi.fetchTokenFromRailway();
  const sas = await loadSasSession();
  const siInstantsByTask = new Map();
  const sasVisitDates = new Map();
  for (const row of cleanupRows) {
    const taskId = row.si?.taskId;
    if (!taskId || siInstantsByTask.has(taskId)) continue;
    siInstantsByTask.set(taskId, await fetchSiPhotoInstants(reboticsApi, auth.token, taskId));
  }
  for (const row of cleanupRows) {
    const visitId = row.prod?.visitId;
    if (!visitId || sasVisitDates.has(visitId)) continue;
    sasVisitDates.set(visitId, await fetchSasVisitDate(sas.token, visitId));
  }

  const handoffRows = cleanupRows.map((row) => {
    const bucket = cleanupBucket(row);
    const prodInstants = prodPhotoInstants(row.prod?.afterPictureUrls || []);
    const siInstants = row.si?.taskId ? (siInstantsByTask.get(row.si.taskId) || []) : [];
    const visitDate = row.prod?.visitId ? (sasVisitDates.get(row.prod.visitId) || '') : '';
    const prodDates = prodInstants.map((item) => item.date);
    if ((row.prod?.photoCount || 0) > 0 && !prodDates.length && visitDate) prodDates.push(visitDate);
    const sourceDates = unique([
      ...prodDates,
      ...siInstants.map((item) => item.date),
    ]).sort();
    const notes = [];
    if ((row.prod?.photoCount || 0) > 0 && !prodInstants.length && visitDate) {
      notes.push('PROD media URL did not include a timestamp; using SAS visit scheduled date as the shift starting point.');
    }
    if (row.canSignOut === 'Needs SI photo load' && !row.si?.taskId) {
      notes.push('Matching live SI task was not found during audit; resolve current/regenerated SI task before uploading.');
    }
    if (row.canSignOut === 'Needs PROD photo load' && !row.prod?.visitId) {
      notes.push('Matching live PROD report row was not found during audit; use SI photo date as starting point to locate the old PROD shift/visit.');
    }
    return {
      bucket: bucket.bucket,
      periodWeek: row.periodWeek,
      store: row.store,
      dbkey: row.dbkey,
      categoryId: row.categoryId || '',
      cleanupAction: bucket.action,
      sourceShiftStartDates: sourceDates.join('; '),
      prodVisitId: row.prod?.visitId || '',
      prodPhotoCount: row.prod?.photoCount || 0,
      prodPhotoDates: unique(prodDates).sort().join('; '),
      siTaskId: row.si?.taskId || '',
      siPhotoCount: row.si?.photoCount || 0,
      siPhotoDates: unique(siInstants.map((item) => item.date)).sort().join('; '),
      prodStatus: row.prod?.completionStatus || '',
      siStatus: row.si?.status || '',
      prodPlanogram: row.prod?.planogramId || row.prodFile?.planogramId || '',
      siTaskName: compactTaskName(row.si?.taskName || row.siFile?.taskName || ''),
      notes: notes.join(' '),
    };
  });

  const mdPath = await writeFileVersioned(
    path.join(OUT_DIR, 'jim-carr-cleanup-worklist.md'),
    markdownFor(handoffRows)
  );
  const csvPath = await writeFileVersioned(
    path.join(OUT_DIR, 'jim-carr-cleanup-worklist.csv'),
    rowsToCsv(handoffRows)
  );
  const jsonPath = await writeFileVersioned(
    path.join(OUT_DIR, 'jim-carr-cleanup-worklist.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), rows: handoffRows }, null, 2)
  );

  const byBucket = {};
  for (const row of handoffRows) byBucket[row.bucket] = (byBucket[row.bucket] || 0) + 1;
  console.log(JSON.stringify({ byBucket, mdPath, csvPath, jsonPath }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
