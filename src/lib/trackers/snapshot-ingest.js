'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { getCurrentPeriodWeek } = require('../fiscal-calendar');
const { mapLimit, normalizeConcurrency } = require('./concurrency');
const { resolveRange } = require('./date-range');
const { DEFAULT_PROJECT_IDS } = require('./metadata');
const reboticsReports = require('./rebotics-reports');
const sasReports = require('./sas-reports');
const { classifyReconciliation } = require('./sheet-reconciliation');
const { fetchSiRowsViaGrafana } = require('./si-grafana-source');
const { normalizeTrackerRow } = require('./tracker-sheet-reader');
const { normalizeWorkbookKind } = require('./tracker-workbooks');

const SHORT_PAYLOAD_FLOOR_RATIO = 0.6;
const SNAPSHOT_INGEST_STUCK_MINUTES = 3;
const SNAPSHOT_INGEST_HEARTBEAT_MS = 60000;
const QUERY46_SQL = fs.readFileSync(path.join(__dirname, 'query46.sql'), 'utf8');

function nowMs() {
  return performance.now();
}

function elapsedMs(startMs) {
  return Math.round(performance.now() - startMs);
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function validateSnapshotPayload(body = {}) {
  let workbookKind;
  try {
    workbookKind = normalizeWorkbookKind(body.workbookKind);
  } catch {
    throw httpError(400, 'workbookKind must be ise or blitz');
  }
  if (!Array.isArray(body.rows)) {
    throw httpError(400, 'rows must be an array');
  }
  return { workbookKind, rows: body.rows, force: body.force === true };
}

function snapshotKey(row) {
  return [
    row.workbookKind,
    row.store,
    row.periodWeek,
    row.categoryId,
    row.dbkey,
  ].join('|');
}

function normalizeRowIndex(value) {
  const parsed = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSnapshotRows(rawRows, workbookKind) {
  const byKey = new Map();
  for (const rawRow of rawRows || []) {
    const row = normalizeTrackerRow(rawRow, workbookKind);
    const rowIndex = normalizeRowIndex(row.rowIndex);
    const categoryId = parseInt(row.categoryId, 10);
    if (!row.store || !Number.isFinite(categoryId) || !row.dbkey || rowIndex == null) {
      continue;
    }
    const normalized = {
      ...row,
      rowIndex,
      categoryId: String(categoryId),
    };
    byKey.set(snapshotKey(normalized), normalized);
  }
  return [...byKey.values()];
}

function periodWeekToRange(periodWeek) {
  const match = String(periodWeek || '').trim().toUpperCase().match(/^P(\d{1,2})W([1-4])$/);
  if (!match) return null;
  return resolveRange({
    period: parseInt(match[1], 10),
    week: parseInt(match[2], 10),
  });
}

async function defaultFetchSourceRows(trackerRows, options = {}) {
  const timing = options.timingCollector || {};
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  timing.prodRanges = timing.prodRanges || [];
  timing.slowSiRanges = timing.slowSiRanges || [];
  if (timing.siGrafanaMs === undefined) timing.siGrafanaMs = null;
  const sourceFetchStart = nowMs();
  if (!trackerRows.length) {
    timing.sourceFetchMs = elapsedMs(sourceFetchStart);
    timing.rangeConcurrency = 1;
    return { prodRows: [], siRows: [], siSourceInfo: { siSource: 'si-api', siFallbackReason: null } };
  }
  const stores = [...new Set(trackerRows.map((row) => row.store).filter(Boolean))]
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const ranges = [...new Set(trackerRows.map((row) => row.periodWeek).filter(Boolean))]
    .map(periodWeekToRange)
    .filter(Boolean);
  const projects = Array.isArray(options.projects) && options.projects.length
    ? options.projects
    : DEFAULT_PROJECT_IDS;
  const settings = options.settings || {};
  const rangeConcurrency = normalizeConcurrency(settings.sasRangeConcurrency, 1, 3);
  timing.rangeConcurrency = rangeConcurrency;
  const grafanaPrimary = options.grafanaPrimary !== undefined
    ? Boolean(options.grafanaPrimary)
    : process.env.SI_GRAFANA_PRIMARY === 'true';
  const fetchSiGrafana = options.fetchSiGrafana || fetchSiRowsViaGrafana;
  const fetchProdRows = options.fetchProdRows || sasReports.fetchRows;
  const fetchSlowSiRows = options.fetchSlowSiRows || reboticsReports.fetchRows;
  const siSourceInfo = { siSource: 'si-api', siFallbackReason: null };
  let grafanaSiRows = null;
  if (grafanaPrimary) {
    onStage('fetching:si-grafana');
    const siStart = nowMs();
    try {
      grafanaSiRows = await fetchSiGrafana({ rawSql: QUERY46_SQL });
      siSourceInfo.siSource = 'grafana';
    } catch (err) {
      if (err && err.siGrafanaStale) {
        siSourceInfo.siSource = 'si-api-fallback';
        siSourceInfo.siFallbackReason = String(err.message || 'Grafana session stale').slice(0, 2000);
        console.warn(
          '[snapshot-ingest] SI Grafana session stale; falling back to slow Store Intelligence API path:',
          siSourceInfo.siFallbackReason,
        );
      } else {
        throw err;
      }
    } finally {
      timing.siGrafanaMs = elapsedMs(siStart);
    }
  }
  const useSlowSi = grafanaSiRows === null;
  const rangeCount = ranges.length;
  let completedRanges = 0;
  const rangeResults = await mapLimit(ranges, rangeConcurrency, async (range) => {
    const rangeStart = nowMs();
    const fetches = [
      fetchProdRows({
        stores,
        projects,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        settings,
      }),
    ];
    if (useSlowSi) {
      fetches.push(fetchSlowSiRows({
        stores,
        dates: range.dates,
        settings,
      }));
    }
    const [prod, si] = await Promise.all(fetches);
    const rangeMs = elapsedMs(rangeStart);
    completedRanges += 1;
    onStage(`fetching:prod:${completedRanges}-of-${rangeCount}-done`);
    return {
      prod,
      si: useSlowSi ? si : null,
      prodEntry: {
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        prodRows: prod.length,
        ms: rangeMs,
      },
      slowSiEntry: useSlowSi
        ? {
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          siRows: si.length,
          ms: rangeMs,
        }
        : null,
    };
  }, { signal: settings.cancelSignal || null });
  const prodRows = [];
  const siRows = [];
  for (const result of rangeResults) {
    prodRows.push(...result.prod);
    timing.prodRanges.push(result.prodEntry);
    if (useSlowSi && result.si) {
      siRows.push(...result.si);
      timing.slowSiRanges.push(result.slowSiEntry);
    }
  }
  if (!useSlowSi) siRows.push(...grafanaSiRows);
  timing.sourceFetchMs = elapsedMs(sourceFetchStart);
  return { prodRows, siRows, siSourceInfo };
}

async function resolveSettings(options = {}) {
  if (options.settings) return options.settings;
  if (typeof options.settingsLoader === 'function') return options.settingsLoader();
  return {};
}

async function reconcileSnapshotRows(trackerRows, options = {}) {
  if (!trackerRows.length) return [];
  const timing = options.timingCollector || {};
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const settings = await resolveSettings(options);
  const sourceFetcher = options.sourceFetcher || defaultFetchSourceRows;
  const classify = options.classify || classifyReconciliation;
  const { prodRows = [], siRows = [], siSourceInfo } = await sourceFetcher(trackerRows, {
    settings,
    projects: options.projects,
    timingCollector: timing,
    onStage,
  });
  if (options.siSourceCollector && siSourceInfo) Object.assign(options.siSourceCollector, siSourceInfo);
  onStage('classify');
  const classifyStart = nowMs();
  const result = classify({
    trackerRows,
    prodRows,
    siRows,
    projectMode: true,
    suppressAlreadySatisfied: false,
  });
  timing.classifyMs = elapsedMs(classifyStart);
  const proposalsByKey = new Map((result.proposals || []).map((proposal) => [proposal.key, proposal]));
  return trackerRows.map((row) => {
    const proposal = proposalsByKey.get(row.key);
    return {
      ...row,
      bucket: proposal?.bucket || 'no_match',
      bucketReason: proposal?.reason || 'Tracker row has no matching PROD or SI row.',
      expectation: proposal?.expectation || 'in_project_scope',
    };
  });
}

function parseRowPeriod(periodWeek) {
  const match = String(periodWeek || '').trim().toUpperCase().match(/^P(\d{1,2})W([1-4])$/);
  if (!match) return null;
  const period = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  if (!Number.isFinite(period) || period < 1 || period > 13 || !Number.isFinite(week)) return null;
  return { period, week };
}

function buildActivePeriodWindow({ currentPeriodWeek = getCurrentPeriodWeek } = {}) {
  let current;
  try {
    current = currentPeriodWeek();
  } catch (err) {
    const wrapped = httpError(502, `Could not compute active tracker period window: ${err.message}`);
    wrapped.snapshotStage = {
      stage: 'active_window',
      message: err.message,
    };
    throw wrapped;
  }
  const currentPeriod = parseInt(current?.period, 10);
  if (!Number.isFinite(currentPeriod) || currentPeriod < 1 || currentPeriod > 13) {
    const message = 'Current fiscal period is unavailable or invalid.';
    const err = httpError(502, `Could not compute active tracker period window: ${message}`);
    err.snapshotStage = {
      stage: 'active_window',
      message,
    };
    throw err;
  }
  const currentFiscalYear = parseInt(current?.fiscalYear, 10);
  const priorPeriod = currentPeriod === 1 ? 13 : currentPeriod - 1;
  const priorFiscalYear = currentPeriod === 1 && Number.isFinite(currentFiscalYear)
    ? currentFiscalYear - 1
    : currentFiscalYear;
  return {
    current: {
      period: currentPeriod,
      fiscalYear: Number.isFinite(currentFiscalYear) ? currentFiscalYear : null,
    },
    prior: {
      period: priorPeriod,
      fiscalYear: Number.isFinite(priorFiscalYear) ? priorFiscalYear : null,
    },
    activePeriods: new Set([currentPeriod, priorPeriod]),
  };
}

function classifyRowsForActiveWindow(rows, activeWindow) {
  const activeRows = [];
  const byKey = new Map();
  for (const row of rows) {
    const parsed = parseRowPeriod(row.periodWeek);
    if (!parsed) {
      byKey.set(row.key, {
        ...row,
        bucket: 'unknown_period',
        bucketReason: 'Tracker row period could not be parsed; skipped live reconciliation.',
        expectation: 'in_project_scope',
      });
      continue;
    }
    if (!activeWindow.activePeriods.has(parsed.period)) {
      byKey.set(row.key, {
        ...row,
        bucket: 'leave_alone_backlog',
        bucketReason: 'Outside active period window; not reconciled live.',
        expectation: 'in_project_scope',
      });
      continue;
    }
    activeRows.push(row);
  }
  return { activeRows, staticRowsByKey: byKey };
}

function mergeWindowedRows(normalizedRows, staticRowsByKey, reconciledRows) {
  const reconciledByKey = new Map((reconciledRows || []).map((row) => [row.key, row]));
  return normalizedRows.map((row) => staticRowsByKey.get(row.key) || reconciledByKey.get(row.key) || row);
}

function bucketCounts(rows) {
  return rows.reduce((acc, row) => {
    const bucket = row.bucket || 'unclassified';
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});
}

function shortPayloadError({ workbookKind, newCount, lastGood }) {
  const reason = newCount === 0 ? 'zero_rows' : 'short_payload';
  const payload = {
    rejected: true,
    kind: workbookKind,
    reason,
    newCount,
    lastGood,
    floorRatio: SHORT_PAYLOAD_FLOOR_RATIO,
  };
  const err = httpError(409, reason);
  err.snapshotReject = payload;
  return err;
}

function parseOptionalCount(value) {
  if (value == null) return null;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadSnapshotMeta(pool, workbookKind) {
  const { rows } = await pool.query(
    'SELECT refreshed_at, row_count, normalized_row_count, last_error FROM tracker_snapshot_meta WHERE workbook_kind = $1',
    [workbookKind],
  );
  return rows[0] || null;
}

async function claimSnapshotIngest(pool, workbookKind, { stuckMinutes = SNAPSHOT_INGEST_STUCK_MINUTES } = {}) {
  const { rowCount } = await pool.query(
    `INSERT INTO tracker_snapshot_meta
       (workbook_kind, refreshed_at, row_count, ingest_status, ingest_started_at, ingest_completed_at, ingest_heartbeat_at, ingest_stage)
     VALUES ($1, to_timestamp(0), 0, 'processing', NOW(), NULL, NOW(), 'claimed')
     ON CONFLICT (workbook_kind) DO UPDATE
       SET ingest_status = 'processing',
           ingest_started_at = NOW(),
           ingest_completed_at = NULL,
           ingest_heartbeat_at = NOW(),
           ingest_stage = 'claimed'
     WHERE tracker_snapshot_meta.ingest_status IS DISTINCT FROM 'processing'
        OR tracker_snapshot_meta.ingest_heartbeat_at IS NULL
        OR tracker_snapshot_meta.ingest_heartbeat_at < NOW() - ($2 || ' minutes')::interval`,
    [workbookKind, String(stuckMinutes)],
  );
  return rowCount === 1;
}

async function touchSnapshotIngestHeartbeat(pool, workbookKind) {
  await pool.query(
    `UPDATE tracker_snapshot_meta
        SET ingest_heartbeat_at = NOW()
      WHERE workbook_kind = $1 AND ingest_status = 'processing'`,
    [workbookKind],
  );
}

async function setSnapshotIngestStage(pool, workbookKind, stage) {
  await pool.query(
    `UPDATE tracker_snapshot_meta
        SET ingest_stage = $2, ingest_heartbeat_at = NOW()
      WHERE workbook_kind = $1 AND ingest_status = 'processing'`,
    [workbookKind, stage],
  );
}

async function sweepStuckSnapshotIngests(pool) {
  const { rowCount } = await pool.query(
    `UPDATE tracker_snapshot_meta
        SET ingest_status = 'error',
            ingest_completed_at = NOW(),
            last_error = 'Ingest interrupted by service restart'
      WHERE ingest_status = 'processing'`,
  );
  return rowCount;
}

function shouldRejectShortPayload({ newCount, lastGood, force = false }) {
  if (force) return false;
  if (newCount === 0) return true;
  return lastGood != null && newCount < SHORT_PAYLOAD_FLOOR_RATIO * lastGood;
}

function logForcedShortPayload({ workbookKind, newCount, lastGood }) {
  console.warn('[trackers.snapshot] FORCED ingest (below floor or zero-row)', {
    kind: workbookKind,
    newNormalizedCount: newCount,
    lastGoodNormalized: lastGood,
    floorRatio: SHORT_PAYLOAD_FLOOR_RATIO,
  });
}

async function assertPayloadCountAllowed({ pool, workbookKind, normalizedCount, force }) {
  const meta = await loadSnapshotMeta(pool, workbookKind);
  const lastGood = parseOptionalCount(meta?.normalized_row_count);
  const wouldReject = normalizedCount === 0
    || (lastGood != null && normalizedCount < SHORT_PAYLOAD_FLOOR_RATIO * lastGood);
  if (shouldRejectShortPayload({ newCount: normalizedCount, lastGood, force })) {
    throw shortPayloadError({ workbookKind, newCount: normalizedCount, lastGood });
  }
  if (force && wouldReject) {
    logForcedShortPayload({ workbookKind, newCount: normalizedCount, lastGood });
  }
  return { lastGood };
}

async function insertSnapshotRows(client, rows, refreshedAt) {
  if (!rows.length) return;
  const columnsPerRow = 13;
  const chunkSize = 250;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, idx) => {
      const base = idx * columnsPerRow;
      values.push(
        row.workbookKind,
        row.store,
        row.periodWeek,
        parseInt(row.categoryId, 10),
        row.dbkey,
        row.rowIndex,
        row.setType || null,
        row.currentK || null,
        row.currentL || null,
        row.bucket || null,
        row.bucketReason || null,
        row.expectation || null,
        refreshedAt,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`;
    });
    await client.query(
      `INSERT INTO tracker_snapshot_rows (
        workbook_kind, store, period_week, category_id, dbkey, row_index, set_type,
        current_k, current_l, bucket, bucket_reason, expectation, refreshed_at
      ) VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}

async function replaceSnapshotRows(pool, workbookKind, rows, refreshedAt, normalizedRowCount, siSourceInfo = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tracker_snapshot_rows WHERE workbook_kind = $1', [workbookKind]);
    await insertSnapshotRows(client, rows, refreshedAt);
    await client.query(
      `INSERT INTO tracker_snapshot_meta (workbook_kind, refreshed_at, row_count, normalized_row_count, last_error, si_source, si_fallback_reason, ingest_status, ingest_completed_at, ingest_stage)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, 'ok', NOW(), NULL)
       ON CONFLICT (workbook_kind) DO UPDATE
         SET refreshed_at = EXCLUDED.refreshed_at,
             row_count = EXCLUDED.row_count,
             normalized_row_count = EXCLUDED.normalized_row_count,
             last_error = NULL,
             si_source = EXCLUDED.si_source,
             si_fallback_reason = EXCLUDED.si_fallback_reason,
             ingest_status = 'ok',
             ingest_completed_at = NOW(),
             ingest_stage = NULL`,
      [workbookKind, refreshedAt, rows.length, normalizedRowCount, siSourceInfo.siSource || null, siSourceInfo.siFallbackReason || null],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recordSnapshotError(pool, workbookKind, err) {
  const message = err?.snapshotReject
    ? JSON.stringify(err.snapshotReject)
    : err?.snapshotStage
      ? JSON.stringify(err.snapshotStage)
      : String(err?.message || err || 'Tracker snapshot ingest failed').slice(0, 2000);
  await pool.query(
    `INSERT INTO tracker_snapshot_meta (workbook_kind, refreshed_at, row_count, last_error, ingest_status, ingest_completed_at, ingest_stage)
     VALUES ($1, NOW(), 0, $2, 'error', NOW(), NULL)
     ON CONFLICT (workbook_kind) DO UPDATE
       SET last_error = EXCLUDED.last_error,
           ingest_status = 'error',
           ingest_completed_at = NOW(),
           ingest_stage = NULL`,
    [workbookKind, message],
  );
}

async function ingestTrackerSnapshot({
  pool,
  workbookKind,
  rows,
  now = new Date(),
  force = false,
  ...options
}) {
  const normalizedRows = normalizeSnapshotRows(rows, workbookKind);
  const normalizedCount = normalizedRows.length;
  const refreshedAt = now instanceof Date ? now.toISOString() : String(now);
  const timingCollector = {};
  const totalIngestStart = nowMs();
  let outcome = 'error';
  let errorMessage = null;
  let activeRowCount = null;
  let siSourceLabel = null;
  const heartbeatTimer = setInterval(() => {
    touchSnapshotIngestHeartbeat(pool, workbookKind).catch(() => {});
  }, SNAPSHOT_INGEST_HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  const stage = (name) => setSnapshotIngestStage(pool, workbookKind, name).catch(() => {});
  const onStage = (name) => { stage(name); };
  try {
    await assertPayloadCountAllowed({
      pool,
      workbookKind,
      normalizedCount,
      force,
    });
    const activeWindow = buildActivePeriodWindow({ currentPeriodWeek: options.currentPeriodWeek });
    const { activeRows, staticRowsByKey } = classifyRowsForActiveWindow(normalizedRows, activeWindow);
    activeRowCount = activeRows.length;
    await stage('fetching_and_reconciling');
    const siSourceCollector = {};
    const reconciledActiveRows = await reconcileSnapshotRows(activeRows, {
      ...options,
      siSourceCollector,
      timingCollector,
      onStage,
    });
    const reconciledRows = mergeWindowedRows(normalizedRows, staticRowsByKey, reconciledActiveRows);
    await stage('writing_snapshot');
    const writeStart = nowMs();
    await replaceSnapshotRows(pool, workbookKind, reconciledRows, refreshedAt, normalizedCount, siSourceCollector);
    timingCollector.writeSnapshotMs = elapsedMs(writeStart);
    timingCollector.totalIngestMs = elapsedMs(totalIngestStart);
    outcome = 'success';
    siSourceLabel = siSourceCollector.siSource || null;
    return {
      kind: workbookKind,
      rowsReceived: rows.length,
      rowsStored: reconciledRows.length,
      normalizedRows: normalizedCount,
      bucketCounts: bucketCounts(reconciledRows),
      refreshedAt,
      forced: Boolean(force),
      siSource: siSourceCollector.siSource || null,
      siFallbackReason: siSourceCollector.siFallbackReason || null,
      timing: timingCollector,
    };
  } catch (err) {
    if (timingCollector.totalIngestMs === undefined) {
      timingCollector.totalIngestMs = elapsedMs(totalIngestStart);
    }
    errorMessage = String(err && err.message ? err.message : err).slice(0, 500);
    if (timingCollector.siGrafanaMs === undefined) timingCollector.siGrafanaMs = null;
    await recordSnapshotError(pool, workbookKind, err).catch(() => {});
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    console.log('[trackers.snapshot.timing]', JSON.stringify({
      outcome,
      workbookKind,
      normalizedRows: normalizedCount,
      activeRows: activeRowCount,
      siSource: siSourceLabel,
      siGrafanaMs: timingCollector.siGrafanaMs ?? null,
      rangeConcurrency: timingCollector.rangeConcurrency ?? 1,
      prodRanges: timingCollector.prodRanges || [],
      slowSiRanges: timingCollector.slowSiRanges || [],
      classifyMs: timingCollector.classifyMs ?? null,
      sourceFetchMs: timingCollector.sourceFetchMs ?? null,
      writeSnapshotMs: timingCollector.writeSnapshotMs ?? null,
      totalIngestMs: timingCollector.totalIngestMs ?? null,
      errorMessage,
    }));
  }
}

async function loadSnapshotMetaSummary(pool, { workbookKind, staleAfterMinutes = 20 } = {}) {
  if (!workbookKind) {
    const err = new Error('workbookKind is required');
    err.statusCode = 400;
    throw err;
  }
  const meta = await loadSnapshotMeta(pool, workbookKind);
  const { rows: metaSourceRows } = await pool.query(
    'SELECT si_source, si_fallback_reason, ingest_status, ingest_started_at, ingest_completed_at, ingest_heartbeat_at, ingest_stage FROM tracker_snapshot_meta WHERE workbook_kind = $1',
    [workbookKind],
  );
  const sourceMeta = metaSourceRows[0] || {};
  const refreshedAt = meta?.refreshed_at || null;
  // Freshness anchor: most recent of refreshed_at and ingest_completed_at.
  // ingest_completed_at only counts when last_error is null - error completions
  // also stamp it, and a fresh error timestamp over old rows must never read fresh.
  const completedAt = (!meta?.last_error && sourceMeta.ingest_completed_at) || null;
  const freshnessAnchor = [refreshedAt, completedAt]
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .sort((a, b) => b - a)[0] ?? null;
  const ageMinutes = freshnessAnchor === null ? null : (Date.now() - freshnessAnchor) / 60000;
  return {
    refreshedAt,
    rowCount: meta?.row_count ?? null,
    normalizedRowCount: meta?.normalized_row_count ?? null,
    lastError: meta?.last_error || null,
    siSource: sourceMeta.si_source || null,
    siFallbackReason: sourceMeta.si_fallback_reason || null,
    ingestStatus: sourceMeta.ingest_status || null,
    ingestStartedAt: sourceMeta.ingest_started_at || null,
    ingestCompletedAt: sourceMeta.ingest_completed_at || null,
    ingestStage: sourceMeta.ingest_stage || null,
    ingestHeartbeatAt: sourceMeta.ingest_heartbeat_at || null,
    stale: ageMinutes === null ? true : ageMinutes > staleAfterMinutes,
    ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes),
  };
}

async function loadSnapshotRows(pool, { workbookKind, setType, store, periodWeek, staleAfterMinutes = 20 } = {}) {
  if (!workbookKind) {
    const err = new Error('workbookKind is required');
    err.statusCode = 400;
    throw err;
  }
  const meta = await loadSnapshotMetaSummary(pool, { workbookKind, staleAfterMinutes });
  const conditions = ['workbook_kind = $1'];
  const params = [workbookKind];
  if (setType) {
    params.push(setType);
    conditions.push(`set_type = $${params.length}`);
  }
  if (store) {
    params.push(String(store));
    conditions.push(`store = $${params.length}`);
  }
  if (periodWeek) {
    params.push(periodWeek);
    conditions.push(`period_week = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT store, period_week, category_id, dbkey, row_index, set_type,
            current_k, current_l, bucket, bucket_reason, expectation, refreshed_at
       FROM tracker_snapshot_rows
      WHERE ${conditions.join(' AND ')}
      ORDER BY store, period_week, category_id, dbkey`,
    params,
  );
  return {
    workbookKind,
    rows: rows.map((r) => ({
      store: r.store,
      periodWeek: r.period_week,
      categoryId: String(r.category_id),
      dbkey: r.dbkey,
      rowIndex: r.row_index,
      setType: r.set_type,
      currentK: r.current_k,
      currentL: r.current_l,
      bucket: r.bucket,
      bucketReason: r.bucket_reason,
      expectation: r.expectation,
    })),
    meta,
  };
}

module.exports = {
  SHORT_PAYLOAD_FLOOR_RATIO,
  assertPayloadCountAllowed,
  buildActivePeriodWindow,
  bucketCounts,
  claimSnapshotIngest,
  classifyRowsForActiveWindow,
  defaultFetchSourceRows,
  ingestTrackerSnapshot,
  loadSnapshotMetaSummary,
  loadSnapshotRows,
  mergeWindowedRows,
  normalizeSnapshotRows,
  parseRowPeriod,
  periodWeekToRange,
  reconcileSnapshotRows,
  replaceSnapshotRows,
  setSnapshotIngestStage,
  sweepStuckSnapshotIngests,
  touchSnapshotIngestHeartbeat,
  validateSnapshotPayload,
};
