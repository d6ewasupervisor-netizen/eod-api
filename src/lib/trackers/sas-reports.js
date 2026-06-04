'use strict';

const sasBridge = require('../../sas-bridge');

const CUSTOMER_ID = 2;
const OFFSET_MIN = 420;
const DEFAULT_PROJECT_IDS = [1, 1668, 1715, 3568];
const projectStoreCache = new Map();

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

async function fetchProjectStores(projectId, { refresh = false } = {}) {
  const cached = projectStoreCache.get(projectId);
  const now = Date.now();
  if (!refresh && cached && now - cached.fetchedAt < 15 * 60 * 1000) {
    return cached.rows;
  }
  const body = await sasBridge.sasGet(`/api/v1/projects/project-stores/?project=${projectId}`);
  const rows = Array.isArray(body) ? body : (body?.results || []);
  projectStoreCache.set(projectId, { fetchedAt: now, rows });
  return rows;
}

async function discoverProjects({ refresh = false } = {}) {
  if (!sasBridge.isSessionAlive()) {
    return DEFAULT_PROJECT_IDS.map((id) => ({ id, name: `Project ${id}`, source: 'default' }));
  }
  try {
    const body = await sasBridge.sasGet(`/api/v1/projects/?customer_id=${CUSTOMER_ID}&page=1&page_size=200`);
    const rows = Array.isArray(body) ? body : (body?.results || []);
    if (!rows.length) {
      return DEFAULT_PROJECT_IDS.map((id) => ({ id, name: `Project ${id}`, source: 'default' }));
    }
    return rows
      .map((p) => ({ id: Number(p.id), name: normalizeProjectName(p), source: 'sas' }))
      .filter((p) => Number.isFinite(p.id))
      .sort((a, b) => a.id - b.id);
  } catch (_err) {
    return DEFAULT_PROJECT_IDS.map((id) => ({ id, name: `Project ${id}`, source: 'default' }));
  }
}

function toSasReportedRange(dateFrom, dateTo) {
  const from = `${dateFrom}T07:00:00.000Z`;
  const end = new Date(`${dateTo}T12:00:00Z`);
  end.setDate(end.getDate() + 1);
  const to = end.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  return { from, to };
}

async function pullCategoryReportCsv({ tokenless = true, projectId, projectStoreId, dateFrom, dateTo }) {
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
  const body = await sasBridge.sasGet(`/api/v1/reports/category-reset-report/?${params.toString()}`);
  if (!body?.file_url) return '';
  const res = await fetch(body.file_url);
  if (!res.ok) throw new Error(`Failed to download SAS CSV (HTTP ${res.status})`);
  return res.text();
}

async function fetchRows({ stores, projects, dateFrom, dateTo }) {
  if (!sasBridge.isSessionAlive()) {
    throw new Error('SAS session is not active. Use /api/trigger-auth first.');
  }
  const normalizedProjects = (projects && projects.length ? projects : DEFAULT_PROJECT_IDS)
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const normalizedStores = (stores || []).map((s) => String(parseInt(String(s), 10))).filter(Boolean);
  const allRows = [];

  for (const projectId of normalizedProjects) {
    const projectStores = await fetchProjectStores(projectId);
    const byStoreNumber = new Map(projectStores.map((ps) => [String(ps?.store?.number), ps]));
    for (const storeNumber of normalizedStores) {
      const projectStore = byStoreNumber.get(String(parseInt(storeNumber, 10)));
      if (!projectStore) continue;
      const csvText = await pullCategoryReportCsv({
        projectId,
        projectStoreId: projectStore.id,
        dateFrom,
        dateTo,
      });
      if (!csvText) continue;
      const rows = parseCsv(await csvText);
      for (const row of rows) {
        const workDate = String(row['Date'] || row['Reported Date'] || row['Scheduled Date'] || '').slice(0, 10);
        const planogramId = row['Planogram ID'] || '';
        const dbkey = extractDbkey(planogramId);
        const afterUrls = parseAfterUrls(row['After Pictures Link']);
        allRows.push({
          source: 'prod',
          storeNumber: String(row['Store #'] || row.Store || storeNumber),
          workDate,
          projectId,
          projectName: String(row.Project || row['Project Name'] || `Project ${projectId}`),
          dbkey,
          pog: dbkey,
          categorySetLabel: String(row.Category || row['Category Name'] || row['Department Name'] || ''),
          planogramId,
          status: String(row['Shift Status'] || row['Status'] || 'unknown').toLowerCase(),
          photoCount: afterUrls.length,
          images: afterUrls.map((url, idx) => ({
            sourceSystem: 'prod',
            sourceRef: row['Visit ID'] ? `visit:${row['Visit ID']}` : null,
            sourceUrl: url,
            bayIndex: idx + 1,
            capturedAt: null,
          })),
          raw: row,
        });
      }
    }
  }
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
