#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  buildApplyScope,
  assertApplyScopeConfirmed,
  assertStoreInScope,
  scopeSummary,
} = require('../src/lib/trackers/apply-scope');

const REBOTICS_ROOT = 'C:/Users/tgaut/rebotics-carry-forward';
const DEFAULT_BLURRY_PATH = 'C:/Users/tgaut/eod-api/output/tracker-prod-to-si-reconcile/blurry.jpg';
const DEFAULT_TARGETS = [
  { store: '286', dbkeys: ['8841496', '8841499'] },
  { store: '351', dbkeys: ['9009215', '9002223', '8920134', '8841499'] },
];

const REJECT_REASON = 'Image not Ideal';
const ACCEPT_REASON = 'On Shelf - UPC Confirmed';
const REMOVE_REASON = 'Removed Item';
const MOVE_REASON = 'Moved Item';

function parseArgs(argv) {
  const out = {
    apply: false,
    date: new Date().toISOString().slice(0, 10),
    districts: [],
    confirmScope: null,
    blurryPath: DEFAULT_BLURRY_PATH,
    outDir: path.join('output', 'tracker-prod-to-si-reconcile', new Date().toISOString().replace(/[:.]/g, '-')),
    targets: DEFAULT_TARGETS,
    releaseTargets: [],
    targetsExplicit: false,
    releaseTargetsExplicit: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--date') out.date = argv[++i];
    else if (arg === '--districts') out.districts = argv[++i].split(',').map((v) => Number(v.trim())).filter(Boolean);
    else if (arg === '--confirm-scope') out.confirmScope = argv[++i];
    else if (arg === '--blurry-path') out.blurryPath = argv[++i];
    else if (arg === '--out') out.outDir = argv[++i];
    else if (arg === '--targets') {
      out.targets = parseTargets(argv[++i]);
      out.targetsExplicit = true;
    } else if (arg === '--release-targets') {
      out.releaseTargets = parseTargets(argv[++i]);
      out.releaseTargetsExplicit = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/close-rebotics-blurry-targets.js [--apply]',
        '  [--date YYYY-MM-DD] [--districts 6] [--confirm-scope D6] [--blurry-path image.jpg]',
        '  [--targets "286:8841496,8841499;351:9009215,9002223"]',
        '  [--release-targets "391:9032258"]',
        '',
        'Dry-run is the default. Built-in D6 demo targets are dry-run only.',
        'Live --apply requires explicit --targets, --districts, and --confirm-scope.',
        '--release-targets deletes task scan photos, resets scan_status, and moves tasks back to incomplete.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

function parseTargets(raw) {
  return String(raw || '').split(';').map((chunk) => {
    const [store, keys] = chunk.split(':');
    return {
      store: String(Number(store)),
      dbkeys: String(keys || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
  }).filter((target) => target.store !== 'NaN' && target.dbkeys.length);
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

function taskTitle(task) {
  return String(task?.title || task?.task_def?.title || '');
}

function dbkeyFromTask(task) {
  const planogramKey = task?.planograms?.[0]?.custom_id;
  if (planogramKey && /^\d{6,10}$/.test(String(planogramKey))) return String(planogramKey);
  const match = taskTitle(task).match(/\b(\d{7,8})\b/);
  return match ? match[1] : '';
}

function rankTask(task) {
  const rank = { in_progress: 0, created: 1, incomplete: 2, completed: 3 };
  return rank[task?.status?.id] ?? 9;
}

function nearbyTaskHints(tasks, dbkey) {
  const prefix = String(dbkey || '').slice(0, 3);
  return tasks
    .filter((task) => {
      const title = taskTitle(task);
      return (prefix && title.includes(prefix)) || /CHECKLANE/i.test(title);
    })
    .slice(0, 12)
    .map((task) => ({
      taskId: task.id,
      status: task.status?.id || null,
      scanStatus: task.scan_status || null,
      dbkey: dbkeyFromTask(task),
      title: taskTitle(task),
    }));
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
        prePhotoId: section.pre_photo?.id || null,
      });
      fallbackBay += 1;
    }
  }
  sections.sort((a, b) => a.bay - b.bay);
  return sections;
}

function sectionsNeedingCapture(sections, { forceAll = false } = {}) {
  return sections.filter((section) => forceAll || !isDoneReport(section.report));
}

function allSectionsReady(sections) {
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

async function getCapture(api, token, taskId) {
  return api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
}

async function deleteProblemReports(api, token, taskId, sections, { forceAll = false } = {}) {
  const deleted = [];
  for (const section of sectionsNeedingCapture(sections, { forceAll })) {
    if (!section.report?.id) continue;
    await api.reboticsJson(token, 'DELETE', `/api/v1/tasks/${taskId}/processing/actions/${section.report.id}/`);
    deleted.push(section.report.id);
  }
  if (deleted.length) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/tasks/${taskId}/`, { scan_status: null });
  }
  return deleted;
}

async function deleteAllReports(api, token, taskId, dryRun) {
  const capture = await getCapture(api, token, taskId);
  const sections = captureSections(capture);
  const reportIds = [...new Set(sections.map((section) => section.report?.id).filter(Boolean))];
  if (dryRun) return { reportIds, deleted: 0, dryRun: true };
  for (const reportId of reportIds) {
    await api.reboticsJson(token, 'DELETE', `/api/v1/tasks/${taskId}/processing/actions/${reportId}/`);
    await sleep(300);
  }
  if (reportIds.length) {
    await api.reboticsJson(token, 'PATCH', `/api/v1/tasks/${taskId}/`, { scan_status: null });
  }
  return { reportIds, deleted: reportIds.length };
}

async function uploadBlurryPhotos({ api, token, task, blurryPath, forceAll = false, dryRun }) {
  const capture = await getCapture(api, token, task.id);
  const sections = captureSections(capture);
  const targets = sectionsNeedingCapture(sections, { forceAll });
  if (!targets.length) return { ok: true, uploaded: 0, skipped: 'sections already ready' };
  if (!fs.existsSync(blurryPath)) return { ok: false, reason: `blurry photo path not found: ${blurryPath}` };
  if (dryRun) return { ok: true, dryRun: true, uploaded: targets.length, targets };

  const storePlanogramId = task.planograms?.[0]?.store_planogram_id;
  const storeId = task.store?.id;
  if (!storePlanogramId || !storeId) throw new Error(`Task ${task.id} missing store_planogram_id or store.id`);

  const deletedReports = await deleteProblemReports(api, token, task.id, sections, { forceAll });
  const fileBuffer = await fsp.readFile(blurryPath);
  const uploaded = [];
  for (const section of targets) {
    if (!section.categoryId || !section.sectionId) throw new Error(`Task ${task.id} missing section/category id for bay ${section.bay}`);
    const result = await api.uploadAndAttachPhoto({
      token,
      filename: `blurry_${task.id}_bay-${String(section.bay).padStart(2, '0')}.jpg`,
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
    uploaded.push({ bay: section.bay, sectionId: section.sectionId, ...result });
    await sleep(600);
  }
  return { ok: true, uploaded: uploaded.length, uploadedSections: uploaded, deletedReports };
}

async function waitForDoneSections(api, token, taskId, timeoutMs = 300000) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    const capture = await getCapture(api, token, taskId);
    const sections = captureSections(capture);
    last = sections.map((section) => ({
      bay: section.bay,
      sectionId: section.sectionId,
      prePhotoId: section.prePhotoId,
      reportId: section.report?.id || null,
      status: section.report?.status || 'none',
      rejected: Boolean(section.report?.rejected),
      error: section.report?.error || null,
    }));
    if (allSectionsReady(sections)) return { ok: true, sections: last };
    if (last.some((section) => section.rejected || section.status === 'rejected' || section.status === 'error')) {
      return { ok: false, reason: 'rejected-or-error', last };
    }
    await sleep(20000);
  }
  return { ok: false, reason: 'timeout', last };
}

async function clearTaskActions(api, token, taskId, dryRun) {
  const capture = await getCapture(api, token, taskId);
  const sections = captureSections(capture);
  const reports = sections.map((section) => section.report).filter((report) => isDoneReport(report));
  const counts = { identify: 0, add: 0, remove: 0, move: 0 };
  let idleRemaining = 0;

  for (const report of reports) {
    const detail = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
    const idle = (detail.report_actions || []).filter((action) => action.state === 'STATE_IDLE');
    const payload = idle.map(correctionPayload);
    for (const action of idle) {
      if (action.action === 'ACTION_IDENTIFY') counts.identify += 1;
      else if (action.action === 'ACTION_ADD') counts.add += 1;
      else if (action.action === 'ACTION_REMOVE') counts.remove += 1;
      else if (action.action === 'ACTION_MOVE') counts.move += 1;
    }
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

async function closeTarget({ api, token, task, blurryPath, dryRun }) {
  if (task.status?.id === 'completed') return { status: 'already-completed' };

  let liveTask = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${task.id}/`);
  const forceAll = String(liveTask.scan_status || '').toUpperCase() === 'REJECTED';
  if (!dryRun && liveTask.status?.id !== 'in_progress') {
    await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${task.id}/`, { status: 'in_progress' });
    liveTask = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${task.id}/`);
  }

  const capture = await getCapture(api, token, task.id);
  const sections = captureSections(capture);
  let upload = { skipped: 'sections already ready' };
  if (!allSectionsReady(sections) || forceAll) {
    upload = await uploadBlurryPhotos({ api, token, task: liveTask, blurryPath, forceAll, dryRun });
    if (!upload.ok) return { status: 'skip', reason: upload.reason, upload };
    const wait = dryRun ? { ok: true, dryRun: true } : await waitForDoneSections(api, token, task.id);
    if (!wait.ok) return { status: 'skip', reason: `CV wait failed: ${wait.reason}`, upload, wait };
  }

  const corrections = await clearTaskActions(api, token, task.id, dryRun);
  const refreshedTask = dryRun ? liveTask : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${task.id}/`);
  const survey = await submitSurveyZero(api, token, refreshedTask, dryRun);
  if (!dryRun) {
    await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${task.id}/`, { status: 'completed' });
  }
  const finalTask = dryRun ? refreshedTask : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${task.id}/`);
  return {
    status: dryRun ? 'would-complete' : 'completed',
    upload,
    corrections,
    survey,
    finalStatus: finalTask.status?.id || null,
    finalScanStatus: finalTask.scan_status || null,
    finalActionsCount: finalTask.actions_count || null,
  };
}

async function releaseTarget({ api, token, task, dryRun }) {
  const liveTask = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${task.id}/`);
  if (liveTask.status?.id === 'completed') return { status: 'skip', reason: 'task already completed' };
  const deletion = await deleteAllReports(api, token, liveTask.id, dryRun);
  if (!dryRun) {
    await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${liveTask.id}/`, {
      status: 'incomplete',
      status_reason: liveTask.status_reason || 'Backlog - Revisit Needed',
    });
  }
  const finalTask = dryRun ? liveTask : await api.reboticsJson(token, 'GET', `/api/v1/tasks/${liveTask.id}/`);
  return {
    status: dryRun ? 'would-release' : 'released',
    deletion,
    finalStatus: finalTask.status?.id || null,
    finalReason: finalTask.status_reason || '',
    finalScanStatus: finalTask.scan_status || null,
    finalActionsCount: finalTask.actions_count || null,
  };
}

async function processTargetGroups({ api, token, opts, groups, summary, mode, handler, scope }) {
  for (const target of groups) {
    try {
      assertStoreInScope(scope, target.store, `${mode} target dbkeys ${target.dbkeys.join(',')}`);
    } catch (error) {
      summary.errors.push({ store: target.store, mode, stage: 'scope', error: error.message });
      console.log(`store ${target.store} ERROR scope: ${error.message}`);
      continue;
    }
    const customId = api.fmStoreToCustomId(target.store);
    let storeId = null;
    let tasks = [];
    try {
      storeId = await api.resolveStoreInternalId(token, customId, { date: opts.date });
      tasks = await api.listTasksForStoreAndDate(token, storeId, opts.date);
    } catch (error) {
      summary.errors.push({ store: target.store, mode, stage: 'list-tasks', error: error.message, body: error.body || null });
      console.log(`store ${target.store} ERROR list-tasks: ${error.message}`);
      continue;
    }

    console.log(`\n${mode} store ${target.store} ${customId} internal=${storeId} tasks=${tasks.length}`);
    for (const dbkey of target.dbkeys) {
      const hits = tasks
        .filter((task) => dbkeyFromTask(task) === dbkey || taskTitle(task).includes(dbkey))
        .sort((a, b) => rankTask(a) - rankTask(b));
      if (!hits.length) {
        const nearby = nearbyTaskHints(tasks, dbkey);
        summary.skipped.push({ store: target.store, dbkey, mode, reason: 'no live task-layer match', nearby });
        console.log(`  dbkey ${dbkey}: skip no live task-layer match`);
        for (const hint of nearby) {
          console.log(`    nearby: task=${hint.taskId} status=${hint.status} scan=${hint.scanStatus || 'null'} dbkey=${hint.dbkey} ${hint.title}`);
        }
        continue;
      }
      if (hits.length > 1 && rankTask(hits[0]) === rankTask(hits[1]) && hits[0].status?.id !== 'completed') {
        summary.skipped.push({
          store: target.store,
          dbkey,
          mode,
          reason: 'ambiguous live task matches',
          matches: hits.map((task) => ({ taskId: task.id, status: task.status?.id, title: taskTitle(task) })),
        });
        console.log(`  dbkey ${dbkey}: skip ambiguous active matches ${hits.map((task) => task.id).join(', ')}`);
        continue;
      }

      const task = hits[0];
      const row = {
        mode,
        store: target.store,
        customId,
        storeId,
        dbkey,
        taskId: task.id,
        status: task.status?.id || null,
        reason: task.status_reason || '',
        scanStatus: task.scan_status || null,
        actionsCount: task.actions_count || null,
        title: taskTitle(task),
      };
      summary.matched.push(row);
      console.log(`  dbkey ${dbkey}: task=${task.id} status=${row.status} scan=${row.scanStatus || 'null'} ${row.title}`);

      try {
        const result = await handler({ task, storeId, row });
        const resultRow = { ...row, result };
        if (['completed', 'already-completed', 'would-complete', 'released', 'would-release'].includes(result.status)) {
          summary.completed.push(resultRow);
          console.log(`    ${result.status}: ${JSON.stringify(result)}`);
        } else {
          summary.skipped.push({ ...resultRow, reason: result.reason || result.status });
          console.log(`    skip: ${result.reason || result.status}`);
        }
      } catch (error) {
        summary.errors.push({ ...row, stage: mode, error: error.message, body: error.body || null });
        console.log(`    ERROR: ${error.message}`);
      } finally {
        await fsp.writeFile(path.join(path.resolve(opts.outDir), 'summary.json'), JSON.stringify(summary, null, 2));
      }
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const outDir = path.resolve(opts.outDir);
  await fsp.mkdir(outDir, { recursive: true });

  if (opts.apply) {
    if (!opts.targetsExplicit && opts.targets.length) {
      throw new Error('--apply requires explicit --targets (built-in demo targets are dry-run only)');
    }
    if (!opts.releaseTargetsExplicit && opts.releaseTargets.length) {
      throw new Error('--apply requires explicit --release-targets when releasing tasks');
    }
    if (!opts.districts.length) {
      throw new Error('--apply requires --districts (e.g. --districts 1)');
    }
  }

  const scope = buildApplyScope({ districts: opts.districts.length ? opts.districts : [6], stores: [] });
  if (opts.apply) {
    assertApplyScopeConfirmed(scope, opts.confirmScope);
  }

  const api = loadApi();
  const auth = await api.fetchTokenFromRailway();
  const token = auth.token;
  const userId = auth.userId || api.DEFAULT_USER_ID || 211;
  const openedStores = new Set();

  const summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    date: opts.date,
    districts: scope.districts,
    applyScope: scopeSummary(scope),
    blurryPath: opts.blurryPath,
    targets: opts.targets,
    releaseTargets: opts.releaseTargets,
    auth: auth.username || userId,
    startedAt: new Date().toISOString(),
    matched: [],
    completed: [],
    skipped: [],
    errors: [],
  };

  console.log(`${opts.apply ? '[APPLY]' : '[DRY RUN]'} close Rebotics targets with blurry photo`);
  console.log(`districts=D${scope.districts.join(',D')} date=${opts.date} blurry=${opts.blurryPath} out=${outDir}`);
  if (!opts.apply && !opts.districts.length) {
    console.log('dry-run scope defaults to D6 for built-in demo targets; pass --districts on live apply');
  }
  console.log(`auth=${summary.auth}`);

  await processTargetGroups({
    api,
    token,
    opts,
    groups: opts.releaseTargets,
    summary,
    mode: 'release',
    scope,
    handler: async ({ task }) => releaseTarget({ api, token, task, dryRun: !opts.apply }),
  });

  await processTargetGroups({
    api,
    token,
    opts,
    groups: opts.targets,
    summary,
    mode: 'close',
    scope,
    handler: async ({ task, storeId }) => {
        if (opts.apply && !openedStores.has(storeId)) {
          await api.openShift(token, storeId, userId);
          openedStores.add(storeId);
        }
        return closeTarget({ api, token, task, blurryPath: opts.blurryPath, dryRun: !opts.apply });
    },
  });

  summary.finishedAt = new Date().toISOString();
  summary.counts = {
    matched: summary.matched.length,
    completed: summary.completed.length,
    skipped: summary.skipped.length,
    errors: summary.errors.length,
  };
  await fsp.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nsummary: ${path.join(outDir, 'summary.json')}`);
  console.log(`matched=${summary.counts.matched} completed=${summary.counts.completed} skipped=${summary.counts.skipped} errors=${summary.counts.errors}`);
  if (summary.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
