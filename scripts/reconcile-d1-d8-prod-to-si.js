#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const { getCurrentPeriodWeek, calculatePreviousWeek, getFolderInfo } = require('../src/lib/fiscal-calendar');
const { DEFAULT_PROJECT_IDS } = require('../src/lib/trackers/metadata');
const {
  buildApplyScope,
  assertApplyScopeConfirmed,
  assertStoreInScope,
  scopeSummary,
  districtForStore,
} = require('../src/lib/trackers/apply-scope');
const { extractProdFields, rowValue, normalizeCategoryId } = require('../src/lib/trackers/prod-row-fields');
const { categoryIdFromTask, dbkeyFromTask, toCustomId } = require('../src/lib/trackers/rebotics-reports');

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const OFFSET_MIN = 420;
const TODAY = new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const out = {
    applySi: false,
    writeTracker: false,
    cutoff: null,
    districts: [1, 8],
    stores: [],
    projects: [...DEFAULT_PROJECT_IDS],
    skipTaskIds: [],
    allowBlurry: false,
    confirmScope: null,
    blurryPath: process.env.BLURRY_SHELF_IMAGE || '',
    taskDate: TODAY,
    outDir: path.join('output', 'tracker-prod-to-si-reconcile', new Date().toISOString().replace(/[:.]/g, '-')),
    maxSets: Infinity,
    snapshotBuckets: false,
    discrepancies: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply-si') out.applySi = true;
    else if (arg === '--write-tracker') out.writeTracker = true;
    else if (arg === '--snapshot-buckets') out.snapshotBuckets = true;
    else if (arg === '--cutoff') out.cutoff = normalizePeriod(argv[++i]);
    else if (arg === '--districts') out.districts = argv[++i].split(',').map((v) => Number(v.trim())).filter(Boolean);
    else if (arg === '--stores') out.stores = argv[++i].split(',').map((v) => String(Number(v.trim()))).filter((v) => v !== 'NaN');
    else if (arg === '--projects') out.projects = argv[++i].split(',').map((v) => Number(v.trim())).filter(Boolean);
    else if (arg === '--skip-task') out.skipTaskIds.push(Number(argv[++i]));
    else if (arg === '--allow-blurry') out.allowBlurry = true;
    else if (arg === '--confirm-scope') out.confirmScope = argv[++i];
    else if (arg === '--blurry-path') out.blurryPath = argv[++i];
    else if (arg === '--task-date') out.taskDate = argv[++i];
    else if (arg === '--out') out.outDir = argv[++i];
    else if (arg === '--max-sets') out.maxSets = Number(argv[++i]);
    else if (arg === '--discrepancies') out.discrepancies = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/reconcile-d1-d8-prod-to-si.js [--apply-si] [--write-tracker] [--snapshot-buckets] [--allow-blurry --blurry-path image.png]',
        '  [--cutoff P05W3] [--districts 1,8] [--stores 19,23] [--task-date YYYY-MM-DD]',
        '  [--discrepancies path.json]  Skip DB snapshot; use PROD-complete/SI-not rows from reconcile export.',
        '  Live apply/write requires --confirm-scope D1,D8 matching --districts exactly.',
        'Default is dry-run: query live sources and write summary only.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

function normalizePeriod(value) {
  const match = String(value || '').trim().match(/^P0?(\d{1,2})W([1-4])$/i);
  if (!match) return null;
  return `P${String(Number(match[1])).padStart(2, '0')}W${Number(match[2])}`;
}

function periodParts(periodWeek) {
  const normalized = normalizePeriod(periodWeek);
  const match = normalized && normalized.match(/^P(\d{2})W([1-4])$/);
  return match ? { period: Number(match[1]), week: Number(match[2]), label: normalized } : null;
}

function periodOrdinal(periodWeek) {
  const p = periodParts(periodWeek);
  return p ? ((p.period - 1) * 4) + p.week : null;
}

function periodsThrough(cutoff) {
  const end = periodOrdinal(cutoff);
  const out = [];
  for (let period = 1; period <= 13; period += 1) {
    for (let week = 1; week <= 4; week += 1) {
      const label = `P${String(period).padStart(2, '0')}W${week}`;
      if (periodOrdinal(label) <= end) out.push(label);
    }
  }
  return out;
}

function defaultCutoff() {
  const current = getCurrentPeriodWeek();
  const previous = calculatePreviousWeek(current.period, current.week);
  return `P${previous.periodStr}W${previous.weekStr}`;
}

function trackerKey(row) {
  return `${row.period_week}|${row.store}|${String(row.category_id)}|${row.dbkey}`;
}

function prodKey(row) {
  return `${row.periodWeek}|${row.storeNumber}|${row.categoryId}|${row.dbkey}`;
}

function taskKeyFromTask(task, periodWeek, store) {
  return `${periodWeek}|${store}|${categoryIdFromTask(task)}|${dbkeyFromTask(task)}`;
}

function periodFromTask(task) {
  const title = String(task?.title || task?.task_def?.title || '');
  const match = title.match(/\b(P\d{1,2}W[1-4])\b/i);
  return match ? normalizePeriod(match[1]) : null;
}

function safeSegment(value, max = 80) {
  return String(value || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, max) || 'unknown';
}

function loadEnvFile(envPath) {
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
  loadEnvFile(path.join(REBOTICS_ROOT, '.env'));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

async function loadSasSession() {
  const statePath = process.env.SAS_AUTH_STATE || 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const token = state?.auth?.auth_token;
    if (token) return { token: String(token), source: statePath, generatedAt: state.generatedAt || null };
  }
  const sessionUrl = process.env.SAS_AUTH_SESSION_URL || 'http://127.0.0.1:7291/session';
  const response = await fetch(sessionUrl);
  if (!response.ok) throw new Error(`SAS auth-server ${response.status}`);
  const body = await response.json();
  const token = body?.auth?.auth_token;
  if (!token) throw new Error('No SAS auth token in session response');
  return { token: String(token), source: sessionUrl, generatedAt: body.generatedAt || null };
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let current = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      record.push(current);
      current = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      record.push(current);
      if (record.some((value) => String(value).trim())) records.push(record);
      record = [];
      current = '';
      continue;
    }
    current += ch;
  }
  record.push(current);
  if (record.some((value) => String(value).trim())) records.push(record);
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

async function sasGetJson(token, route) {
  const res = await fetch(`${SAS_BASE}${route}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`SAS ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function fetchProjectStoreMaps(token, projects) {
  const maps = new Map();
  for (const projectId of projects) {
    const body = await sasGetJson(token, `/projects/project-stores/?project=${projectId}`);
    const rows = Array.isArray(body) ? body : body?.results || [];
    maps.set(Number(projectId), new Map(rows.map((row) => [String(row?.store?.number), row])));
  }
  return maps;
}

function nextDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function downloadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  return res.text();
}

async function fetchProdRows({ token, projectStoreMaps, trackerRows, projects }) {
  const rows = [];
  const stores = [...new Set(trackerRows.map((row) => row.store))].sort((a, b) => Number(a) - Number(b));
  const periods = [...new Set(trackerRows.map((row) => row.period_week))].sort((a, b) => periodOrdinal(a) - periodOrdinal(b));
  for (const periodWeek of periods) {
    const parts = periodParts(periodWeek);
    const info = getFolderInfo(parts.period, parts.week, 2026);
    for (const projectId of projects) {
      const byStore = projectStoreMaps.get(Number(projectId)) || new Map();
      for (const store of stores) {
        const projectStore = byStore.get(String(store));
        if (!projectStore?.id) continue;
        const params = new URLSearchParams({
          customer_id: String(CUSTOMER_ID),
          date_from: `${info.startDate}T07:00:00.000Z`,
          date_to: `${nextDate(info.endDate)}T12:00:00.000Z`,
          date_type: 'reported',
          offset: String(OFFSET_MIN),
          project_id: String(projectId),
          shift_status: 'completed',
          store_id: String(projectStore.id),
        });
        const body = await sasGetJson(token, `/reports/category-reset-report/?${params}`);
        if (!body?.file_url) continue;
        const csvRows = parseCsv(await downloadText(body.file_url));
        for (const csvRow of csvRows) {
          const fields = extractProdFields(csvRow);
          if (fields.categoryCompletionStatus !== 'done') continue;
          const dbkey = extractDbkey(rowValue(csvRow, ['Planogram ID']));
          if (!dbkey || !fields.categoryId) continue;
          rows.push({
            periodWeek,
            storeNumber: String(rowValue(csvRow, ['Store #', 'Store']) || store),
            categoryId: fields.categoryId,
            dbkey,
            projectId,
            planogramId: String(rowValue(csvRow, ['Planogram ID']) || ''),
            categorySetLabel: String(rowValue(csvRow, ['Category', 'Category Name', 'Department Name']) || ''),
            afterPictureUrls: fields.afterPictureUrls,
            raw: csvRow,
          });
        }
      }
    }
  }
  return rows;
}

async function fetchProdRowForTracker({ token, projectStoreMaps, trackerRow, projects, throughDate = TODAY }) {
  const parts = periodParts(trackerRow.period_week);
  const info = getFolderInfo(parts.period, parts.week, 2026);
  const rows = [];
  for (const projectId of projects) {
    const byStore = projectStoreMaps.get(Number(projectId)) || new Map();
    const projectStore = byStore.get(String(trackerRow.store));
    if (!projectStore?.id) continue;
    const params = new URLSearchParams({
      customer_id: String(CUSTOMER_ID),
      date_from: `${info.startDate}T07:00:00.000Z`,
      date_to: `${nextDate(throughDate)}T12:00:00.000Z`,
      date_type: 'reported',
      offset: String(OFFSET_MIN),
      project_id: String(projectId),
      shift_status: 'completed',
      store_id: String(projectStore.id),
    });
    const body = await sasGetJson(token, `/reports/category-reset-report/?${params}`);
    if (!body?.file_url) continue;
    const csvRows = parseCsv(await downloadText(body.file_url));
    for (const csvRow of csvRows) {
      const fields = extractProdFields(csvRow);
      if (fields.categoryCompletionStatus !== 'done') continue;
      const dbkey = extractDbkey(rowValue(csvRow, ['Planogram ID']));
      if (!dbkey || !fields.categoryId) continue;
      rows.push({
        periodWeek: normalizePeriod(String(rowValue(csvRow, ['Planogram ID']) || '').match(/^(P\d+W\d)_/i)?.[1]) || trackerRow.period_week,
        storeNumber: String(rowValue(csvRow, ['Store #', 'Store']) || trackerRow.store),
        categoryId: fields.categoryId,
        dbkey,
        projectId,
        planogramId: String(rowValue(csvRow, ['Planogram ID']) || ''),
        categorySetLabel: String(rowValue(csvRow, ['Category', 'Category Name', 'Department Name']) || ''),
        afterPictureUrls: fields.afterPictureUrls,
        raw: csvRow,
      });
    }
  }
  const key = trackerKey(trackerRow);
  return rows
    .filter((row) => prodKey(row) === key)
    .sort((a, b) => b.afterPictureUrls.length - a.afterPictureUrls.length)[0] || null;
}

async function fetchTrackerRows({ stores, periods, snapshotBuckets = false }) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Run under `railway run`.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const meta = await pool.query(
      'SELECT workbook_kind, refreshed_at, row_count, normalized_row_count, ingest_status, si_source FROM tracker_snapshot_meta ORDER BY workbook_kind',
    );
    const bucketFilter = snapshotBuckets
      ? `AND bucket = ANY($3)`
      : '';
    const params = [stores, periods];
    if (snapshotBuckets) {
      params.push([
        'matched_both',
        'mirror_si_simple_close',
        'mirror_si_photo_push',
        'mirror_si_stale_or_absent',
      ]);
    }
    const result = await pool.query(
      `SELECT workbook_kind, store, period_week, category_id, dbkey, row_index, set_type, current_k, current_l, bucket, bucket_reason
         FROM tracker_snapshot_rows
        WHERE store = ANY($1)
          AND period_week = ANY($2)
          AND lower(coalesce(current_k, '')) <> 'yes'
          ${bucketFilter}
        ORDER BY store::int, period_week, category_id, dbkey`,
      params,
    );
    return { meta: meta.rows, rows: result.rows };
  } finally {
    await pool.end();
  }
}

async function writeSnapshotRowsComplete(rows) {
  if (!rows.length) return { updated: 0 };
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Run under `railway run`.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const keys = rows.map((row) => ({
      workbookKind: row.workbookKind,
      store: row.store,
      periodWeek: row.periodWeek,
      categoryId: row.categoryId,
      dbkey: row.dbkey,
    }));
    const result = await pool.query(
      `UPDATE tracker_snapshot_rows r
          SET current_k = 'Yes',
              current_l = CASE
                WHEN lower(coalesce(current_l, '')) IN ('', 'confirmed - not in si') THEN NULL
                ELSE current_l
              END,
              bucket = 'matched_both',
              bucket_reason = 'PROD and SI both show complete after prod-to-SI closeout.'
         FROM jsonb_to_recordset($1::jsonb)
           AS x(workbook_kind text, store text, period_week text, category_id int, dbkey text)
        WHERE r.workbook_kind = x.workbook_kind
          AND r.store = x.store
          AND r.period_week = x.period_week
          AND r.category_id = x.category_id
          AND r.dbkey = x.dbkey`,
      [JSON.stringify(keys.map((row) => ({
        workbook_kind: row.workbookKind,
        store: row.store,
        period_week: row.periodWeek,
        category_id: Number(row.categoryId),
        dbkey: row.dbkey,
      })))],
    );
    return { updated: result.rowCount };
  } finally {
    await pool.end();
  }
}

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
  return sections.length > 0 && sections.every((section) => isDoneReport(section.report));
}

function sectionsNeedingCapture(sections, { forceAll = false } = {}) {
  return (sections || []).filter((section) => forceAll || !isDoneReport(section.report));
}

async function waitForDoneSections(api, token, taskId, timeoutMs = 300000) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
    const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
    const sections = captureSections(capture);
    last = sections.map((section) => ({
      bay: section.bay,
      sectionId: section.sectionId,
      prePhotoId: section.prePhotoId,
      reportId: section.report?.id || null,
      status: section.report?.status || 'none',
      rejected: Boolean(section.report?.rejected),
      scanStatus: task.scan_status || null,
    }));
    if (allSectionsDone(sections) && String(task.scan_status || '').toUpperCase() !== 'REJECTED') return { ok: true, sections, scanStatus: task.scan_status || null };
    if (String(task.scan_status || '').toUpperCase() === 'REJECTED' || last.some((section) => section.rejected || section.status === 'rejected' || section.status === 'error')) {
      return { ok: false, reason: 'rejected-or-error', last };
    }
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
  return { ok: false, reason: 'timeout', last };
}

function acceptGroupId(action) {
  if (action.to && String(action.to).includes(':')) {
    const [shelf] = String(action.to).split(':');
    if (Number(shelf) === action.from_shelf) return `${shelf} - ${action.from_position_unique}`;
  }
  return `${action.from_shelf} - ${action.from_position_unique}`;
}

function correctionPayloads(reportActions) {
  const idle = (reportActions || []).filter((action) => action.state === 'STATE_IDLE');
  return [
    ...idle.filter((action) => action.action === 'ACTION_IDENTIFY').map((action) => ({
      action: action.action,
      group_id: String(action.group_id),
      id: action.id,
      reason: 'Image not Ideal',
      source_id: action.source_id,
      state: 'STATE_REJECTED',
      status: 'unidentified',
    })),
    ...idle.filter((action) => action.action === 'ACTION_ADD').map((action) => ({
      action: action.action,
      group_id: acceptGroupId(action),
      id: action.id,
      plu: action.plu,
      reason: 'On Shelf - UPC Confirmed',
      source_id: action.source_id,
      state: 'STATE_ACCEPTED',
      status: 'ok',
    })),
    ...idle.filter((action) => action.action === 'ACTION_REMOVE').map((action) => ({
      action: action.action,
      group_id: String(action.group_id),
      id: action.id,
      plu: action.plu,
      reason: 'Removed Item',
      source_id: action.source_id,
      state: 'STATE_ACCEPTED',
      status: 'ok',
    })),
    ...idle.filter((action) => action.action === 'ACTION_MOVE').map((action) => ({
      action: action.action,
      group_id: String(action.group_id),
      id: action.id,
      plu: action.plu,
      reason: 'Moved Item',
      source_id: action.source_id,
      state: 'STATE_ACCEPTED',
      status: 'ok',
    })),
  ];
}

async function clearTaskActions(api, token, taskId, dryRun) {
  const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
  const reports = captureSections(capture).map((section) => section.report).filter(isDoneReport);
  let patched = 0;
  let idleRemaining = 0;
  for (const report of reports) {
    const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
    const payload = correctionPayloads(detail.report_actions || []);
    patched += payload.length;
    if (payload.length && !dryRun) {
      await api.reboticsJson(token, 'PATCH', `/api/v4/processing/actions/${report.id}/update_actions/`, payload);
    }
  }
  if (!dryRun) {
    for (const report of reports) {
      const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
      idleRemaining += (detail.report_actions || []).filter((action) => action.state === 'STATE_IDLE').length;
    }
  }
  return { reports: reports.length, patched, idleRemaining };
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
  if (!item?.id) throw new Error(`No bays/doors survey item on survey ${surveyId}`);
  if (!dryRun) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/surveys/${surveyId}/responses/${responseId}/`, {
      answers: [{ item: item.id, answer: '0' }],
    });
  }
  return { item: item.id, answer: '0' };
}

function downloadBinary(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBinary(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for photo URL`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function uploadProdPhotos({ api, token, task, prod, sections, dryRun }) {
  const urls = [...new Set(prod.afterPictureUrls || [])].sort();
  const targetSections = sectionsNeedingCapture(sections);
  const maxBay = Math.max(...targetSections.map((section) => section.bay), 0);
  if (urls.length < maxBay) {
    return { ok: false, reason: `insufficient PROD photos ${urls.length}/${maxBay}` };
  }
  if (dryRun) return { ok: true, uploaded: targetSections.length, dryRun: true };
  const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
  const storeId = task.store?.id;
  if (!storePlanogramId || !storeId) throw new Error('Task missing store_planogram_id or store.id');
  let uploaded = 0;
  for (let i = 0; i < targetSections.length; i += 1) {
    const section = targetSections[i];
    const url = urls[section.bay - 1] || urls[i];
    const fileBuffer = await downloadBinary(url);
    await api.uploadAndAttachPhoto({
      token,
      filename: `${safeSegment(task.title || task.id)}_bay-${String(section.bay).padStart(2, '0')}.jpg`,
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
    uploaded += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { ok: true, uploaded };
}

async function deleteProblemReportsForSections(api, token, taskId, sections, { forceAll = false } = {}) {
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

async function uploadBlurryPhotos({ api, token, task, sections, blurryPath, forceAll = false, dryRun }) {
  const targetSections = sectionsNeedingCapture(sections, { forceAll });
  if (!targetSections.length) return { ok: true, uploaded: 0, skipped: 'sections already done' };
  if (!blurryPath || !fs.existsSync(blurryPath)) {
    return { ok: false, reason: `blurry photo path not found: ${blurryPath || '(not provided)'}` };
  }
  if (dryRun) return { ok: true, uploaded: targetSections.length, dryRun: true, blurry: true };
  const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
  const storeId = task.store?.id;
  if (!storePlanogramId || !storeId) throw new Error('Task missing store_planogram_id or store.id');
  const deletedReports = await deleteProblemReportsForSections(api, token, task.id, sections, { forceAll });
  const fileBuffer = await fsp.readFile(blurryPath);
  let uploaded = 0;
  for (const section of targetSections) {
    await api.uploadAndAttachPhoto({
      token,
      filename: `blurry_${safeSegment(task.title || task.id)}_bay-${String(section.bay).padStart(2, '0')}.jpg`,
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
    uploaded += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { ok: true, uploaded, blurry: true, deletedReports };
}

async function closeTask({ api, token, taskId, prod, getProd, allowBlurry = false, blurryPath = '', dryRun }) {
  let task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  let openedByScript = false;
  async function openTaskIfNeeded() {
    if (task.status?.id === 'in_progress' || dryRun) return;
    await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, { status: 'in_progress' });
    openedByScript = true;
    task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  }
  async function resetIfOpenedByScript() {
    if (!openedByScript || dryRun) return;
    try {
      await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, {
        status: 'incomplete',
        status_reason: 'Backlog - Revisit Needed',
      });
    } catch {
      // Best-effort cleanup; the original skip/error is more useful to report.
    }
  }
  if (task.status?.id === 'completed') return { status: 'already-completed' };
  const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
  const sections = captureSections(capture);
  const taskRejected = String(task.scan_status || '').toUpperCase() === 'REJECTED';
  let uploaded = { skipped: 'sections already done' };
  if (!allSectionsDone(sections) || taskRejected) {
    if (!prod && dryRun) {
      return { status: 'would-need-prod-photo-upload', reason: 'sections are not all done in SI; apply run would fetch PROD photos before upload' };
    }
    if (!taskRejected && !prod && typeof getProd === 'function') {
      prod = await getProd();
    }
    if (!prod && !allowBlurry) {
      return { status: 'skip', reason: 'no matching completed PROD row with photos found for upload' };
    }
    await openTaskIfNeeded();
    if (taskRejected && allowBlurry) {
      uploaded = await uploadBlurryPhotos({ api, token, task, sections, blurryPath, forceAll: true, dryRun });
    } else if (prod) {
      uploaded = await uploadProdPhotos({ api, token, task, prod, sections, dryRun });
    } else {
      uploaded = { ok: false, reason: 'no matching completed PROD row with photos found for upload' };
    }
    if (!uploaded.ok && allowBlurry) {
      uploaded = await uploadBlurryPhotos({ api, token, task, sections, blurryPath, dryRun });
    }
    if (!uploaded.ok) {
      await resetIfOpenedByScript();
      return { status: 'skip', reason: uploaded.reason, resetToIncomplete: openedByScript };
    }
    const wait = dryRun ? { ok: true, dryRun: true } : await waitForDoneSections(api, token, taskId);
    if (!wait.ok) {
      await resetIfOpenedByScript();
      return { status: 'skip', reason: `CV wait failed: ${wait.reason}`, states: wait.last, resetToIncomplete: openedByScript };
    }
  } else {
    await openTaskIfNeeded();
  }
  const corrections = await clearTaskActions(api, token, taskId, dryRun);
  const survey = await submitSurveyZero(api, token, task, dryRun);
  if (!dryRun) {
    try {
      await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${taskId}/`, { status: 'completed' });
    } catch (error) {
      await resetIfOpenedByScript();
      throw error;
    }
  }
  const finalTask = dryRun ? task : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/`);
  return {
    status: dryRun ? 'would-complete' : 'completed',
    uploaded,
    corrections,
    survey,
    finalStatus: finalTask.status?.id || null,
    finalScanStatus: finalTask.scan_status || null,
    finalActionsCount: finalTask.actions_count || null,
  };
}

async function writeJson(dest, value) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, JSON.stringify(value, null, 2));
}

function countBy(rows, field) {
  return (rows || []).reduce((acc, row) => {
    const value = String(row?.[field] ?? 'unknown');
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function loadDiscrepancyCandidates(discrepancyPath, scope, periods) {
  const raw = JSON.parse(fs.readFileSync(discrepancyPath, 'utf8'));
  const rows = [];
  const prodByKey = new Map();
  for (const item of raw) {
    if (!item.prodDone || item.siDone) continue;
    if (!scope.allowedStores.has(String(item.store))) continue;
    if (periods.length && !periods.includes(item.periodWeek)) continue;
    const key = `${item.periodWeek}|${item.store}|${String(item.categoryId)}|${item.dbkey}`;
    rows.push({
      store: String(item.store),
      period_week: item.periodWeek,
      category_id: String(item.categoryId),
      dbkey: String(item.dbkey),
      workbook_kind: item.workbookKind,
      row_index: item.rowIndex,
      set_type: item.setType || '',
      bucket: item.bucket || 'mirror_si_stale_or_absent',
      si_task_id: item.siTaskId || null,
    });
    const urls = Array.isArray(item.prodAfterPictureUrls) ? item.prodAfterPictureUrls.filter(Boolean) : [];
    if (urls.length) {
      prodByKey.set(key, {
        periodWeek: item.periodWeek,
        storeNumber: String(item.store),
        categoryId: String(item.categoryId),
        dbkey: String(item.dbkey),
        afterPictureUrls: urls,
      });
    }
  }
  return { rows, prodByKey };
}

async function main() {
  const opts = parseArgs(process.argv);
  const cutoff = opts.cutoff || defaultCutoff();
  const periods = periodsThrough(cutoff);
  const scope = buildApplyScope({ districts: opts.districts, stores: opts.stores });
  const stores = [...scope.allowedStores].sort((a, b) => Number(a) - Number(b));
  if (opts.applySi || opts.writeTracker) {
    assertApplyScopeConfirmed(scope, opts.confirmScope);
  }
  const outDir = path.resolve(opts.outDir);
  await fsp.mkdir(outDir, { recursive: true });

  const summary = {
    mode: opts.applySi ? 'apply-si' : 'dry-run',
    writeTrackerRequested: opts.writeTracker,
    districts: scope.districts,
    applyScope: scopeSummary(scope),
    stores,
    cutoff,
    periods,
    projects: opts.projects,
    taskDate: opts.taskDate,
    snapshotBuckets: opts.snapshotBuckets,
    allowBlurry: opts.allowBlurry,
    blurryPath: opts.allowBlurry ? opts.blurryPath : '',
    outDir,
    startedAt: new Date().toISOString(),
    counts: {},
    meta: [],
    candidates: [],
    completed: [],
    trackerWritePlan: [],
    skipped: [],
    errors: [],
  };

  console.log(`${opts.applySi ? '[APPLY SI]' : '[DRY RUN]'} PROD-complete -> SI closeout`);
  console.log(`districts=D${scope.districts.join(',D')} stores=${stores.length} cutoff=${cutoff} taskDate=${opts.taskDate} out=${outDir}`);

  let prodByKeyFromDiscrepancies = new Map();
  let tracker;
  if (opts.discrepancies) {
    if (!fs.existsSync(opts.discrepancies)) throw new Error(`Discrepancies file not found: ${opts.discrepancies}`);
    const loaded = loadDiscrepancyCandidates(opts.discrepancies, scope, periods);
    tracker = { meta: [{ source: 'discrepancies', path: opts.discrepancies }], rows: loaded.rows };
    prodByKeyFromDiscrepancies = loaded.prodByKey;
    summary.discrepanciesSource = opts.discrepancies;
  } else {
    tracker = await fetchTrackerRows({ stores, periods, snapshotBuckets: opts.snapshotBuckets });
  }
  summary.meta = tracker.meta;
  summary.counts.trackerPending = tracker.rows.length;
  console.log(`tracker pending rows: ${tracker.rows.length}${opts.discrepancies ? ' (from discrepancies JSON)' : opts.snapshotBuckets ? ' (snapshot PROD/SI buckets only)' : ''}`);

  let sasContext = null;
  async function getSasContext() {
    if (sasContext) return sasContext;
    const sas = await loadSasSession();
    console.log(`SAS session source: ${sas.source} generatedAt=${sas.generatedAt || 'unknown'}`);
    sasContext = {
      sas,
      projectStoreMaps: await fetchProjectStoreMaps(sas.token, opts.projects),
    };
    return sasContext;
  }

  const api = loadReboticsApi();
  const auth = await api.fetchTokenFromRailway();
  const token = auth.token;
  const userId = auth.userId || api.DEFAULT_USER_ID || 211;
  console.log(`Rebotics auth: ${auth.username || userId}`);

  const liveTasksByKey = new Map();
  const storeIds = new Map();
  for (const store of stores) {
    const customId = toCustomId(store);
    try {
      const storeId = await api.resolveStoreInternalId(token, customId, { date: opts.taskDate });
      storeIds.set(store, storeId);
      const tasks = await api.listTasksForStoreAndDate(token, storeId, opts.taskDate);
      for (const task of tasks) {
        const taskDbkey = dbkeyFromTask(task);
        const taskCategory = categoryIdFromTask(task);
        const taskPeriod = periodFromTask(task);
        if (!taskDbkey || !taskCategory || !taskPeriod || !periods.includes(taskPeriod)) continue;
        const key = taskKeyFromTask(task, taskPeriod, store);
        const current = liveTasksByKey.get(key);
        const rank = { in_progress: 0, created: 1, incomplete: 2, completed: 3 };
        if (!current || (rank[task.status?.id] ?? 9) < (rank[current.status?.id] ?? 9)) {
          liveTasksByKey.set(key, task);
        }
      }
    } catch (error) {
      summary.errors.push({ store, stage: 'list-si-tasks', error: error.message });
      console.log(`store ${store} SI task list error: ${error.message}`);
    }
  }
  if (opts.discrepancies) {
    for (const row of tracker.rows) {
      if (!row.si_task_id) continue;
      try {
        const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${row.si_task_id}/`);
        const key = `${row.period_week}|${row.store}|${String(row.category_id)}|${row.dbkey}`;
        liveTasksByKey.set(key, task);
      } catch (error) {
        summary.errors.push({ store: row.store, stage: 'seed-si-task', taskId: row.si_task_id, error: error.message });
      }
    }
  }

  summary.counts.liveSiKeys = liveTasksByKey.size;
  console.log(`live SI keys=${liveTasksByKey.size}`);

  const openedStores = new Set();
  let processed = 0;
  for (const row of tracker.rows) {
    if (!scope.allowedStores.has(String(row.store))) {
      summary.skipped.push({
        key: trackerKey(row),
        store: row.store,
        district: districtForStore(row.store),
        reason: 'out of apply scope',
        row,
      });
      continue;
    }
    const key = trackerKey(row);
    let prod = null;
    if (row.bucket === 'matched_both') {
      summary.trackerWritePlan.push({
        key,
        workbookKind: row.workbook_kind,
        rowIndex: row.row_index,
        store: row.store,
        periodWeek: row.period_week,
        categoryId: String(row.category_id),
        dbkey: row.dbkey,
        setType: row.set_type,
        reason: 'snapshot bucket already matched_both',
      });
      continue;
    }
    const bucket = String(row.bucket || '');
    const prodCompleteBySnapshot = bucket.startsWith('mirror_si_') || Boolean(opts.discrepancies);
    if (opts.discrepancies) {
      prod = prodByKeyFromDiscrepancies.get(key) || null;
    } else if (!prodCompleteBySnapshot) {
      const context = await getSasContext();
      prod = await fetchProdRowForTracker({
        token: context.sas.token,
        projectStoreMaps: context.projectStoreMaps,
        trackerRow: row,
        projects: opts.projects,
        throughDate: opts.taskDate,
      });
    }
    if (!prodCompleteBySnapshot && !prod) {
      summary.skipped.push({ key, reason: 'not complete in PROD', row });
      continue;
    }
    const task = liveTasksByKey.get(key);
    const candidate = {
      key,
      workbookKind: row.workbook_kind,
      rowIndex: row.row_index,
      store: row.store,
      periodWeek: row.period_week,
      categoryId: String(row.category_id),
      dbkey: row.dbkey,
      setType: row.set_type,
      prodPhotos: prod?.afterPictureUrls?.length ?? null,
      taskId: task?.id || null,
      taskStatus: task?.status?.id || 'absent',
      taskTitle: task?.title || task?.task_def?.title || '',
    };
    summary.candidates.push(candidate);
    if (!task) {
      summary.skipped.push({ ...candidate, reason: 'no live SI task match on task layer' });
      continue;
    }
    if (opts.skipTaskIds.includes(Number(task.id))) {
      summary.skipped.push({ ...candidate, reason: 'task explicitly skipped' });
      continue;
    }
    if (task.status?.id === 'completed') {
      summary.trackerWritePlan.push({ ...candidate, reason: 'PROD complete and SI already completed' });
      continue;
    }
    if (processed >= opts.maxSets) {
      summary.skipped.push({ ...candidate, reason: 'max sets reached' });
      continue;
    }
    processed += 1;
    try {
      assertStoreInScope(scope, row.store, `dbkey ${row.dbkey} task ${task.id}`);
      if (opts.applySi && !openedStores.has(task.store?.id)) {
        await api.openShift(token, task.store.id, userId);
        openedStores.add(task.store.id);
      }
      const close = await closeTask({
        api,
        token,
        taskId: task.id,
        prod,
        getProd: async () => {
          const context = await getSasContext();
          return fetchProdRowForTracker({
            token: context.sas.token,
            projectStoreMaps: context.projectStoreMaps,
            trackerRow: row,
            projects: opts.projects,
            throughDate: opts.taskDate,
          });
        },
        allowBlurry: opts.allowBlurry,
        blurryPath: opts.blurryPath,
        dryRun: !opts.applySi,
      });
      if (close.status === 'completed' || close.status === 'already-completed' || close.status === 'would-complete') {
        const completedRow = { ...candidate, close };
        summary.completed.push(completedRow);
        summary.trackerWritePlan.push({ ...candidate, reason: `${close.status} in SI` });
        console.log(`${close.status}: ${key} task=${task.id}`);
      } else {
        summary.skipped.push({ ...candidate, reason: close.reason || close.status, close });
        console.log(`skip: ${key} task=${task.id} ${close.reason || close.status}`);
      }
    } catch (error) {
      summary.errors.push({ ...candidate, stage: 'close-si', error: error.message, body: error.body || null });
      console.log(`ERROR ${key} task=${task.id}: ${error.message}`);
    } finally {
      await writeJson(path.join(outDir, 'summary.json'), summary);
    }
  }

  if (opts.writeTracker) {
    if (!opts.applySi) {
      summary.errors.push({ stage: 'write-tracker', error: '--write-tracker requires --apply-si so tracker Yes is the final step.' });
    } else {
      const rowsToWrite = summary.trackerWritePlan.map((row) => ({
        workbookKind: row.workbookKind,
        store: row.store,
        periodWeek: row.periodWeek,
        categoryId: normalizeCategoryId(row.categoryId),
        dbkey: row.dbkey,
      }));
      summary.snapshotWrite = await writeSnapshotRowsComplete(rowsToWrite);
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.counts.candidates = summary.candidates.length;
  summary.counts.completed = summary.completed.length;
  summary.counts.trackerWritePlan = summary.trackerWritePlan.length;
  summary.counts.skipped = summary.skipped.length;
  summary.counts.errors = summary.errors.length;
  summary.counts.candidatesByTaskStatus = countBy(summary.candidates, 'taskStatus');
  summary.counts.skippedByReason = countBy(summary.skipped, 'reason');
  summary.counts.trackerWritePlanByReason = countBy(summary.trackerWritePlan, 'reason');
  await writeJson(path.join(outDir, 'summary.json'), summary);
  console.log(`summary: ${path.join(outDir, 'summary.json')}`);
  console.log(`candidates=${summary.counts.candidates} completed=${summary.counts.completed} trackerWritePlan=${summary.counts.trackerWritePlan} skipped=${summary.counts.skipped} errors=${summary.counts.errors}`);
  console.log(`candidateStatus=${JSON.stringify(summary.counts.candidatesByTaskStatus)} skippedReasons=${JSON.stringify(summary.counts.skippedByReason)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
