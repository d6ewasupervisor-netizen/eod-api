#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');
const COOKIE_PATH = path.join(SCRIPT_DIR, '.cookie');
const TEMP_COOKIE_PATH = path.join(SCRIPT_DIR, '.cookie.cookie.tmp');
const QUERY_PATH = path.join(SCRIPT_DIR, 'query46.sql');

const EXPECTED_IGNORE_LINE = 'scripts/kompass-proof/.cookie';
const GRAFANA_BASE = 'https://krcs-reporting.rebotics.net';
const DS_QUERY_URL = `${GRAFANA_BASE}/api/ds/query`;
const DATASOURCE_UID = 'Drt7OkEGk';
const DATASOURCE_TYPE = 'grafana-postgresql-datasource';
const PLACEHOLDER_SQL = '-- PASTE VERBATIM QUERY 46 HERE';

function fail(step, message) {
  console.error(`${step} failed: ${message}`);
  console.error('.cookie was left UNCHANGED.');
  process.exitCode = 1;
}

async function assertCookieIsIgnored() {
  const content = await fsp.readFile(GITIGNORE_PATH, 'utf8');
  const ignored = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(EXPECTED_IGNORE_LINE);

  if (!ignored) {
    throw new Error(`missing exact .gitignore line: ${EXPECTED_IGNORE_LINE}`);
  }
}

function stripCookiePrefix(value) {
  const text = String(value || '').trim();
  const headerLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^cookie\s*:/i.test(line));
  return (headerLine || text).replace(/^cookie\s*:\s*/i, '').trim();
}

function cookieNames(cookie) {
  return String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.includes('='))
    .map((part) => part.split('=')[0].trim())
    .filter((name) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
    .filter(Boolean);
}

function readHiddenLine(promptText) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    let value = '';
    let rawWasEnabled = false;

    function restore() {
      input.removeListener('data', onData);
      if (rawWasEnabled && input.isTTY) input.setRawMode(false);
      input.pause();
    }

    function finish() {
      restore();
      output.write('\n');
      resolve(value);
    }

    function onData(chunk) {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          restore();
          output.write('\n');
          reject(new Error('interrupted'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    }

    output.write(promptText);
    input.resume();
    input.setEncoding('utf8');
    if (input.isTTY) {
      input.setRawMode(true);
      rawWasEnabled = true;
    }
    input.on('data', onData);
  });
}

async function readCookieFromInput() {
  if (process.argv.includes('--clipboard')) {
    return stripCookiePrefix(await readCookieFromClipboard());
  }
  if (process.stdin.isTTY) {
    return stripCookiePrefix(await readHiddenLine('Paste Grafana Cookie header (hidden), then press Enter: '));
  }
  return stripCookiePrefix(process.env.GRAFANA_COOKIE || process.env.KOMPASS_GRAFANA_COOKIE || '');
}

function readCookieFromClipboard() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('could not read Windows clipboard'));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function isJsonContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('json');
}

async function validateCheap(cookie) {
  const response = await fetch(`${GRAFANA_BASE}/api/user`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Cookie: cookie,
      'x-grafana-org-id': '1',
    },
  });
  const contentType = response.headers.get('content-type') || '';
  await response.arrayBuffer();

  if (response.status !== 200 || !isJsonContentType(contentType)) {
    throw new Error(`HTTP ${response.status}, content-type=${contentType || '(blank)'}`);
  }

  return { status: response.status, contentType };
}

function createQueryBody(rawSql) {
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

function rowCountFromFrame(frame) {
  const values = frame?.data?.values;
  if (!Array.isArray(values)) return 0;
  return values.reduce((max, column) => Math.max(max, Array.isArray(column) ? column.length : 0), 0);
}

async function validateDeep(cookie) {
  const rawSql = await fsp.readFile(QUERY_PATH, 'utf8');
  if (rawSql.trim() === PLACEHOLDER_SQL) {
    throw new Error('query46.sql still contains the placeholder');
  }

  const response = await fetch(DS_QUERY_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-datasource-uid': DATASOURCE_UID,
      'x-grafana-org-id': '1',
      'x-plugin-id': DATASOURCE_TYPE,
    },
    body: createQueryBody(rawSql),
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (response.status !== 200 || !isJsonContentType(contentType)) {
    throw new Error(`HTTP ${response.status}, content-type=${contentType || '(blank)'}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }

  const result = payload?.results?.A;
  if (Number(result?.status) === 401 || result?.error) {
    throw new Error(`Grafana result status=${result?.status ?? '(none)'}`);
  }

  const rows = rowCountFromFrame(result?.frames?.[0]);
  if (rows <= 0) {
    throw new Error(`frame parsed but row count was ${rows}`);
  }

  return { rows };
}

async function atomicWriteCookie(cookie) {
  const handle = await fsp.open(TEMP_COOKIE_PATH, 'w', 0o600);
  try {
    await handle.writeFile(`${cookie}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(TEMP_COOKIE_PATH, COOKIE_PATH);
}

async function main() {
  let gitignoreOk = false;
  try {
    await assertCookieIsIgnored();
    gitignoreOk = true;
  } catch (error) {
    fail('gitignore gate', error.message);
    return;
  }

  let cookie;
  try {
    cookie = await readCookieFromInput();
  } catch (error) {
    fail('intake', error.message);
    return;
  }

  if (!cookie) {
    fail('intake', 'no cookie provided');
    return;
  }

  const names = cookieNames(cookie);
  if (!names.includes('grafana_session')) {
    fail('intake', `cookie header did not contain grafana_session; parsed names: ${names.length ? names.join(', ') : '(none)'}`);
    return;
  }

  let cheap;
  try {
    cheap = await validateCheap(cookie);
  } catch (error) {
    fail('cheap validation', `${error.message}; parsed cookie names: ${names.length ? names.join(', ') : '(none)'}`);
    return;
  }

  let deep = null;
  if (process.argv.includes('--deep')) {
    try {
      deep = await validateDeep(cookie);
    } catch (error) {
      fail('deep validation', `cheap ok, deep failed (${error.message})`);
      return;
    }
  }

  try {
    await atomicWriteCookie(cookie);
  } catch (error) {
    fail('atomic write', error.message);
    return;
  }

  console.log(`gitignore gate OK: ${gitignoreOk ? 'yes' : 'no'}`);
  console.log(`cookie names: ${names.length ? names.join(', ') : '(none)'}`);
  console.log(`validation: cheap-${cheap.status}`);
  if (deep) console.log(`validation: deep rows>0 (${deep.rows})`);
  console.log('.cookie updated = yes');
  console.log('next command: node scripts/kompass-proof/three-way-join-proof.js');
  console.log('clipboard mode: node scripts/kompass-proof/refresh-cookie.js --clipboard');
}

main().catch((error) => {
  fail('unexpected error', error?.message || String(error));
});
