'use strict';

/**
 * Durable cache of tracker sets confirmed complete in both PROD and SI.
 * Join key: P##W#|store|categoryId|dbkey (same as classifyReconciliation).
 *
 * Purpose: skip re-fetching / reclassifying sets week after week once both
 * systems have been verified done. Lives beside writes cache by default:
 *   {outDir}/{label}_confirmed_sets.json
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  buildReconciliationKey,
  normalizePeriodWeek,
  normalizeStore,
} = require('./sheet-reconciliation');
const { normalizeCategoryId } = require('./prod-row-fields');

const CACHE_VERSION = 1;

function normalizeConfirmedKey(keyOrRow) {
  if (keyOrRow == null) return '';
  if (typeof keyOrRow === 'object') {
    const built = buildReconciliationKey(keyOrRow);
    if (built && !built.startsWith('|') && !built.endsWith('|')) return built;
  }
  const raw = String(keyOrRow);
  const parts = raw.split('|');
  if (parts.length !== 4) return raw.trim();
  const [pw, store, cat, dbkey] = parts;
  const periodWeek = normalizePeriodWeek(pw) || String(pw || '').trim().toUpperCase();
  const storeNorm = normalizeStore(store);
  const catNorm = normalizeCategoryId(cat) || String(cat || '').trim();
  const db = String(dbkey || '').trim();
  if (!periodWeek || !storeNorm || !catNorm || !db) return raw.trim();
  return `${periodWeek}|${storeNorm}|${catNorm}|${db}`;
}

function defaultConfirmedCachePath(outDir, label = 'D6D8') {
  return path.join(outDir, `${label}_confirmed_sets.json`);
}

function emptyCache() {
  return {
    version: CACHE_VERSION,
    updatedAt: null,
    sets: {},
  };
}

function loadConfirmedSetsSync(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return emptyCache();
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const sets = {};
    for (const [key, entry] of Object.entries(raw.sets || {})) {
      const norm = normalizeConfirmedKey(key);
      if (!norm) continue;
      sets[norm] = { ...entry, key: norm };
    }
    return {
      version: Number(raw.version) || CACHE_VERSION,
      updatedAt: raw.updatedAt || null,
      sets,
    };
  } catch (err) {
    console.warn(`[confirmed-sets] failed to load ${cachePath}: ${err.message}`);
    return emptyCache();
  }
}

async function loadConfirmedSets(cachePath) {
  return loadConfirmedSetsSync(cachePath);
}

async function saveConfirmedSets(cachePath, cache) {
  if (!cachePath) throw new Error('confirmed-sets cache path required');
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  const payload = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    sets: cache.sets || {},
  };
  await fsp.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function confirmedKeySet(cache) {
  return new Set(Object.keys(cache?.sets || {}));
}

function isConfirmed(cache, keyOrRow) {
  const key = normalizeConfirmedKey(keyOrRow);
  return Boolean(key && cache?.sets?.[key]);
}

/**
 * Upsert confirmed entries. Returns { added, updated, total }.
 * @param {object} cache
 * @param {Array<object|string>} entries - keys or { key, workbookKind, ... }
 * @param {object} meta - { source, label }
 */
function upsertConfirmed(cache, entries = [], meta = {}) {
  if (!cache.sets) cache.sets = {};
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  for (const entry of entries) {
    const key = normalizeConfirmedKey(
      typeof entry === 'string' ? entry : (entry.key || entry),
    );
    if (!key) continue;
    const prev = cache.sets[key];
    const next = {
      key,
      confirmedAt: prev?.confirmedAt || now,
      lastSeenAt: now,
      source: meta.source || entry.source || prev?.source || 'unknown',
      label: meta.label || entry.label || prev?.label || null,
      workbookKind: entry.workbookKind || prev?.workbookKind || null,
      prodDone: true,
      siDone: true,
    };
    if (!prev) {
      added += 1;
      cache.sets[key] = next;
    } else {
      updated += 1;
      cache.sets[key] = { ...prev, ...next, confirmedAt: prev.confirmedAt };
    }
  }
  cache.updatedAt = now;
  return { added, updated, total: Object.keys(cache.sets).length };
}

/**
 * Seed from writes-cache Yes rows (and optional completed key sets).
 */
function seedFromWritesCache(cache, writesCache, meta = {}) {
  const entries = [];
  for (const kind of ['ise', 'blitz']) {
    for (const row of writesCache?.[kind] || []) {
      if (String(row.K || '').toLowerCase() !== 'yes') continue;
      entries.push({
        key: row.key,
        workbookKind: kind,
        source: meta.source || 'seed-writes-cache',
      });
    }
  }
  for (const key of meta.completedKeys || []) {
    entries.push({ key, source: meta.source || 'seed-completed-keys' });
  }
  return upsertConfirmed(cache, entries, {
    source: meta.source || 'seed-writes-cache',
    label: meta.label,
  });
}

/**
 * Filter tracker rows, dropping keys already in the confirmed cache.
 * When recheckConfirmed is true, returns rows unchanged.
 */
function filterOutConfirmed(rows = [], cache, { recheckConfirmed = false } = {}) {
  if (recheckConfirmed || !cache?.sets || !Object.keys(cache.sets).length) {
    return { rows: [...rows], skipped: 0, skippedKeys: [] };
  }
  const kept = [];
  const skippedKeys = [];
  for (const row of rows) {
    const key = normalizeConfirmedKey(row.key || row);
    if (key && cache.sets[key]) {
      skippedKeys.push(key);
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, skipped: skippedKeys.length, skippedKeys };
}

module.exports = {
  CACHE_VERSION,
  normalizeConfirmedKey,
  defaultConfirmedCachePath,
  emptyCache,
  loadConfirmedSets,
  loadConfirmedSetsSync,
  saveConfirmedSets,
  confirmedKeySet,
  isConfirmed,
  upsertConfirmed,
  seedFromWritesCache,
  filterOutConfirmed,
};
