'use strict';

const reboticsBridge = require('../../rebotics-bridge');

const REQUEST_TIMEOUT_MS = 15000;
const ACTIONS_PAGE_LIMIT = 200;
const MAX_ACTION_PAGES = 40;
const MAX_TASK_PAGES = 20;

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

async function fetchJson(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
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
      throw new Error(detail || `Rebotics HTTP ${res.status} for ${path}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveStoreInternalId(customId, date) {
  let offset = 0;
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const data = await fetchJson(`/api/v1/tasks/?from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}`);
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
  return null;
}

async function listTasksForStoreAndDate(storeId, date) {
  let offset = 0;
  const out = [];
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const data = await fetchJson(
      `/api/v1/tasks/?store=${storeId}&from_date=${encodeURIComponent(date)}&to_date=${encodeURIComponent(date)}&limit=200&offset=${offset}&ordering=task_def__title`
    );
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    if (rows.length < 200) break;
    offset += 200;
  }
  return out;
}

async function listPrePhotoActionsForStoreOnDate(storeId, date) {
  let offset = 0;
  const out = [];
  for (let page = 0; page < MAX_ACTION_PAGES; page += 1) {
    const data = await fetchJson(`/api/v4/processing/actions/?store=${storeId}&limit=${ACTIONS_PAGE_LIMIT}&offset=${offset}`);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    if (!rows.length) break;
    for (const row of rows) {
      const day = String(row?.captured_at || '').slice(0, 10);
      if (day < date) return out;
      if (day !== date) continue;
      if (row?.stage !== 'pre_photo') continue;
      if (row?.deactivated || row?.rejected) continue;
      if (!row?.merged_image) continue;
      out.push(row);
    }
    const hasMore = data && typeof data === 'object' && data.next != null;
    if (!hasMore) break;
    offset += ACTIONS_PAGE_LIMIT;
  }
  return out;
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
  };
}

async function fetchRows({ stores, dates }) {
  const rows = [];
  const storeCustomToInternal = new Map();

  for (const date of dates) {
    for (const storeNumber of stores) {
      const customId = toCustomId(storeNumber);
      if (!customId) continue;
      let internalId = storeCustomToInternal.get(customId);
      if (!internalId) {
        internalId = await resolveStoreInternalId(customId, date);
        if (!internalId) continue;
        storeCustomToInternal.set(customId, internalId);
      }

      const [tasks, actions] = await Promise.all([
        listTasksForStoreAndDate(internalId, date),
        listPrePhotoActionsForStoreOnDate(internalId, date),
      ]);

      const actionsByDbkey = new Map();
      for (const action of actions) {
        const key = String(action?.store_planogram?.planogram?.custom_id || '').trim();
        if (!key) continue;
        if (!actionsByDbkey.has(key)) actionsByDbkey.set(key, []);
        actionsByDbkey.get(key).push(actionToImage(action));
      }

      for (const task of tasks) {
        const dbkey = dbkeyFromTask(task);
        const images = dbkey && actionsByDbkey.has(dbkey) ? actionsByDbkey.get(dbkey) : [];
        rows.push({
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
    }
  }
  return rows;
}

module.exports = {
  fetchRows,
  fetchJson,
  toCustomId,
  dbkeyFromTask,
};
