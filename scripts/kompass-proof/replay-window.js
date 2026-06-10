#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DS_QUERY_URL = 'https://krcs-reporting.rebotics.net/api/ds/query';
const DATASOURCE_UID = 'Drt7OkEGk';
const DATASOURCE_TYPE = 'grafana-postgresql-datasource';
const SESSION_INVALID_MESSAGE = 'SESSION EXPIRED OR INVALID — recapture cookie and rerun';
const PLACEHOLDER_SQL = '-- PASTE VERBATIM QUERY 46 HERE';

const TAG_LOOKUP_SQL = `select tag_id, tag_name
  from dds.d_tag
 where (right(tag_name, 4))::int = 2026
   and substr(tag_name, 1, 3) in ('P04','P05')
 order by substr(tag_name, 1, 5)`;

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

function formatBytes(byteLength) {
  const kb = byteLength / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(2)} MB`;
}

function countOccurrences(input, target) {
  let count = 0;
  let offset = 0;

  while (true) {
    const index = input.indexOf(target, offset);
    if (index === -1) {
      return count;
    }
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
      console.error(`Tag filter replacement target "${target}" matched ${count} time(s); aborting.`);
      process.exit(1);
    }
  }

  let widenedSql = rawSql;
  for (const [target, replacement] of replacements) {
    widenedSql = widenedSql.replace(target, replacement);
  }

  console.log(`3/3 tag filters widened to IN-list of ${tagIds.length} tags`);
  return widenedSql;
}

function createRequestBody(rawSql) {
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
    body: createRequestBody(rawSql),
  });

  const responseText = await response.text();
  const responseBytes = Buffer.byteLength(responseText, 'utf8');
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
  return { columnNames, rows, responseBytes };
}

function buildTagSet(rows) {
  const tagPairs = rows
    .map((row) => {
      const tagId = Number.parseInt(row.tag_id, 10);
      return {
        tag_id: tagId,
        tag_name: row.tag_name == null ? '' : String(row.tag_name),
      };
    })
    .filter((pair) => Number.isInteger(pair.tag_id))
    .sort((a, b) => {
      const byName = a.tag_name.localeCompare(b.tag_name);
      return byName === 0 ? a.tag_id - b.tag_id : byName;
    });

  const tagIds = tagPairs.map((pair) => pair.tag_id);

  if (tagIds.length === 0) {
    console.error('Tag lookup returned no P04/P05 tags for 2026 — aborting');
    process.exit(1);
  }

  return { tagIds, tagPairs };
}

function printTagSet(tagPairs) {
  console.log(`Resolved P04/P05 2026 tags: ${tagPairs.length}`);
  for (const pair of tagPairs) {
    console.log(`- ${pair.tag_id} -> ${pair.tag_name}`);
  }
}

function printCriticalColumnReport(columnNames, rows) {
  const criticalColumns = [
    { label: 'store_id', names: ['store_id'] },
    { label: 'category_id', names: ['category_id'] },
    { label: 'planogram_id', names: ['planogram_id'] },
    { label: 'Period/Week', names: ['Period/Week'] },
    { label: 'Task Status', names: ['Task Status'] },
    { label: 'Task Exception Response', names: ['Task Exception Response'] },
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
}

function printWindowReport(columnNames, rows, responseBytes, tagCount) {
  console.log('');
  console.log(`Total rows: ${rows.length}`);
  console.log(`Response payload size: ${formatBytes(responseBytes)} (${responseBytes} bytes)`);
  console.log(`Rough rows per tag: ${(rows.length / tagCount).toFixed(1)}`);

  printCriticalColumnReport(columnNames, rows);

  const periodWeeks = distinctValues(rows, 'Period/Week');
  const divisions = distinctValues(rows, 'Division');
  const commodities = distinctValues(rows, 'Commodity');
  const supervisors = distinctValues(rows, 'Supervisor');

  console.log('');
  console.log('Widen proof:');
  console.log(`- Distinct Period/Week values: ${formatList(periodWeeks)}`);
  console.log(`- Includes P04 weeks? ${periodWeeks.some((value) => value.startsWith('P04')) ? 'yes' : 'no'}`);
  console.log(`- Includes P05 weeks? ${periodWeeks.some((value) => value.startsWith('P05')) ? 'yes' : 'no'}`);

  console.log('');
  console.log('Cross-check:');
  console.log(`- Distinct Division values: ${formatList(divisions)}`);
  console.log(`- Distinct Commodity count: ${commodities.length}`);
  console.log(`- Distinct Supervisor count: ${supervisors.length}`);

  const previewColumns = ['Store', 'Commodity', 'Period/Week', 'Task Status'];
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
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('Native fetch is unavailable. Run this proof with Node 24.');
    process.exit(1);
  }

  await loadLocalEnv();

  const grafanaCookie = await readGrafanaCookie();
  const dsQueryUrl = process.env.KOMPASS_DS_QUERY_URL || DEFAULT_DS_QUERY_URL;

  const tagLookup = await fireGrafanaQuery(dsQueryUrl, grafanaCookie, TAG_LOOKUP_SQL);
  const { tagIds, tagPairs } = buildTagSet(tagLookup.rows);
  printTagSet(tagPairs);

  const query46Sql = await readQuery46Sql();
  const widenedSql = widenQuery46(query46Sql, tagIds);

  const query46Result = await fireGrafanaQuery(dsQueryUrl, grafanaCookie, widenedSql);
  printWindowReport(
    query46Result.columnNames,
    query46Result.rows,
    query46Result.responseBytes,
    tagIds.length,
  );
}

main().catch((error) => {
  console.error(`Proof runner error: ${error.message}`);
  process.exit(1);
});
