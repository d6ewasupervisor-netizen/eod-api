'use strict';

const { getFolderInfo, getPeriodWeekForDate, formatPeriodWeek } = require('../fiscal-calendar');

function parseLocalDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date format: ${value}`);
  }
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function enumerateDates(startDate, endDate) {
  const out = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    out.push(formatLocalDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function resolveRange(input = {}) {
  if (input.dateFrom && input.dateTo) {
    const start = parseLocalDate(input.dateFrom);
    const end = parseLocalDate(input.dateTo);
    if (end < start) throw new Error('dateTo must be on or after dateFrom');
    return {
      dateFrom: formatLocalDate(start),
      dateTo: formatLocalDate(end),
      dates: enumerateDates(start, end),
      periodWeek: null,
      fiscalYear: null,
    };
  }

  const period = parseInt(input.period, 10);
  const week = parseInt(input.week, 10);
  const fiscalYear = input.fiscalYear != null ? parseInt(input.fiscalYear, 10) : null;
  if (Number.isNaN(period) || Number.isNaN(week)) {
    throw new Error('Provide either dateFrom/dateTo or period/week');
  }
  const info = getFolderInfo(period, week, fiscalYear);
  const start = parseLocalDate(info.startDate);
  const end = parseLocalDate(info.endDate);
  return {
    dateFrom: info.startDate,
    dateTo: info.endDate,
    dates: enumerateDates(start, end),
    periodWeek: formatPeriodWeek(period, week),
    fiscalYear: info.fiscalYear,
  };
}

function attachPeriodWeek(rows) {
  return rows.map((row) => {
    if (row.periodWeek) return row;
    const pw = row.workDate ? getPeriodWeekForDate(parseLocalDate(row.workDate)) : null;
    return {
      ...row,
      periodWeek: pw ? pw.periodWeek : null,
    };
  });
}

module.exports = {
  resolveRange,
  attachPeriodWeek,
  parseLocalDate,
  formatLocalDate,
};
