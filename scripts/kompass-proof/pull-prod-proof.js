#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const PROJECT_ID = 1;
const PROJECT_LABEL = 'Fred Meyer Kompass ISE';
const PERIOD_WEEK = 'P05W3';
const OFFSET_MIN = 420;
const REQUIRED_HEADERS = [
  'Store #',
  'Category ID',
  'Planogram ID',
  'Category Completion Status',
  'Category Exception Reason',
  'Cycle Name',
  'Reset Type',
];

const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';

function weekToIsoRange() {
  const start = '2026-06-07';
  const end = '2026-06-13';
  const dateFrom = `${start}T07:00:00.000Z`;
  const endD = new Date(`${end}T12:00:00Z`);
  endD.setDate(endD.getDate() + 1);
  const dateTo = endD.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  return { dateFrom, dateTo };
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
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
    // Fall through to the environment fallback used by the proven pull script.
  }

  if (process.env.SAS_TOKEN) {
    return { token: String(process.env.SAS_TOKEN), source: 'SAS_TOKEN', generatedAt: null };
  }

  throw new Error('SAS keep-alive token unavailable');
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

async function fetchCsv(fileUrl) {
  const res = await fetch(fileUrl, {
    method: 'GET',
    headers: { Accept: 'text/csv,*/*;q=0.8' },
  });
  if (!res.ok) {
    throw new Error(`CloudFront CSV fetch failed (status=${res.status})`);
  }
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
      if (row.some((value) => String(value).trim() !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (row.some((value) => String(value).trim() !== '')) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => String(h || '').trim());
  const rows = records.slice(1).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] == null ? '' : record[index];
    });
    return row;
  });
  return { headers, rows };
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeInteger(value) {
  const raw = clean(value).replace(/,/g, '');
  if (!raw) return '';
  const match = raw.match(/^\d+/);
  if (!match) return '';
  return String(parseInt(match[0], 10));
}

function deriveKey(row) {
  const planogramId = clean(row['Planogram ID']);
  const parts = planogramId.split('_');
  const periodWeek = clean(parts[0]);
  const dbkey = clean(parts[1]);
  const store = normalizeInteger(row['Store #']);
  const categoryId = normalizeInteger(row['Category ID']);
  const complete = Boolean(periodWeek && store && categoryId && dbkey);
  return {
    periodWeek,
    store,
    categoryId,
    dbkey,
    key: complete ? `${periodWeek}|${store}|${categoryId}|${dbkey}` : '',
    complete,
    planogramId,
  };
}

function distinct(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function formatDistinct(values) {
  return values.length ? values.map((value) => JSON.stringify(value)).join(', ') : '(none)';
}

function nonNullCount(rows, header) {
  return rows.filter((row) => clean(row[header]) !== '').length;
}

function printHeaderReport(headers, rows) {
  console.log('\nJoin/compare columns:');
  for (const header of REQUIRED_HEADERS) {
    const present = headers.includes(header);
    const count = present ? nonNullCount(rows, header) : 0;
    console.log(`- ${header}: present=${present ? 'yes' : 'no'}, non-null=${count}`);
  }
}

function printKeyReport(rows) {
  const derived = rows.map(deriveKey);
  const complete = derived.filter((row) => row.complete);
  const failed = derived.filter((row) => !row.complete);

  console.log('\nReconciliation key proof:');
  console.log(`- Complete keys: ${complete.length}`);
  console.log(`- Failed keys: ${failed.length}`);
  if (failed.length) {
    console.log('- First parse failures:');
    for (const row of failed.slice(0, 5)) {
      console.log(`  raw Planogram ID=${JSON.stringify(row.planogramId)}`);
    }
  }

  return { derived, complete, failed };
}

function printVocabularyReport(rows) {
  console.log('\nStatus vocabulary:');
  console.log(`- Category Completion Status: ${formatDistinct(distinct(rows.map((row) => row['Category Completion Status'])))}`);
  console.log(`- Category Exception Reason: ${formatDistinct(distinct(rows.map((row) => row['Category Exception Reason'])))}`);
  console.log(`- Cycle Name: ${formatDistinct(distinct(rows.map((row) => row['Cycle Name'])))}`);
  console.log(`- Reset Type: ${formatDistinct(distinct(rows.map((row) => row['Reset Type'])))}`);
}

function printCrossCheck(rows, derived) {
  const distinctStores = distinct(derived.map((row) => row.store));
  const distinctPeriods = distinct(derived.map((row) => row.periodWeek));

  console.log('\nCross-check summary:');
  console.log(`- Total rows: ${rows.length}`);
  console.log(`- Distinct stores (${distinctStores.length}): ${distinctStores.join(', ') || '(none)'}`);
  console.log(`- Distinct periodWeek values: ${distinctPeriods.join(', ') || '(none)'}`);
  console.log('- First 8 rows:');

  for (let i = 0; i < Math.min(8, rows.length); i += 1) {
    const row = rows[i];
    const key = derived[i];
    console.log(
      `  ${i + 1}. store=${key.store || '(blank)'}, categoryId=${key.categoryId || '(blank)'}, ` +
      `dbkey=${key.dbkey || '(blank)'}, periodWeek=${key.periodWeek || '(blank)'}, ` +
      `Category Completion Status=${JSON.stringify(clean(row['Category Completion Status']))}, ` +
      `Category Exception Reason=${JSON.stringify(clean(row['Category Exception Reason']))}`
    );
  }
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
  console.error(`PROD report request failed (status=${err.status || 'unknown'})`);
}

async function main() {
  let session;
  try {
    session = await loadSasToken();
  } catch (_) {
    console.error('SAS keep-alive token unavailable');
    process.exit(1);
  }

  const { dateFrom, dateTo } = weekToIsoRange();
  const params = new URLSearchParams({
    customer_id: String(CUSTOMER_ID),
    date_from: dateFrom,
    date_to: dateTo,
    date_type: 'reported',
    offset: String(OFFSET_MIN),
    project_id: String(PROJECT_ID),
    shift_status: 'completed',
  });

  console.log('PROD category-reset-report proof');
  console.log(`- Project: ${PROJECT_LABEL} (project_id=${PROJECT_ID})`);
  console.log(`- Period: ${PERIOD_WEEK}`);
  console.log(`- Date window: ${dateFrom} -> ${dateTo}`);
  console.log(`- Token source: ${session.source}${session.generatedAt ? ` (${session.generatedAt})` : ''}`);
  console.log('- Auth headers: Authorization Token only, no X-CSRFToken');

  let body;
  try {
    body = await sasGetJsonTokenOnly(session.token, `/reports/category-reset-report/?${params.toString()}`);
  } catch (err) {
    reportTokenOnlyRejection(err);
    process.exit(1);
  }

  const fileUrl = clean(body?.file_url);
  if (!fileUrl) {
    console.error(`PROD report did not return file_url: ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }

  console.log(`- Step A: report response message=${JSON.stringify(body?.message || '')}, file_url present=yes`);

  let csvText;
  try {
    csvText = await fetchCsv(fileUrl);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`- Step B: CloudFront CSV fetched (${csvText.length} bytes)`);

  const { headers, rows } = parseCsv(csvText);
  printHeaderReport(headers, rows);
  const { derived } = printKeyReport(rows);
  printVocabularyReport(rows);
  printCrossCheck(rows, derived);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
