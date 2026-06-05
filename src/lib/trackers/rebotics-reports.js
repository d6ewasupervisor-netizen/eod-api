'use strict';

const reboticsBridge = require('../../rebotics-bridge');
const { mapLimit, normalizeConcurrency } = require('./concurrency');

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_ACTIONS_PAGE_LIMIT = 200;
const DEFAULT_MAX_ACTION_PAGES = 40;
const DEFAULT_MAX_TASK_PAGES = 20;
const DEFAULT_MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(err) {
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

async function fetchJsonOnce(path, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const token = reboticsBridge.getTokenForServer();
  const base = reboticsBridge.getApiBase();
  if (!token) {
    const err = new Error('Rebotics token is not active. Use /rebotics-trigger-auth first.');
    err.code = 'REBOTICS_NO_TOKEN';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  }
}

async function fetchJson(path, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, attempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(path, { timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetriableError(err)) break;
      await sleep(500 * attempt);
    }
  }
  if (lastErr?.name === 'AbortError') {
    throw new Error(`Rebotics request timed out after ${timeoutMs}ms: ${path}`);
  }
  throw lastErr;
}

async function resolveStoreInternalId(customId, options = {}) {
  const dates = Array.isArray(options.dates) ? [...options.dates].filter(Boolean).sort().reverse() : [];
  const maxTaskPages = options.maxTaskPages || DEFAULT_MAX_TASK_PAGES;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  try {
    const data = await fetchJson(`/api/v1/stores/?custom_id=${encodeURIComponent(customId)}`, { timeoutMs, attempts });
    const rows = Array.isArray(data) ? data : (data?.results || []);
    if (rows[0]?.id != null) return rows[0].id;
  } catch (_err) {
    // This endpoint often returns the SPA shell; task rows are the reliable fallback.
  }

  for (const date of dates) {
    let offset = 0;
    for (let page = 0; page < maxTaskPages; page += 1) {
      const data = await fetchJson(`/api/v1/tasks/?from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}`, { timeoutMs, attempts });
      const rows = Array.isArray(data) ? data : (data?.results || []);
      if (!rows.length) break;
      for (const row of rows) {
        if (row?.store?.custom_id === customId && row?.store?.id != null) {
          return row.store.id;
        }
      }
      const hasMore = data && typeof data === 'object' && data.next != null;
      if (!hasMore) break;
      offset += 200;
    }
  }
  return null;
}

async function listTasksForStoreAndDate(storeId, date, options = {}) {
  const maxTaskPages = options.maxTaskPages || DEFAULT_MAX_TASK_PAGES;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  let offset = 0;
  const out = [];
  for (let page = 0; page < maxTaskPages; page += 1) {
    const data = await fetchJson(
      `/api/v1/tasks/?store=${storeId}&from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}&ordering=task_def__title`,
      { timeoutMs, attempts }
    );
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    if (rows.length < 200) break;
    offset += 200;
  }
  return out;
}

async function listPrePhotoActionsForStoreDateRange(storeId, dates, options = {}) {
  const maxActionPages = options.maxActionPages || DEFAULT_MAX_ACTION_PAGES;
  const actionsPageLimit = options.actionsPageLimit || DEFAULT_ACTIONS_PAGE_LIMIT;
  const timeoutMs = options.reboticsRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const attempts = options.reboticsMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  const dateSet = new Set((dates || []).map((d) => String(d)));
  const sortedDates = [...dateSet].sort();
  const earliest = sortedDates[0] || '';
  const latest = sortedDates[sortedDates.length - 1] || '';
  let offset = 0;
  const out = [];
  for (let page = 0; page < maxActionPages; page += 1) {
    const data = await fetchJson(`/api/v4/processing/actions/?store=${storeId}&limit=${actionsPageLimit}&offset=${offset}`, { timeoutMs, attempts });
    const rows = Array.isArray(data) ? data : (data?.results || []);
    if (!rows.length) break;
    for (const row of rows) {
      const day = String(row?.captured_at || '').slice(0, 10);
      if (earliest && day < earliest) return out;
      if (latest && day > latest) continue;
      if (!dateSet.has(day)) continue;
      if (row?.stage !== 'pre_photo') continue;
      if (row?.deactivated || row?.rejected) continue;
      if (!row?.merged_image) continue;
      out.push(row);
    }
    const hasMore = data && typeof data === 'object' && data.next != null;
    if (!hasMore) break;
    offset += actionsPageLimit;
  }
  return out;
}

function bucketActionsByDateAndDbkey(actions) {
  const buckets = new Map();
  for (const action of actions || []) {
    const day = String(action?.captured_at || '').slice(0, 10);
    const dbkey = String(action?.store_planogram?.planogram?.custom_id || '').trim();
    const storePlanogramId = action?.store_planogram_id || action?.store_planogram?.id || null;
    if (!day) continue;
    for (const keyPart of [dbkey, storePlanogramId].filter(Boolean)) {
      const key = `${day}|${keyPart}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(actionToImage(action));
    }
  }
  return buckets;
}

function actionToImage(action) {
  return {
    sourceSystem: 'si',
    sourceRef: action?.id != null ? `action:${action.id}` : null,
    sourceUrl: null,
    actionId: action?.id || null,
    bayIndex: parseInt(action?.section_info?.name, 10) || null,
    capturedAt: action?.captured_at || null,
    dbkey: String(action?.store_planogram?.planogram?.custom_id || ''),
    storePlanogramId: action?.store_planogram_id || action?.store_planogram?.id || null,
  };
}

async function fetchRows({ stores, dates, settings = {}, onProgress, onWarning }) {
  const rows = [];
  const storeCustomToInternal = new Map();
  const totalLookups = Math.max(1, dates.length * stores.length);
  const reboticsRequestTimeoutMs = parseInt(settings.reboticsRequestTimeoutMs, 10) || DEFAULT_REQUEST_TIMEOUT_MS;
  const reboticsConcurrency = normalizeConcurrency(settings.reboticsConcurrency, 3, 10);
  let completedLookups = 0;
  const storeContexts = new Map();

  await mapLimit(stores || [], reboticsConcurrency, async (storeNumber) => {
    const customId = toCustomId(storeNumber);
    if (!customId) return;
    if (onProgress) {
      await onProgress({
        completedLookups,
        totalLookups,
        rows: rows.length,
        source: 'si',
        storeNumber,
        date: dates?.[0] || null,
        status: 'pulling',
      });
    }
    try {
      let internalId = storeCustomToInternal.get(customId);
      if (!internalId) {
        internalId = await resolveStoreInternalId(customId, {
          dates,
          maxTaskPages: settings.reboticsMaxTaskPages,
          reboticsRequestTimeoutMs,
          reboticsMaxAttempts: settings.reboticsMaxAttempts,
        });
        if (internalId) storeCustomToInternal.set(customId, internalId);
      }
      if (!internalId) {
        warn({ onWarning }, `Rebotics store lookup skipped for ${customId}: store not found`);
        return;
      }
      let actions = [];
      try {
        actions = await listPrePhotoActionsForStoreDateRange(internalId, dates, {
          maxActionPages: settings.reboticsMaxActionPages,
          actionsPageLimit: settings.reboticsActionsPageLimit,
          reboticsRequestTimeoutMs,
          reboticsMaxAttempts: settings.reboticsMaxAttempts,
        });
      } catch (err) {
        if (isAuthError(err)) throw err;
        warn({ onWarning }, `Rebotics photos skipped for store ${storeNumber}: ${err.message}`);
      }
      storeContexts.set(String(parseInt(String(storeNumber), 10)), {
        internalId,
        actionsByDateDbkey: bucketActionsByDateAndDbkey(actions),
      });
    } catch (err) {
      if (isAuthError(err)) throw err;
      warn({ onWarning }, `Rebotics store setup skipped for ${customId}: ${err.message}`);
    }
  });

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

  await mapLimit(units, reboticsConcurrency, async (unit) => {
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
    const context = storeContexts.get(storeNumber);
    if (!context?.internalId) {
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      return [];
    }

    try {
      const tasks = await listTasksForStoreAndDate(context.internalId, date, {
          maxTaskPages: settings.reboticsMaxTaskPages,
          reboticsRequestTimeoutMs,
          reboticsMaxAttempts: settings.reboticsMaxAttempts,
      });
      completedLookups += 1;
      const out = [];
      for (const task of tasks || []) {
        const dbkey = dbkeyFromTask(task);
        const storePlanogramId = task?.planograms?.[0]?.store_planogram_id || null;
        const imageKeys = [
          dbkey ? `${date}|${dbkey}` : null,
          storePlanogramId ? `${date}|${storePlanogramId}` : null,
        ].filter(Boolean);
        const seenImageIds = new Set();
        const images = [];
        for (const key of imageKeys) {
          for (const image of context.actionsByDateDbkey.get(key) || []) {
            const imageId = image.actionId || image.sourceRef || `${image.dbkey}|${image.storePlanogramId}|${image.bayIndex}`;
            if (seenImageIds.has(imageId)) continue;
            seenImageIds.add(imageId);
            images.push(image);
          }
        }
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
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      return;
    } catch (err) {
      if (isAuthError(err)) throw err;
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: rows.length, status: 'complete' });
      warn({ onWarning }, `Rebotics tasks skipped for store ${storeNumber} on ${date}: ${err.message}`);
    }
  });
  return rows;
}

module.exports = {
  fetchRows,
  fetchJson,
  toCustomId,
  dbkeyFromTask,
  listPrePhotoActionsForStoreDateRange,
};
