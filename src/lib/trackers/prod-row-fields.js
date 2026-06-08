'use strict';

function normalizeHeaderKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowValue(row, names) {
  const normalized = new Map(Object.entries(row || {}).map(([key, value]) => [normalizeHeaderKey(key), value]));
  for (const name of names || []) {
    const value = normalized.get(normalizeHeaderKey(name));
    if (value != null) return value;
  }
  return '';
}

function normalizeCategoryId(value) {
  const match = String(value ?? '').trim().match(/\d+/);
  if (!match) return '';
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function normalizeCategoryCompletionStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return 'done';
  if (normalized === 'false') return 'not_done';
  return 'unknown';
}

function parseTrueFalse(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseAfterPictureUrls(value) {
  const urls = [];
  const pattern = /https?:\/\/[^'"\s,\]]+/g;
  const raw = String(value || '');
  let match = null;
  while ((match = pattern.exec(raw)) != null) urls.push(match[0]);
  return urls;
}

function extractProdFields(row = {}) {
  return {
    categoryId: normalizeCategoryId(rowValue(row, ['Category ID', 'Category #', 'Category#'])),
    categoryCompletionStatus: normalizeCategoryCompletionStatus(rowValue(row, ['Category Completion Status'])),
    categoryExceptionReason: String(rowValue(row, ['Category Exception Reason', 'Exception Reason']) || '').trim(),
    comment: String(rowValue(row, ['Comment', 'Comments']) || '').trim(),
    afterPhotoRequired: parseTrueFalse(rowValue(row, ['After Photo Required']), false),
    afterPictureUrls: parseAfterPictureUrls(rowValue(row, ['After Pictures Link'])),
  };
}

module.exports = {
  extractProdFields,
  normalizeCategoryCompletionStatus,
  normalizeCategoryId,
  parseAfterPictureUrls,
  parseTrueFalse,
  rowValue,
};
