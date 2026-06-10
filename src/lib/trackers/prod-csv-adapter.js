'use strict';

const {
  normalizeDbkey,
  normalizePeriodWeek,
} = require('./sheet-reconciliation');
const {
  normalizeCategoryId,
  parseAfterPictureUrls,
} = require('./prod-row-fields');

const PROJECT_ID = 1;
const PROJECT_LABEL = 'Fred Meyer Kompass ISE';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeInteger(value) {
  const match = clean(value).replace(/,/g, '').match(/\d+/);
  if (!match) return '';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function parseCsvRecords(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => clean(value) !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.some((value) => clean(value) !== '')) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => clean(h));
  const rows = records.slice(1).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] == null ? '' : record[index];
    });
    return row;
  });
  return { headers, rows };
}

function parseProdPlanogram(planogramId) {
  const parts = clean(planogramId).split('_');
  const periodWeek = normalizePeriodWeek(parts[0] || '');
  const dbkey = normalizeDbkey(parts[1] || '');
  return {
    periodWeek,
    dbkey,
    complete: Boolean(periodWeek && dbkey),
  };
}

function normalizeProdDone(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'true') return 'done';
  if (normalized === 'false') return 'not_done';
  return 'unknown';
}

function normalizeResetType(value) {
  const normalized = clean(value).toUpperCase();
  return normalized === 'UPDATE' ? 'UPDATE' : normalized;
}

function prodRowToEngine(row) {
  const parsed = parseProdPlanogram(row['Planogram ID']);
  const storeNumber = normalizeInteger(row['Store #']);
  const categoryId = normalizeCategoryId(row['Category ID']);
  if (!parsed.complete || !storeNumber || !categoryId) {
    return {
      joinable: false,
      shiftSignoff: {
        storeNumber,
        shiftId: clean(row['Shift ID']),
        visitId: clean(row['Visit ID']),
        afterPictureLink: clean(row['After Pictures Link']),
        planogramId: clean(row['Planogram ID']),
      },
    };
  }

  return {
    joinable: true,
    row: {
      source: 'prod',
      projectId: PROJECT_ID,
      projectName: PROJECT_LABEL,
      periodWeek: parsed.periodWeek,
      storeNumber,
      categoryId,
      dbkey: parsed.dbkey,
      planogramId: clean(row['Planogram ID']),
      categoryCompletionStatus: normalizeProdDone(row['Category Completion Status']),
      rawCategoryCompletionStatus: clean(row['Category Completion Status']),
      categoryExceptionReason: clean(row['Category Exception Reason']),
      comment: clean(row.Comment || row.Comments),
      setType: normalizeResetType(row['Reset Type']),
      cycleName: clean(row['Cycle Name']),
      workDate: clean(row['Reported Date'] || row.Date || row['Scheduled Date']),
      afterPictureUrls: parseAfterPictureUrls(row['After Pictures Link']),
      raw: row,
    },
  };
}

function normalizeProdCsv(rawCsvText, { periodWeek } = {}) {
  const targetPeriodWeek = normalizePeriodWeek(periodWeek);
  if (!targetPeriodWeek) {
    throw new Error('normalizeProdCsv requires a periodWeek option.');
  }

  const parsed = parseCsv(rawCsvText);
  const prodRows = [];
  const shiftSignoffs = [];
  let filteredCarryoverRows = 0;

  for (const csvRow of parsed.rows) {
    const mapped = prodRowToEngine(csvRow);
    if (mapped.joinable) {
      if (mapped.row.periodWeek === targetPeriodWeek) prodRows.push(mapped.row);
      else filteredCarryoverRows += 1;
    } else {
      shiftSignoffs.push({ ...mapped.shiftSignoff, sourceWeek: targetPeriodWeek });
    }
  }

  return {
    headers: parsed.headers,
    rawRows: parsed.rows,
    prodRows,
    shiftSignoffs,
    filteredCarryoverRows,
  };
}

module.exports = {
  normalizeProdCsv,
};
