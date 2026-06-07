'use strict';

const reboticsBridge = require('../../rebotics-bridge');
const { mapLimit, normalizeConcurrency, throwIfAborted } = require('./concurrency');

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_ACTIONS_PAGE_LIMIT = 200;
const DEFAULT_MAX_ACTION_PAGES = 40;
const DEFAULT_MAX_TASK_PAGES = 20;
const DEFAULT_MAX_ATTEMPTS = 3;
const storeIdCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(err) {
  if (err?.code === 'TRACKER_CANCELLED') return false;
  if (err?.name === 'AbortError') return true;
  const status = err?.status;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

function isAuthError(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return true;
  if (err?.code === 'REBOTICS_NO_TOKEN') return true;
  return /token|auth|sign in|required/i.test(String(err?.message || ''));
}

function warn(options, message) {
  if (typeof options?.onWarning === 'function') options.onWarning(message);
}

function toCustomId(storeNumber) {
  const n = String(parseInt(String(storeNumber), 10));
  if (!n || n === 'NaN') return '';
  return `701-${n.padStart(5, '0')}`;
}

function dbkeyFromTask(task) {
  const fromPlanogram = task?.planograms?.[0]?.custom_id;
  if (fromPlanogram && /^\d{6,10}$/.test(String(fromPlanogram))) return String(fromPlanogram);
  const title = String(task?.title || task?.task_def?.title || '');
  const m = title.match(/P\d{2}W\d[-\s]+\d{4}\s+(\d{6,8})/i);
  if (m) return m[1];
  const m2 = title.match(/\b(\d{7,8})\b/);
  return m2 ? m2[1] : null;
}

function categoryLabelFromTask(task) {
  return String(task?.category?.name || task?.commodity || '').trim();
}

function taskStatus(task) {
  return String(task?.status?.id || task?.status || 'unknown').toLowerCase();
}

async function fetchJsonOnce(path, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const token = reboticsBridge.getTokenForServer();
  const base = reboticsBridge.getApiBase();
  if (!token) {
    const err = new Error('Rebotics token is not active. Use /rebotics-trigger-auth first.');
    err.code = 'REBOTICS_NO_TOKEN';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Token ${token}`,
        'Accept-Language': 'en',
        'X-Timezone': 'America/Los_Angeles',
        'User-Agent': 'KOMPASS-Tracker/1.0',
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail = body && typeof body === 'object' ? (body.detail || body.message) : null;
      const err = new Error(detail || `Rebotics HTTP ${res.status} for ${path}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function fetchJson(path, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, attempts = DEFAULT_MAX_ATTEMPTS, signal = null } = {}) {
  let lastErr = null;
  let refreshedAuth = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fetchJsonOnce(path, { timeoutMs, signal });
    } catch (err) {
      lastErr = err;
      if (err?.code === 'TRACKER_CANCELLED') throw err;
      if (!refreshedAuth && isAuthError(err)) {
        refreshedAuth = true;
        await reboticsBridge.validateCurrentToken({ force: true });
        throwIfAborted(signal);
        try {
          return await fetchJsonOnce(path, { timeoutMs, signal });
        } catch (retryErr) {
          lastErr = retryErr;
          if (retryErr?.code === 'TRACKER_CANCELLED') throw retryErr;
          if (attempt >= attempts || !isRetriableError(retryErr)) break;
          await sleep(500 * attempt);
          continue;
        }
      }
      if (attempt >= attempts || !isRetriableError(err)) break;
      await sleep(500 * attempt);
    }
  }
  if (lastErr?.name === 'AbortError') {
    throw new Error(`Rebotics request timed out after ${timeoutMs}ms: ${path}`);
  }
  throw lastErr;
}

function cacheStoreFromTask(task) {
  const customId = String(task?.store?.custom_id || '').trim();
  const internalId = task?.store?.id;
  if (customId && internalId != null) storeIdCache.set(customId, internalId);
}

async function resolveStoreInternalIds(customIds, options = {}) {
  const wanted = new Set((customIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const dates = Array.isArray(options.dates) ? [...options.dates].filter(Boolean).sort().reverse() : [];
  const maxTaskPages = options.maxTaskPages || DEFAULT_MAX_TASK_PAGES;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  const signal = options.cancelSignal || null;
  throwIfAborted(signal);

  const out = new Map();
  for (const customId of wanted) {
    if (storeIdCache.has(customId)) out.set(customId, storeIdCache.get(customId));
  }
  const unresolved = () => [...wanted].filter((customId) => !out.has(customId));
  if (!unresolved().length) return out;

  for (const date of dates) {
    let offset = 0;
    for (let page = 0; page < maxTaskPages; page += 1) {
      throwIfAborted(signal);
      const data = await fetchJson(`/api/v1/tasks/?from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}`, { timeoutMs, attempts, signal });
      const rows = Array.isArray(data) ? data : (data?.results || []);
      if (!rows.length) break;
      for (const row of rows) {
        cacheStoreFromTask(row);
      }
      for (const customId of unresolved()) {
        if (storeIdCache.has(customId)) out.set(customId, storeIdCache.get(customId));
      }
      if (!unresolved().length) return out;
      const hasMore = data && typeof data === 'object' && data.next != null;
      if (!hasMore) break;
      offset += 200;
    }
  }
  return out;
}

async function resolveStoreInternalId(customId, options = {}) {
  const ids = await resolveStoreInternalIds([customId], options);
  return ids.get(customId) || null;
}

async function listTasksForStoreAndDate(storeId, date, options = {}) {
  const maxTaskPages = options.maxTaskPages || DEFAULT_MAX_TASK_PAGES;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  const signal = options.cancelSignal || null;
  let offset = 0;
  const out = [];
  for (let page = 0; page < maxTaskPages; page += 1) {
    throwIfAborted(signal);
    const data = await fetchJson(
      `/api/v1/tasks/?store=${storeId}&from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}&ordering=task_def__title`,
      { timeoutMs, attempts, signal }
    );
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    if (rows.length < 200) break;
    offset += 200;
  }
  return out;
}

async function listActionsForTask(taskId, options = {}) {
  const maxActionPages = options.maxActionPages || DEFAULT_MAX_ACTION_PAGES;
  const actionsPageLimit = options.actionsPageLimit || DEFAULT_ACTIONS_PAGE_LIMIT;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  const signal = options.cancelSignal || null;
  let offset = 0;
  const out = [];
  for (let page = 0; page < maxActionPages; page += 1) {
    throwIfAborted(signal);
    const data = await fetchJson(`/api/v4/processing/actions/?task_id=${encodeURIComponent(taskId)}&limit=${actionsPageLimit}&offset=${offset}`, { timeoutMs, attempts, signal });
    const rows = Array.isArray(data) ? data : (data?.results || []);
    if (!rows.length) break;
    out.push(...rows);
    const hasMore = data && typeof data === 'object' && data.next != null;
    if (!hasMore) break;
    offset += actionsPageLimit;
  }
  return out;
}

function embeddedPrePhotoActions(task) {
  const prePhoto = task?.result?.pre_photo;
  if (!Array.isArray(prePhoto)) return [];
  return prePhoto
    .map((action) => ({
      ...action,
      id: action?.id ?? action?.action_id ?? action?.actionId ?? null,
      stage: action?.stage || 'pre_photo',
      captured_at: action?.captured_at || action?.created_at || action?.created || null,
      store_planogram_id: action?.store_planogram_id || action?.store_planogram?.id || task?.planograms?.[0]?.store_planogram_id || null,
      store_planogram: action?.store_planogram || {
        id: task?.planograms?.[0]?.store_planogram_id || null,
        planogram: { custom_id: task?.planograms?.[0]?.custom_id || null },
      },
    }))
    .filter((action) => action.id != null);
}

function isUsablePrePhotoAction(action) {
  if (!action) return false;
  if (action.stage && action.stage !== 'pre_photo') return false;
  if (action.deactivated || action.rejected) return false;
  if (!action.merged_image && !action.id && !action.action_id) return false;
  return true;
}

function dedupeActions(actions) {
  const out = [];
  const seen = new Set();
  for (const action of actions || []) {
    const id = action?.id ?? action?.action_id ?? action?.actionId ?? `${action?.store_planogram_id || ''}|${action?.section_id || ''}|${action?.captured_at || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(action);
  }
  return out;
}

function actionToImage(action, { dbkey = '', storePlanogramId = null } = {}) {
  const actionId = action?.id ?? action?.action_id ?? action?.actionId ?? null;
  return {
    sourceSystem: 'si',
    imageRole: 'after',
    sourceRef: actionId != null ? `action:${actionId}` : null,
    sourceUrl: null,
    actionId,
    bayIndex: parseInt(action?.section_info?.name, 10) || null,
    capturedAt: action?.captured_at || null,
    dbkey: String(action?.store_planogram?.planogram?.custom_id || dbkey || ''),
    storePlanogramId: action?.store_planogram_id || action?.store_planogram?.id || storePlanogramId || null,
  };
}

async function fetchRows({ stores, dates, settings = {}, onProgress, onWarning }) {
  const cancelSignal = settings.cancelSignal || null;
  throwIfAborted(cancelSignal);
  const rows = [];
  const totalLookups = Math.max(1, dates.length * stores.length);
  const reboticsRequestTimeoutMs = parseInt(settings.reboticsRequestTimeoutMs, 10) || DEFAULT_REQUEST_TIMEOUT_MS;
  const reboticsConcurrency = normalizeConcurrency(settings.reboticsConcurrency, 3, 10);
  let completedLookups = 0;

  const units = [];
  for (const date of dates || []) {
    for (const storeNumber of stores || []) {
      const customId = toCustomId(storeNumber);
      if (!customId) continue;
      units.push({
        storeNumber: String(parseInt(String(storeNumber), 10)),
        customId,
        date,
      });
    }
  }
  const uniqueCustomIds = [...new Set(units.map((unit) => unit.customId))];
  const storeIdsPromise = resolveStoreInternalIds(uniqueCustomIds, {
    dates,
    maxTaskPages: settings.reboticsMaxTaskPages,
    reboticsRequestTimeoutMs,
    reboticsMaxAttempts: settings.reboticsMaxAttempts,
    cancelSignal,
  });

  await mapLimit(units, reboticsConcurrency, async (unit) => {
    throwIfAborted(cancelSignal);
    const { storeNumber, customId, date } = unit;
    const progressContext = {
        completedLookups,
        totalLookups,
        rows: rows.length,
        source: 'si',
        storeNumber,
        date,
    };
    if (onProgress) await onProgress({ ...progressContext, status: 'pulling' });
    const storeIds = await storeIdsPromise;
    throwIfAborted(cancelSignal);
    const internalId = storeIds.get(customId);
    if (!internalId) {
      warn({ onWarning }, `Rebotics store lookup skipped for ${customId}: store not found`);
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      return [];
    }

    try {
      const tasks = await listTasksForStoreAndDate(internalId, date, {
          maxTaskPages: settings.reboticsMaxTaskPages,
          reboticsRequestTimeoutMs,
          reboticsMaxAttempts: settings.reboticsMaxAttempts,
          cancelSignal,
      });
      throwIfAborted(cancelSignal);
      const actionsByTaskId = new Map();
      await mapLimit(tasks || [], reboticsConcurrency, async (task) => {
        throwIfAborted(cancelSignal);
        const embedded = dedupeActions(embeddedPrePhotoActions(task).filter(isUsablePrePhotoAction));
        if (embedded.length) {
          actionsByTaskId.set(task.id, embedded);
          return;
        }
        const fetched = await listActionsForTask(task.id, {
          maxActionPages: settings.reboticsMaxActionPages,
          actionsPageLimit: settings.reboticsActionsPageLimit,
          reboticsRequestTimeoutMs,
          reboticsMaxAttempts: settings.reboticsMaxAttempts,
          cancelSignal,
        });
        throwIfAborted(cancelSignal);
        actionsByTaskId.set(task.id, dedupeActions((fetched || []).filter(isUsablePrePhotoAction)));
      }, { signal: cancelSignal });
      throwIfAborted(cancelSignal);

      const out = [];
      for (const task of tasks || []) {
        const dbkey = dbkeyFromTask(task);
        const storePlanogramId = task?.planograms?.[0]?.store_planogram_id || null;
        const images = (actionsByTaskId.get(task.id) || []).map((action) => actionToImage(action, {
          dbkey,
          storePlanogramId,
        })).filter((image) => image.actionId != null);
        out.push({
          source: 'si',
          storeNumber: String(parseInt(String(storeNumber), 10)),
          workDate: date,
          projectId: null,
          projectName: 'Store Intelligence',
          dbkey,
          pog: dbkey,
          categorySetLabel: categoryLabelFromTask(task),
          planogramId: task?.planograms?.[0]?.name || null,
          status: taskStatus(task),
          photoCount: images.length,
          images,
          raw: {
            taskId: task?.id,
            title: task?.title || task?.task_def?.title || '',
          },
        });
      }
      rows.push(...out);
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      return;
    } catch (err) {
      throwIfAborted(cancelSignal);
      if (isAuthError(err)) throw err;
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      warn({ onWarning }, `Rebotics tasks skipped for store ${storeNumber} on ${date}: ${err.message}`);
    }
  }, { signal: cancelSignal });
  return rows;
}

module.exports = {
  fetchRows,
  fetchJson,
  toCustomId,
  dbkeyFromTask,
  listActionsForTask,
};
