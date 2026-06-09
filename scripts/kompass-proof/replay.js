#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DS_QUERY_URL = 'https://krcs-reporting.rebotics.net/api/ds/query';
const DATASOURCE_UID = 'Drt7OkEGk';
const DATASOURCE_TYPE = 'grafana-postgresql-datasource';
const PLACEHOLDER_SQL = '-- PASTE VERBATIM QUERY 46 HERE';
const SESSION_INVALID_MESSAGE = 'SESSION EXPIRED OR INVALID — recapture cookie and rerun';

const scriptDir = __dirname;
const queryPath = path.join(scriptDir, 'query46.sql');
const cookiePath = path.join(scriptDir, '.cookie');
const envPath = path.join(scriptDir, '.env');

async function loadLocalEnv() {
  let content;

  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

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

async function readGrafanaCookie() {
  const envCookie = process.env.KOMPASS_GRAFANA_COOKIE;
  if (envCookie && envCookie.trim()) {
    return envCookie.trim();
  }

  try {
    const fileCookie = await fs.readFile(cookiePath, 'utf8');
    const cookie = fileCookie.trim();
    if (cookie) {
      return cookie;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  console.error('No Grafana session supplied');
  console.error('Set KOMPASS_GRAFANA_COOKIE to the raw Cookie header value, or place it on one line in scripts/kompass-proof/.cookie.');
  console.error('Capture it fresh from browser DevTools immediately before running.');
  process.exit(1);
}

async function readQuery46Sql() {
  const rawSql = await fs.readFile(queryPath, 'utf8');
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

function getGrafanaErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') {
      return error.message;
    }
    if (error.data && typeof error.data.message === 'string') {
      return error.data.message;
    }
  }

  return JSON.stringify(error);
}

function rowsFromGrafanaFrame(frame) {
  const fields = frame?.schema?.fields;
  const values = frame?.data?.values;

  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new Error('No Grafana table frame found at results.A.frames[0].');
  }

  const columnNames = fields.map((field) => field?.name ?? '');
  const rowCount = values.reduce((max, column) => {
    return Math.max(max, Array.isArray(column) ? column.length : 0);
  }, 0);

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

function isPopulated(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function distinctValues(rows, columnName) {
  return [...new Set(rows.map((row) => row[columnName]).filter(isPopulated).map(String))]
    .sort((a, b) => a.localeCompare(b));
}

function formatList(values) {
  return values.length ? values.join(' | ') : '(none)';
}

function printReport(columnNames, rows) {
  console.log(`Total rows: ${rows.length}`);
  console.log('Columns:');
  for (const columnName of columnNames) {
    console.log(`- ${columnName}`);
  }

  const criticalColumns = [
    { label: 'store_id', names: ['store_id'] },
    { label: 'category_id', names: ['category_id'] },
    { label: 'planogram_id', names: ['planogram_id'] },
    { label: 'Period/Week', names: ['Period/Week'] },
    { label: 'Task Status', names: ['Task Status'] },
    { label: 'Task Exception Response (status_reason)', names: ['Task Exception Response', 'status_reason'] },
  ];

  console.log('');
  console.log('Reconciliation-critical columns:');
  for (const check of criticalColumns) {
    const actualName = check.names.find((name) => columnNames.includes(name));
    const nonNullCount = actualName
      ? rows.filter((row) => isPopulated(row[actualName])).length
      : 0;
    const present = actualName ? `yes (${actualName})` : 'no';
    console.log(`- ${check.label}: present? ${present}; non-null count: ${nonNullCount}`);
  }

  const previewColumns = ['Division', 'Supervisor', 'Store', 'Commodity', 'Period/Week', 'Task Status'];
  const previewRows = rows.slice(0, 10).map((row) => {
    const preview = {};
    for (const columnName of previewColumns) {
      preview[columnName] = row[columnName] ?? null;
    }
    return preview;
  });

  console.log('');
  console.log('First 10 rows:');
  console.log(JSON.stringify(previewRows, null, 2));

  const divisions = distinctValues(rows, 'Division');
  const commodities = distinctValues(rows, 'Commodity');
  const periodWeeks = distinctValues(rows, 'Period/Week');
  const supervisors = distinctValues(rows, 'Supervisor');
  const targetCommodity = '812-Vacuums-Steamers-Chemicals';

  console.log('');
  console.log('Screenshot cross-check:');
  console.log(`- Distinct Division values: ${formatList(divisions)}`);
  console.log(`- Commodity includes "${targetCommodity}"? ${commodities.includes(targetCommodity) ? 'yes' : 'no'}`);
  console.log(`- Distinct Period/Week values: ${formatList(periodWeeks)}`);
  console.log(`- Distinct Supervisor values: ${formatList(supervisors)}`);
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('Native fetch is unavailable. Run this proof with Node 24.');
    process.exit(1);
  }

  await loadLocalEnv();

  const rawSql = await readQuery46Sql();
  const grafanaCookie = await readGrafanaCookie();
  const dsQueryUrl = process.env.KOMPASS_DS_QUERY_URL || DEFAULT_DS_QUERY_URL;
  const now = Date.now();

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
    body: JSON.stringify({
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
    }),
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

  if (Number(result?.status) === 401) {
    printSessionInvalidAndExit();
  }

  if (result?.error) {
    console.error(`Grafana query error: ${getGrafanaErrorMessage(result.error)}`);
    process.exit(1);
  }

  const frame = result?.frames?.[0];
  const { columnNames, rows } = rowsFromGrafanaFrame(frame);
  printReport(columnNames, rows);
}

main().catch((error) => {
  console.error(`Proof runner error: ${error.message}`);
  process.exit(1);
});
