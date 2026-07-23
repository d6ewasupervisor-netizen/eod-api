'use strict';

/**
 * Client helpers to sync tracker caches with eod-api Railway volume.
 *
 * Env:
 *   EOD_API_URL / EOD_API_BASE_URL  (default https://eod-api.the-dump-bin.com)
 *   SAS_AUTH_SECRET                 (Bearer / X-Auth-Secret)
 *   TRACKER_CACHE_REMOTE=0          disable auto remote sync
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  loadConfirmedSetsSync,
  saveConfirmedSets,
  upsertConfirmed,
  emptyCache,
} = require('./confirmed-sets-cache');

function remoteEnabled() {
  if (String(process.env.TRACKER_CACHE_REMOTE || '1').trim() === '0') return false;
  return Boolean(apiBaseUrl() && authSecret());
}

function apiBaseUrl() {
  return String(
    process.env.EOD_API_URL
    || process.env.EOD_API_BASE_URL
    || process.env.BACKEND_BASE_URL
    || 'https://eod-api.the-dump-bin.com',
  ).replace(/\/+$/, '');
}

function authSecret() {
  return String(
    process.env.SAS_AUTH_SECRET
    || process.env.TRACKER_CACHE_SECRET
    || '',
  ).trim();
}

async function remoteFetch(pathname, { method = 'GET', body = null, query = '' } = {}) {
  const secret = authSecret();
  if (!secret) throw new Error('SAS_AUTH_SECRET (or TRACKER_CACHE_SECRET) required for tracker-cache sync');
  const url = `${apiBaseUrl()}/internal/tracker-cache${pathname}${query || ''}`;
  const headers = {
    Authorization: `Bearer ${secret}`,
    'X-Auth-Secret': secret,
    Accept: 'application/json',
  };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const errMsg = json?.error || text || `HTTP ${res.status}`;
    throw new Error(`tracker-cache ${method} ${pathname}: ${errMsg}`);
  }
  return json;
}

async function listRemoteCaches() {
  return remoteFetch('/');
}

async function pullConfirmedSets({ label, localPath, mergeLocal = true } = {}) {
  if (!label) throw new Error('label required');
  const remote = await remoteFetch(`/${encodeURIComponent(label)}/confirmed_sets`);
  const remoteCache = remote?.data || emptyCache();
  let localCache = emptyCache();
  if (localPath && fs.existsSync(localPath) && mergeLocal) {
    localCache = loadConfirmedSetsSync(localPath);
  }
  const merged = emptyCache();
  upsertConfirmed(merged, Object.values(remoteCache.sets || {}), {
    source: 'railway-pull',
    label,
  });
  upsertConfirmed(merged, Object.values(localCache.sets || {}), {
    source: 'local-merge',
    label,
  });
  if (localPath) await saveConfirmedSets(localPath, merged);
  return {
    ok: true,
    label,
    localPath: localPath || null,
    remoteExists: Boolean(remote?.exists),
    remoteUpdatedAt: remote?.updatedAt || null,
    total: Object.keys(merged.sets || {}).length,
    cache: merged,
  };
}

async function pushConfirmedSets({ label, localPath, cache = null, replace = false } = {}) {
  if (!label) throw new Error('label required');
  let payload = cache;
  if (!payload) {
    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error(`Local confirmed cache missing: ${localPath}`);
    }
    payload = loadConfirmedSetsSync(localPath);
  }
  const result = await remoteFetch(
    `/${encodeURIComponent(label)}/confirmed_sets`,
    {
      method: 'PUT',
      body: payload,
      query: replace ? '?replace=1' : '',
    },
  );
  return { ok: true, label, localPath: localPath || null, remote: result };
}

async function pullWritesCache({ label, localPath } = {}) {
  if (!label || !localPath) throw new Error('label and localPath required');
  const remote = await remoteFetch(`/${encodeURIComponent(label)}/writes_cache`);
  if (!remote?.exists || !remote.data) {
    return { ok: true, label, exists: false, localPath };
  }
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, `${JSON.stringify(remote.data, null, 2)}\n`);
  return {
    ok: true,
    label,
    exists: true,
    localPath,
    updatedAt: remote.updatedAt,
  };
}

async function pushWritesCache({ label, localPath } = {}) {
  if (!label || !localPath) throw new Error('label and localPath required');
  if (!fs.existsSync(localPath)) throw new Error(`Writes cache missing: ${localPath}`);
  const payload = JSON.parse(await fsp.readFile(localPath, 'utf8'));
  const result = await remoteFetch(
    `/${encodeURIComponent(label)}/writes_cache`,
    { method: 'PUT', body: payload, query: '?replace=1' },
  );
  return { ok: true, label, localPath, remote: result };
}

module.exports = {
  remoteEnabled,
  apiBaseUrl,
  authSecret,
  listRemoteCaches,
  pullConfirmedSets,
  pushConfirmedSets,
  pullWritesCache,
  pushWritesCache,
};
