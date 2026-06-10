'use strict';

const path = require('node:path');

const WORKBOOKS = {
  blitz: {
    kind: 'blitz',
    fileName: 'SUPER Tracker Blitz V1.3.xlsx',
    sheetName: 'BLITZ TRACKER',
    routeLabels: ['blitz'],
  },
  ise: {
    kind: 'ise',
    fileName: 'SUPER Tracker ISE V1.3.xlsm',
    sheetName: 'ISE & CUT TRACKER',
    routeLabels: ['ise', 'cut in', 'cut-in', 'kompass ise', 'central pet', 'div'],
  },
};

const TRACKER_COLUMNS = {
  store: 3,
  categoryNumber: 4,
  pogName: 5,
  pogId: 8,
  setType: 9,
  currentK: 11,
  currentL: 12,
};

function normalizeWorkbookKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (normalized === 'blitz') return 'blitz';
  if (normalized === 'ise' || normalized === 'cut' || normalized === 'ise_cut') return 'ise';
  throw new Error(`Unknown tracker workbook kind: ${kind}`);
}

function workbookForKind(kind) {
  return WORKBOOKS[normalizeWorkbookKind(kind)];
}

function isBlitzSetType(value) {
  return /\bblitz\b/i.test(String(value || ''));
}

function workbookKindForSetType(value) {
  return isBlitzSetType(value) ? 'blitz' : 'ise';
}

function resolveTrackerBaseDir(env = process.env) {
  return env.TRACKER_ONEDRIVE_DIR || '';
}

function resolveWorkbookPath(kind, { baseDir = resolveTrackerBaseDir() } = {}) {
  if (!baseDir) {
    throw new Error('TRACKER_ONEDRIVE_DIR is not set; point it at the local OneDrive tracker folder.');
  }
  return path.join(baseDir, workbookForKind(kind).fileName);
}

module.exports = {
  TRACKER_COLUMNS,
  WORKBOOKS,
  isBlitzSetType,
  normalizeWorkbookKind,
  resolveTrackerBaseDir,
  resolveWorkbookPath,
  workbookForKind,
  workbookKindForSetType,
};
