'use strict';

const sasBridge = require('../../sas-bridge');
const { DEFAULT_PROJECT_IDS, projectLabel, knownProjectOptions } = require('./metadata');
const { mapLimit, normalizeConcurrency } = require('./concurrency');

const CUSTOMER_ID = 2;
const OFFSET_MIN = 420;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;
const projectStoreCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapAxiosData(response) {
  return response && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
}

function isRetriableError(err) {
  if (err?.name === 'AbortError') return true;
  const status = err?.response?.status || err?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err?.code);
}

async function withRetry(fn, { attempts = DEFAULT_MAX_ATTEMPTS, label = 'SAS request' } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetriableError(err)) break;
      await sleep(400 * attempt);
    }
  }
  if (lastErr) lastErr.message = `${label} failed: ${lastErr.message}`;
  throw lastErr;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cols[i] || '';
    return row;
  });
}

function normalizeHeaderKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowValue(row, names) {
  for (const name of names) {
    if (row[name] != null && String(row[name]).trim()) return row[name];
  }
  const normalized = new Map(Object.entries(row || {}).map(([k, v]) => [normalizeHeaderKey(k), v]));
  for (const name of names) {
    const value = normalized.get(normalizeHeaderKey(name));
    if (value != null && String(value).trim()) return value;
  }
  return '';
}

function extractWorkDate(row, fallbackDate = '') {
  const value = rowValue(row, [
    'Date',
    'Reported Date',
    'Scheduled Date',
    'Shift Reported Date',
    'Shift Scheduled Date',
    'Visit Date',
  ]);
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  return fallbackDate || '';
}

function parseAfterUrls(raw) {
  const urls = [];
  const re = /https?:\/\/[^'\s,\]]+/g;
  let m = null;
  const s = String(raw || '');
  while ((m = re.exec(s)) != null) urls.push(m[0]);
  return urls;
}

function extractDbkey(planogramId) {
  const s = String(planogramId || '');
  const m = s.match(/^P\d+W\d_(\d+)_/i);
  if (m) return m[1];
  const m2 = s.match(/\b(\d{6,10})\b/);
  return m2 ? m2[1] : null;
}

function normalizeProjectName(project) {
  const raw = String(project?.name || '').trim();
  return raw || `Project ${project?.id || 'unknown'}`;
}

async function fetchProjectStores(projectId, { refresh = false, settings = {} } = {}) {
  const cached = projectStoreCache.get(projectId);
  const now = Date.now();
  if (!refresh && cached && now - cached.fetchedAt < 15 * 60 * 1000) {
    return cached.rows;
  }
  const response = await withRetry(
    () => sasBridge.sasGet(
      `/api/v1/projects/project-stores/?project=${projectId}`,
      {},
      { timeout: settings.sasRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS }
    ),
    { attempts: settings.sasMaxAttempts || DEFAULT_MAX_ATTEMPTS, label: `SAS project stores ${projectId}` }
  );
  const body = unwrapAxiosData(response);
  const rows = Array.isArray(body) ? body : (body?.results || []);
  projectStoreCache.set(projectId, { fetchedAt: now, rows });
  return rows;
}

async function discoverProjects({ refresh = false } = {}) {
  if (!sasBridge.isSessionAlive()) {
    return knownProjectOptions();
  }
  try {
    const response = await withRetry(
      () => sasBridge.sasGet(`/api/v1/projects/?customer_id=${CUSTOMER_ID}&page=1&page_size=200`),
      { label: 'SAS projects' }
    );
    const body = unwrapAxiosData(response);
    const rows = Array.isArray(body) ? body : (body?.results || []);
    if (!rows.length) {
      return knownProjectOptions();
    }
    const discovered = rows
      .map((p) => ({ id: Number(p.id), name: normalizeProjectName(p), source: 'sas' }))
      .filter((p) => Number.isFinite(p.id))
      .sort((a, b) => a.id - b.id);
    const byId = new Map(discovered.map((p) => [p.id, p]));
    for (const preset of knownProjectOptions()) {
      const existing = byId.get(preset.id);
      byId.set(preset.id, {
        ...preset,
        ...(existing || {}),
        name: projectLabel(preset.id, existing?.name),
        label: preset.label,
        source: existing ? 'sas+preset' : 'preset',
      });
    }
    return [...byId.values()].sort((a, b) => {
      const aPreset = DEFAULT_PROJECT_IDS.includes(a.id) ? 0 : 1;
      const bPreset = DEFAULT_PROJECT_IDS.includes(b.id) ? 0 : 1;
      if (aPreset !== bPreset) return aPreset - bPreset;
      return a.id - b.id;
    });
  } catch (_err) {
    return knownProjectOptions();
  }
}

function toSasReportedRange(dateFrom, dateTo) {
  const from = `${dateFrom}T07:00:00.000Z`;
  const end = new Date(`${dateTo}T12:00:00Z`);
  end.setDate(end.getDate() + 1);
  const to = end.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  return { from, to };
}

async function pullCategoryReportCsv({ projectId, projectStoreId, dateFrom, dateTo, settings = {} }) {
  const range = toSasReportedRange(dateFrom, dateTo);
  const params = new URLSearchParams({
    customer_id: String(CUSTOMER_ID),
    date_from: range.from,
    date_to: range.to,
    date_type: 'reported',
    offset: String(OFFSET_MIN),
    project_id: String(projectId),
    shift_status: 'completed',
    store_id: String(projectStoreId),
  });
  const response = await withRetry(
    () => sasBridge.sasGet(
      `/api/v1/reports/category-reset-report/?${params.toString()}`,
      {},
      { timeout: settings.sasRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS }
    ),
    { attempts: settings.sasMaxAttempts || DEFAULT_MAX_ATTEMPTS, label: `SAS category report ${projectId}/${projectStoreId}` }
  );
  const body = unwrapAxiosData(response);
  if (!body?.file_url) return '';
  const timeoutMs = settings.sasRequestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const res = await withRetry(
    () => fetchWithTimeout(body.file_url, timeoutMs),
    { attempts: settings.sasMaxAttempts || DEFAULT_MAX_ATTEMPTS, label: 'SAS CSV download' }
  );
  if (!res.ok) throw new Error(`Failed to download SAS CSV (HTTP ${res.status})`);
  return res.text();
}

async function fetchRows({ stores, projects, dateFrom, dateTo, settings = {}, onProgress }) {
  if (!sasBridge.isSessionAlive()) {
    throw new Error('SAS session is not active. Use /api/trigger-auth first.');
  }
  const normalizedProjects = (projects && projects.length ? projects : DEFAULT_PROJECT_IDS)
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const normalizedStores = (stores || []).map((s) => String(parseInt(String(s), 10))).filter(Boolean);
  const allRows = [];
  const totalLookups = Math.max(1, normalizedProjects.length * normalizedStores.length);
  const sasConcurrency = normalizeConcurrency(settings.sasConcurrency, 3, 10);
  let completedLookups = 0;

  const projectContexts = await mapLimit(normalizedProjects, sasConcurrency, async (projectId) => {
    const projectStores = await fetchProjectStores(projectId, { settings });
    return {
      projectId,
      byStoreNumber: new Map(projectStores.map((ps) => [String(ps?.store?.number), ps])),
    };
  });

  const units = [];
  for (const context of projectContexts) {
    for (const storeNumber of normalizedStores) {
      units.push({ ...context, storeNumber });
    }
  }

  await mapLimit(units, sasConcurrency, async (unit) => {
    const { projectId, byStoreNumber, storeNumber } = unit;
    const progressContext = {
      completedLookups,
      totalLookups,
      rows: allRows.length,
      source: 'prod',
      projectId,
      projectName: projectLabel(projectId),
      storeNumber,
      dateFrom,
      dateTo,
    };
    if (onProgress) await onProgress({ ...progressContext, status: 'pulling' });
    const projectStore = byStoreNumber.get(String(parseInt(storeNumber, 10)));
    if (!projectStore) {
      completedLookups += 1;
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: allRows.length, status: 'complete' });
      return;
    }
    const csvText = await pullCategoryReportCsv({
      projectId,
      projectStoreId: projectStore.id,
      dateFrom,
      dateTo,
      settings,
    });
    completedLookups += 1;
    if (!csvText) {
      if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: allRows.length, status: 'complete' });
      return;
    }
    const rows = parseCsv(await csvText);
    for (const row of rows) {
      const workDate = extractWorkDate(row, dateFrom === dateTo ? dateFrom : '');
      const planogramId = rowValue(row, ['Planogram ID']);
      const dbkey = extractDbkey(planogramId);
      const afterUrls = parseAfterUrls(rowValue(row, ['After Pictures Link']));
      allRows.push({
        source: 'prod',
        storeNumber: String(rowValue(row, ['Store #', 'Store']) || storeNumber),
        workDate,
        projectId,
        projectName: projectLabel(projectId, String(rowValue(row, ['Project', 'Project Name']) || '')),
        dbkey,
        pog: dbkey,
        categorySetLabel: String(rowValue(row, ['Category', 'Category Name', 'Department Name']) || ''),
        planogramId,
        status: String(rowValue(row, ['Shift Status', 'Status']) || 'unknown').toLowerCase(),
        photoCount: afterUrls.length,
        images: afterUrls.map((url, idx) => ({
          sourceSystem: 'prod',
          sourceRef: rowValue(row, ['Visit ID']) ? `visit:${rowValue(row, ['Visit ID'])}` : null,
          sourceUrl: url,
          bayIndex: idx + 1,
          capturedAt: null,
        })),
        raw: row,
      });
    }
    if (onProgress) await onProgress({ ...progressContext, completedLookups, rows: allRows.length, status: 'complete' });
  });
  return allRows;
}

module.exports = {
  DEFAULT_PROJECT_IDS,
  discoverProjects,
  fetchProjectStores,
  fetchRows,
  extractDbkey,
  parseAfterUrls,
};
