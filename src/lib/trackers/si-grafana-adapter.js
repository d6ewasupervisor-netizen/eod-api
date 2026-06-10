'use strict';

const { normalizeDbkey, normalizePeriodWeek } = require('./sheet-reconciliation');
const { normalizeCategoryId } = require('./prod-row-fields');
const { categoryIdFromTask } = require('./rebotics-reports');

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeInteger(value) {
  const match = clean(value).replace(/,/g, '').match(/\d+/);
  if (!match) return '';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function rowsFromGrafanaFrame(frame) {
  const fields = frame?.schema?.fields;
  const values = frame?.data?.values;
  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new Error('No Grafana table frame found at results.A.frames[0].');
  }
  const columnNames = fields.map((field) => field?.name ?? '');
  const rowCount = values.reduce((max, column) => Math.max(max, Array.isArray(column) ? column.length : 0), 0);
  const rows = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = {};
    for (let columnIndex = 0; columnIndex < columnNames.length; columnIndex += 1) {
      const column = values[columnIndex];
      row[columnNames[columnIndex]] = Array.isArray(column) ? column[rowIndex] : undefined;
    }
    rows.push(row);
  }
  return { columnNames, rows };
}

function normalizeSiTaskStatus(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === 'completed') return 'completed';
  if (normalized === 'complete') return 'completed';
  if (normalized === 'not started') return 'created';
  if (normalized === 'not completed') return 'incomplete';
  if (normalized === 'in progress') return 'in_progress';
  if (normalized === 'cancelled') return 'cancelled';
  return normalized || 'unknown';
}

function parseStoreFromDisplay(value) {
  const text = clean(value);
  const match = text.match(/#701-(\d{1,5})\b/i) || text.match(/\b(\d{1,4})\b/);
  return match ? normalizeInteger(match[1]) : '';
}

function taskShapeFromQuery46Row(row = {}) {
  const title = clean(row['Task Name']);
  return {
    title,
    task_def: { title },
    commodity: clean(row.Commodity),
  };
}

function categoryFromSiDisplay(row = {}) {
  return categoryIdFromTask(taskShapeFromQuery46Row(row));
}

function siRowToEngine(row) {
  const periodWeek = normalizePeriodWeek(row['Period/Week'] || row['Task Name']);
  const storeNumber = parseStoreFromDisplay(row.Store) || normalizeInteger(row.store_id);
  const categoryId = categoryFromSiDisplay(row) || normalizeCategoryId(row.category_id);
  const dbkey = normalizeDbkey(row['Task Name']) || normalizeDbkey(row.planogram_id);
  if (!periodWeek || !storeNumber || !categoryId || !dbkey) return null;

  return {
    source: 'si',
    periodWeek,
    storeNumber,
    categoryId,
    dbkey,
    planogramId: clean(row.planogram_id),
    status: normalizeSiTaskStatus(row['Task Status']),
    rawTaskStatus: clean(row['Task Status']),
    statusReason: clean(row['Task Exception Response']),
    currentTask: true,
    scanStatus: clean(row['Task Status']),
    actionsCount: {
      identify: parseInt(clean(row.Identify), 10) || 0,
      remove: parseInt(clean(row.Remove), 10) || 0,
      move: parseInt(clean(row.Move), 10) || 0,
    },
    hasPrePhoto: clean(row['Visit Date']) !== '',
    workDate: clean(row['Visit Date'] || row.v_date),
    raw: {
      title: clean(row['Task Name']),
      taskExceptionResponse: clean(row['Task Exception Response']),
      grafana: row,
    },
  };
}

function query46RowsFromInput(rawFrameOrRows) {
  if (Array.isArray(rawFrameOrRows)) return rawFrameOrRows;
  if (Array.isArray(rawFrameOrRows?.rows)) return rawFrameOrRows.rows;
  if (rawFrameOrRows?.schema && rawFrameOrRows?.data) return rowsFromGrafanaFrame(rawFrameOrRows).rows;
  const frame = rawFrameOrRows?.results?.A?.frames?.[0];
  if (frame) return rowsFromGrafanaFrame(frame).rows;
  return rowsFromGrafanaFrame(rawFrameOrRows).rows;
}

function normalizeQuery46Rows(rawFrameOrRows) {
  return query46RowsFromInput(rawFrameOrRows)
    .map(siRowToEngine)
    .filter(Boolean);
}

module.exports = {
  categoryFromSiDisplay,
  normalizeQuery46Rows,
  normalizeSiTaskStatus,
  parseStoreFromDisplay,
  rowsFromGrafanaFrame,
  siRowToEngine,
};
