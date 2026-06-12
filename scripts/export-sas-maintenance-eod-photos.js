#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { getFolderInfo } = require('../src/lib/fiscal-calendar');

const SAS_BASE = 'https://prod.sasretail.com/api/v1';
const CUSTOMER_ID = 2;
const OFFSET_MIN = 420;
const PROJECT_ID = 1;
const DEFAULT_CATEGORY = '5555';
const DEFAULT_PERIOD = 'P05W3';
const DEFAULT_FISCAL_YEAR = 2026;
const DEFAULT_OUTPUT = path.join(os.homedir(), 'Downloads', 'eod_p05W3');
const DEFAULT_D1_STORES = [
  75, 93, 125, 127, 135, 140, 150, 185, 208, 236,
  255, 360, 372, 460, 600, 614, 660, 663, 683,
];
const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';

function normalizePeriod(periodWeek) {
  const m = String(periodWeek || '').match(/P0?(\d+)W0?(\d)/i);
  if (!m) return null;
  return `P${m[1].padStart(2, '0')}W${m[2]}`;
}

function parsePeriod(periodWeek) {
  const m = normalizePeriod(periodWeek)?.match(/^P(\d{2})W(\d)$/);
  if (!m) throw new Error(`Invalid period/week: ${periodWeek}`);
  return { period: Number(m[1]), week: Number(m[2]), label: `P${m[1]}W${m[2]}` };
}

function defaultOutForPeriod(periodWeek) {
  return path.join(os.homedir(), 'Downloads', `eod_${normalizePeriod(periodWeek) || periodWeek}`);
}

function parseArgs(argv) {
  const out = {
    stores: [...DEFAULT_D1_STORES],
    category: DEFAULT_CATEGORY,
    period: DEFAULT_PERIOD,
    fiscalYear: DEFAULT_FISCAL_YEAR,
    outDir: DEFAULT_OUTPUT,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stores') out.stores = argv[++i].split(',').map((s) => Number(s.trim())).filter(Boolean);
    else if (arg === '--category') out.category = String(argv[++i]);
    else if (arg === '--period') {
      out.period = normalizePeriod(argv[++i]) || argv[i].toUpperCase();
      out.outDir = defaultOutForPeriod(out.period);
    } else if (arg === '--fiscal-year') out.fiscalYear = Number(argv[++i]);
    else if (arg === '--start') out.start = argv[++i];
    else if (arg === '--end') out.end = argv[++i];
    else if (arg === '--out') out.outDir = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage:',
        '  node scripts/export-sas-maintenance-eod-photos.js --period P05W3 --stores 75,93 --out ~/Downloads/eod_p05W3',
        '',
        'Defaults: D1 stores, category 5555, project 1, scheduled P05W3 FY2026.',
      ].join('\n'));
      process.exit(0);
    }
  }

  if (!out.start || !out.end) {
    const parsed = parsePeriod(out.period);
    const info = getFolderInfo(parsed.period, parsed.week, out.fiscalYear);
    out.start = out.start || info.startDate;
    out.end = out.end || info.endDate;
    out.period = info.periodWeek;
  }

  if (!out.token) out.token = process.env.SAS_TOKEN;
  return out;
}

async function loadSasSession() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE_PATH;
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const token = state?.auth?.auth_token;
    if (token) {
      return {
        token: String(token),
        generatedAt: state.generatedAt || null,
        source: statePath,
      };
    }
  }

  const sessionUrl = process.env.SAS_AUTH_SESSION_URL || DEFAULT_SESSION_URL;
  const res = await fetch(sessionUrl);
  if (!res.ok) throw new Error(`SAS auth-server ${res.status}: ${sessionUrl}`);
  const body = await res.json();
  const token = body?.auth?.auth_token;
  if (!token) throw new Error('No auth_token in sas-auth session response');
  return {
    token: String(token),
    generatedAt: body.generatedAt || null,
    source: sessionUrl,
  };
}

function nextDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseCSVLine(line) {
  const out = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line, index) => {
    const columns = parseCSVLine(line);
    return {
      __rowNumber: index + 2,
      ...Object.fromEntries(headers.map((header, i) => [header, columns[i] ?? ''])),
    };
  });
}

function parseUrlList(raw) {
  const urls = [];
  const re = /https?:\/\/[^'\s,\]]+/g;
  let match;
  while ((match = re.exec(String(raw || ''))) !== null) urls.push(match[0]);
  return urls;
}

function sortPhotoUrls(urls) {
  return [...urls].sort((a, b) => {
    const left = (a.match(/media\/(\d+)/) || [])[1] || a;
    const right = (b.match(/media\/(\d+)/) || [])[1] || b;
    return left.localeCompare(right);
  });
}

function safeSegment(value, max = 70) {
  return String(value || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, max) || 'unknown';
}

function rowPeriod(row) {
  const cycle = normalizePeriod(row['Cycle Name']);
  if (cycle) return cycle;
  const pogPeriod = String(row['Planogram ID'] || '').match(/^(P\d+W\d)_/i)?.[1];
  return normalizePeriod(pogPeriod) || '';
}

function rowScheduledDate(row) {
  return String(
    row['Shift Scheduled Date']
    || row['Scheduled Date']
    || row['Visit Scheduled Date']
    || ''
  ).slice(0, 10);
}

function categoryMatches(row, category) {
  const exactFields = [
    row['Category ID'],
    row['Department #'],
    row['Department Number'],
    row['Department ID'],
  ];
  if (exactFields.some((value) => String(value || '').trim() === category)) return true;

  const textFields = [
    row.Category,
    row.Department,
    row['Planogram ID'],
    row['Planogram Name'],
    row['Task Name'],
  ];
  const re = new RegExp(`(^|\\D)${category}(\\D|$)`);
  return textFields.some((value) => re.test(String(value || '')));
}

function sasReportParams({ start, end, projectStoreId }) {
  return new URLSearchParams({
    customer_id: String(CUSTOMER_ID),
    date_from: start,
    date_to: nextDate(end),
    date_type: 'scheduled',
    offset: String(OFFSET_MIN),
    project_id: String(PROJECT_ID),
    store_id: String(projectStoreId),
  });
}

async function sasGet(token, route) {
  const res = await fetch(`${SAS_BASE}${route}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`SAS ${res.status}: ${JSON.stringify(body).slice(0, 240)}`);
  return body;
}

function normalizeList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  return [];
}

function download(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function writeFileVersioned(dest, data) {
  let candidate = dest;
  const parsed = path.parse(dest);
  for (let version = 2; ; version += 1) {
    try {
      await fsp.writeFile(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if (!['EEXIST', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
      candidate = path.join(parsed.dir, `${parsed.name} version ${version}${parsed.ext}`);
    }
  }
}

function photoBaseName({ store, row, side, seq, total }) {
  const date = safeSegment(rowScheduledDate(row) || rowPeriod(row), 14);
  const visit = safeSegment(row['Visit ID'] || row['Shift ID'] || `row${row.__rowNumber}`, 26);
  const planogram = safeSegment(row['Planogram ID'], 38);
  const category = safeSegment(row.Category || `category_${DEFAULT_CATEGORY}`, 35);
  return [
    `store${store}`,
    date,
    visit,
    planogram,
    category,
    side,
    `bay${String(seq).padStart(2, '0')}of${String(total).padStart(2, '0')}`,
  ].join('_');
}

async function downloadSidePhotos({ store, row, side, urls, outRoot, dryRun, seenUrls }) {
  const manifest = [];
  const sorted = sortPhotoUrls(urls);
  const dir = path.join(outRoot, `store${store}`, side);
  if (!dryRun) await fsp.mkdir(dir, { recursive: true });

  for (let i = 0; i < sorted.length; i += 1) {
    const url = sorted[i];
    const key = `${store}|${side}|${url}`;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);

    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const dest = path.join(dir, `${photoBaseName({ store, row, side, seq: i + 1, total: sorted.length })}${ext}`);
    const item = {
      store,
      side,
      seq: i + 1,
      total: sorted.length,
      period: rowPeriod(row),
      scheduledDate: rowScheduledDate(row),
      categoryId: row['Category ID'] || '',
      category: row.Category || '',
      planogramId: row['Planogram ID'] || '',
      visitId: row['Visit ID'] || '',
      shiftId: row['Shift ID'] || '',
      rowNumber: row.__rowNumber,
      url,
      dest,
    };

    if (!dryRun) item.dest = await writeFileVersioned(dest, await download(url));
    manifest.push(item);
  }
  return manifest;
}

async function pullStore({ token, projectStore, store, opts, outRoot }) {
  const storeRoot = path.join(outRoot, `store${store}`);
  if (!opts.dryRun) {
    await fsp.mkdir(path.join(storeRoot, 'before'), { recursive: true });
    await fsp.mkdir(path.join(storeRoot, 'after'), { recursive: true });
  }

  const params = sasReportParams({ start: opts.start, end: opts.end, projectStoreId: projectStore.id });
  const report = await sasGet(token, `/reports/category-reset-report/?${params}`);
  if (!report?.file_url) return { store, rows: 0, matchingRows: [], photos: [], skipped: 'no file_url' };

  const csvText = await (await fetch(report.file_url)).text();
  const csvDir = path.join(outRoot, '_audit', 'sas-csv');
  const csvPath = path.join(csvDir, `store${store}-${opts.period}-p${PROJECT_ID}-scheduled.csv`);
  if (!opts.dryRun) {
    await fsp.mkdir(csvDir, { recursive: true });
    await writeFileVersioned(csvPath, csvText);
  }

  const rows = parseCsv(csvText);
  const matchingRows = rows.filter((row) => categoryMatches(row, opts.category));
  const seenUrls = new Set();
  const photos = [];

  for (const row of matchingRows) {
    photos.push(...await downloadSidePhotos({
      store,
      row,
      side: 'before',
      urls: parseUrlList(row['Before Pictures Link']),
      outRoot,
      dryRun: opts.dryRun,
      seenUrls,
    }));
    photos.push(...await downloadSidePhotos({
      store,
      row,
      side: 'after',
      urls: parseUrlList(row['After Pictures Link']),
      outRoot,
      dryRun: opts.dryRun,
      seenUrls,
    }));
  }

  const storeManifest = {
    store,
    period: opts.period,
    scheduledRange: { start: opts.start, end: opts.end },
    category: opts.category,
    projectId: PROJECT_ID,
    projectStoreId: projectStore.id,
    csvPath,
    rows: rows.length,
    matchingRows: matchingRows.map((row) => ({
      rowNumber: row.__rowNumber,
      period: rowPeriod(row),
      scheduledDate: rowScheduledDate(row),
      categoryId: row['Category ID'] || '',
      category: row.Category || '',
      planogramId: row['Planogram ID'] || '',
      visitId: row['Visit ID'] || '',
      shiftId: row['Shift ID'] || '',
      shiftStatus: row['Shift Status'] || '',
      beforeCount: parseUrlList(row['Before Pictures Link']).length,
      afterCount: parseUrlList(row['After Pictures Link']).length,
    })),
    photos,
  };

  if (!opts.dryRun) await writeFileVersioned(path.join(storeRoot, 'manifest.json'), JSON.stringify(storeManifest, null, 2));
  return storeManifest;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summaryCsv(results) {
  const headers = [
    'store', 'status', 'total_report_rows', 'maintenance_rows', 'before_photos',
    'after_photos', 'matching_visit_ids', 'matching_scheduled_dates', 'notes',
  ];
  const lines = [headers.join(',')];
  for (const result of results) {
    const before = (result.photos || []).filter((p) => p.side === 'before').length;
    const after = (result.photos || []).filter((p) => p.side === 'after').length;
    const rows = result.matchingRows || [];
    lines.push([
      result.store,
      result.error ? 'error' : result.skipped ? 'skipped' : rows.length ? 'found' : 'no_maintenance_rows',
      result.rows ?? '',
      rows.length,
      before,
      after,
      [...new Set(rows.map((r) => r.visitId).filter(Boolean))].join(';'),
      [...new Set(rows.map((r) => r.scheduledDate).filter(Boolean))].join(';'),
      result.error || result.skipped || '',
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const outRoot = path.resolve(opts.outDir);
  if (!opts.stores.length) throw new Error('No stores provided');
  if (!opts.dryRun) await fsp.mkdir(outRoot, { recursive: true });

  const session = opts.token
    ? { token: opts.token, source: 'SAS_TOKEN/--token', generatedAt: null }
    : await loadSasSession();

  console.log(`${opts.dryRun ? '[DRY RUN] ' : ''}Exporting SAS maintenance EOD photos`);
  console.log(`SAS token from ${session.source} (${session.generatedAt || 'unknown age'})`);
  console.log(`Stores: ${opts.stores.join(', ')}`);
  console.log(`Period/date range: ${opts.period} ${opts.start}..${opts.end}`);
  console.log(`Category: ${opts.category}`);
  console.log(`Output: ${outRoot}`);

  const projectStores = normalizeList(await sasGet(session.token, `/projects/project-stores/?project=${PROJECT_ID}`));
  const projectStoreByNumber = new Map(projectStores.map((ps) => [Number(ps?.store?.number), ps]));
  const results = [];

  for (const store of opts.stores) {
    const projectStore = projectStoreByNumber.get(Number(store));
    if (!projectStore) {
      console.log(`store${store}: no project-store id`);
      results.push({ store, error: 'store not found in SAS project 1' });
      continue;
    }

    try {
      const result = await pullStore({ token: session.token, projectStore, store, opts, outRoot });
      const before = result.photos.filter((p) => p.side === 'before').length;
      const after = result.photos.filter((p) => p.side === 'after').length;
      console.log(`store${store}: rows=${result.rows} maintenanceRows=${result.matchingRows.length} before=${before} after=${after}`);
      results.push(result);
    } catch (err) {
      console.log(`store${store}: ERROR ${err.message}`);
      results.push({ store, error: err.message });
    }
  }

  const summary = {
    dryRun: opts.dryRun,
    period: opts.period,
    scheduledRange: { start: opts.start, end: opts.end },
    category: opts.category,
    projectId: PROJECT_ID,
    stores: opts.stores,
    output: outRoot,
    totals: {
      stores: results.length,
      storesWithMaintenanceRows: results.filter((r) => (r.matchingRows || []).length).length,
      beforePhotos: results.reduce((sum, r) => sum + (r.photos || []).filter((p) => p.side === 'before').length, 0),
      afterPhotos: results.reduce((sum, r) => sum + (r.photos || []).filter((p) => p.side === 'after').length, 0),
    },
    results,
    finishedAt: new Date().toISOString(),
  };

  if (!opts.dryRun) {
    await writeFileVersioned(path.join(outRoot, 'manifest.json'), JSON.stringify(summary, null, 2));
    await writeFileVersioned(path.join(outRoot, 'audit-summary.csv'), summaryCsv(results));
  }

  console.log('\nTotals:');
  console.log(`  stores=${summary.totals.stores}`);
  console.log(`  storesWithMaintenanceRows=${summary.totals.storesWithMaintenanceRows}`);
  console.log(`  beforePhotos=${summary.totals.beforePhotos}`);
  console.log(`  afterPhotos=${summary.totals.afterPhotos}`);
}

main().catch((err) => {
  console.error('[fail]', err.stack || err.message || err);
  process.exit(1);
});
