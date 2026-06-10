'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { readTrackerWorkbookRaw } = require('../src/lib/trackers/tracker-sheet-reader');

const DEFAULT_LOCAL_FLOOR = 50;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_FILES = 4;
const KINDS = [
  { kind: 'ise', envKey: 'ISE_WORKBOOK_PATH' },
  { kind: 'blitz', envKey: 'BLITZ_WORKBOOK_PATH' },
];

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const idx = withoutExport.indexOf('=');
    if (idx <= 0) continue;
    const key = withoutExport.slice(0, idx).trim();
    let value = withoutExport.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(envPath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(envPath)) return {};
  return parseEnvText(fs.readFileSync(envPath, 'utf8'));
}

function splitKindList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item === 'ise' || item === 'blitz');
}

function resolveForceSet(env = {}, argv = []) {
  const force = new Set(splitKindList(env.TRACKER_INGEST_FORCE_KIND));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force-kind') {
      for (const kind of splitKindList(argv[i + 1] || '')) force.add(kind);
      i += 1;
      continue;
    }
    if (arg.startsWith('--force-kind=')) {
      for (const kind of splitKindList(arg.slice('--force-kind='.length))) force.add(kind);
    }
  }
  return force;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveConfig({
  env = process.env,
  argv = process.argv.slice(2),
  envFile = path.join(__dirname, '.env'),
} = {}) {
  const fileEnv = loadEnvFile(envFile);
  const merged = { ...fileEnv, ...env };
  const missing = [];
  for (const key of ['API_BASE_URL', 'TRACKER_INGEST_TOKEN', 'ISE_WORKBOOK_PATH', 'BLITZ_WORKBOOK_PATH']) {
    if (!String(merged[key] || '').trim()) missing.push(key);
  }
  if (missing.length) {
    const err = new Error(`Missing required config: ${missing.join(', ')}`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  return {
    apiBaseUrl: String(merged.API_BASE_URL).replace(/\/+$/, ''),
    token: String(merged.TRACKER_INGEST_TOKEN),
    workbookPaths: {
      ise: String(merged.ISE_WORKBOOK_PATH),
      blitz: String(merged.BLITZ_WORKBOOK_PATH),
    },
    forceKinds: resolveForceSet(merged, argv),
    localFloor: parsePositiveInteger(merged.LOCAL_FLOOR, DEFAULT_LOCAL_FLOOR),
    logDir: String(merged.LOG_DIR || path.join(__dirname, 'logs')),
  };
}

function shouldSkipLocal({ rowsLength, forced, floor = DEFAULT_LOCAL_FLOOR }) {
  const count = Number(rowsLength) || 0;
  const threshold = parsePositiveInteger(floor, DEFAULT_LOCAL_FLOOR);
  if (forced) return { skip: false, reason: null };
  if (count === 0) return { skip: true, reason: 'zero_rows' };
  if (count < threshold) return { skip: true, reason: 'below_local_floor' };
  return { skip: false, reason: null };
}

function classifyResponse(status, body = {}) {
  if (status >= 200 && status < 300) {
    return {
      ok: true,
      kind: body.kind || null,
      outcome: 'posted',
      bucketCounts: body.bucketCounts || {},
      rowsStored: body.rowsStored ?? null,
      normalizedRows: body.normalizedRows ?? null,
      forced: Boolean(body.forced),
    };
  }
  if (status === 409) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: body.reason || body.error || 'rejected',
      newCount: body.newCount ?? null,
      lastGood: body.lastGood ?? null,
      floorRatio: body.floorRatio ?? null,
    };
  }
  const authStatuses = new Set([401, 503]);
  return {
    ok: false,
    outcome: authStatuses.has(status) ? 'auth_or_config_error' : 'post_failed',
    reason: body.error || body.reason || `HTTP ${status}`,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rotateLogs(logPath, { maxBytes = DEFAULT_LOG_MAX_BYTES, keepFiles = DEFAULT_LOG_FILES } = {}) {
  if (!fs.existsSync(logPath)) return;
  const stat = fs.statSync(logPath);
  if (stat.size < maxBytes) return;
  for (let i = keepFiles - 1; i >= 1; i -= 1) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  fs.renameSync(logPath, `${logPath}.1`);
}

function createLogger(logDir) {
  ensureDir(logDir);
  const logPath = path.join(logDir, 'tracker-agent.log');
  function write(level, message, fields = {}) {
    rotateLogs(logPath);
    const entry = {
      at: new Date().toISOString(),
      level,
      message,
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
    const consoleLine = `[tracker-agent] ${level} ${message}`;
    if (level === 'error') console.error(consoleLine, fields);
    else console.log(consoleLine, fields);
  }
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    logPath,
  };
}

function acquireLock(lockPath = path.join(__dirname, '.run.lock')) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
      },
    };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { acquired: false, release: () => {} };
    }
    throw err;
  }
}

async function readKindRows({ kind, workbookPath, reader = readTrackerWorkbookRaw, logger, retryDelayMs = 3000 }) {
  try {
    return await reader(kind, { workbookPath });
  } catch (firstErr) {
    logger.warn('read failed, retrying once', { kind, error: firstErr.message });
    await delay(retryDelayMs);
    try {
      return await reader(kind, { workbookPath });
    } catch (secondErr) {
      logger.error('read failed after retry, skipping kind', { kind, error: secondErr.message });
      throw secondErr;
    }
  }
}

async function postKind({ kind, rows, forced, config, fetchImpl = fetch }) {
  const res = await fetchImpl(`${config.apiBaseUrl}/api/trackers/snapshot/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workbookKind: kind,
      rows,
      force: Boolean(forced),
    }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return {
    status: res.status,
    body,
    summary: classifyResponse(res.status, body),
  };
}

async function processKind({ kindConfig, config, reader = readTrackerWorkbookRaw, fetchImpl = fetch, logger }) {
  const { kind } = kindConfig;
  const forced = config.forceKinds.has(kind);
  let rows;
  try {
    rows = await readKindRows({
      kind,
      workbookPath: config.workbookPaths[kind],
      reader,
      logger,
      retryDelayMs: config.retryDelayMs ?? 3000,
    });
  } catch {
    return { kind, outcome: 'read_failed_skipped', posted: false, forced };
  }

  const rowsLength = Array.isArray(rows) ? rows.length : 0;
  logger.info('read complete', { kind, rows: rowsLength, forced });
  const localDecision = shouldSkipLocal({ rowsLength, forced, floor: config.localFloor });
  if (localDecision.skip) {
    logger.warn('below local floor, skipping', {
      kind,
      rows: rowsLength,
      floor: config.localFloor,
      reason: localDecision.reason,
    });
    return { kind, outcome: 'local_floor_skipped', posted: false, rows: rowsLength, reason: localDecision.reason, forced };
  }

  try {
    const response = await postKind({ kind, rows, forced, config, fetchImpl });
    logger.info('post complete', {
      kind,
      status: response.status,
      outcome: response.summary.outcome,
      rows: rowsLength,
      forced,
      summary: response.summary,
    });
    return { kind, outcome: response.summary.outcome, posted: true, rows: rowsLength, status: response.status, forced, response: response.summary };
  } catch (err) {
    logger.error('post failed, skipping kind', { kind, rows: rowsLength, forced, error: err.message });
    return { kind, outcome: 'post_error_skipped', posted: false, rows: rowsLength, forced, error: err.message };
  }
}

async function runAgent(options = {}) {
  const config = options.config || resolveConfig(options);
  const logger = options.logger || createLogger(config.logDir);
  const lock = options.lock || acquireLock(options.lockPath || path.join(__dirname, '.run.lock'));
  if (!lock.acquired) {
    logger.warn('previous run still active, exiting');
    return { skippedByLock: true, results: [] };
  }

  const results = [];
  try {
    logger.info('run started', {
      apiBaseUrl: config.apiBaseUrl,
      localFloor: config.localFloor,
      forceKinds: [...config.forceKinds],
    });
    for (const kindConfig of KINDS) {
      results.push(await processKind({
        kindConfig,
        config,
        reader: options.reader,
        fetchImpl: options.fetchImpl,
        logger,
      }));
    }
    logger.info('run finished', {
      results: results.map((result) => ({
        kind: result.kind,
        outcome: result.outcome,
        posted: result.posted,
        rows: result.rows,
        status: result.status,
        forced: result.forced,
      })),
    });
    return { skippedByLock: false, results };
  } finally {
    lock.release();
  }
}

async function main() {
  try {
    await runAgent();
    process.exitCode = 0;
  } catch (err) {
    const logger = createLogger(process.env.LOG_DIR || path.join(__dirname, 'logs'));
    logger.error('fatal agent error', { error: err.message, code: err.code || null });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  KINDS,
  classifyResponse,
  parseEnvText,
  processKind,
  resolveConfig,
  resolveForceSet,
  runAgent,
  shouldSkipLocal,
};
