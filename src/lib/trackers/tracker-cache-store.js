'use strict';

/**
 * Persist district-tracker caches on the eod-api Railway volume so any
 * travel laptop can pull/push confirmed sets (and optional writes caches)
 * without depending on a home Downloads folder.
 *
 * Layout (default):
 *   {EOD_ARTIFACTS_DIR|/app/data/eod-artifacts}/tracker-cache/{label}/
 *     confirmed_sets.json
 *     writes_cache.json
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  emptyCache,
  normalizeConfirmedKey,
  upsertConfirmed,
} = require('./confirmed-sets-cache');

const ALLOWED_KINDS = new Set(['confirmed_sets', 'writes_cache']);

function trackerCacheRoot() {
  const fromEnv = String(process.env.TRACKER_CACHE_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const artifacts = String(process.env.EOD_ARTIFACTS_DIR || '').trim()
    || '/app/data/eod-artifacts';
  return path.resolve(artifacts, 'tracker-cache');
}

function normalizeLabel(label) {
  const cleaned = String(label || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '');
  if (!cleaned || cleaned.length > 32) {
    throw new Error('Invalid tracker cache label (use e.g. D6D8, D1)');
  }
  return cleaned;
}

function normalizeKind(kind) {
  const key = String(kind || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  const mapped = key === 'confirmed' || key === 'confirmedsets'
    ? 'confirmed_sets'
    : key === 'writes' || key === 'writescache'
      ? 'writes_cache'
      : key;
  if (!ALLOWED_KINDS.has(mapped)) {
    throw new Error(`Invalid tracker cache kind: ${kind}`);
  }
  return mapped;
}

function labelDir(label) {
  return path.join(trackerCacheRoot(), normalizeLabel(label));
}

function cacheFilePath(label, kind) {
  return path.join(labelDir(label), `${normalizeKind(kind)}.json`);
}

function ensureRoot() {
  const root = trackerCacheRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function readJsonFile(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function getCache(label, kind) {
  ensureRoot();
  const filePath = cacheFilePath(label, kind);
  const data = await readJsonFile(filePath);
  const stat = data == null
    ? null
    : await fsp.stat(filePath).catch(() => null);
  return {
    ok: true,
    label: normalizeLabel(label),
    kind: normalizeKind(kind),
    exists: data != null,
    updatedAt: data?.updatedAt || stat?.mtime?.toISOString?.() || null,
    path: filePath,
    data: data || (normalizeKind(kind) === 'confirmed_sets' ? emptyCache() : null),
  };
}

function mergeConfirmedPayload(existing, incoming) {
  const base = existing && existing.sets ? existing : emptyCache();
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sets: { ...(base.sets || {}) },
  };
  const entries = [];
  if (incoming?.sets && typeof incoming.sets === 'object') {
    for (const [key, entry] of Object.entries(incoming.sets)) {
      entries.push({
        ...(entry && typeof entry === 'object' ? entry : {}),
        key: normalizeConfirmedKey(key),
      });
    }
  } else if (Array.isArray(incoming?.keys)) {
    for (const key of incoming.keys) entries.push({ key });
  }
  const result = upsertConfirmed(next, entries, {
    source: incoming?.source || 'railway-merge',
    label: incoming?.label || null,
  });
  return { cache: next, result };
}

async function putCache(label, kind, payload, { replace = false } = {}) {
  ensureRoot();
  const normKind = normalizeKind(kind);
  const filePath = cacheFilePath(label, normKind);
  const existing = await readJsonFile(filePath);

  let toWrite;
  let mergeMeta = null;
  if (normKind === 'confirmed_sets' && !replace) {
    const merged = mergeConfirmedPayload(existing, payload || {});
    toWrite = merged.cache;
    mergeMeta = merged.result;
  } else if (normKind === 'confirmed_sets' && replace) {
    const sets = {};
    for (const [key, entry] of Object.entries(payload?.sets || {})) {
      const norm = normalizeConfirmedKey(key);
      if (!norm) continue;
      sets[norm] = { ...(entry || {}), key: norm };
    }
    toWrite = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sets,
    };
    mergeMeta = { added: Object.keys(sets).length, updated: 0, total: Object.keys(sets).length };
  } else {
    // writes_cache: replace whole document (caller owns merge locally)
    toWrite = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      updatedAt: new Date().toISOString(),
      railwaySyncedAt: new Date().toISOString(),
    };
  }

  await writeJsonAtomic(filePath, toWrite);
  return {
    ok: true,
    label: normalizeLabel(label),
    kind: normKind,
    path: filePath,
    updatedAt: toWrite.updatedAt,
    replace: Boolean(replace),
    merge: mergeMeta,
    counts: normKind === 'confirmed_sets'
      ? { sets: Object.keys(toWrite.sets || {}).length }
      : {
        ise: Array.isArray(toWrite.ise) ? toWrite.ise.length : 0,
        blitz: Array.isArray(toWrite.blitz) ? toWrite.blitz.length : 0,
      },
  };
}

async function listCaches() {
  ensureRoot();
  const root = trackerCacheRoot();
  const labels = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const label = ent.name;
    const kinds = {};
    for (const kind of ALLOWED_KINDS) {
      const filePath = cacheFilePath(label, kind);
      try {
        const st = await fsp.stat(filePath);
        const data = await readJsonFile(filePath);
        kinds[kind] = {
          exists: true,
          updatedAt: data?.updatedAt || st.mtime.toISOString(),
          bytes: st.size,
          sets: kind === 'confirmed_sets' ? Object.keys(data?.sets || {}).length : undefined,
        };
      } catch {
        kinds[kind] = { exists: false };
      }
    }
    labels.push({ label, kinds });
  }
  return { ok: true, root, labels };
}

module.exports = {
  ALLOWED_KINDS,
  trackerCacheRoot,
  normalizeLabel,
  normalizeKind,
  getCache,
  putCache,
  listCaches,
  ensureRoot,
};
