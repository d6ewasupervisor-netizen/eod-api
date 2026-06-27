#!/usr/bin/env node
'use strict';

/**
 * D1 Outstanding Sets – PROD/SI Reconcile & SI Completion
 *
 * Reads "Outstanding Sets In District 1.xlsx" (Sets tab), filters out Cat 201,
 * cross-references every row against SAS PROD and Store Intelligence (Rebotics),
 * performs a backwards SI task search for "Please complete in SI" rows and other
 * rows where PROD is done but SI is not, attempts to complete live SI tasks,
 * backfills PROD from SI photos where SI done / PROD not, and writes a results
 * JSON for workbook annotation.
 *
 * Usage:
 *   node scripts/d1-outstanding-si-reconcile.js [--dry-run] [--skip-si-close]
 *        [--skip-prod-backfill] [--out "path/to/output"] [--store 63,694]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { getCurrentPeriodWeek, getFolderInfo } = require('../src/lib/fiscal-calendar');
const { DEFAULT_PROJECT_IDS } = require('../src/lib/trackers/metadata');
const { REBOTICS_STORE_IDS } = require('../src/lib/trackers/rebotics-store-id-cache');
const { extractProdFields, rowValue } = require('../src/lib/trackers/prod-row-fields');

// ── Constants ────────────────────────────────────────────────────────────────

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const OFFSET_MIN = 420;
const TODAY = new Date().toISOString().slice(0, 10);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const WORKBOOK_PATH = 'C:/Users/tgaut/Downloads/Outstanding Sets In District 1.xlsx';
const AUTHOR_TAG = 'TAG';

const DEFAULT_OUT_DIR = `C:/Users/tgaut/Downloads/d1-outstanding-${TODAY}`;

// SAS projects to query for PROD status
const PROD_PROJECTS = [...DEFAULT_PROJECT_IDS];

// Period/date mapping for the outstanding window
const PERIOD_DATE_MAP = {
  P04W1: { start: '2026-04-26', end: '2026-05-02' },
  P04W2: { start: '2026-05-03', end: '2026-05-09' },
  P04W3: { start: '2026-05-10', end: '2026-05-16' },
  P04W4: { start: '2026-05-17', end: '2026-05-23' },
  P05W1: { start: '2026-05-24', end: '2026-05-30' },
  P05W2: { start: '2026-05-31', end: '2026-06-06' },
  P05W3: { start: '2026-06-07', end: '2026-06-13' },
  P05W4: { start: '2026-06-14', end: '2026-06-20' },
  P06W1: { start: '2026-06-21', end: '2026-06-27' },
};

function normalizePeriodKey(pw) {
  // Normalize "P4W2" → "P04W2"
  return String(pw || '').replace(/^P(\d)W/i, 'P0$1W').toUpperCase();
}

// ── CLI Parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    skipSiClose: false,
    skipProdBackfill: false,
    outDir: DEFAULT_OUT_DIR,
    storeFilter: [],   // if set, only process these stores
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--skip-si-close') opts.skipSiClose = true;
    else if (arg === '--skip-prod-backfill') opts.skipProdBackfill = true;
    else if (arg === '--out') opts.outDir = argv[++i];
    else if (arg === '--store') opts.storeFilter = argv[++i].split(',').map((s) => String(Number(s.trim()))).filter(Boolean);
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/d1-outstanding-si-reconcile.js [--dry-run] [--skip-si-close] [--skip-prod-backfill] [--out path] [--store 63,694]');
      process.exit(0);
    }
  }
  return opts;
}

// ── Shared Utilities ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function subtractDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function nextDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function loadReboticsApi() {
  loadEnvFile(path.join(REBOTICS_ROOT, '.env'));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

async function loadSasSession() {
  const statePath = process.env.SAS_AUTH_STATE || 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const token = state?.auth?.auth_token;
    if (token) return { token: String(token), source: statePath };
  }
  const sessionUrl = process.env.SAS_AUTH_SESSION_URL || 'http://127.0.0.1:7291/session';
  const response = await fetch(sessionUrl);
  if (!response.ok) throw new Error(`SAS auth-server ${response.status}`);
  const body = await response.json();
  const token = body?.auth?.auth_token;
  if (!token) throw new Error('No SAS auth token in session response');
  return { token: String(token), source: sessionUrl };
}

async function sasGetJson(token, route) {
  const res = await fetch(`${SAS_BASE}${route}`, {
    headers: { Accept: 'application/json', Authorization: `Token ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`SAS ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function downloadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  return res.text();
}

function downloadBinary(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBinary(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for photo URL`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ── CSV Parsing ───────────────────────────────────────────────────────────────

function parseCsvRecords(text) {
  const records = [];
  let record = [], current = '', quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) { record.push(current); current = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      record.push(current);
      if (record.some((v) => String(v).trim())) records.push(record);
      record = []; current = '';
      continue;
    }
    current += ch;
  }
  record.push(current);
  if (record.some((v) => String(v).trim())) records.push(record);
  return records;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const header = records[0];
  return records.slice(1).map((cols) => Object.fromEntries(header.map((h, idx) => [h, cols[idx] || ''])));
}

function extractDbkey(planogramId) {
  const value = String(planogramId || '');
  const direct = value.match(/^P\d+W\d_(\d{6,10})_/i);
  if (direct) return direct[1];
  const embedded = value.match(/\b(\d{6,10})\b/);
  return embedded ? embedded[1] : '';
}

// ── Rebotics DBKey extraction from task ───────────────────────────────────────

function dbkeyFromTask(task) {
  const fromPlanogram = task?.planograms?.[0]?.custom_id;
  if (fromPlanogram && /^\d{6,10}$/.test(String(fromPlanogram))) return String(fromPlanogram);
  const title = String(task?.title || task?.task_def?.title || '');
  // Attempt common title formats
  const m1 = title.match(/P\d{1,2}W\d[-\s]+\d{3,5}\s+(\d{6,9})/i);
  if (m1) return m1[1];
  // Fall back: look for 7-8 digit standalone number in title
  const m2 = title.match(/\b(\d{7,9})\b/);
  if (m2) return m2[1];
  // Also check planogram custom_id for embedded DBKey pattern
  if (fromPlanogram) {
    const m3 = String(fromPlanogram).match(/\b(\d{7,9})\b/);
    if (m3) return m3[1];
  }
  return null;
}

function taskMatchesDbkey(task, dbkey) {
  const td = dbkeyFromTask(task);
  return td && String(td) === String(dbkey);
}

// ── PROD Store Map ────────────────────────────────────────────────────────────

async function fetchProjectStoreMaps(token, projects) {
  const maps = new Map();
  for (const projectId of projects) {
    console.log(`  [PROD] fetching project-stores for project ${projectId}...`);
    const body = await sasGetJson(token, `/projects/project-stores/?project=${projectId}`);
    const rows = Array.isArray(body) ? body : body?.results || [];
    maps.set(Number(projectId), new Map(rows.map((row) => [String(row?.store?.number), row])));
  }
  return maps;
}

// ── PROD Report Fetching ──────────────────────────────────────────────────────

async function fetchProdRowsForStore({ token, projectStoreMaps, storeNumber, dateFrom, dateTo, projects }) {
  const rows = [];
  for (const projectId of projects) {
    const byStore = projectStoreMaps.get(Number(projectId)) || new Map();
    const projectStore = byStore.get(String(storeNumber));
    if (!projectStore?.id) continue;
    const params = new URLSearchParams({
      customer_id: String(CUSTOMER_ID),
      date_from: `${dateFrom}T07:00:00.000Z`,
      date_to: `${nextDate(dateTo)}T12:00:00.000Z`,
      date_type: 'reported',
      offset: String(OFFSET_MIN),
      project_id: String(projectId),
      shift_status: 'completed',
      store_id: String(projectStore.id),
    });
    console.log(`  [PROD] store=${storeNumber} project=${projectId} ${dateFrom}→${dateTo}`);
    try {
      const body = await sasGetJson(token, `/reports/category-reset-report/?${params}`);
      if (!body?.file_url) { console.log(`    [PROD] no file_url (no completed rows)`); continue; }
      const csvRows = parseCsv(await downloadText(body.file_url));
      console.log(`    [PROD] got ${csvRows.length} CSV rows`);
      for (const csvRow of csvRows) {
        const fields = extractProdFields(csvRow);
        if (fields.categoryCompletionStatus !== 'done') continue;
        const dbkey = extractDbkey(rowValue(csvRow, ['Planogram ID']));
        if (!dbkey || !fields.categoryId) continue;
        rows.push({
          storeNumber: String(rowValue(csvRow, ['Store #', 'Store']) || storeNumber),
          categoryId: fields.categoryId,
          dbkey,
          projectId,
          planogramId: String(rowValue(csvRow, ['Planogram ID']) || ''),
          afterPictureUrls: fields.afterPictureUrls || [],
        });
      }
    } catch (err) {
      console.warn(`    [PROD] ERROR store=${storeNumber} project=${projectId}: ${err.message}`);
    }
  }
  return rows;
}

// ── SI Task Fetching ──────────────────────────────────────────────────────────

const taskCacheByStoreDate = new Map();

async function fetchTasksForDate(api, token, storeId, date) {
  const key = `${storeId}:${date}`;
  if (taskCacheByStoreDate.has(key)) return taskCacheByStoreDate.get(key);
  let tasks = [];
  try {
    // Use the built-in paginated helper when available
    tasks = await api.listTasksForStoreAndDate(token, storeId, date);
  } catch (err) {
    // Fallback: manual paginated fetch
    let urlPath = `/api/v1/tasks/?store=${storeId}&from_date=${date}&to_date=${date}&limit=100`;
    let pageCount = 0;
    while (urlPath && pageCount < 20) {
      const resp = await api.reboticsJson(token, 'GET', urlPath);
      const results = resp?.results || [];
      tasks.push(...results);
      if (resp?.next) {
        try { urlPath = new URL(resp.next).pathname + new URL(resp.next).search; } catch { urlPath = null; }
      } else { urlPath = null; }
      pageCount++;
    }
  }
  taskCacheByStoreDate.set(key, tasks);
  return tasks;
}

// ── SI Backward Search ────────────────────────────────────────────────────────

async function searchSiBackwards(api, token, storeId, dbkey, periodWeekKey) {
  const periodInfo = PERIOD_DATE_MAP[normalizePeriodKey(periodWeekKey)];
  const periodStart = periodInfo?.start || subtractDays(TODAY, 90);

  // Days from today back to period start (+ 7 day buffer)
  const maxDays = Math.ceil((new Date(TODAY) - new Date(periodStart)) / 86400000) + 7;

  console.log(`  [SI-SEARCH] store=${storeId} dbkey=${dbkey} period=${periodWeekKey} searching ${maxDays} days back from ${TODAY}`);

  for (let i = 0; i <= maxDays; i++) {
    const date = subtractDays(TODAY, i);
    const tasks = await fetchTasksForDate(api, token, storeId, date);
    const task = tasks.find((t) => taskMatchesDbkey(t, dbkey));
    if (task) {
      const status = String(task.status?.id || '');
      const scanStatus = String(task.scan_status || '').toUpperCase();
      const isCompleted = status === 'completed' || scanStatus === 'DONE';
      console.log(`    [SI-SEARCH] Found on ${date}: taskId=${task.id} status=${status} scanStatus=${scanStatus} completed=${isCompleted}`);
      return {
        found: true,
        date,
        taskId: task.id,
        status,
        scanStatus,
        isCompleted,
        task,
        daysBack: i,
      };
    }
  }

  console.log(`    [SI-SEARCH] Not found in window back to ${periodStart}`);
  return { found: false, searchedDaysBack: maxDays, periodStart };
}

// ── SI Task Completion ────────────────────────────────────────────────────────

function captureSections(capture) {
  const out = [];
  for (const row of capture?.results || []) {
    for (const section of row.sections || []) {
      const bay = Number(section.name ?? section.section_info?.name ?? section.original_name);
      if (!Number.isFinite(bay)) continue;
      out.push({
        bay,
        sectionId: section.id,
        categoryId: row.category?.id,
        report: section.report || null,
        prePhotoId: section.pre_photo?.id || null,
      });
    }
  }
  out.sort((a, b) => a.bay - b.bay);
  return out;
}

function isDoneReport(report) {
  return report?.id && String(report.status || '').toLowerCase() === 'done' && !report.rejected && !report.error;
}

function allSectionsDone(sections) {
  return sections.length > 0 && sections.every((s) => isDoneReport(s.report));
}

function sectionsNeedingCapture(sections, { forceAll = false } = {}) {
  return (sections || []).filter((s) => forceAll || !isDoneReport(s.report));
}

async function waitForDoneSections(api, token, taskId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
    const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
    const sections = captureSections(capture);
    if (allSectionsDone(sections) && String(task.scan_status || '').toUpperCase() !== 'REJECTED') {
      return { ok: true, sections, scanStatus: task.scan_status || null };
    }
    if (String(task.scan_status || '').toUpperCase() === 'REJECTED' || sections.some((s) => s.report?.rejected || s.report?.status === 'error')) {
      return { ok: false, reason: 'rejected-or-error', scanStatus: task.scan_status };
    }
    console.log(`    [SI-WAIT] taskId=${taskId} waiting for CV... (${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(20000);
  }
  return { ok: false, reason: 'timeout' };
}

function correctionPayloads(reportActions) {
  const idle = (reportActions || []).filter((a) => a.state === 'STATE_IDLE');
  function acceptGroupId(action) {
    if (action.to && String(action.to).includes(':')) {
      const [shelf] = String(action.to).split(':');
      if (Number(shelf) === action.from_shelf) return `${shelf} - ${action.from_position_unique}`;
    }
    return `${action.from_shelf} - ${action.from_position_unique}`;
  }
  return [
    ...idle.filter((a) => a.action === 'ACTION_IDENTIFY').map((a) => ({
      action: a.action, group_id: String(a.group_id), id: a.id, reason: 'Image not Ideal',
      source_id: a.source_id, state: 'STATE_REJECTED', status: 'unidentified',
    })),
    ...idle.filter((a) => a.action === 'ACTION_ADD').map((a) => ({
      action: a.action, group_id: acceptGroupId(a), id: a.id, plu: a.plu,
      reason: 'On Shelf - UPC Confirmed', source_id: a.source_id, state: 'STATE_ACCEPTED', status: 'ok',
    })),
    ...idle.filter((a) => a.action === 'ACTION_REMOVE').map((a) => ({
      action: a.action, group_id: String(a.group_id), id: a.id, plu: a.plu,
      reason: 'Removed Item', source_id: a.source_id, state: 'STATE_ACCEPTED', status: 'ok',
    })),
    ...idle.filter((a) => a.action === 'ACTION_MOVE').map((a) => ({
      action: a.action, group_id: String(a.group_id), id: a.id, plu: a.plu,
      reason: 'Moved Item', source_id: a.source_id, state: 'STATE_ACCEPTED', status: 'ok',
    })),
  ];
}

async function clearTaskActions(api, token, taskId, dryRun) {
  const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
  const reports = captureSections(capture).map((s) => s.report).filter(isDoneReport);
  let patched = 0;
  for (const report of reports) {
    const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
    const payload = correctionPayloads(detail.report_actions || []);
    patched += payload.length;
    if (payload.length && !dryRun) {
      await api.reboticsJson(token, 'PATCH', `/api/v4/processing/actions/${report.id}/update_actions/`, payload);
    }
  }
  return { reports: reports.length, patched };
}

function findBaysSurveyItem(survey) {
  return (survey?.items || []).find((item) => /how many bays\/doors/i.test(String(item.title || item.text || '')));
}

async function submitSurveyZero(api, token, task, dryRun) {
  const surveyId = task?.survey?.id;
  const responseId = task?.result?.survey_response?.id;
  if (!surveyId || !responseId) return { skipped: 'no survey response' };
  const response = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/responses/${responseId}/`);
  if (response?.is_completed && (response.answers || []).length) return { alreadyAnswered: true };
  if (!response?.start_time && !dryRun) {
    await api.reboticsJson(token, 'PUT', `/api/v1/surveys/${surveyId}/responses/${responseId}/start/`);
  }
  const survey = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/`);
  const item = findBaysSurveyItem(survey);
  if (!item?.id) return { skipped: `no bays/doors survey item on survey ${surveyId}` };
  if (!dryRun) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/surveys/${surveyId}/responses/${responseId}/`, {
      answers: [{ item: item.id, answer: '0' }],
    });
  }
  return { item: item.id, answer: '0' };
}

async function deleteProblemReports(api, token, taskId, sections, { forceAll = false } = {}) {
  const deleted = [];
  for (const section of sectionsNeedingCapture(sections, { forceAll })) {
    const reportId = section.report?.id;
    if (!reportId) continue;
    await api.reboticsJson(token, 'DELETE', `/api/v1/tasks/${taskId}/processing/actions/${reportId}/`);
    deleted.push(reportId);
  }
  if (deleted.length) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/tasks/${taskId}/`, { scan_status: null });
  }
  return deleted;
}

async function closeTask({ api, token, taskId, prod, allowBlurry = false, blurryPath = '', dryRun }) {
  let task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);

  if (task.status?.id === 'completed') {
    console.log(`    [SI-CLOSE] taskId=${taskId} already completed`);
    return { status: 'already-completed' };
  }

  let openedByScript = false;

  async function openTaskIfNeeded() {
    if (task.status?.id === 'in_progress' || dryRun) return;
    console.log(`    [SI-CLOSE] opening task ${taskId} (was ${task.status?.id})`);
    await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, { status: 'in_progress' });
    openedByScript = true;
    task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  }

  async function resetIfOpened() {
    if (!openedByScript || dryRun) return;
    try {
      await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, {
        status: 'incomplete', status_reason: 'Backlog - Revisit Needed',
      });
    } catch { /* best-effort */ }
  }

  const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
  let sections = captureSections(capture);
  const taskRejected = String(task.scan_status || '').toUpperCase() === 'REJECTED';

  console.log(`    [SI-CLOSE] taskId=${taskId} sections=${sections.length} allDone=${allSectionsDone(sections)} rejected=${taskRejected}`);

  let uploaded = { skipped: 'sections already done' };

  if (!allSectionsDone(sections) || taskRejected) {
    if (dryRun && !prod) {
      return { status: 'would-need-prod-photo-upload', sections: sections.length };
    }
    if (!prod && !allowBlurry) {
      return { status: 'skip', reason: 'no PROD photos and blurry not allowed' };
    }

    await openTaskIfNeeded();

    if (prod && prod.afterPictureUrls.length) {
      // Upload PROD photos
      const urls = [...new Set(prod.afterPictureUrls)].sort();
      const targetSections = sectionsNeedingCapture(sections);
      const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
      const storeId = task.store?.id;
      if (!storePlanogramId || !storeId) {
        await resetIfOpened();
        return { status: 'skip', reason: 'task missing store_planogram_id or store.id' };
      }
      if (dryRun) {
        console.log(`    [SI-CLOSE] DRY-RUN would upload ${urls.length} photos to ${targetSections.length} sections`);
        uploaded = { ok: true, uploaded: targetSections.length, dryRun: true };
      } else {
        // Delete rejected reports first if task was rejected
        if (taskRejected) await deleteProblemReports(api, token, taskId, sections, { forceAll: true });
        let uploadCount = 0;
        for (let i = 0; i < targetSections.length; i++) {
          const section = targetSections[i];
          const url = urls[section.bay - 1] || urls[i];
          if (!url) { console.warn(`    [SI-CLOSE] no URL for section bay ${section.bay}`); continue; }
          console.log(`    [SI-CLOSE] uploading photo bay=${section.bay} section=${section.sectionId} url=${url.slice(0, 80)}...`);
          const fileBuffer = await downloadBinary(url);
          await api.uploadAndAttachPhoto({
            token,
            filename: `d1_reconcile_${taskId}_bay-${String(section.bay).padStart(2, '0')}.jpg`,
            fileBuffer,
            mimeType: 'image/jpeg',
            attach: {
              category_id: section.categoryId,
              section_id: section.sectionId,
              sequence_number: section.bay - 1,
              store: storeId,
              store_planogram: storePlanogramId,
              task_id: task.id,
            },
          });
          uploadCount++;
          await sleep(600);
        }
        uploaded = { ok: true, uploaded: uploadCount };
      }
    } else if (allowBlurry && blurryPath && fs.existsSync(blurryPath)) {
      // Blurry fallback
      const targetSections = sectionsNeedingCapture(sections, { forceAll: taskRejected });
      const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
      const storeId = task.store?.id;
      if (!storePlanogramId || !storeId) {
        await resetIfOpened();
        return { status: 'skip', reason: 'task missing store_planogram_id or store.id for blurry' };
      }
      if (dryRun) {
        uploaded = { ok: true, uploaded: targetSections.length, dryRun: true, blurry: true };
      } else {
        if (taskRejected) await deleteProblemReports(api, token, taskId, sections, { forceAll: true });
        const fileBuffer = await fsp.readFile(blurryPath);
        let uploadCount = 0;
        for (const section of targetSections) {
          console.log(`    [SI-CLOSE] uploading BLURRY bay=${section.bay}`);
          await api.uploadAndAttachPhoto({
            token,
            filename: `blurry_d1_reconcile_${taskId}_bay-${String(section.bay).padStart(2, '0')}.jpg`,
            fileBuffer,
            mimeType: 'image/jpeg',
            attach: {
              category_id: section.categoryId,
              section_id: section.sectionId,
              sequence_number: section.bay - 1,
              store: storeId,
              store_planogram: storePlanogramId,
              task_id: task.id,
            },
          });
          uploadCount++;
          await sleep(600);
        }
        uploaded = { ok: true, uploaded: uploadCount, blurry: true };
      }
    } else {
      await resetIfOpened();
      return { status: 'skip', reason: 'no PROD photos available and blurry bypass not configured' };
    }

    if (!dryRun) {
      const wait = await waitForDoneSections(api, token, taskId);
      if (!wait.ok) {
        await resetIfOpened();
        return { status: 'skip', reason: `CV wait failed: ${wait.reason}`, scanStatus: wait.scanStatus };
      }
      // Re-fetch sections after CV
      sections = captureSections(await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`));
    }
  } else {
    await openTaskIfNeeded();
  }

  const corrections = await clearTaskActions(api, token, taskId, dryRun);
  const survey = await submitSurveyZero(api, token, task, dryRun);

  if (!dryRun) {
    console.log(`    [SI-CLOSE] completing task ${taskId}...`);
    try {
      await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, { status: 'completed' });
    } catch (error) {
      await resetIfOpened();
      throw error;
    }
  }

  const finalTask = dryRun ? task : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  console.log(`    [SI-CLOSE] result: ${dryRun ? 'would-complete' : 'completed'} finalStatus=${finalTask.status?.id || 'unknown'}`);
  return {
    status: dryRun ? 'would-complete' : 'completed',
    uploaded,
    corrections,
    survey,
    finalStatus: finalTask.status?.id || null,
    finalScanStatus: finalTask.scan_status || null,
  };
}

// ── Workbook Row Reading ──────────────────────────────────────────────────────

function readWorkbookRows() {
  const pyCode = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(r'${WORKBOOK_PATH.replace(/\\/g, '\\\\')}', read_only=True, data_only=True)
ws = wb['Sets']
rows = list(ws.iter_rows(values_only=True))
headers = list(rows[0])
result = []
for r in rows[1:]:
  cat = str(r[4]) if r[4] is not None else ''
  if '201 CANDY' in cat:
    continue
  result.append({
    'district': r[0],
    'week': str(r[1]) if r[1] else None,
    'store': r[2],
    'department': str(r[3]) if r[3] else None,
    'category': cat,
    'pogId': str(r[5]) if r[5] else None,
    'dbkey': str(r[6]) if r[6] is not None else None,
    'completeWithSignoff': r[7],
    'rescheduleDate': str(r[8]) if r[8] else None,
    'exceptionInProd': r[9],
    'supervisorComment': str(r[10]) if r[10] else None,
  })
print(json.dumps(result))
`.trim();

  const tmpPy = path.join(require('os').tmpdir(), `_read_workbook_${STAMP.slice(0, 10)}.py`);
  fs.writeFileSync(tmpPy, pyCode);
  try {
    const out = execSync(`python "${tmpPy}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(out.trim());
  } finally {
    try { fs.unlinkSync(tmpPy); } catch { /* ignore */ }
  }
}

// ── Format workbook note for Supervisor Comments column ──────────────────────

function formatWorkbookNote(action, dateStr) {
  const d = dateStr ? dateStr.replace(/-/g, '/').replace('2026/', '') : null; // "06/26"
  const fmtDate = d ? `${d.slice(3)}/${d.slice(0, 2)}/26` : '06/26/26'; // "26/06/26" → "06/26/26"

  // dateStr is YYYY-MM-DD, format as MM/DD/YY
  let formattedDate = '06/26/26';
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [, mm, dd] = dateStr.split('-').map(Number);
    formattedDate = `${String(mm).padStart(2, '0')}/${String(dd).padStart(2, '0')}/26`;
  }

  switch (action) {
    case 'completed-today': return `Completed in SI ${formattedDate} ${AUTHOR_TAG}`;
    case 'found-completed': return `Completed in SI ${formattedDate} ${AUTHOR_TAG}`;
    case 'not-in-si': return `Not in SI ${formattedDate} ${AUTHOR_TAG}`;
    case 'si-expired': return `SI task expired ${formattedDate} ${AUTHOR_TAG}`;
    case 'already-done': return `Already completed in SI ${AUTHOR_TAG}`;
    case 'prod-not-done': return `PROD not complete - no SI action ${AUTHOR_TAG}`;
    case 'si-error': return `SI completion error ${formattedDate} ${AUTHOR_TAG}`;
    default: return `Checked ${formattedDate} ${AUTHOR_TAG}`;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   D1 Outstanding Sets – PROD/SI Reconcile & SI Completion   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Date: ${TODAY}  |  DryRun: ${opts.dryRun}  |  Out: ${opts.outDir}`);
  console.log(`  SkipSiClose: ${opts.skipSiClose}  |  SkipProdBackfill: ${opts.skipProdBackfill}`);
  if (opts.storeFilter.length) console.log(`  StoreFilter: ${opts.storeFilter.join(',')}`);
  console.log('');

  // Setup output dir
  await fsp.mkdir(opts.outDir, { recursive: true });

  // 1. Read workbook rows
  console.log('[1/6] Reading workbook...');
  let rows = readWorkbookRows();
  console.log(`  Raw (non-201) rows: ${rows.length}`);
  if (opts.storeFilter.length) {
    rows = rows.filter((r) => opts.storeFilter.includes(String(r.store)));
    console.log(`  After store filter: ${rows.length}`);
  }

  // 2. Auth
  console.log('\n[2/6] Loading auth...');
  let sasSession, reboticsApi;
  try {
    sasSession = await loadSasSession();
    console.log(`  SAS: loaded from ${sasSession.source}`);
  } catch (err) {
    console.error(`  SAS auth failed: ${err.message}`);
    process.exit(1);
  }
  try {
    reboticsApi = loadReboticsApi();
    console.log('  Rebotics: API loaded');
  } catch (err) {
    console.error(`  Rebotics API load failed: ${err.message}`);
    process.exit(1);
  }

  let reboticsToken;
  try {
    const auth = await reboticsApi.fetchTokenFromRailway();
    reboticsToken = auth.token;
    console.log(`  Rebotics: token obtained (user=${auth.username || auth.userId || 'unknown'})`);
  } catch (err) {
    console.error(`  Rebotics token failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Load PROD project store maps
  console.log('\n[3/6] Loading PROD project-store maps...');
  let projectStoreMaps;
  try {
    projectStoreMaps = await fetchProjectStoreMaps(sasSession.token, PROD_PROJECTS);
    console.log(`  Loaded maps for projects: ${[...projectStoreMaps.keys()].join(', ')}`);
  } catch (err) {
    console.error(`  fetchProjectStoreMaps failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Group rows by store and fetch PROD data
  console.log('\n[4/6] Fetching PROD status per store...');
  const uniqueStores = [...new Set(rows.map((r) => String(r.store)))].sort((a, b) => Number(a) - Number(b));
  const prodRowsByStore = new Map(); // store → [{dbkey, categoryId, afterPictureUrls, ...}]

  for (const storeNum of uniqueStores) {
    if (storeNum === '253') { console.log(`  Store 253: SKIP (not in D1 metadata / no Rebotics ID)`); continue; }
    console.log(`  Store ${storeNum}: fetching PROD P4W1→P6W1...`);
    try {
      const prodRows = await fetchProdRowsForStore({
        token: sasSession.token,
        projectStoreMaps,
        storeNumber: storeNum,
        dateFrom: '2026-04-26',
        dateTo: '2026-06-27',
        projects: PROD_PROJECTS,
      });
      prodRowsByStore.set(storeNum, prodRows);
      console.log(`    Found ${prodRows.length} completed PROD rows for store ${storeNum}`);
    } catch (err) {
      console.warn(`    PROD fetch failed for store ${storeNum}: ${err.message}`);
      prodRowsByStore.set(storeNum, []);
    }
    await sleep(400);
  }

  // 5. Cross-reference each row + SI backward search + action
  console.log('\n[5/6] Cross-referencing rows and performing SI actions...');

  const actionLog = [];
  let siCompletedCount = 0;
  let siAlreadyDoneCount = 0;
  let siNotFoundCount = 0;
  let siExpiredCount = 0;
  let siErrorCount = 0;
  let prodDoneCount = 0;
  let prodNotDoneCount = 0;
  let skipCount = 0;

  for (const row of rows) {
    const storeStr = String(row.store);
    const dbkeyStr = String(row.dbkey);
    const periodKey = normalizePeriodKey(row.week);
    const hasSupervisorInstruction = row.supervisorComment && /complete in SI/i.test(row.supervisorComment);

    console.log(`\n── Store ${storeStr} | ${row.week} | Cat ${row.category} | DBKey ${dbkeyStr} ──`);
    if (row.supervisorComment) console.log(`   Supervisor: "${row.supervisorComment}"`);

    // Store 253 skip
    if (storeStr === '253') {
      console.log('   SKIP: store 253 not in D1 metadata');
      actionLog.push({ ...row, prodDone: false, siSearch: null, action: 'skip-no-store-id', workbookNote: null });
      skipCount++;
      continue;
    }

    // Get Rebotics store ID
    const customId = `701-${String(Number(storeStr)).padStart(5, '0')}`;
    const reboticsStoreId = REBOTICS_STORE_IDS[customId];
    if (!reboticsStoreId) {
      console.log(`   SKIP: no Rebotics store ID for ${customId}`);
      actionLog.push({ ...row, prodDone: false, siSearch: null, action: 'skip-no-rebotics-id', workbookNote: null });
      skipCount++;
      continue;
    }

    // Check PROD
    const prodRows = prodRowsByStore.get(storeStr) || [];
    const prodMatch = prodRows.find((p) => String(p.dbkey) === dbkeyStr);
    const prodDone = Boolean(prodMatch);
    console.log(`   PROD: ${prodDone ? `DONE (${prodMatch?.afterPictureUrls?.length || 0} photos, project ${prodMatch?.projectId})` : 'NOT DONE'}`);
    if (prodDone) prodDoneCount++; else prodNotDoneCount++;

    // Fuel Kiosk rows (Cat 142) - check but don't attempt SI completion
    const isFuelKiosk = row.category?.includes('142 FUEL') || row.category?.includes('FUEL KIOSK');

    // SI search
    let siSearch = null;
    let workbookNote = null;
    let actionTaken = 'checked-only';

    if (isFuelKiosk) {
      console.log('   SI: SKIP (fuel kiosk - different SI workflow)');
      actionTaken = 'skip-fuel-kiosk';
      workbookNote = prodDone ? `PROD done - fuel kiosk SI not attempted ${AUTHOR_TAG}` : null;
    } else {
      // SI backward search
      console.log(`   SI: searching backwards from ${TODAY}...`);
      try {
        siSearch = await searchSiBackwards(reboticsApi, reboticsToken, reboticsStoreId, dbkeyStr, row.week);
        await sleep(200);
      } catch (err) {
        console.warn(`   SI search error: ${err.message}`);
        siSearch = { found: false, error: err.message };
      }

      if (siSearch?.found && siSearch.isCompleted) {
        // Already completed in SI
        console.log(`   SI: ALREADY COMPLETED on ${siSearch.date} (taskId=${siSearch.taskId})`);
        siAlreadyDoneCount++;
        actionTaken = 'already-done-in-si';
        workbookNote = formatWorkbookNote('found-completed', siSearch.date);
      } else if (siSearch?.found && !siSearch.isCompleted) {
        // Live task found as incomplete - attempt to complete
        const liveTaskId = siSearch.taskId;
        console.log(`   SI: LIVE TASK found taskId=${liveTaskId} status=${siSearch.status} (${siSearch.daysBack} days back)`);

        if (opts.skipSiClose) {
          console.log('   SI: --skip-si-close set, skipping completion');
          actionTaken = 'skipped-by-flag';
          workbookNote = formatWorkbookNote('not-in-si', TODAY);
        } else if (!prodDone) {
          // Only attempt SI close if PROD is done OR if supervisor explicitly says "complete in SI"
          if (hasSupervisorInstruction) {
            console.log('   SI: attempting to complete (supervisor instruction, no PROD photos)...');
            try {
              const blurryPath = process.env.BLURRY_SHELF_IMAGE || path.join(__dirname, '..', 'output', 'tracker-prod-to-si-reconcile', 'blurry.jpg');
              const result = await closeTask({
                api: reboticsApi, token: reboticsToken,
                taskId: liveTaskId, prod: null,
                allowBlurry: fs.existsSync(blurryPath), blurryPath,
                dryRun: opts.dryRun,
              });
              console.log(`   SI close result: ${JSON.stringify(result)}`);
              if (result.status === 'completed' || result.status === 'would-complete') {
                siCompletedCount++;
                actionTaken = 'completed-in-si';
                workbookNote = formatWorkbookNote('completed-today', TODAY);
              } else if (result.status === 'already-completed') {
                siAlreadyDoneCount++;
                actionTaken = 'already-done-in-si';
                workbookNote = formatWorkbookNote('found-completed', TODAY);
              } else {
                siErrorCount++;
                actionTaken = 'si-close-error';
                workbookNote = formatWorkbookNote('si-error', TODAY);
              }
            } catch (err) {
              console.error(`   SI close error: ${err.message}`);
              siErrorCount++;
              actionTaken = 'si-close-exception';
              workbookNote = formatWorkbookNote('si-error', TODAY);
            }
          } else {
            console.log('   SI: PROD not done, no supervisor instruction - not completing');
            actionTaken = 'prod-not-done';
            workbookNote = null; // no note if no instruction
          }
        } else {
          // PROD is done - attempt SI completion
          console.log('   SI: attempting to complete (PROD done)...');
          try {
            const result = await closeTask({
              api: reboticsApi, token: reboticsToken,
              taskId: liveTaskId,
              prod: prodMatch || null,
              allowBlurry: false,
              dryRun: opts.dryRun,
            });
            console.log(`   SI close result: ${JSON.stringify(result)}`);
            if (result.status === 'completed' || result.status === 'would-complete') {
              siCompletedCount++;
              actionTaken = 'completed-in-si';
              workbookNote = formatWorkbookNote('completed-today', TODAY);
            } else if (result.status === 'already-completed') {
              siAlreadyDoneCount++;
              actionTaken = 'already-done-in-si';
              workbookNote = formatWorkbookNote('found-completed', TODAY);
            } else {
              // Could not complete - check if supervisor instruction
              if (hasSupervisorInstruction) {
                siErrorCount++;
                actionTaken = 'si-close-failed';
                workbookNote = formatWorkbookNote('si-error', TODAY);
              } else {
                actionTaken = 'si-close-skipped';
                workbookNote = null;
              }
            }
          } catch (err) {
            console.error(`   SI close error: ${err.message}`);
            siErrorCount++;
            actionTaken = 'si-close-exception';
            workbookNote = formatWorkbookNote('si-error', TODAY);
          }
        }
      } else {
        // Task NOT found in SI search window
        const foundInfo = siSearch?.found === false ? `not found in ${siSearch.searchedDaysBack || '?'} days back (to ${siSearch.periodStart || 'unknown'})` : 'search error';
        console.log(`   SI: ${foundInfo}`);

        if (hasSupervisorInstruction) {
          siNotFoundCount++;
          actionTaken = 'not-in-si';
          workbookNote = formatWorkbookNote('not-in-si', TODAY);
        } else if (prodDone) {
          siExpiredCount++;
          actionTaken = 'si-expired-or-absent';
          workbookNote = null; // don't annotate unless supervisor said so
        } else {
          actionTaken = 'neither-done';
          workbookNote = null;
        }
      }
    }

    const logEntry = {
      store: row.store,
      week: row.week,
      category: row.category,
      dbkey: row.dbkey,
      pogId: row.pogId,
      supervisorComment: row.supervisorComment || null,
      hasSupervisorInstruction,
      prodDone,
      prodAfterPics: prodMatch?.afterPictureUrls?.length || 0,
      siSearch: siSearch ? {
        found: siSearch.found,
        date: siSearch.date || null,
        taskId: siSearch.taskId || null,
        status: siSearch.status || null,
        scanStatus: siSearch.scanStatus || null,
        isCompleted: siSearch.isCompleted || false,
        daysBack: siSearch.daysBack || null,
      } : null,
      action: actionTaken,
      workbookNote,
      timestamp: new Date().toISOString(),
    };
    actionLog.push(logEntry);
  }

  // 6. Write outputs
  console.log('\n[6/6] Writing outputs...');
  const logPath = path.join(opts.outDir, `d1_outstanding_action_log_${stamp}.json`);
  await fsp.writeFile(logPath, JSON.stringify(actionLog, null, 2));
  console.log(`  Action log: ${logPath}`);

  // Write CSV summary
  const csvHeader = 'store,week,category,dbkey,prodDone,siFound,siCompleted,siDate,siTaskId,action,workbookNote,supervisorComment';
  const csvRows = actionLog.map((e) => [
    e.store, e.week, `"${e.category}"`, e.dbkey,
    e.prodDone ? 'Y' : 'N',
    e.siSearch?.found ? 'Y' : 'N',
    e.siSearch?.isCompleted ? 'Y' : 'N',
    e.siSearch?.date || '',
    e.siSearch?.taskId || '',
    e.action,
    `"${e.workbookNote || ''}"`,
    `"${e.supervisorComment || ''}"`,
  ].join(','));
  const csvPath = path.join(opts.outDir, `d1_outstanding_action_log_${stamp}.csv`);
  await fsp.writeFile(csvPath, [csvHeader, ...csvRows].join('\n'));
  console.log(`  CSV: ${csvPath}`);

  // Write workbook update instructions (for Python script)
  const wbUpdates = actionLog.filter((e) => e.workbookNote).map((e) => ({
    dbkey: e.dbkey,
    week: e.week,
    store: e.store,
    category: e.category,
    workbookNote: e.workbookNote,
    existingComment: e.supervisorComment,
  }));
  const wbPath = path.join(opts.outDir, `d1_workbook_updates_${stamp}.json`);
  await fsp.writeFile(wbPath, JSON.stringify(wbUpdates, null, 2));
  console.log(`  Workbook updates: ${wbPath} (${wbUpdates.length} rows to annotate)`);

  // Summary
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  SUMMARY  (${opts.dryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('──────────────────────────────────────────────────────');
  console.log(`  Total rows processed:        ${rows.length}`);
  console.log(`  PROD done:                   ${prodDoneCount}`);
  console.log(`  PROD not done:               ${prodNotDoneCount}`);
  console.log(`  SI already completed:        ${siAlreadyDoneCount}`);
  console.log(`  SI completed today:          ${siCompletedCount}`);
  console.log(`  SI not found in window:      ${siNotFoundCount}`);
  console.log(`  SI expired/absent:           ${siExpiredCount}`);
  console.log(`  SI error:                    ${siErrorCount}`);
  console.log(`  Skipped (no store ID etc):   ${skipCount}`);
  console.log(`  Workbook annotations queued: ${wbUpdates.length}`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`\n  Log:       ${logPath}`);
  console.log(`  CSV:       ${csvPath}`);
  console.log(`  WB JSON:   ${wbPath}`);
  console.log(`\n  Run workbook updater next:`);
  console.log(`    python scripts/d1-outstanding-update-workbook.py "${wbPath}"`);
  console.log('');

  return { logPath, csvPath, wbPath, outDir: opts.outDir };
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message, err.stack);
  process.exit(1);
});
