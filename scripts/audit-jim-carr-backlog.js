#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { FISCAL_CALENDARS } = require('../src/lib/fiscal-calendar');
const { DISTRICT_STORES } = require('../src/lib/trackers/metadata');
const { writeFileVersioned } = require('../src/lib/file-utils');
const { loadSasSession } = require('C:/Users/tgaut/kompass-netcap/lib/sas-session');

const PROD_FILE = 'C:/Users/tgaut/Downloads/PROD P4 Backlog as of 6.11.26.xlsx';
const SI_FILE = 'C:/Users/tgaut/Downloads/SI Backlog 6.11.26.xlsx';
const REBOTICS_ENV = 'C:/Users/tgaut/rebotics-carry-forward/.env';
const OUT_DIR = path.join(process.cwd(), 'output', 'jim-carr-backlog-audit');
const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const PROJECT_ID = 1;
const OFFSET_MIN = 420;
const FISCAL_YEAR = 2026;
const WEEKS_TO_QUERY = ['P03W3', 'P03W4', 'P04W1', 'P04W2', 'P04W3', 'P04W4'];

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizePeriodWeek(value) {
  const match = clean(value).toUpperCase().match(/P\s*(\d{1,2})\s*W\s*([1-4])/);
  return match ? `P${String(parseInt(match[1], 10)).padStart(2, '0')}W${parseInt(match[2], 10)}` : '';
}

function normalizeStore(value) {
  const text = clean(value);
  const match = text.match(/701[-\s]0*(\d{1,5})/i) || text.match(/\b0*(\d{1,4})\b/);
  if (!match) return '';
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function normalizeDbkey(value) {
  const text = clean(value);
  const fromProd = text.match(/^P\d+W\d[_-](\d{6,10})/i);
  if (fromProd) return fromProd[1];
  const fromSi = text.match(/^P\d+W\d(?:-\d{4})?\s+(\d{6,10})/i);
  if (fromSi) return fromSi[1];
  const embedded = text.match(/\b(\d{7,8})\b/);
  return embedded ? embedded[1] : '';
}

function normalizeCategoryId(value) {
  const match = clean(value).match(/\d+/);
  if (!match) return '';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function categoryFromProdPlanogram(value) {
  const match = clean(value).match(/_C(\d{2,4})_/i);
  return match ? normalizeCategoryId(match[1]) : '';
}

function categoryFromSiTaskName(value) {
  const text = clean(value);
  const afterDbkey = text.match(/^P\d+W\d(?:-\d{4})?\s+\d{6,10}\s+(\d{2,4})\s*[- ]/i);
  if (afterDbkey) return normalizeCategoryId(afterDbkey[1]);
  return '';
}

function keyFor(row) {
  return `${row.periodWeek || ''}|${row.store || ''}|${row.dbkey || ''}`;
}

function weekInfo(periodWeek) {
  const match = normalizePeriodWeek(periodWeek).match(/^P(\d{2})W([1-4])$/);
  if (!match) throw new Error(`Invalid period/week ${periodWeek}`);
  const period = match[1];
  const week = match[2];
  const data = FISCAL_CALENDARS[FISCAL_YEAR].periods[period].weeks[week];
  return {
    periodWeek: `P${period}W${week}`,
    start: data.start,
    end: data.end,
  };
}

function sasReportedRange(info) {
  const dateFrom = `${info.start}T07:00:00.000Z`;
  const endD = new Date(`${info.end}T12:00:00Z`);
  endD.setDate(endD.getDate() + 1);
  const dateTo = endD.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  return { dateFrom, dateTo };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      out[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function fetchWithRetry(url, options = {}, label = url, attempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      await sleep(500 * attempt);
    }
  }
  throw new Error(`${label} failed: ${lastErr.message}`);
}

async function sasGet(token, apiPath) {
  const res = await fetchWithRetry(`${SAS_BASE}${apiPath}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  }, `SAS ${apiPath}`);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`SAS ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function normalizeList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  return [];
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      record.push(field);
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((value) => clean(value))) records.push(record);
      record = [];
      field = '';
      continue;
    }
    field += ch;
  }
  record.push(field);
  if (record.some((value) => clean(value))) records.push(record);
  return records;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const headers = records[0].map(clean);
  return records.slice(1).map((record) => {
    const row = {};
    headers.forEach((header, i) => {
      row[header] = record[i] == null ? '' : record[i];
    });
    return row;
  });
}

function rowValue(row, names) {
  const normalized = new Map(Object.entries(row || {}).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, ' ').trim(), value]));
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/\s+/g, ' ').trim());
    if (value != null) return value;
  }
  return '';
}

function parseAfterPictureUrls(value) {
  const urls = [];
  const pattern = /https?:\/\/[^'"\s,\]]+/g;
  const raw = String(value || '');
  let match = null;
  while ((match = pattern.exec(raw)) != null) urls.push(match[0]);
  return urls;
}

function normalizeProdCompletion(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'true') return 'done';
  if (normalized === 'false') return 'not_done';
  return 'unknown';
}

function parseWorkbookFiles() {
  const py = String.raw`
import json, re
from pathlib import Path
import openpyxl

PROD_FILE = Path(r'${PROD_FILE.replace(/\\/g, '\\\\')}')
SI_FILE = Path(r'${SI_FILE.replace(/\\/g, '\\\\')}')

def norm(v):
    return str(v or '').strip()
def period(v):
    m = re.search(r'P\s*(\d{1,2})\s*W\s*([1-4])', norm(v), re.I)
    return f"P{int(m.group(1)):02d}W{int(m.group(2))}" if m else ''
def store(v):
    s = norm(v)
    m = re.search(r'701[- ]0*(\d{1,5})', s, re.I) or re.search(r'\b0*(\d{1,4})\b', s)
    return str(int(m.group(1))) if m else ''
def dbkey(v):
    s = norm(v)
    m = re.search(r'^P\d+W\d[_-](\d{6,10})', s, re.I) or re.search(r'^P\d+W\d(?:-\d{4})?\s+(\d{6,10})', s, re.I) or re.search(r'\b(\d{7,8})\b', s)
    return m.group(1) if m else ''
def cat_prod(commodity, plan):
    m = re.match(r'\s*(\d{2,4})\b', norm(commodity))
    if m:
        return str(int(m.group(1)))
    m = re.search(r'_C(\d{2,4})_', norm(plan), re.I)
    return str(int(m.group(1))) if m else ''
def cat_si(task):
    m = re.search(r'^P\d+W\d(?:-\d{4})?\s+\d{6,10}\s+(\d{2,4})\s*[- ]', norm(task), re.I)
    return str(int(m.group(1))) if m else ''
def rows_from(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    header = None
    for idx, row in enumerate(ws.iter_rows(values_only=True), 1):
        vals = [norm(v) for v in row]
        if not any(vals):
            continue
        if header is None:
            if any(v.lower() == 'supervisor' for v in vals) and any(v.lower() == 'period/week' for v in vals):
                header = vals
            continue
        data = {header[i]: vals[i] if i < len(vals) else '' for i in range(len(header))}
        yield idx, data

prod = []
prod_sup_counts = {}
for idx, data in rows_from(PROD_FILE):
    sup = data.get('Supervisor', '')
    prod_sup_counts[sup] = prod_sup_counts.get(sup, 0) + 1
    if sup.lower() == 'james carr' or 'carr' in sup.lower():
        plan = data.get('Planogram Id') or data.get('Planogram ID') or ''
        rec = {
            'sourceFile': 'prod',
            'fileRow': idx,
            'periodWeek': period(data.get('Period/Week') or plan),
            'supervisor': sup,
            'store': store(data.get('Store #')),
            'commodity': data.get('Commodity', ''),
            'categoryId': cat_prod(data.get('Commodity', ''), plan),
            'exception': data.get('Category Exception', ''),
            'comment': data.get('Category Comment', ''),
            'planogramId': plan,
            'dbkey': dbkey(plan),
        }
        rec['key'] = f"{rec['periodWeek']}|{rec['store']}|{rec['dbkey']}"
        prod.append(rec)

si = []
si_sup_counts = {}
for idx, data in rows_from(SI_FILE):
    sup = data.get('Supervisor', '')
    si_sup_counts[sup] = si_sup_counts.get(sup, 0) + 1
    if sup.lower() in {'701-james', '701-jim'} or 'carr' in sup.lower():
        task = data.get('Task Name', '')
        rec = {
            'sourceFile': 'si',
            'fileRow': idx,
            'periodWeek': period(data.get('Period/Week') or task),
            'supervisor': sup,
            'store': store(data.get('Store')),
            'taskName': task,
            'categoryId': cat_si(task),
            'exception': data.get('Task Exception', ''),
            'dbkey': dbkey(task),
        }
        rec['key'] = f"{rec['periodWeek']}|{rec['store']}|{rec['dbkey']}"
        si.append(rec)

print(json.dumps({
    'prodFileRows': prod,
    'siFileRows': si,
    'prodSupervisorCounts': prod_sup_counts,
    'siSupervisorCounts': si_sup_counts,
}))
`;
  const result = spawnSync('python', ['-c', py], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Workbook parse failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function fetchProdRows(stores, weeks) {
  const session = await loadSasSession();
  const projectStores = normalizeList(await sasGet(session.token, `/projects/project-stores/?project=${PROJECT_ID}`));
  const byStore = new Map(projectStores.map((ps) => [String(ps?.store?.number), ps]));
  const units = [];
  for (const store of stores) {
    for (const periodWeek of weeks) units.push({ store, info: weekInfo(periodWeek) });
  }
  const rows = [];
  const errors = [];
  let done = 0;
  await mapLimit(units, 4, async ({ store, info }) => {
    const ps = byStore.get(String(store));
    if (!ps) {
      errors.push({ source: 'prod', store, periodWeek: info.periodWeek, error: `Store not found in project ${PROJECT_ID}` });
      return;
    }
    try {
      const range = sasReportedRange(info);
      const params = new URLSearchParams({
        customer_id: String(CUSTOMER_ID),
        date_from: range.dateFrom,
        date_to: range.dateTo,
        date_type: 'reported',
        offset: String(OFFSET_MIN),
        project_id: String(PROJECT_ID),
        shift_status: 'completed',
        store_id: String(ps.id),
      });
      const body = await sasGet(session.token, `/reports/category-reset-report/?${params.toString()}`);
      if (!body?.file_url) return;
      const csvRes = await fetchWithRetry(body.file_url, {}, `SAS CSV ${store} ${info.periodWeek}`);
      const csvText = await csvRes.text();
      const parsed = parseCsv(csvText);
      for (const raw of parsed) {
        const planogramId = clean(rowValue(raw, ['Planogram ID']));
        const periodWeek = normalizePeriodWeek(planogramId || rowValue(raw, ['Period/Week']));
        const rowStore = normalizeStore(rowValue(raw, ['Store #', 'Store']) || store);
        const dbkey = normalizeDbkey(planogramId);
        if (periodWeek !== info.periodWeek || rowStore !== String(store) || !dbkey) continue;
        const afterPictureUrls = parseAfterPictureUrls(rowValue(raw, ['After Pictures Link']));
        rows.push({
          source: 'prod',
          periodWeek,
          store: rowStore,
          dbkey,
          key: `${periodWeek}|${rowStore}|${dbkey}`,
          categoryId: normalizeCategoryId(rowValue(raw, ['Category ID'])) || categoryFromProdPlanogram(planogramId),
          commodity: clean(rowValue(raw, ['Category', 'Category Name', 'Department Name', 'Commodity'])),
          planogramId,
          completionStatus: normalizeProdCompletion(rowValue(raw, ['Category Completion Status'])),
          exception: clean(rowValue(raw, ['Category Exception Reason', 'Category Exception', 'Exception Reason'])),
          comment: clean(rowValue(raw, ['Comment', 'Comments'])),
          afterPhotoRequired: clean(rowValue(raw, ['After Photo Required'])).toLowerCase() === 'true',
          photoCount: afterPictureUrls.length,
          afterPictureUrls,
          visitId: clean(rowValue(raw, ['Visit ID'])),
          shiftStatus: clean(rowValue(raw, ['Shift Status', 'Status'])).toLowerCase(),
        });
      }
    } catch (err) {
      errors.push({ source: 'prod', store, periodWeek: info.periodWeek, error: err.message });
    } finally {
      done += 1;
      if (done % 20 === 0 || done === units.length) console.log(`[audit] PROD ${done}/${units.length}`);
    }
  });
  return { rows, errors };
}

function taskStatus(task) {
  return clean(task?.status?.id || task?.status || 'unknown').toLowerCase();
}

function taskTitle(task) {
  return clean(task?.title || task?.task_def?.title || task?.task_def__title);
}

function taskDbkey(task) {
  const fromPlanogram = clean(task?.planograms?.[0]?.custom_id);
  if (/^\d{6,10}$/.test(fromPlanogram)) return fromPlanogram;
  return normalizeDbkey(taskTitle(task));
}

function taskCategoryId(task) {
  const fromTitle = categoryFromSiTaskName(taskTitle(task));
  if (fromTitle) return fromTitle;
  const label = clean(task?.category?.name || task?.commodity);
  const match = label.match(/^(\d{2,4})\s*-/);
  return match ? normalizeCategoryId(match[1]) : '';
}

function embeddedPrePhotoActions(task) {
  const pre = task?.result?.pre_photo;
  return Array.isArray(pre) ? pre : [];
}

function usableAction(action) {
  if (!action) return false;
  if (action.stage && action.stage !== 'pre_photo') return false;
  if (action.deactivated || action.rejected) return false;
  return Boolean(action.merged_image || action.id || action.action_id || action.actionId);
}

async function countSiActions(reboticsApi, token, taskId) {
  const actions = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const data = await reboticsApi.reboticsJson(token, 'GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/processing/actions/?show_actions=below&limit=${limit}&offset=${offset}`);
    const chunk = Array.isArray(data) ? data : (data?.results || []);
    actions.push(...chunk);
    if (!data?.next || chunk.length < limit) break;
    offset += limit;
  }
  return actions.filter(usableAction).length;
}

async function fetchSiRows(stores, weeks, targetKeySet) {
  parseDotEnv(REBOTICS_ENV);
  const reboticsApi = require('C:/Users/tgaut/rebotics-carry-forward/lib/rebotics-api');
  const auth = await reboticsApi.fetchTokenFromRailway();
  const units = [];
  for (const store of stores) {
    for (const periodWeek of weeks) units.push({ store, info: weekInfo(periodWeek) });
  }
  const rows = [];
  const errors = [];
  let done = 0;
  await mapLimit(units, 4, async ({ store, info }) => {
    try {
      const customId = reboticsApi.fmStoreToCustomId(store);
      const storeId = await reboticsApi.resolveStoreInternalId(auth.token, customId, { date: info.start });
      const path = `/api/v1/tasks/?store=${storeId}&from_date=${encodeURIComponent(info.start)}&to_date=${encodeURIComponent(info.end)}&limit=200&offset=0&ordering=task_def__title`;
      const data = await reboticsApi.reboticsJson(auth.token, 'GET', path);
      const tasks = Array.isArray(data) ? data : (data?.results || []);
      for (const task of tasks) {
        const title = taskTitle(task);
        const periodWeek = normalizePeriodWeek(title);
        if (periodWeek !== info.periodWeek) continue;
        const dbkey = taskDbkey(task);
        if (!dbkey) continue;
        const key = `${periodWeek}|${store}|${dbkey}`;
        const embedded = embeddedPrePhotoActions(task).filter(usableAction);
        rows.push({
          source: 'si',
          periodWeek,
          store: String(store),
          dbkey,
          key,
          categoryId: taskCategoryId(task),
          taskId: task?.id || null,
          taskName: title,
          status: taskStatus(task),
          statusReason: clean(task?.status_reason || task?.statusReason || task?.result?.status_reason),
          scanStatus: clean(task?.scan_status || task?.scanStatus),
          embeddedPhotoCount: embedded.length,
          photoCount: embedded.length,
          actionPhotoCountChecked: false,
          rawActionCounts: task?.actions_count || null,
        });
      }
    } catch (err) {
      errors.push({ source: 'si', store, periodWeek: info.periodWeek, error: err.message });
    } finally {
      done += 1;
      if (done % 20 === 0 || done === units.length) console.log(`[audit] SI tasks ${done}/${units.length}`);
    }
  });

  const relevant = rows.filter((row) => targetKeySet.has(row.key));
  await mapLimit(relevant, 6, async (row, i) => {
    if (row.photoCount > 0 || !row.taskId) return;
    try {
      row.photoCount = await countSiActions(reboticsApi, auth.token, row.taskId);
      row.actionPhotoCountChecked = true;
    } catch (err) {
      row.actionPhotoCountError = err.message;
    }
    if ((i + 1) % 25 === 0 || i + 1 === relevant.length) console.log(`[audit] SI photo checks ${i + 1}/${relevant.length}`);
  });
  return { rows, errors, authMeta: { username: auth.username, refreshedAt: auth.refreshedAt } };
}

function chooseBest(rows, source) {
  if (!rows || !rows.length) return null;
  return [...rows].sort((a, b) => {
    if (source === 'prod') {
      const score = (row) => (row.completionStatus === 'done' ? 4 : 0) + (row.photoCount > 0 ? 2 : 0) + (/backlog/i.test(row.exception) ? 1 : 0);
      return score(b) - score(a);
    }
    const score = (row) => (/complete/.test(row.status) ? 4 : 0) + (row.photoCount > 0 ? 2 : 0) + (/backlog/i.test(row.statusReason) ? 1 : 0);
    return score(b) - score(a);
  })[0];
}

function classify(row) {
  const prodPresent = Boolean(row.prod);
  const siPresent = Boolean(row.si);
  const prodPhotos = (row.prod?.photoCount || 0) > 0;
  const siPhotos = (row.si?.photoCount || 0) > 0;
  const prodDone = row.prod?.completionStatus === 'done';
  const siDone = row.si && ['complete', 'completed', 'done'].includes(clean(row.si.status));

  if (prodDone && siDone && prodPhotos && siPhotos) {
    return { canSignOut: 'Yes', finding: 'Both systems complete with photos loaded.' };
  }
  if (prodPhotos && siPhotos) {
    return { canSignOut: 'Likely after status cleanup', finding: 'Photos are loaded in both systems, but one or both statuses are not complete.' };
  }
  if (prodPhotos && !siPhotos) {
    return { canSignOut: 'Needs SI photo load', finding: siPresent ? 'Pictures are loaded in PROD but not SI.' : 'Pictures are loaded in PROD; matching SI task was not found live.' };
  }
  if (siPhotos && !prodPhotos) {
    return { canSignOut: 'Needs PROD photo load', finding: prodPresent ? 'Pictures are loaded in SI but not PROD.' : 'Pictures are loaded in SI; matching PROD row was not found live.' };
  }
  if (!prodPresent && !siPresent) {
    return { canSignOut: 'No', finding: 'Listed in workbook(s), but no live match was found in either system.' };
  }
  if (!prodPresent || !siPresent) {
    return { canSignOut: 'Manual review', finding: `${prodPresent ? 'PROD' : 'SI'} has the only live match, and no photos were found.` };
  }
  return { canSignOut: 'No', finding: 'Live matches exist, but no photos were found in either system.' };
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  const headers = [
    'periodWeek', 'store', 'dbkey', 'categoryId', 'prodFileListed', 'siFileListed',
    'prodLiveListed', 'siLiveListed', 'prodStatus', 'siStatus', 'prodPhotos', 'siPhotos',
    'canSignOut', 'finding', 'prodException', 'siException', 'prodPlanogramId', 'siTaskName',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const record = {
      periodWeek: row.periodWeek,
      store: row.store,
      dbkey: row.dbkey,
      categoryId: row.categoryId,
      prodFileListed: row.prodFileListed,
      siFileListed: row.siFileListed,
      prodLiveListed: Boolean(row.prod),
      siLiveListed: Boolean(row.si),
      prodStatus: row.prod?.completionStatus || '',
      siStatus: row.si?.status || '',
      prodPhotos: row.prod?.photoCount || 0,
      siPhotos: row.si?.photoCount || 0,
      canSignOut: row.canSignOut,
      finding: row.finding,
      prodException: row.prod?.exception || '',
      siException: row.si?.statusReason || '',
      prodPlanogramId: row.prod?.planogramId || row.prodFile?.planogramId || '',
      siTaskName: row.si?.taskName || row.siFile?.taskName || '',
    };
    lines.push(headers.map((h) => csvEscape(record[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const parsed = parseWorkbookFiles();
  const jimStores = DISTRICT_STORES[1].map(String);
  const fileRows = [...parsed.prodFileRows, ...parsed.siFileRows];
  const targetKeySet = new Set(fileRows.map((row) => row.key).filter((key) => !key.startsWith('||')));

  console.log(`[audit] workbook PROD Jim rows=${parsed.prodFileRows.length}`);
  console.log(`[audit] workbook SI James rows=${parsed.siFileRows.length}`);
  console.log(`[audit] Jim District 1 stores=${jimStores.join(',')}`);

  const [prodLive, siLive] = await Promise.all([
    fetchProdRows(jimStores, WEEKS_TO_QUERY),
    fetchSiRows(jimStores, WEEKS_TO_QUERY, targetKeySet),
  ]);

  const prodFileByKey = new Map();
  for (const row of parsed.prodFileRows) {
    if (!prodFileByKey.has(row.key)) prodFileByKey.set(row.key, []);
    prodFileByKey.get(row.key).push(row);
  }
  const siFileByKey = new Map();
  for (const row of parsed.siFileRows) {
    if (!siFileByKey.has(row.key)) siFileByKey.set(row.key, []);
    siFileByKey.get(row.key).push(row);
  }
  const prodLiveByKey = new Map();
  for (const row of prodLive.rows) {
    if (!prodLiveByKey.has(row.key)) prodLiveByKey.set(row.key, []);
    prodLiveByKey.get(row.key).push(row);
  }
  const siLiveByKey = new Map();
  for (const row of siLive.rows) {
    if (!siLiveByKey.has(row.key)) siLiveByKey.set(row.key, []);
    siLiveByKey.get(row.key).push(row);
  }

  const reportKeys = new Set(targetKeySet);
  const prodLiveBacklogExtras = prodLive.rows
    .filter((row) => /backlog/i.test(row.exception) && !targetKeySet.has(row.key))
    .map((row) => row.key);
  const siLiveBacklogExtras = siLive.rows
    .filter((row) => /backlog/i.test(row.statusReason) && !targetKeySet.has(row.key))
    .map((row) => row.key);

  const results = [...reportKeys].sort((a, b) => {
    const [ap, as, ad] = a.split('|');
    const [bp, bs, bd] = b.split('|');
    return ap.localeCompare(bp) || (parseInt(as, 10) - parseInt(bs, 10)) || ad.localeCompare(bd);
  }).map((key) => {
    const [periodWeek, store, dbkey] = key.split('|');
    const prodFile = prodFileByKey.get(key)?.[0] || null;
    const siFile = siFileByKey.get(key)?.[0] || null;
    const prod = chooseBest(prodLiveByKey.get(key), 'prod');
    const si = chooseBest(siLiveByKey.get(key), 'si');
    const base = {
      key,
      periodWeek,
      store,
      dbkey,
      categoryId: prod?.categoryId || si?.categoryId || prodFile?.categoryId || siFile?.categoryId || '',
      prodFileListed: Boolean(prodFile),
      siFileListed: Boolean(siFile),
      prodFile,
      siFile,
      prod,
      si,
    };
    return { ...base, ...classify(base) };
  });

  const byFinding = {};
  const byCanSignOut = {};
  for (const row of results) {
    byFinding[row.finding] = (byFinding[row.finding] || 0) + 1;
    byCanSignOut[row.canSignOut] = (byCanSignOut[row.canSignOut] || 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    workbooks: {
      prodFile: PROD_FILE,
      siFile: SI_FILE,
      prodFileJimRows: parsed.prodFileRows.length,
      siFileJamesRows: parsed.siFileRows.length,
      prodSupervisorCounts: parsed.prodSupervisorCounts,
      siSupervisorCounts: parsed.siSupervisorCounts,
    },
    scope: {
      supervisor: 'Jim Carr / James Carr / 701-James',
      fiscalYear: FISCAL_YEAR,
      weeksQueried: WEEKS_TO_QUERY.map(weekInfo),
      storesQueried: jimStores,
      projectId: PROJECT_ID,
      projectName: 'Fred Meyer Kompass ISE',
    },
    liveCounts: {
      prodRowsFetched: prodLive.rows.length,
      siTasksFetched: siLive.rows.length,
      resultRows: results.length,
      prodLiveBacklogExtras: new Set(prodLiveBacklogExtras).size,
      siLiveBacklogExtras: new Set(siLiveBacklogExtras).size,
      prodQueryErrors: prodLive.errors.length,
      siQueryErrors: siLive.errors.length,
    },
    byCanSignOut,
    byFinding,
    errors: [...prodLive.errors, ...siLive.errors],
  };

  const payload = { summary, results };
  const jsonPath = await writeFileVersioned(path.join(OUT_DIR, 'jim-carr-backlog-audit.json'), JSON.stringify(payload, null, 2));
  const csvPath = await writeFileVersioned(path.join(OUT_DIR, 'jim-carr-backlog-audit.csv'), toCsv(results));
  console.log(JSON.stringify({ summary, jsonPath, csvPath }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
