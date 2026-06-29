#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { writeFileVersioned } = require('../src/lib/file-utils');

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const DEFAULT_MANIFEST = 'C:/Users/tgaut/eod-api/output/rebotics-photo-recovery/store-391_dbkey-9032258_2026-06-16T02-00-13-608Z/manifest.json';
const DEFAULT_OUT_ROOT = 'output/rebotics-scheduled-closeout';

const REJECT_REASON = 'Image not Ideal';
const ACCEPT_REASON = 'On Shelf - UPC Confirmed';
const REMOVE_REASON = 'Removed Item';
const MOVE_REASON = 'Moved Item';

function parseArgs(argv) {
  const opts = {
    apply: false,
    taskId: 39278330,
    manifest: DEFAULT_MANIFEST,
    outDir: path.join(DEFAULT_OUT_ROOT, `store-391_dbkey-9032258_${new Date().toISOString().replace(/[:.]/g, '-')}`),
    waitMs: 300000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--task') opts.taskId = Number(argv[++i]);
    else if (arg === '--manifest') opts.manifest = argv[++i];
    else if (arg === '--out') opts.outDir = argv[++i];
    else if (arg === '--wait-ms') opts.waitMs = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/close-rebotics-recovered-task.js [--apply]',
        '  [--task 39278330] [--manifest path/to/recovered/manifest.json]',
        'Dry-run is the default. Use --apply for live upload and closeout.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

function loadEnv() {
  const envPath = path.join(REBOTICS_ROOT, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

function loadApi() {
  loadEnv();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REBOTICS_ROOT, 'lib', 'rebotics-api'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDoneReport(report) {
  return Boolean(report?.id) && String(report.status || '').toLowerCase() === 'done' && !report.rejected && !report.error;
}

function captureSections(capture) {
  const sections = [];
  for (const row of capture?.results || []) {
    let fallbackBay = 1;
    for (const section of row.sections || []) {
      const bay = Number(section.name ?? section.section_info?.name ?? section.original_name ?? fallbackBay);
      sections.push({
        bay: Number.isFinite(bay) ? bay : fallbackBay,
        sectionId: section.id,
        categoryId: row.category?.id,
        report: section.report || null,
      });
      fallbackBay += 1;
    }
  }
  sections.sort((a, b) => a.bay - b.bay);
  return sections;
}

function allSectionsDone(sections) {
  return sections.length > 0 && sections.every((section) => isDoneReport(section.report));
}

function acceptGroupId(action) {
  if (action.to && String(action.to).includes(':')) {
    const [shelf] = String(action.to).split(':');
    if (Number(shelf) === action.from_shelf) return `${shelf} - ${action.from_position_unique}`;
  }
  return String(action.group_id || `${action.from_shelf} - ${action.from_position_unique}`);
}

function correctionPayload(action) {
  if (action.action === 'ACTION_IDENTIFY') {
    return {
      action: action.action,
      group_id: String(action.group_id),
      id: action.id,
      reason: REJECT_REASON,
      source_id: action.source_id,
      state: 'STATE_REJECTED',
      status: 'unidentified',
    };
  }
  const reasonByAction = {
    ACTION_ADD: ACCEPT_REASON,
    ACTION_REMOVE: REMOVE_REASON,
    ACTION_MOVE: MOVE_REASON,
  };
  return {
    action: action.action,
    group_id: action.action === 'ACTION_ADD' ? acceptGroupId(action) : String(action.group_id),
    id: action.id,
    plu: action.plu,
    reason: reasonByAction[action.action] || ACCEPT_REASON,
    source_id: action.source_id,
    state: 'STATE_ACCEPTED',
    status: 'ok',
  };
}

function loadRecoveredPhotos(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const byBay = new Map();
  for (const row of manifest.recovered || []) {
    const bay = Number(row.sectionName);
    if (!Number.isFinite(bay)) continue;
    if (!fs.existsSync(row.path)) throw new Error(`Recovered photo missing: ${row.path}`);
    byBay.set(bay, row.path);
  }
  return { manifest, byBay };
}

async function getCapture(api, token, taskId) {
  return api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
}

async function deleteExistingReports(api, token, taskId, sections) {
  const reportIds = [...new Set(sections.map((section) => section.report?.id).filter(Boolean))];
  for (const reportId of reportIds) {
    await api.reboticsJson(token, 'DELETE', `/api/v1/tasks/${taskId}/processing/actions/${reportId}/`);
    await sleep(300);
  }
  if (reportIds.length) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/tasks/${taskId}/`, { scan_status: null });
  }
  return reportIds;
}

async function uploadPhotos({ api, token, task, sections, photosByBay, dryRun }) {
  const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
  const storeId = task.store?.id;
  if (!storePlanogramId || !storeId) throw new Error(`Task ${task.id} missing store_planogram_id or store.id`);

  const missing = sections.filter((section) => !photosByBay.has(section.bay)).map((section) => section.bay);
  if (missing.length) throw new Error(`Missing recovered photos for bay(s): ${missing.join(', ')}`);
  if (dryRun) {
    return sections.map((section) => ({ bay: section.bay, sectionId: section.sectionId, path: photosByBay.get(section.bay), dryRun: true }));
  }

  const uploaded = [];
  for (const section of sections) {
    const photoPath = photosByBay.get(section.bay);
    const fileBuffer = await fsp.readFile(photoPath);
    const result = await api.uploadAndAttachPhoto({
      token,
      filename: path.basename(photoPath),
      fileBuffer,
      mimeType: 'image/jpeg',
      attach: {
        category_id: section.categoryId,
        section_id: section.sectionId,
        sequence_number: section.bay - 1,
        store: storeId,
        store_planogram: storePlanogramId,
        task_id: task.id,
      },
    });
    uploaded.push({ bay: section.bay, sectionId: section.sectionId, path: photoPath, ...result });
    await sleep(600);
  }
  return uploaded;
}

async function waitForDoneSections(api, token, taskId, timeoutMs) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    const capture = await getCapture(api, token, taskId);
    const sections = captureSections(capture);
    last = sections.map((section) => ({
      bay: section.bay,
      sectionId: section.sectionId,
      reportId: section.report?.id || null,
      status: section.report?.status || 'none',
      rejected: Boolean(section.report?.rejected),
      error: section.report?.error || null,
    }));
    if (allSectionsDone(sections)) return { ok: true, sections: last };
    if (last.some((section) => section.rejected || section.status === 'rejected' || section.status === 'error')) {
      return { ok: false, reason: 'rejected-or-error', last };
    }
    await sleep(20000);
  }
  return { ok: false, reason: 'timeout', last };
}

async function clearTaskActions(api, token, taskId, dryRun) {
  const capture = await getCapture(api, token, taskId);
  const reports = captureSections(capture)
    .map((section) => section.report)
    .filter((report) => isDoneReport(report));
  const counts = { identify: 0, add: 0, remove: 0, move: 0 };
  let idleRemaining = 0;

  for (const report of reports) {
    const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
    const idle = (detail.report_actions || []).filter((action) => action.state === 'STATE_IDLE');
    for (const action of idle) {
      if (action.action === 'ACTION_IDENTIFY') counts.identify += 1;
      else if (action.action === 'ACTION_ADD') counts.add += 1;
      else if (action.action === 'ACTION_REMOVE') counts.remove += 1;
      else if (action.action === 'ACTION_MOVE') counts.move += 1;
    }
    const payload = idle.map(correctionPayload);
    if (payload.length && !dryRun) {
      await api.reboticsJson(token, 'PATCH', `/api/v4/processing/actions/${report.id}/update_actions/`, payload);
    }
  }

  if (!dryRun) {
    for (const report of reports) {
      const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
      idleRemaining += (detail.report_actions || []).filter((action) => action.state === 'STATE_IDLE').length;
    }
  }

  return { reports: reports.length, counts, idleRemaining };
}

function findBaysSurveyItem(survey) {
  return (survey?.items || []).find((item) => /how many bays\/doors/i.test(String(item.title || item.text || '')));
}

async function submitSurveyZero(api, token, task, dryRun) {
  const surveyId = task?.survey?.id;
  const responseId = task?.result?.survey_response?.id;
  if (!surveyId || !responseId) return { skipped: 'no survey response' };
  const response = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/responses/${responseId}/`);
  if (response?.is_completed && (response.answers || []).length) return { alreadyAnswered: true };
  if (!response?.start_time && !dryRun) {
    await api.reboticsJson(token, 'PUT', `/api/v1/surveys/${surveyId}/responses/${responseId}/start/`);
  }
  const survey = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/`);
  const item = findBaysSurveyItem(survey);
  if (!item?.id) throw new Error(`No bays/doors survey item found on survey ${surveyId}`);
  if (!dryRun) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/surveys/${surveyId}/responses/${responseId}/`, {
      answers: [{ item: item.id, answer: '0' }],
    });
  }
  return { item: item.id, answer: '0' };
}

async function main() {
  const opts = parseArgs(process.argv);
  const outDir = path.resolve(opts.outDir);
  await fsp.mkdir(outDir, { recursive: true });

  const api = loadApi();
  const auth = await api.fetchTokenFromRailway();
  const token = auth.token;
  const userId = auth.userId || api.DEFAULT_USER_ID || 211;
  const dryRun = !opts.apply;
  const { manifest, byBay } = loadRecoveredPhotos(opts.manifest);

  const summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    taskId: opts.taskId,
    store: manifest.store || '391',
    dbkey: manifest.dbkey || '9032258',
    manifest: opts.manifest,
    outDir,
    auth: auth.username || userId,
    startedAt: new Date().toISOString(),
    steps: [],
    errors: [],
  };

  try {
    let task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${opts.taskId}/`);
    summary.initialTask = {
      status: task.status?.id || null,
      reason: task.status_reason || '',
      scanStatus: task.scan_status || null,
      actionsCount: task.actions_count || null,
      title: task.title || task.task_def?.title || '',
    };
    console.log(`${dryRun ? '[DRY RUN]' : '[APPLY]'} close recovered task ${opts.taskId}: ${summary.initialTask.title}`);
    if (task.status?.id === 'completed') {
      summary.result = { status: 'already-completed' };
      return;
    }

    if (!dryRun) {
      await api.openShift(token, task.store.id, userId);
      if (task.status?.id !== 'in_progress') {
        await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${opts.taskId}/`, { status: 'in_progress' });
      }
      task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${opts.taskId}/`);
    }

    let capture = await getCapture(api, token, opts.taskId);
    let sections = captureSections(capture);
    summary.sectionsBefore = sections.map((section) => ({
      bay: section.bay,
      sectionId: section.sectionId,
      categoryId: section.categoryId,
      reportId: section.report?.id || null,
      reportStatus: section.report?.status || null,
    }));

    let upload = { skipped: 'sections already done' };
    if (!allSectionsDone(sections)) {
      const deletedReports = dryRun ? [] : await deleteExistingReports(api, token, opts.taskId, sections);
      if (deletedReports.length) summary.steps.push({ deletedReports });
      if (!dryRun && deletedReports.length) {
        capture = await getCapture(api, token, opts.taskId);
        sections = captureSections(capture);
      }
      upload = await uploadPhotos({ api, token, task, sections, photosByBay: byBay, dryRun });
      summary.steps.push({ upload });
      const wait = dryRun ? { ok: true, dryRun: true } : await waitForDoneSections(api, token, opts.taskId, opts.waitMs);
      summary.steps.push({ wait });
      if (!wait.ok) throw new Error(`CV wait failed: ${wait.reason}`);
    }

    const corrections = await clearTaskActions(api, token, opts.taskId, dryRun);
    summary.steps.push({ corrections });
    task = dryRun ? task : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${opts.taskId}/`);
    const survey = await submitSurveyZero(api, token, task, dryRun);
    summary.steps.push({ survey });
    if (!dryRun) {
      await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${opts.taskId}/`, { status: 'completed' });
    }
    const finalTask = dryRun ? task : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${opts.taskId}/`);
    summary.result = {
      status: dryRun ? 'would-complete' : 'completed',
      upload,
      finalStatus: finalTask.status?.id || null,
      finalScanStatus: finalTask.scan_status || null,
      finalActionsCount: finalTask.actions_count || null,
    };
    console.log(`${summary.result.status}: final=${summary.result.finalStatus} scan=${summary.result.finalScanStatus}`);
  } catch (error) {
    summary.errors.push({ error: error.message, body: error.body || null });
    console.log(`ERROR: ${error.message}`);
    process.exitCode = 1;
  } finally {
    summary.finishedAt = new Date().toISOString();
    const summaryPath = await writeFileVersioned(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`summary: ${summaryPath}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
