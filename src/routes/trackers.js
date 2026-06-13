'use strict';

const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const { requireAuth } = require('../auth-middleware');
const { FISCAL_CALENDARS, getFolderInfo } = require('../lib/fiscal-calendar');
const sasBridge = require('../sas-bridge');
const reboticsBridge = require('../rebotics-bridge');
const { resolveRange } = require('../lib/trackers/date-range');
const sasReports = require('../lib/trackers/sas-reports');
const reboticsReports = require('../lib/trackers/rebotics-reports');
const { compareRows, PHASE2_ROSTER_NOTE } = require('../lib/trackers/compare');
const { cancelledError, throwIfAborted } = require('../lib/trackers/concurrency');
const {
  DEFAULT_PROJECT_IDS,
  districtOptions,
  normalizeDistricts,
  projectLabel,
  storesForDistricts,
} = require('../lib/trackers/metadata');
const {
  DEFAULTS: TRACKER_DEFAULTS,
  trackerAdminEmails,
  loadTrackerSettings,
  saveTrackerSettings,
  isTrackerUserAllowed,
} = require('../lib/trackers/settings');
const {
  claimSnapshotIngest,
  ingestTrackerSnapshot,
  loadSnapshotMetaSummary,
  loadSnapshotRows,
  sweepStuckSnapshotIngests,
  validateSnapshotPayload,
} = require('../lib/trackers/snapshot-ingest');

const inFlightRuns = new Map();
const TRACKER_ADMIN_EMAILS = trackerAdminEmails();
const RUN_HEARTBEAT_MS = 15000;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'degraded']);
const STALE_THRESHOLD_MS = RUN_HEARTBEAT_MS * 6;
const INTERRUPTED_RUN_ERROR = 'Run interrupted by a server restart. Please re-run.';
const PROCESS_STARTED_AT = new Date().toISOString();

function bearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function safeTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireTrackerAdmin(req, res, next) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email || !TRACKER_ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: 'Tracker admin access denied' });
  }
  return next();
}

async function requireTrackerAccess(req, res, next) {
  try {
    const settings = await loadTrackerSettings(req.trackerPool);
    if (!isTrackerUserAllowed(req.user, settings)) {
      return res.status(403).json({ ok: false, error: 'Tracker access is restricted. Ask an admin for access.' });
    }
    req.trackerSettings = settings;
    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Could not evaluate tracker access: ${err.message}` });
  }
}

function buildWeeks() {
  const weeks = [];
  const fiscalYears = Object.keys(FISCAL_CALENDARS)
    .map((y) => parseInt(y, 10))
    .filter((y) => !Number.isNaN(y))
    .sort((a, b) => a - b);
  for (const fy of fiscalYears) {
    const calendar = FISCAL_CALENDARS[fy];
    const periodKeys = Object.keys(calendar.periods || {}).sort();
    for (const periodStr of periodKeys) {
      const periodData = calendar.periods[periodStr];
      if (!periodData || !periodData.weeks) continue;
      for (const weekStr of ['1', '2', '3', '4']) {
        const weekData = periodData.weeks[weekStr];
        if (!weekData) continue;
        const info = getFolderInfo(parseInt(periodStr, 10), parseInt(weekStr, 10), fy);
        let prefix = `${info.relativePath.split(path.sep).join('/')}/`;
        const dumpBinSeg = `${info.dumpBinPath}/`;
        if (prefix.startsWith(dumpBinSeg)) prefix = prefix.slice(dumpBinSeg.length);
        weeks.push({
          start: info.startDate,
          end: info.endDate,
          short: info.periodWeek,
          fiscalYear: fy,
          period: parseInt(periodStr, 10),
          week: parseInt(weekStr, 10),
          prefix,
        });
      }
    }
  }
  weeks.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return weeks;
}

function normalizeStores(stores) {
  return (Array.isArray(stores) ? stores : String(stores || '').split(','))
    .map((s) => parseInt(String(s).trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => String(n));
}

function normalizeProjects(projects) {
  return (Array.isArray(projects) ? projects : String(projects || '').split(','))
    .map((p) => parseInt(String(p).trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function truthyFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeRunParams(params = {}) {
  const explicitStores = normalizeStores(params.stores);
  const districts = normalizeDistricts(params.districts);
  const districtStores = storesForDistricts(districts);
  const stores = [...new Set([...explicitStores, ...districtStores])]
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const projects = normalizeProjects(params.projects);
  return {
    ...params,
    stores,
    districts,
    projects,
    includeOffScope: truthyFlag(params.includeOffScope),
  };
}

function validateRunShape({ params, range, settings, effectiveProjectCount = null }) {
  const projectCount = effectiveProjectCount || params.projects?.length || DEFAULT_PROJECT_IDS.length;
  const stores = params.stores || [];
  const dates = range.dates || [];
  const workUnits = stores.length * dates.length * projectCount;
  const warnings = [];

  if (!stores.length) {
    return { ok: false, status: 400, error: 'Choose at least one store or district.' };
  }
  if (stores.length > settings.maxRunStores) {
    return {
      ok: false,
      status: 413,
      error: `This run includes ${stores.length} stores. Limit it to ${settings.maxRunStores} stores or split by district.`,
    };
  }
  if (dates.length > settings.maxRunDates) {
    return {
      ok: false,
      status: 413,
      error: `This run spans ${dates.length} days. Limit it to ${settings.maxRunDates} days or run smaller date windows.`,
    };
  }
  if (workUnits > settings.maxRunWorkUnits) {
    return {
      ok: false,
      status: 413,
      error: `This run would check ${workUnits} store/date/project combinations. Limit it to ${settings.maxRunWorkUnits} or split the request.`,
    };
  }
  if (workUnits > Math.floor(settings.maxRunWorkUnits * 0.75)) {
    warnings.push(`Large run: ${workUnits} store/date/project combinations. It may take several minutes.`);
  }
  return { ok: true, workUnits, warnings };
}

function classifySourceError(err) {
  if (isCancelError(err)) return 'cancelled';
  const message = String(err?.message || err || '');
  if (/sign in|required|session|token|auth/i.test(message)) return 'auth';
  if (/timeout|timed out|abort/i.test(message)) return 'source_timeout';
  if (/limit|too large|split/i.test(message)) return 'request_too_large';
  return 'source_error';
}

function isCancelError(err) {
  return err?.code === 'TRACKER_CANCELLED' || /cancelled|canceled/i.test(String(err?.message || ''));
}

function formatShortDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || '').trim();
  const [, year, month, day] = match;
  return `${Number(month)}/${Number(day)}/${year.slice(2)}`;
}

function formatRunDateRange(dateFrom, dateTo) {
  const from = formatShortDate(dateFrom);
  const to = formatShortDate(dateTo || dateFrom);
  if (!from) return 'the selected dates';
  return !to || to === from ? from : `${from}-${to}`;
}

function friendlySourceMessage(info = {}, range = {}) {
  if (info.source === 'prod') {
    const projectName = info.projectName || projectLabel(info.projectId, 'PROD');
    const store = info.storeNumber ? ` for store ${info.storeNumber}` : '';
    const dates = formatRunDateRange(info.dateFrom || range.dateFrom, info.dateTo || range.dateTo);
    return `Pulling ${dates} ${projectName}${store}.`;
  }
  if (info.source === 'si') {
    const store = info.storeNumber ? ` for store ${info.storeNumber}` : '';
    const date = info.date ? ` on ${formatShortDate(info.date)}` : ` for ${formatRunDateRange(range.dateFrom, range.dateTo)}`;
    return `Pulling Store Intelligence${store}${date}.`;
  }
  return 'Pulling tracker data.';
}

function friendlyHeartbeatMessage(info = {}, range = {}, elapsedMs = 0) {
  const elapsedSeconds = Math.max(15, Math.round(elapsedMs / 1000));
  const elapsedText = elapsedSeconds >= 90
    ? `about ${Math.round(elapsedSeconds / 60)} minutes`
    : `${elapsedSeconds} seconds`;
  const base = friendlySourceMessage(info, range).replace(/\.$/, '');
  if (info.source === 'si') {
    return `${base}. Still checking Store Intelligence; this source can take a few minutes (${elapsedText}).`;
  }
  return `${base}. Still working on this source (${elapsedText}).`;
}

function buildProdProgress(info = {}, range = {}, params = {}) {
  const completed = Number(info.completedLookups || 0);
  const total = Math.max(1, Number(info.totalLookups || params.projects?.length || 1));
  return {
    stage: 'pulling_prod',
    progress: Math.min(50, 15 + Math.round((completed / total) * 35)),
    message: friendlySourceMessage({ ...info, source: 'prod' }, range),
    source: 'prod',
    storeNumber: info.storeNumber || null,
    projectId: info.projectId || null,
    projectName: info.projectName || projectLabel(info.projectId, 'PROD'),
    completedLookups: completed,
    totalLookups: total,
    prodRows: info.rows,
    stores: params.stores?.length || 0,
    dates: range.dates?.length || 0,
    dateFrom: info.dateFrom || range.dateFrom,
    dateTo: info.dateTo || range.dateTo,
    projects: params.projects?.length || 0,
  };
}

function buildSiProgress(info = {}, range = {}, params = {}, { heartbeat = false, elapsedMs = 0, prodDone = false } = {}) {
  const completed = Number(info.completedLookups || 0);
  const total = Math.max(1, Number(info.totalLookups || ((range.dates?.length || 1) * (params.stores?.length || 1))));
  const progressBase = prodDone ? 50 : 15;
  const progressSpan = prodDone ? 15 : 45;
  return {
    stage: 'pulling_rebotics',
    progress: Math.min(65, progressBase + Math.round((completed / total) * progressSpan)),
    message: heartbeat
      ? friendlyHeartbeatMessage({ ...info, source: 'si' }, range, elapsedMs)
      : friendlySourceMessage({ ...info, source: 'si' }, range),
    source: 'si',
    storeNumber: info.storeNumber || params.stores?.[0] || null,
    date: info.date || range.dates?.[Math.min(completed, Math.max(0, (range.dates?.length || 1) - 1))] || null,
    completedLookups: completed,
    totalLookups: total,
    siRows: info.rows,
    stores: params.stores?.length || 0,
    dates: range.dates?.length || 0,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  };
}

async function updateRun(pool, runId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = [];
  const values = [];
  keys.forEach((k, idx) => {
    sets.push(`${k} = $${idx + 1}`);
    values.push(fields[k]);
  });
  values.push(runId);
  await pool.query(`UPDATE tracker_runs SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

async function markRunInterrupted(pool, runId) {
  const { rows } = await pool.query(
    `UPDATE tracker_runs
     SET status = 'failed',
         completed_at = NOW(),
         error_text = $2,
         progress_json = progress_json || $3::jsonb
     WHERE id = $1
     RETURNING *`,
    [
      runId,
      INTERRUPTED_RUN_ERROR,
      JSON.stringify({
        stage: 'failed',
        progress: 100,
        errorType: 'interrupted',
        error: INTERRUPTED_RUN_ERROR,
      }),
    ],
  );
  return rows[0] || null;
}

async function sweepInterruptedRuns(pool) {
  await pool.query(
    `UPDATE tracker_runs
     SET status = 'failed',
         completed_at = NOW(),
         error_text = $1,
         progress_json = progress_json || $2::jsonb
     WHERE status IN ('queued', 'running')`,
    [
      INTERRUPTED_RUN_ERROR,
      JSON.stringify({
        stage: 'failed',
        progress: 100,
        errorType: 'interrupted',
        error: INTERRUPTED_RUN_ERROR,
      }),
    ],
  );
}

async function loadRun(pool, idOrKey) {
  const asInt = parseInt(String(idOrKey), 10);
  if (Number.isFinite(asInt) && String(asInt) === String(idOrKey)) {
    const { rows } = await pool.query('SELECT * FROM tracker_runs WHERE id = $1', [asInt]);
    return rows[0] || null;
  }
  const { rows } = await pool.query('SELECT * FROM tracker_runs WHERE run_key = $1', [String(idOrKey)]);
  return rows[0] || null;
}

function runFreshnessTime(run) {
  const progress = run?.progress_json || {};
  const value = progress.updatedAt || run?.started_at || run?.created_at;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function isStaleOrphanedRun(run) {
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
  if (inFlightRuns.has(run.id)) return false;
  const lastSeen = runFreshnessTime(run);
  return !lastSeen || Date.now() - lastSeen > STALE_THRESHOLD_MS;
}

async function fetchReboticsAction(actionId) {
  try {
    return await reboticsReports.fetchJson(`/api/v4/processing/actions/${actionId}/`);
  } catch (err) {
    if (err?.status === 401 || err?.status === 403 || /401|403|token|auth/i.test(String(err?.message || ''))) {
      await reboticsBridge.validateCurrentToken({ force: true });
      return reboticsReports.fetchJson(`/api/v4/processing/actions/${actionId}/`);
    }
    throw err;
  }
}

async function insertRunResults(pool, runId, compared) {
  await pool.query('DELETE FROM tracker_run_images WHERE run_id = $1', [runId]);
  await pool.query('DELETE FROM tracker_run_items WHERE run_id = $1', [runId]);

  const itemIdByKey = new Map();
  for (const item of compared.items) {
    const sourceRefs = item.sourceRefs || {};
    const { rows } = await pool.query(
      `INSERT INTO tracker_run_items (
        run_id, store_number, work_date, period_week, project_id, project_name, dbkey, pog, category_set_label,
        prod_status, si_status, prod_photo_count, si_photo_count, confidence, notes, source_refs_json,
        expectation, prod_presence_state, si_presence_state, row_state, reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb,
        $17, $18, $19, $20, $21
      ) RETURNING id`,
      [
        runId,
        item.storeNumber || null,
        item.workDate || null,
        item.periodWeek || null,
        item.projectId || null,
        item.projectName || null,
        item.dbkey || null,
        item.pog || null,
        item.categorySetLabel || null,
        item.prodStatus || null,
        item.siStatus || null,
        item.prodPhotoCount || 0,
        item.siPhotoCount || 0,
        item.confidence || 'needs_review',
        item.notes || null,
        JSON.stringify(sourceRefs),
        item.expectation || null,
        item.prodPresenceState || null,
        item.siPresenceState || null,
        item.rowState || item.comparisonStatus || null,
        item.reason || null,
      ],
    );
    const itemId = rows[0].id;
    const key = item.itemKey || `${item.storeNumber || ''}|${item.dbkey || ''}`;
    itemIdByKey.set(key, itemId);
  }

  for (const image of compared.images) {
    const itemId = itemIdByKey.get(image.itemKey || '') || null;
    await pool.query(
      `INSERT INTO tracker_run_images (
        run_id, item_id, source_system, image_role, source_ref, source_url, action_id, bay_index, captured_at, metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
      )`,
      [
        runId,
        itemId,
        image.sourceSystem || 'unknown',
        image.imageRole || 'after',
        image.sourceRef || null,
        image.sourceUrl || null,
        image.actionId || null,
        image.bayIndex || null,
        image.capturedAt || null,
        JSON.stringify({ dbkey: image.dbkey || null }),
      ],
    );
  }
}

async function processRun(pool, run, options = {}) {
  const cancelSignal = options.signal || null;
  const warnings = [];
  let keepalive = null;
  try {
    throwIfAborted(cancelSignal);
    const params = normalizeRunParams(run.params_json || {});
    const settings = await loadTrackerSettings(pool);
    const runSettings = { ...settings, cancelSignal };
    const range = resolveRange(params);
    const projectMode = Boolean(params.projects.length);
    const effectiveProjects = projectMode
      ? params.projects
      : (await sasReports.discoverProjects())
        .map((project) => Number(project.id))
        .filter((id) => Number.isFinite(id));
    if (!effectiveProjects.length) throw new Error('No SAS projects are available for full reconciliation.');
    const includeOffScope = Boolean(settings.includeOffScope || params.includeOffScope);
    const sourceParams = { ...params, projects: effectiveProjects };
    const guard = validateRunShape({ params, range, settings, effectiveProjectCount: effectiveProjects.length });
    if (!guard.ok) throw new Error(guard.error);
    warnings.push(...guard.warnings);

    await updateRun(pool, run.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      progress_json: JSON.stringify({
        stage: 'starting',
        progress: 0,
        updatedAt: new Date().toISOString(),
        stores: params.stores.length,
        dates: range.dates.length,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        projects: effectiveProjects.length,
        workUnits: guard.workUnits,
      }),
    });

    await updateRun(pool, run.id, {
      progress_json: JSON.stringify({
        stage: 'pulling_sources',
        progress: 15,
        updatedAt: new Date().toISOString(),
        message: `Starting source pulls for ${formatRunDateRange(range.dateFrom, range.dateTo)}.`,
        stores: params.stores.length,
        dates: range.dates.length,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        projects: effectiveProjects.length,
        workUnits: guard.workUnits,
      }),
    });

    const sourceState = {
      prod: { done: false, info: null },
      si: { done: false, info: null, startedAt: 0 },
    };
    let lastProgress = null;
    const writeProgress = (progress) => {
      throwIfAborted(cancelSignal);
      lastProgress = {
        ...progress,
        updatedAt: new Date().toISOString(),
      };
      return updateRun(pool, run.id, {
        progress_json: JSON.stringify(lastProgress),
      });
    };
    const writeProdProgress = async (info) => {
      sourceState.prod.info = { ...info };
      await writeProgress(buildProdProgress(info, range, sourceParams));
    };
    const writeSiProgress = async (info) => {
      sourceState.si.info = { ...info };
      if (!sourceState.si.startedAt) sourceState.si.startedAt = Date.now();
      await writeProgress(buildSiProgress(info, range, params, { prodDone: sourceState.prod.done }));
    };
    keepalive = setInterval(() => {
      if (cancelSignal?.aborted) return;
      const info = !sourceState.si.done && (sourceState.si.info || (sourceState.prod.done ? {
        source: 'si',
        storeNumber: params.stores[0] || null,
        date: range.dates[0] || null,
        completedLookups: 0,
        totalLookups: Math.max(1, range.dates.length * params.stores.length),
        rows: 0,
      } : null));
      if (info) {
        if (!sourceState.si.startedAt) sourceState.si.startedAt = Date.now();
        writeProgress(buildSiProgress(info, range, params, {
          heartbeat: true,
          elapsedMs: Date.now() - sourceState.si.startedAt,
          prodDone: sourceState.prod.done,
        })).catch(() => {});
        return;
      }
      if (lastProgress && !TERMINAL_RUN_STATUSES.has(lastProgress.stage)) {
        writeProgress(lastProgress).catch(() => {});
      }
    }, RUN_HEARTBEAT_MS);

    let prodResult;
    let siResult;
    [prodResult, siResult] = await Promise.allSettled([
      sasReports.fetchRows({
        stores: params.stores,
        projects: effectiveProjects,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        settings: runSettings,
        onProgress: (info) => writeProdProgress(info).catch(() => {}),
      }).finally(() => {
        sourceState.prod.done = true;
      }),
      reboticsReports.fetchRows({
        stores: params.stores,
        dates: range.dates,
        settings: runSettings,
        onWarning: (message) => warnings.push(message),
        onProgress: (info) => writeSiProgress(info).catch(() => {}),
      }).finally(() => {
        sourceState.si.done = true;
      }),
    ]);
    throwIfAborted(cancelSignal);

    let prodRows = [];
    let siRows = [];
    let siCoverageComplete = true;
    if (prodResult.status === 'fulfilled') prodRows = prodResult.value;
    else warnings.push(`SAS pull failed: ${prodResult.reason?.message || String(prodResult.reason)}`);
    if (siResult.status === 'fulfilled') {
      const siValue = siResult.value;
      siRows = Array.isArray(siValue) ? siValue : (siValue?.rows || []);
      const coverageComplete = Array.isArray(siValue) ? true : siValue?.coverageComplete !== false;
      const skipped = Array.isArray(siValue) ? [] : (siValue?.skipped || []);
      siCoverageComplete = coverageComplete;
      if (!coverageComplete) {
        warnings.push(`Store Intelligence coverage incomplete: ${skipped.length} unit(s) skipped; absence not verified for affected sets.`);
      }
    } else {
      siCoverageComplete = false;
      warnings.push(`Rebotics pull failed: ${siResult.reason?.message || String(siResult.reason)}`);
    }
    if (prodResult.status === 'rejected' && siResult.status === 'rejected') {
      throw new Error('Both SAS and Rebotics pulls failed; no rows to compare.');
    }

    await writeProgress({
      stage: 'comparing',
      progress: 70,
      message: 'Comparing PROD and Store Intelligence results.',
      prodRows: prodRows.length,
      siRows: siRows.length,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });

    const compared = compareRows(prodRows, siRows, {
      expectedProdRows: [],
      projectMode,
      includeOffScope,
      siCoverageComplete,
    });
    for (const note of compared.summary.notes || [PHASE2_ROSTER_NOTE]) {
      if (!warnings.includes(note)) warnings.push(note);
    }
    throwIfAborted(cancelSignal);
    await insertRunResults(pool, run.id, compared);
    throwIfAborted(cancelSignal);
    const siDegraded = prodResult.status === 'fulfilled'
      && (siResult.status === 'rejected' || !siCoverageComplete);
    const finalStatus = siDegraded ? 'degraded' : 'completed';
    const doneMessage = siDegraded
      ? 'Comparison complete — Store Intelligence coverage incomplete; absence not verified for affected sets'
      : (compared.summary.total ? 'Comparison complete' : 'No matching rows found');
    await updateRun(pool, run.id, {
      status: finalStatus,
      completed_at: new Date().toISOString(),
      warnings_json: JSON.stringify(warnings),
      summary_json: JSON.stringify({
        ...compared.summary,
        prodRows: prodRows.length,
        siRows: siRows.length,
        siCoverageComplete,
        status: finalStatus,
      }),
      progress_json: JSON.stringify({
        stage: siDegraded ? 'done_degraded' : 'done',
        progress: 100,
        message: doneMessage,
        prodRows: prodRows.length,
        siRows: siRows.length,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        total: compared.summary.total,
      }),
    });
  } catch (err) {
    if (isCancelError(err)) {
      await updateRun(pool, run.id, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        warnings_json: JSON.stringify(warnings),
        error_text: null,
        progress_json: JSON.stringify({
          stage: 'cancelled',
          progress: 100,
          message: 'Run cancelled.',
          errorType: 'cancelled',
        }),
      });
      return;
    }
    await updateRun(pool, run.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      warnings_json: JSON.stringify(warnings),
      error_text: err.message,
      progress_json: JSON.stringify({
        stage: 'failed',
        progress: 100,
        error: err.message,
        errorType: classifySourceError(err),
      }),
    });
  } finally {
    if (keepalive) clearInterval(keepalive);
    inFlightRuns.delete(run.id);
  }
}

function jsonToCsv(rows) {
  if (!rows.length) return '';
  const header = [
    'store',
    'work_date',
    'period_week',
    'project_id',
    'project_name',
    'dbkey',
    'pog',
    'category_set_label',
    'PROD_status',
    'SI_status',
    'prod_photo_count',
    'si_photo_count',
    'confidence',
    'notes',
  ];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => header.map((h) => esc(r[h])).join(','));
  return `${header.join(',')}\n${body.join('\n')}`;
}

function createTrackersRouter({ pool, snapshotIngest = {} }) {
  const router = express.Router();
  sweepInterruptedRuns(pool).catch((err) => {
    console.error('[trackers] failed to mark interrupted startup runs:', err.message);
  });
  sweepStuckSnapshotIngests(pool).catch((err) => {
    console.error('[trackers] failed to sweep stuck snapshot ingests:', err.message);
  });

  router.use((req, _res, next) => {
    req.trackerPool = pool;
    next();
  });

  router.post('/snapshot/ingest', async (req, res) => {
    const expectedToken = String(process.env.TRACKER_INGEST_TOKEN || '').trim();
    if (!expectedToken) {
      return res.status(503).json({ ok: false, error: 'Tracker ingest token is not configured' });
    }
    if (!safeTokenEquals(bearerToken(req), expectedToken)) {
      return res.status(401).json({ ok: false, error: 'Invalid tracker ingest token' });
    }

    let payload;
    try {
      payload = validateSnapshotPayload(req.body || {});
    } catch (err) {
      return res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }

    let claimed;
    try {
      claimed = await claimSnapshotIngest(pool, payload.workbookKind);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
    if (!claimed) {
      return res.status(409).json({
        ok: false,
        error: `An ingest for '${payload.workbookKind}' is already processing`,
      });
    }

    res.status(202).json({ ok: true, kind: payload.workbookKind, status: 'processing' });

    ingestTrackerSnapshot({
      pool,
      workbookKind: payload.workbookKind,
      rows: payload.rows,
      force: payload.force,
      settingsLoader: () => loadTrackerSettings(pool),
      ...snapshotIngest,
    }).catch((err) => {
      console.error(
        `[trackers] background snapshot ingest failed for '${payload.workbookKind}':`,
        err.message,
      );
    });
  });

  router.get('/snapshot/meta', async (req, res) => {
    const expectedToken = String(process.env.TRACKER_META_TOKEN || '').trim();
    if (!expectedToken) {
      return res.status(503).json({ ok: false, error: 'Tracker meta token is not configured' });
    }
    if (!safeTokenEquals(bearerToken(req), expectedToken)) {
      return res.status(401).json({ ok: false, error: 'Invalid tracker meta token' });
    }
    try {
      const workbookKind = String(req.query.workbookKind || '').trim();
      const meta = await loadSnapshotMetaSummary(req.trackerPool, { workbookKind });
      return res.json({ ok: true, workbookKind, meta });
    } catch (err) {
      return res.status(err.statusCode || 502).json({ ok: false, error: err.message });
    }
  });

  router.use(requireAuth);
  router.use(requireTrackerAccess);

  router.get('/bootstrap', async (req, res) => {
    const weeks = buildWeeks();
    const projects = await sasReports.discoverProjects();
    const settings = req.trackerSettings || await loadTrackerSettings(req.trackerPool);
    let reboticsStatus = reboticsBridge.authStatusPayload();
    if (reboticsStatus.stale && reboticsStatus.ok) {
      await reboticsBridge.validateCurrentToken({ force: true });
      reboticsStatus = reboticsBridge.authStatusPayload();
    }
    return res.json({
      ok: true,
      auth: { email: req.user?.email || null, roles: req.user?.roles || [] },
      weeks,
      projects,
      districts: districtOptions(),
      defaults: {
        projects: DEFAULT_PROJECT_IDS,
      },
      trackerDefaults: settings || TRACKER_DEFAULTS,
      version: {
        commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
        startedAt: PROCESS_STARTED_AT,
      },
      sas: {
        active: sasBridge.isSessionAlive(),
      },
      rebotics: reboticsStatus,
    });
  });

  router.get('/snapshot', async (req, res) => {
    try {
      const result = await loadSnapshotRows(req.trackerPool, {
        workbookKind: String(req.query.workbookKind || '').trim(),
        setType: String(req.query.setType || '').trim() || undefined,
        store: String(req.query.store || '').trim() || undefined,
        periodWeek: String(req.query.periodWeek || '').trim() || undefined,
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(err.statusCode || 502).json({ ok: false, error: err.message });
    }
  });

  router.get('/projects', async (_req, res) => {
    const projects = await sasReports.discoverProjects();
    return res.json({ ok: true, projects });
  });

  router.post('/runs', async (req, res) => {
    const params = normalizeRunParams({
      ...(req.body || {}),
      includeOffScope: req.body?.includeOffScope ?? req.query.includeOffScope,
    });
    let range;
    try {
      range = resolveRange(params);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message, errorType: 'validation' });
    }
    const settings = req.trackerSettings || await loadTrackerSettings(pool);
    const effectiveProjectCount = params.projects.length
      ? params.projects.length
      : (await sasReports.discoverProjects()).filter((project) => Number.isFinite(Number(project.id))).length;
    if (!effectiveProjectCount) {
      return res.status(400).json({ ok: false, error: 'No SAS projects are available for full reconciliation.', errorType: 'validation' });
    }
    const guard = validateRunShape({ params, range, settings, effectiveProjectCount });
    if (!guard.ok) {
      return res.status(guard.status).json({ ok: false, error: guard.error, errorType: 'request_too_large' });
    }
    const runKey = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO tracker_runs (run_key, created_by_email, status, params_json, progress_json)
       VALUES ($1, $2, 'queued', $3::jsonb, $4::jsonb)
       RETURNING *`,
      [
        runKey,
        req.user?.email || 'unknown',
        JSON.stringify({
          ...params,
          stores: params.stores,
          districts: params.districts,
          projects: params.projects,
          includeOffScope: Boolean(settings.includeOffScope || params.includeOffScope),
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          guardWarnings: guard.warnings,
        }),
        JSON.stringify({
          stage: 'queued',
          progress: 0,
          stores: params.stores.length,
          dates: range.dates.length,
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          projects: effectiveProjectCount,
          workUnits: guard.workUnits,
          warnings: guard.warnings,
        }),
      ],
    );
    const run = rows[0];
    const controller = new AbortController();
    const p = processRun(pool, run, { signal: controller.signal });
    inFlightRuns.set(run.id, { promise: p, controller });
    return res.status(202).json({ ok: true, runId: run.id, runKey: run.run_key, warnings: guard.warnings });
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });

    const email = String(req.user?.email || '').trim().toLowerCase();
    const createdBy = String(run.created_by_email || '').trim().toLowerCase();
    const isAdmin = email && TRACKER_ADMIN_EMAILS.includes(email);
    if (!isAdmin && email !== createdBy) {
      return res.status(403).json({ ok: false, error: 'Only the run creator or a tracker admin can cancel this run.' });
    }

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return res.json({ ok: true, cancelled: run.status === 'cancelled', status: run.status });
    }

    const active = inFlightRuns.get(run.id);
    if (active?.controller && !active.controller.signal.aborted) {
      active.controller.abort(cancelledError(`Run cancelled by ${email || 'user'}`));
    }

    const currentProgress = run.progress_json || {};
    await updateRun(pool, run.id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      error_text: null,
      progress_json: JSON.stringify({
        ...currentProgress,
        stage: 'cancelled',
        progress: Math.max(Number(currentProgress.progress || 0), 100),
        message: 'Run cancelled.',
        errorType: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: email || null,
      }),
    });
    return res.json({ ok: true, cancelled: true, status: 'cancelled' });
  });

  router.get('/runs/:id', async (req, res) => {
    let run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    if (isStaleOrphanedRun(run)) {
      run = await markRunInterrupted(pool, run.id) || run;
    }
    return res.json({
      ok: true,
      run: {
        id: run.id,
        runKey: run.run_key,
        status: run.status,
        createdBy: run.created_by_email,
        createdAt: run.created_at,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        params: run.params_json || {},
        progress: run.progress_json || {},
        summary: run.summary_json || {},
        warnings: run.warnings_json || [],
        error: run.error_text || null,
      },
    });
  });

  router.get('/runs/:id/items', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const settings = await loadTrackerSettings(pool);
    const pageSizeDefault = settings.runItemsPageSizeDefault || 100;
    const pageSizeMax = settings.runItemsPageSizeMax || 500;
    const pageSize = Math.min(pageSizeMax, Math.max(1, parseInt(req.query.pageSize, 10) || pageSizeDefault));
    const offset = (page - 1) * pageSize;
    const confidence = String(req.query.confidence || '').trim();
    const status = String(req.query.status || '').trim();
    const store = String(req.query.store || '').trim();
    const search = String(req.query.search || '').trim();
    const sortParam = String(req.query.sort || 'store').trim();
    const orderParam = String(req.query.order || 'asc').trim().toLowerCase();
    const sortColumns = {
      store: 'store_number',
      date: 'work_date',
      dbkey: 'dbkey',
      category: 'category_set_label',
      confidence: 'confidence',
      prodPhotos: 'prod_photo_count',
      siPhotos: 'si_photo_count',
    };
    const sortColumn = sortColumns[sortParam] || sortColumns.store;
    const sortOrder = orderParam === 'desc' ? 'DESC' : 'ASC';

    const where = ['run_id = $1'];
    const params = [run.id];
    if (confidence) {
      params.push(confidence);
      where.push(`confidence = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`COALESCE(row_state, 'legacy') = $${params.length}`);
    }
    if (store) {
      params.push(String(parseInt(store, 10)));
      where.push(`store_number = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(dbkey ILIKE $${params.length} OR category_set_label ILIKE $${params.length} OR project_name ILIKE $${params.length})`);
    }

    const whereSql = where.join(' AND ');
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM tracker_run_items WHERE ${whereSql}`, params);
    params.push(pageSize);
    params.push(offset);
    const itemsResult = await pool.query(
      `SELECT * FROM tracker_run_items
       WHERE ${whereSql}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, store_number, work_date, dbkey
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const items = itemsResult.rows.map((item) => ({
      ...item,
      row_state: item.row_state || 'legacy',
      reason: item.reason || item.notes || null,
      comparisonStatus: item.row_state || 'legacy',
    }));
    return res.json({
      ok: true,
      page,
      pageSize,
      total: countResult.rows[0].total,
      items,
    });
  });

  router.post('/auth/rebotics/refresh', async (_req, res) => {
    try {
      const result = await reboticsBridge.ensureFreshAuth('manual:/api/trackers/auth/rebotics/refresh');
      if (result?.ok === false) {
        return res.status(502).json({ ok: false, error: result.error, errorType: 'auth' });
      }
      return res.json({
        ok: true,
        message: result.message,
        rebotics: result.status || reboticsBridge.authStatusPayload(),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message, errorType: 'auth' });
    }
  });

  router.get('/runs/:id/images', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const itemId = req.query.itemId ? parseInt(req.query.itemId, 10) : null;
    const rows = itemId
      ? (await pool.query(
        `SELECT id, item_id, source_system, image_role, source_ref, action_id, bay_index, captured_at
         FROM tracker_run_images
         WHERE run_id = $1 AND item_id = $2
         ORDER BY source_system, bay_index NULLS LAST, id`,
        [run.id, itemId],
      )).rows
      : (await pool.query(
        `SELECT id, item_id, source_system, image_role, source_ref, action_id, bay_index, captured_at
         FROM tracker_run_images
         WHERE run_id = $1
         ORDER BY item_id, source_system, bay_index NULLS LAST, id`,
        [run.id],
      )).rows;
    const images = rows.map((r) => ({
      ...r,
      stream_url: `/api/trackers/images/${r.id}`,
    }));
    return res.json({ ok: true, images });
  });

  router.get('/runs/:id/manifest.json', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const { rows } = await pool.query(
      `SELECT
        store_number AS store,
        work_date,
        period_week,
        project_id,
        project_name,
        dbkey,
        pog,
        category_set_label,
        prod_status AS "PROD_status",
        si_status AS "SI_status",
        prod_photo_count,
        si_photo_count,
        confidence,
        notes,
        COALESCE(expectation, 'in_project_scope') AS expectation,
        COALESCE(prod_presence_state, prod_status, 'absent') AS prod_presence_state,
        COALESCE(si_presence_state, si_status, 'absent') AS si_presence_state,
        COALESCE(row_state, 'legacy') AS row_state,
        COALESCE(reason, notes) AS reason
       FROM tracker_run_items
       WHERE run_id = $1
       ORDER BY store_number, work_date, dbkey`,
      [run.id],
    );
    return res.json({
      runId: run.id,
      runKey: run.run_key,
      generatedAt: new Date().toISOString(),
      rows,
    });
  });

  router.get('/runs/:id/manifest.csv', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    const { rows } = await pool.query(
      `SELECT
        store_number AS store,
        work_date,
        period_week,
        project_id,
        project_name,
        dbkey,
        pog,
        category_set_label,
        prod_status AS "PROD_status",
        si_status AS "SI_status",
        prod_photo_count,
        si_photo_count,
        confidence,
        notes,
        COALESCE(expectation, 'in_project_scope') AS expectation,
        COALESCE(prod_presence_state, prod_status, 'absent') AS prod_presence_state,
        COALESCE(si_presence_state, si_status, 'absent') AS si_presence_state,
        COALESCE(row_state, 'legacy') AS row_state,
        COALESCE(reason, notes) AS reason
       FROM tracker_run_items
       WHERE run_id = $1
       ORDER BY store_number, work_date, dbkey`,
      [run.id],
    );
    const csv = jsonToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracker-run-${run.id}.csv"`);
    return res.send(csv);
  });

  router.get('/images/:imageId', async (req, res) => {
    const imageId = parseInt(req.params.imageId, 10);
    if (!Number.isFinite(imageId)) return res.status(400).json({ ok: false, error: 'Invalid image id' });
    const { rows } = await pool.query('SELECT * FROM tracker_run_images WHERE id = $1', [imageId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Image not found' });
    const image = rows[0];
    try {
      let sourceUrl = image.source_url;
      if (image.source_system === 'si') {
        if (!image.action_id) throw new Error('Missing action_id for SI image');
        const action = await fetchReboticsAction(image.action_id);
        sourceUrl = action?.merged_image;
      }
      if (!sourceUrl) throw new Error('Image source URL unavailable');
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
      const buf = Buffer.from(await response.arrayBuffer());
      return res.send(buf);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  });

  router.get('/admin/settings', requireTrackerAdmin, async (req, res) => {
    const settings = await loadTrackerSettings(pool);
    return res.json({
      ok: true,
      auth: { email: req.user?.email || null },
      settings,
      defaults: TRACKER_DEFAULTS,
      adminEmails: TRACKER_ADMIN_EMAILS,
    });
  });

  router.put('/admin/settings', requireTrackerAdmin, async (req, res) => {
    const settingsInput = req.body?.settings || {};
    const settings = await saveTrackerSettings(pool, settingsInput, req.user?.email || null);
    return res.json({
      ok: true,
      settings,
      updatedAt: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = {
  createTrackersRouter,
};
