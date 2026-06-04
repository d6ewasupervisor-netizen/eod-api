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
const { compareRows } = require('../lib/trackers/compare');
const {
  DEFAULTS: TRACKER_DEFAULTS,
  trackerAdminEmails,
  loadTrackerSettings,
  saveTrackerSettings,
  isTrackerUserAllowed,
} = require('../lib/trackers/settings');

const inFlightRuns = new Map();
const TRACKER_ADMIN_EMAILS = trackerAdminEmails();

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
    .map((n) => String(n));
}

function normalizeProjects(projects) {
  return (Array.isArray(projects) ? projects : String(projects || '').split(','))
    .map((p) => parseInt(String(p).trim(), 10))
    .filter((n) => Number.isFinite(n));
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

async function loadRun(pool, idOrKey) {
  const asInt = parseInt(String(idOrKey), 10);
  if (Number.isFinite(asInt) && String(asInt) === String(idOrKey)) {
    const { rows } = await pool.query('SELECT * FROM tracker_runs WHERE id = $1', [asInt]);
    return rows[0] || null;
  }
  const { rows } = await pool.query('SELECT * FROM tracker_runs WHERE run_key = $1', [String(idOrKey)]);
  return rows[0] || null;
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
        prod_status, si_status, prod_photo_count, si_photo_count, confidence, notes, source_refs_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb
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
      ],
    );
    const itemId = rows[0].id;
    const key = `${item.storeNumber || ''}|${item.dbkey || ''}|${item.workDate || ''}`;
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

async function processRun(pool, run) {
  const warnings = [];
  try {
    await updateRun(pool, run.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      progress_json: JSON.stringify({ stage: 'starting', progress: 0 }),
    });

    const params = run.params_json || {};
    const range = resolveRange(params);
    const stores = normalizeStores(params.stores);
    const projects = normalizeProjects(params.projects);
    const settings = await loadTrackerSettings(pool);
    if (!stores.length) throw new Error('At least one store is required');

    await updateRun(pool, run.id, {
      progress_json: JSON.stringify({ stage: 'pulling_prod', progress: 20 }),
    });

    const [prodResult, siResult] = await Promise.allSettled([
      sasReports.fetchRows({
        stores,
        projects,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
      }),
      reboticsReports.fetchRows({
        stores,
        dates: range.dates,
        settings,
      }),
    ]);

    let prodRows = [];
    let siRows = [];
    if (prodResult.status === 'fulfilled') prodRows = prodResult.value;
    else warnings.push(`SAS pull failed: ${prodResult.reason?.message || String(prodResult.reason)}`);
    if (siResult.status === 'fulfilled') siRows = siResult.value;
    else warnings.push(`Rebotics pull failed: ${siResult.reason?.message || String(siResult.reason)}`);
    if (!prodRows.length && !siRows.length) {
      throw new Error('Both SAS and Rebotics pulls failed; no rows to compare.');
    }

    await updateRun(pool, run.id, {
      progress_json: JSON.stringify({
        stage: 'comparing',
        progress: 70,
        prodRows: prodRows.length,
        siRows: siRows.length,
      }),
    });

    const compared = compareRows(prodRows, siRows);
    await insertRunResults(pool, run.id, compared);

    await updateRun(pool, run.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      warnings_json: JSON.stringify(warnings),
      summary_json: JSON.stringify({
        ...compared.summary,
        prodRows: prodRows.length,
        siRows: siRows.length,
      }),
      progress_json: JSON.stringify({ stage: 'done', progress: 100 }),
    });
  } catch (err) {
    await updateRun(pool, run.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      warnings_json: JSON.stringify(warnings),
      error_text: err.message,
      progress_json: JSON.stringify({ stage: 'failed', progress: 100, error: err.message }),
    });
  } finally {
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

function createTrackersRouter({ pool }) {
  const router = express.Router();
  router.use((req, _res, next) => {
    req.trackerPool = pool;
    next();
  });
  router.use(requireAuth);
  router.use(requireTrackerAccess);

  router.get('/bootstrap', async (req, res) => {
    const weeks = buildWeeks();
    const projects = await sasReports.discoverProjects();
    return res.json({
      ok: true,
      auth: { email: req.user?.email || null, roles: req.user?.roles || [] },
      weeks,
      projects,
      defaults: {
        projects: sasReports.DEFAULT_PROJECT_IDS,
      },
      trackerDefaults: TRACKER_DEFAULTS,
      sas: {
        active: sasBridge.isSessionAlive(),
      },
      rebotics: reboticsBridge.authStatusPayload(),
    });
  });

  router.get('/projects', async (_req, res) => {
    const projects = await sasReports.discoverProjects();
    return res.json({ ok: true, projects });
  });

  router.post('/runs', async (req, res) => {
    const params = req.body || {};
    const stores = normalizeStores(params.stores);
    if (!stores.length) {
      return res.status(400).json({ ok: false, error: 'stores is required' });
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
          stores,
          projects: normalizeProjects(params.projects),
        }),
        JSON.stringify({ stage: 'queued', progress: 0 }),
      ],
    );
    const run = rows[0];
    const p = processRun(pool, run);
    inFlightRuns.set(run.id, p);
    return res.status(202).json({ ok: true, runId: run.id, runKey: run.run_key });
  });

  router.get('/runs/:id', async (req, res) => {
    const run = await loadRun(pool, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
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
    const search = String(req.query.search || '').trim();

    const where = ['run_id = $1'];
    const params = [run.id];
    if (confidence) {
      params.push(confidence);
      where.push(`confidence = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`(prod_status = $${params.length} OR si_status = $${params.length})`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(dbkey ILIKE $${params.length} OR category_set_label ILIKE $${params.length})`);
    }

    const whereSql = where.join(' AND ');
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM tracker_run_items WHERE ${whereSql}`, params);
    params.push(pageSize);
    params.push(offset);
    const itemsResult = await pool.query(
      `SELECT * FROM tracker_run_items WHERE ${whereSql} ORDER BY store_number, work_date, dbkey LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.json({
      ok: true,
      page,
      pageSize,
      total: countResult.rows[0].total,
      items: itemsResult.rows,
    });
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
        notes
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
        notes
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
        const action = await reboticsReports.fetchJson(`/api/v4/processing/actions/${image.action_id}/`);
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
