#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  buildReconciliationKey,
  classifyReconciliation,
  normalizeDbkey,
  normalizePeriodWeek,
  normalizeSiStatus,
} = require('../../src/lib/trackers/sheet-reconciliation');
const {
  normalizeCategoryId,
  parseAfterPictureUrls,
} = require('../../src/lib/trackers/prod-row-fields');

const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const PROJECT_ID = 1;
const PROJECT_LABEL = 'Fred Meyer Kompass ISE';
const OFFSET_MIN = 420;
const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';

const DEFAULT_DS_QUERY_URL = 'https://krcs-reporting.rebotics.net/api/ds/query';
const DATASOURCE_UID = 'Drt7OkEGk';
const DATASOURCE_TYPE = 'grafana-postgresql-datasource';
const SESSION_INVALID_MESSAGE = 'SESSION EXPIRED OR INVALID - recapture cookie and rerun';
const PLACEHOLDER_SQL = '-- PASTE VERBATIM QUERY 46 HERE';

const SCRIPT_DIR = __dirname;
const QUERY_PATH = path.join(SCRIPT_DIR, 'query46.sql');
const COOKIE_PATH = path.join(SCRIPT_DIR, '.cookie');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');

const TAG_LOOKUP_SQL = `select tag_id, tag_name
  from dds.d_tag
 where (right(tag_name, 4))::int = 2026
   and substr(tag_name, 1, 3) in ('P04','P05')
 order by substr(tag_name, 1, 5)`;

const PROD_WEEK_RANGES = [
  { periodWeek: 'P04W1', dateFrom: '2026-04-26T07:00:00.000Z', dateTo: '2026-05-03T12:00:00.000Z' },
  { periodWeek: 'P04W2', dateFrom: '2026-05-03T07:00:00.000Z', dateTo: '2026-05-10T12:00:00.000Z' },
  { periodWeek: 'P04W3', dateFrom: '2026-05-10T07:00:00.000Z', dateTo: '2026-05-17T12:00:00.000Z' },
  { periodWeek: 'P04W4', dateFrom: '2026-05-17T07:00:00.000Z', dateTo: '2026-05-24T12:00:00.000Z' },
  { periodWeek: 'P05W1', dateFrom: '2026-05-24T07:00:00.000Z', dateTo: '2026-05-31T12:00:00.000Z' },
  { periodWeek: 'P05W2', dateFrom: '2026-05-31T07:00:00.000Z', dateTo: '2026-06-07T12:00:00.000Z' },
  { periodWeek: 'P05W3', dateFrom: '2026-06-07T07:00:00.000Z', dateTo: '2026-06-14T12:00:00.000Z' },
];

const PREFERRED_KEYS = {
  matchedBoth: ['P05W3|50|55|9014777'],
};

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeInteger(value) {
  const match = clean(value).replace(/,/g, '').match(/\d+/);
  if (!match) return '';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function distinct(values) {
  return [...new Set(values.map(clean).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function formatList(values) {
  return values.length ? values.join(', ') : '(none)';
}

function formatJsonList(values) {
  return values.length ? values.map((value) => JSON.stringify(value)).join(', ') : '(none)';
}

async function loadLocalEnv() {
  let content;
  try {
    content = await fsp.readFile(ENV_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function loadSasToken() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE_PATH;
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const token = state?.auth?.auth_token;
    if (token) {
      return { token: String(token), source: 'state-file', generatedAt: state.generatedAt || null };
    }
  }

  const sessionUrl = process.env.SAS_AUTH_SESSION_URL || DEFAULT_SESSION_URL;
  try {
    const res = await fetch(sessionUrl);
    if (res.ok) {
      const body = await res.json();
      const token = body?.auth?.auth_token;
      if (token) {
        return { token: String(token), source: 'auth-server', generatedAt: body.generatedAt || null };
      }
    }
  } catch (_) {
    // Fall through to the same SAS_TOKEN fallback used by the proven pull script.
  }

  if (process.env.SAS_TOKEN) {
    return { token: String(process.env.SAS_TOKEN), source: 'SAS_TOKEN', generatedAt: null };
  }

  throw new Error('SAS keep-alive token unavailable');
}

async function readGrafanaCookie() {
  const envCookie = process.env.KOMPASS_GRAFANA_COOKIE;
  if (envCookie && envCookie.trim()) return envCookie.trim();

  try {
    const fileCookie = await fsp.readFile(COOKIE_PATH, 'utf8');
    const cookie = fileCookie.trim();
    if (cookie) return cookie;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  console.error('No Grafana session supplied');
  console.error('Set KOMPASS_GRAFANA_COOKIE to the raw Cookie header value, or place it on one line in scripts/kompass-proof/.cookie.');
  process.exit(1);
}

async function readQuery46Sql() {
  const rawSql = await fsp.readFile(QUERY_PATH, 'utf8');
  if (rawSql.trim() === PLACEHOLDER_SQL) {
    console.error('query46.sql still contains the placeholder. Paste the verbatim Query 46 rawSql before running.');
    process.exit(1);
  }
  return rawSql;
}

function isHtmlBody(contentType, text) {
  const lowerType = contentType.toLowerCase();
  const lowerText = text.slice(0, 1000).toLowerCase();
  return (
    lowerType.includes('text/html') ||
    lowerText.includes('<!doctype html') ||
    lowerText.includes('<html') ||
    (lowerText.includes('grafana') && lowerText.includes('login'))
  );
}

function printSessionInvalidAndExit() {
  console.error(SESSION_INVALID_MESSAGE);
  process.exit(1);
}

function grafanaErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') return error.message;
    if (error.data && typeof error.data.message === 'string') return error.data.message;
  }
  return JSON.stringify(error);
}

async function sasGetJsonTokenOnly(token, apiPath) {
  const res = await fetch(`${SAS_BASE}${apiPath}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  const body = parseJsonOrText(text);
  if (!res.ok) {
    const err = new Error(`SAS HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.bodyText = text;
    throw err;
  }
  return body;
}

function reportTokenOnlyRejection(err) {
  const bodyText = clean(err.bodyText || JSON.stringify(err.body || ''));
  const lower = bodyText.toLowerCase();
  if (err.status === 401) {
    console.error('PROD report rejected Token-only (status=401); token expired/invalid - recapture keep-alive');
    return;
  }
  if (err.status === 403 || lower.includes('csrf') || lower.includes('forbidden')) {
    console.error(`PROD report rejected Token-only (status=${err.status || 'unknown'}); CSRF/session may be required`);
    return;
  }
  console.error(`PROD report request failed (status=${err.status || 'unknown'}): ${err.message || 'unknown error'}`);
  if (err.cause?.message) {
    console.error(`PROD report fetch cause: ${err.cause.message}`);
  }
}

async function fetchCsv(fileUrl) {
  const res = await fetch(fileUrl, {
    method: 'GET',
    headers: { Accept: 'text/csv,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`CloudFront CSV fetch failed (status=${res.status})`);
  return res.text();
}

function parseCsvRecords(text) {
  const rows = [];
  let row = [];
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
      row.push(field);
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => clean(value) !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.some((value) => clean(value) !== '')) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => clean(h));
  const rows = records.slice(1).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] == null ? '' : record[index];
    });
    return row;
  });
  return { headers, rows };
}

function rowsFromGrafanaFrame(frame) {
  const fields = frame?.schema?.fields;
  const values = frame?.data?.values;
  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new Error('No Grafana table frame found at results.A.frames[0].');
  }
  const columnNames = fields.map((field) => field?.name ?? '');
  const rowCount = values.reduce((max, column) => Math.max(max, Array.isArray(column) ? column.length : 0), 0);
  const rows = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = {};
    for (let columnIndex = 0; columnIndex < columnNames.length; columnIndex += 1) {
      const column = values[columnIndex];
      row[columnNames[columnIndex]] = Array.isArray(column) ? column[rowIndex] : undefined;
    }
    rows.push(row);
  }
  return { columnNames, rows };
}

function createGrafanaRequestBody(rawSql) {
  const now = Date.now();
  return JSON.stringify({
    from: String(now - 21600000),
    to: String(now),
    queries: [
      {
        refId: 'A',
        datasource: { type: DATASOURCE_TYPE, uid: DATASOURCE_UID },
        rawSql,
        format: 'table',
      },
    ],
  });
}

async function fireGrafanaQuery(dsQueryUrl, grafanaCookie, rawSql) {
  const response = await fetch(dsQueryUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Cookie: grafanaCookie,
      'x-datasource-uid': DATASOURCE_UID,
      'x-grafana-org-id': '1',
      'x-plugin-id': DATASOURCE_TYPE,
    },
    body: createGrafanaRequestBody(rawSql),
  });

  const responseText = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (
    response.status === 302 ||
    response.status === 401 ||
    response.status === 403 ||
    isHtmlBody(contentType, responseText)
  ) {
    printSessionInvalidAndExit();
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    if (!response.ok) {
      console.error(`Grafana HTTP error ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    console.error(`Grafana response was not JSON: ${error.message}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Grafana HTTP error ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const result = payload?.results?.A;
  if (Number(result?.status) === 401) printSessionInvalidAndExit();
  if (result?.error) {
    console.error(`Grafana query error: ${grafanaErrorMessage(result.error)}`);
    process.exit(1);
  }

  return rowsFromGrafanaFrame(result?.frames?.[0]);
}

function countOccurrences(input, target) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = input.indexOf(target, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + target.length;
  }
}

function widenQuery46(rawSql, tagIds) {
  const inList = tagIds.join(',');
  const replacements = [
    ['se.tag_id = 182', `se.tag_id IN (${inList})`],
    ['pe.tag_id = 182', `pe.tag_id IN (${inList})`],
    ['te.tag_id = 182', `te.tag_id IN (${inList})`],
  ];

  for (const [target] of replacements) {
    const count = countOccurrences(rawSql, target);
    if (count !== 1) {
      throw new Error(`Tag filter replacement target "${target}" matched ${count} time(s); aborting.`);
    }
  }

  let widenedSql = rawSql;
  for (const [target, replacement] of replacements) {
    widenedSql = widenedSql.replace(target, replacement);
  }
  return widenedSql;
}

function buildTagSet(rows) {
  const tagPairs = rows
    .map((row) => ({
      tag_id: Number.parseInt(row.tag_id, 10),
      tag_name: clean(row.tag_name),
    }))
    .filter((pair) => Number.isInteger(pair.tag_id))
    .sort((a, b) => {
      const byName = a.tag_name.localeCompare(b.tag_name);
      return byName === 0 ? a.tag_id - b.tag_id : byName;
    });
  const tagIds = tagPairs.map((pair) => pair.tag_id);
  if (!tagIds.length) throw new Error('Tag lookup returned no P04/P05 tags for 2026.');
  return { tagIds, tagPairs };
}

function parseProdPlanogram(planogramId) {
  const parts = clean(planogramId).split('_');
  const periodWeek = normalizePeriodWeek(parts[0] || '');
  const dbkey = normalizeDbkey(parts[1] || '');
  return {
    periodWeek,
    dbkey,
    complete: Boolean(periodWeek && dbkey),
  };
}

function normalizeProdDone(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'true') return 'done';
  if (normalized === 'false') return 'not_done';
  return 'unknown';
}

function normalizeResetType(value) {
  const normalized = clean(value).toUpperCase();
  return normalized === 'UPDATE' ? 'UPDATE' : normalized;
}

function prodRowToEngine(row) {
  const parsed = parseProdPlanogram(row['Planogram ID']);
  const storeNumber = normalizeInteger(row['Store #']);
  const categoryId = normalizeCategoryId(row['Category ID']);
  if (!parsed.complete || !storeNumber || !categoryId) {
    return {
      joinable: false,
      shiftSignoff: {
        storeNumber,
        shiftId: clean(row['Shift ID']),
        visitId: clean(row['Visit ID']),
        afterPictureLink: clean(row['After Pictures Link']),
        planogramId: clean(row['Planogram ID']),
      },
    };
  }

  return {
    joinable: true,
    row: {
      source: 'prod',
      projectId: PROJECT_ID,
      projectName: PROJECT_LABEL,
      periodWeek: parsed.periodWeek,
      storeNumber,
      categoryId,
      dbkey: parsed.dbkey,
      planogramId: clean(row['Planogram ID']),
      categoryCompletionStatus: normalizeProdDone(row['Category Completion Status']),
      rawCategoryCompletionStatus: clean(row['Category Completion Status']),
      categoryExceptionReason: clean(row['Category Exception Reason']),
      comment: clean(row.Comment || row.Comments),
      setType: normalizeResetType(row['Reset Type']),
      cycleName: clean(row['Cycle Name']),
      workDate: clean(row['Reported Date'] || row.Date || row['Scheduled Date']),
      afterPictureUrls: parseAfterPictureUrls(row['After Pictures Link']),
      raw: row,
    },
  };
}

function parseStoreFromDisplay(value) {
  const text = clean(value);
  const match = text.match(/\b(\d{1,4})\b/);
  return match ? normalizeInteger(match[1]) : '';
}

function normalizeSiTaskStatus(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'completed') return 'completed';
  if (normalized === 'complete') return 'completed';
  if (normalized === 'not started') return 'created';
  if (normalized === 'not completed') return 'incomplete';
  if (normalized === 'in progress') return 'in_progress';
  if (normalized === 'cancelled') return 'cancelled';
  return normalized || 'unknown';
}

function siRowToEngine(row) {
  const periodWeek = normalizePeriodWeek(row['Period/Week'] || row['Task Name']);
  const storeNumber = normalizeInteger(row.store_id) || parseStoreFromDisplay(row.Store);
  const categoryId = normalizeCategoryId(row.category_id);
  const dbkey = normalizeDbkey(row.planogram_id || row['Task Name']);
  if (!periodWeek || !storeNumber || !categoryId || !dbkey) return null;

  return {
    source: 'si',
    periodWeek,
    storeNumber,
    categoryId,
    dbkey,
    planogramId: clean(row.planogram_id),
    status: normalizeSiTaskStatus(row['Task Status']),
    rawTaskStatus: clean(row['Task Status']),
    statusReason: clean(row['Task Exception Response']),
    currentTask: true,
    scanStatus: clean(row['Task Status']),
    actionsCount: {
      identify: parseInt(clean(row.Identify), 10) || 0,
      remove: parseInt(clean(row.Remove), 10) || 0,
      move: parseInt(clean(row.Move), 10) || 0,
    },
    hasPrePhoto: clean(row['Visit Date']) !== '',
    workDate: clean(row['Visit Date'] || row.v_date),
    raw: {
      title: clean(row['Task Name']),
      taskExceptionResponse: clean(row['Task Exception Response']),
      grafana: row,
    },
  };
}

function rowTime(row = {}) {
  const raw = clean(row.workDate || row.work_date || row.date || row.raw?.work_date || row.raw?.date);
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldReplace(current, candidate, isDone) {
  if (!current) return true;
  const currentDone = isDone(current);
  const candidateDone = isDone(candidate);
  if (candidateDone !== currentDone) return candidateDone;
  return rowTime(candidate) >= rowTime(current);
}

function collapseRowsByKey(rows, isDone) {
  const out = new Map();
  for (const row of rows) {
    const key = buildReconciliationKey(row);
    const [periodWeek, store, categoryId, dbkey] = key.split('|');
    if (!periodWeek || !store || !categoryId || !dbkey) continue;
    if (shouldReplace(out.get(key), row, isDone)) out.set(key, row);
  }
  return out;
}

function isProdDone(row) {
  return row?.categoryCompletionStatus === 'done';
}

function isSiDone(row) {
  return normalizeSiStatus(row?.status) === 'done';
}

function isBacklog(row) {
  return /backlog\s*[-\u2013]\s*revisit\s*needed/i.test(clean(row?.categoryExceptionReason));
}

function isNotExecutable(row) {
  return /not an executable kompass event/i.test(clean(row?.categoryExceptionReason));
}

function hasNotInStoreOrSiComment(row) {
  return /\bnot\s+in\s+(store|si)\b/i.test(clean(row?.comment));
}

function samePeriodPrefix(key, prefix) {
  return key.toUpperCase().startsWith(`${prefix.toUpperCase()}|`);
}

function sortedKeys(keys) {
  return [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function selectKey({
  label,
  prodByKey,
  siByKey,
  usedKeys,
  preferred = [],
  predicate,
}) {
  for (const key of preferred) {
    if (!usedKeys.has(key) && predicate(key, prodByKey.get(key), siByKey.get(key))) {
      usedKeys.add(key);
      return { key, selection: 'preferred' };
    }
  }

  const allKeys = sortedKeys(new Set([...prodByKey.keys(), ...siByKey.keys()]));
  for (const key of allKeys) {
    if (usedKeys.has(key)) continue;
    if (predicate(key, prodByKey.get(key), siByKey.get(key))) {
      usedKeys.add(key);
      return { key, selection: 'live fallback' };
    }
  }

  throw new Error(`Could not select fixture anchor for ${label}`);
}

function trackerRowFromKey(key, overrides = {}) {
  const [periodWeek, store, categoryId, dbkey] = key.split('|');
  return {
    rowIndex: overrides.rowIndex || null,
    workbookKind: 'ise',
    routedWorkbookKind: 'ise',
    periodWeek,
    store,
    categoryId,
    dbkey,
    pogId: `${periodWeek}_${dbkey}_FIXTURE_C${String(categoryId).padStart(3, '0')}`,
    setType: overrides.setType || 'ISE',
    K: overrides.K ?? 'No',
    L: overrides.L ?? '',
    currentK: overrides.K ?? 'No',
    currentL: overrides.L ?? '',
    proofCase: overrides.proofCase || '',
    key,
  };
}

function expectedCarryoverBucket(prod, si) {
  if (prod && isBacklog(prod)) return 'leave_alone_backlog';
  if (prod && isProdDone(prod) && si && isSiDone(si)) return 'matched_both';
  if (prod && isProdDone(prod)) return 'mirror_si_*';
  if (si && isSiDone(si)) return 'mirror_si_to_prod';
  return 'judgment_call';
}

function buildFixture({ prodByKey, siByKey }) {
  const usedKeys = new Set();
  const cases = [];

  const matched = selectKey({
    label: 'matched_both',
    prodByKey,
    siByKey,
    usedKeys,
    preferred: PREFERRED_KEYS.matchedBoth,
    predicate: (key, prod, si) => samePeriodPrefix(key, 'P05W3') && isProdDone(prod) && isSiDone(si),
  });
  cases.push({
    id: 'matched_both',
    expected: ['matched_both'],
    expectProd: true,
    expectSi: true,
    ...matched,
    tracker: trackerRowFromKey(matched.key, { rowIndex: 1, proofCase: 'matched_both', K: 'No' }),
  });

  const mirror = selectKey({
    label: 'mirror',
    prodByKey,
    siByKey,
    usedKeys,
    predicate: (_key, prod, si) => {
      if (!prod || !si) return false;
      return (isProdDone(prod) && !isSiDone(si)) || (!isProdDone(prod) && isSiDone(si));
    },
  });
  const mirrorProd = prodByKey.get(mirror.key);
  const mirrorSi = siByKey.get(mirror.key);
  cases.push({
    id: 'mirror',
    expected: isProdDone(mirrorProd) && !isSiDone(mirrorSi)
      ? ['mirror_si_photo_push', 'mirror_si_simple_close', 'mirror_si_stale_or_absent']
      : ['mirror_si_to_prod'],
    displayExpected: isProdDone(mirrorProd) ? 'mirror_si_*' : 'mirror_si_to_prod',
    expectProd: true,
    expectSi: true,
    ...mirror,
    tracker: trackerRowFromKey(mirror.key, { rowIndex: 2, proofCase: 'mirror', K: 'No' }),
  });

  const backlog = selectKey({
    label: 'backlog both-not-done',
    prodByKey,
    siByKey,
    usedKeys,
    predicate: (_key, prod, si) => Boolean(prod)
      && Boolean(si)
      && !isProdDone(prod)
      && isBacklog(prod)
      && !isSiDone(si),
  });
  cases.push({
    id: 'backlog_both_not_done',
    expected: ['leave_alone_backlog'],
    expectProd: true,
    expectSi: Boolean(siByKey.get(backlog.key)),
    ...backlog,
    tracker: trackerRowFromKey(backlog.key, { rowIndex: 3, proofCase: 'backlog_both_not_done', K: 'No' }),
  });

  const nii = selectKey({
    label: 'NII not-executable',
    prodByKey,
    siByKey,
    usedKeys,
    predicate: (_key, prod, si) => Boolean(prod)
      && !isProdDone(prod)
      && isNotExecutable(prod)
      && !hasNotInStoreOrSiComment(prod)
      && !isSiDone(si),
  });
  cases.push({
    id: 'nii_not_executable',
    expected: ['judgment_call'],
    expectProd: true,
    expectSi: false,
    ...nii,
    tracker: trackerRowFromKey(nii.key, { rowIndex: 4, proofCase: 'nii_not_executable', K: 'No' }),
  });

  const carryover = selectKey({
    label: 'carryover prior-period',
    prodByKey,
    siByKey,
    usedKeys,
    predicate: (key, prod, si) => samePeriodPrefix(key, 'P04W4')
      && Boolean(prod)
      && Boolean(si)
      && !isProdDone(prod)
      && !isSiDone(si),
  });
  cases.push({
    id: 'carryover_prior_period',
    expected: [expectedCarryoverBucket(prodByKey.get(carryover.key), siByKey.get(carryover.key))],
    expectProd: Boolean(prodByKey.get(carryover.key)),
    expectSi: Boolean(siByKey.get(carryover.key)),
    ...carryover,
    tracker: trackerRowFromKey(carryover.key, { rowIndex: 5, proofCase: 'carryover_prior_period', K: 'No' }),
  });

  const alreadyYes = selectKey({
    label: 'already-Yes suppression',
    prodByKey,
    siByKey,
    usedKeys,
    predicate: (_key, prod, si) => isProdDone(prod) && isSiDone(si),
  });
  cases.push({
    id: 'already_yes_suppression',
    expected: ['suppressed_already_satisfied'],
    expectProd: true,
    expectSi: true,
    ...alreadyYes,
    tracker: trackerRowFromKey(alreadyYes.key, { rowIndex: 6, proofCase: 'already_yes_suppression', K: 'Yes', L: '' }),
  });

  let unmatchedKey = 'P05W3|999|999|9999999';
  let suffix = 9999999;
  while (prodByKey.has(unmatchedKey) || siByKey.has(unmatchedKey)) {
    suffix += 1;
    unmatchedKey = `P05W3|999|999|${suffix}`;
  }
  cases.push({
    id: 'unmatched',
    expected: ['no_match'],
    expectProd: false,
    expectSi: false,
    key: unmatchedKey,
    selection: 'synthetic absent key',
    tracker: trackerRowFromKey(unmatchedKey, { rowIndex: 7, proofCase: 'unmatched', K: 'No' }),
  });

  return cases;
}

async function pullProdWeek(sasToken, range) {
  const params = new URLSearchParams({
    customer_id: String(CUSTOMER_ID),
    date_from: range.dateFrom,
    date_to: range.dateTo,
    date_type: 'reported',
    offset: String(OFFSET_MIN),
    project_id: String(PROJECT_ID),
    shift_status: 'completed',
  });

  let body;
  try {
    body = await sasGetJsonTokenOnly(sasToken, `/reports/category-reset-report/?${params.toString()}`);
  } catch (err) {
    console.error(`PROD week ${range.periodWeek} failed (${range.dateFrom} -> ${range.dateTo})`);
    reportTokenOnlyRejection(err);
    process.exit(1);
  }

  const fileUrl = clean(body?.file_url);
  if (!fileUrl) {
    console.error(`PROD report for ${range.periodWeek} did not return file_url: ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }

  const csvText = await fetchCsv(fileUrl);
  const parsed = parseCsv(csvText);
  return {
    periodWeek: range.periodWeek,
    message: body?.message || '',
    csvBytes: Buffer.byteLength(csvText, 'utf8'),
    headers: parsed.headers,
    rows: parsed.rows,
  };
}

async function pullProdRows(sasToken) {
  const weeks = [];
  for (const range of PROD_WEEK_RANGES) {
    weeks.push(await pullProdWeek(sasToken, range));
  }

  const prodRows = [];
  const shiftSignoffs = [];
  for (const week of weeks) {
    for (const csvRow of week.rows) {
      const mapped = prodRowToEngine(csvRow);
      if (mapped.joinable) prodRows.push(mapped.row);
      else shiftSignoffs.push({ ...mapped.shiftSignoff, sourceWeek: week.periodWeek });
    }
  }

  return {
    headers: weeks[0]?.headers || [],
    rawRows: weeks.flatMap((week) => week.rows),
    prodRows,
    shiftSignoffs,
    csvBytes: weeks.reduce((sum, week) => sum + week.csvBytes, 0),
    weeks: weeks.map((week) => ({
      periodWeek: week.periodWeek,
      rows: week.rows.length,
      csvBytes: week.csvBytes,
      message: week.message,
    })),
  };
}

async function pullSiRows(grafanaCookie) {
  const dsQueryUrl = process.env.KOMPASS_DS_QUERY_URL || DEFAULT_DS_QUERY_URL;
  const tagLookup = await fireGrafanaQuery(dsQueryUrl, grafanaCookie, TAG_LOOKUP_SQL);
  const { tagIds, tagPairs } = buildTagSet(tagLookup.rows);
  const rawSql = await readQuery46Sql();
  const widenedSql = widenQuery46(rawSql, tagIds);
  const query46Result = await fireGrafanaQuery(dsQueryUrl, grafanaCookie, widenedSql);
  const siRows = query46Result.rows.map(siRowToEngine).filter(Boolean);
  return {
    tagPairs,
    columnNames: query46Result.columnNames,
    rawRows: query46Result.rows,
    siRows,
  };
}

function proposalByKey(result) {
  return new Map((result.proposals || []).map((proposal) => [proposal.key, proposal]));
}

function actualForCase(fixtureCase, proposalsByKey) {
  const proposal = proposalsByKey.get(fixtureCase.key);
  if (proposal) return proposal.bucket;
  if (fixtureCase.expected.includes('suppressed_already_satisfied')) return 'suppressed_already_satisfied';
  return '(missing proposal)';
}

function casePasses(fixtureCase, actual) {
  return fixtureCase.expected.includes(actual);
}

function printSourceSummary({ prod, si, prodByKey, siByKey }) {
  console.log('Three-way join proof');
  console.log(`- PROD project: ${PROJECT_LABEL} (project_id=${PROJECT_ID})`);
  console.log(`- PROD weeks: ${PROD_WEEK_RANGES.map((range) => range.periodWeek).join(', ')}`);
  console.log(`- PROD raw rows=${prod.rawRows.length}, keyed rows=${prod.prodRows.length}, csv bytes=${prod.csvBytes}`);
  console.log(`- PROD weekly calls: ${prod.weeks.map((week) => `${week.periodWeek}:${week.rows} rows/${week.message || 'no message'}`).join(' | ')}`);
  console.log(`- SI tags: ${si.tagPairs.map((pair) => `${pair.tag_id}:${pair.tag_name}`).join(' | ')}`);
  console.log(`- SI raw rows=${si.rawRows.length}, keyed rows=${si.siRows.length}`);
  console.log(`- PROD distinct keyed periods: ${formatList(distinct([...prodByKey.keys()].map((key) => key.split('|')[0])))}`);
  console.log(`- SI distinct keyed periods: ${formatList(distinct([...siByKey.keys()].map((key) => key.split('|')[0])))}`);
}

function printShiftSignoffReport(shiftSignoffs) {
  const stores = distinct(shiftSignoffs.map((row) => row.storeNumber));
  const shifts = distinct(shiftSignoffs.map((row) => row.shiftId));
  const visits = distinct(shiftSignoffs.map((row) => row.visitId));
  console.log('\nShift-signoff partition:');
  console.log(`- Set aside rows: ${shiftSignoffs.length}`);
  console.log(`- Stores covered: ${stores.length} (${formatList(stores)})`);
  console.log(`- Shift IDs covered: ${shifts.length}`);
  console.log(`- Visit IDs covered: ${visits.length}`);
}

function printVocabularyReport({ prodRows, siRows, trackerRows }) {
  console.log('\nDone-vocabulary normalization:');
  console.log('- PROD: Category Completion Status "True" -> done, "False" -> not_done');
  console.log('- SI: Task Status "Completed" -> done; other Query 46 task statuses -> not_done');
  console.log('- Tracker: K="Yes" can suppress already-satisfied writes; K!="Yes" remains eligible');
  console.log(`- PROD raw values observed: ${formatJsonList(distinct(prodRows.map((row) => row.rawCategoryCompletionStatus)))}`);
  console.log(`- SI raw values observed: ${formatJsonList(distinct(siRows.map((row) => row.rawTaskStatus)))}`);
  console.log(`- Tracker K values in fixture: ${formatJsonList(distinct(trackerRows.map((row) => row.K)))}`);
}

function printFixtureReport({ fixtureCases, result, prodByKey, siByKey }) {
  const proposalsByKey = proposalByKey(result);
  const counts = {};
  let pass = 0;
  let fail = 0;
  const matchFailures = [];

  console.log('\nFixture assertions:');
  for (const fixtureCase of fixtureCases) {
    const actual = actualForCase(fixtureCase, proposalsByKey);
    const ok = casePasses(fixtureCase, actual);
    const expectedLabel = fixtureCase.displayExpected || fixtureCase.expected.join('|');
    counts[actual] = (counts[actual] || 0) + 1;
    if (ok) pass += 1;
    else fail += 1;

    if (fixtureCase.expectProd && !prodByKey.has(fixtureCase.key)) {
      matchFailures.push(`${fixtureCase.id}: expected PROD match for ${fixtureCase.key}`);
    }
    if (fixtureCase.expectSi && !siByKey.has(fixtureCase.key)) {
      matchFailures.push(`${fixtureCase.id}: expected SI match for ${fixtureCase.key}`);
    }

    const proposal = proposalsByKey.get(fixtureCase.key);
    console.log(
      `- ${fixtureCase.id}: ${ok ? 'PASS' : 'FAIL'} expected=${expectedLabel}, actual=${actual}, ` +
      `key=${fixtureCase.key}, anchor=${fixtureCase.selection}`
    );
    if (proposal) {
      console.log(`  reason=${proposal.reason}`);
    }
  }

  console.log('\nFixture bucket counts:');
  for (const [bucket, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${bucket}: ${count}`);
  }
  console.log(`- PASS=${pass}, FAIL=${fail}`);
  console.log(`- Engine alreadySatisfied count=${result.alreadySatisfied}`);

  console.log('\nExpected-match key checks:');
  if (!matchFailures.length) {
    console.log('- All expected PROD/SI oracle matches were present.');
  } else {
    for (const item of matchFailures) console.log(`- ${item}`);
  }

  const carryover = fixtureCases.find((item) => item.id === 'carryover_prior_period');
  if (carryover) {
    const [periodWeek] = carryover.key.split('|');
    console.log('\nCarryover period check:');
    console.log(`- Carryover key period=${periodWeek}; full key=${carryover.key}`);
    console.log(`- Cross-period match avoided? ${periodWeek === 'P04W4' ? 'yes' : 'no'}`);
  }

  if (fail || matchFailures.length) process.exitCode = 1;
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('Native fetch is unavailable. Run this proof with Node 24.');
    process.exit(1);
  }

  await loadLocalEnv();

  let sasSession;
  try {
    sasSession = await loadSasToken();
  } catch (_) {
    console.error('SAS keep-alive token unavailable');
    process.exit(1);
  }
  const grafanaCookie = await readGrafanaCookie();

  console.log(`SAS token source: ${sasSession.source}${sasSession.generatedAt ? ` (${sasSession.generatedAt})` : ''}`);
  console.log('Grafana cookie source: environment or scripts/kompass-proof/.cookie (value not printed)');

  const [prod, si] = await Promise.all([
    pullProdRows(sasSession.token),
    pullSiRows(grafanaCookie),
  ]);

  const prodByKey = collapseRowsByKey(prod.prodRows, isProdDone);
  const siByKey = collapseRowsByKey(si.siRows, isSiDone);
  const fixtureCases = buildFixture({ prodByKey, siByKey });
  const trackerRows = fixtureCases.map((item) => item.tracker);

  const result = classifyReconciliation({
    trackerRows,
    prodRows: prod.prodRows,
    siRows: si.siRows,
  });

  printSourceSummary({ prod, si, prodByKey, siByKey });
  printShiftSignoffReport(prod.shiftSignoffs);
  printVocabularyReport({ prodRows: prod.prodRows, siRows: si.siRows, trackerRows });
  printFixtureReport({ fixtureCases, result, prodByKey, siByKey });
}

main().catch((error) => {
  console.error(`Three-way join proof failed: ${error.message}`);
  process.exit(1);
});
