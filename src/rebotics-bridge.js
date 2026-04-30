/**
 * Rebotics (Store Intelligence) bridge — token storage, candidates, bulk-backlog.
 */

const crypto = require('crypto');
const { requireAuth } = require('./auth-middleware');

const logger = {
  info: (...a) => console.log('[rebotics-bridge]', ...a),
  error: (...a) => console.error('[rebotics-bridge]', ...a),
};

const REBOTICS_API = process.env.REBOTICS_API_BASE || 'https://krcs.rebotics.net';
const BRIDGE_SECRET = process.env.REBOTICS_AUTH_SECRET || process.env.SAS_AUTH_SECRET || '';
const DEFAULT_USER_ID = parseInt(process.env.REBOTICS_DEFAULT_USER_ID || '211', 10);
const STALE_MINUTES = 6 * 60;
const REAUTH_EMAIL_TO = process.env.REBOTICS_REAUTH_NOTIFY_EMAIL || 'tyson.gauthier@retailodyssey.com';
const TASK_PAUSE_MS = 250;

let _resend = null;

let reboticsToken = null;
let reboticsUsername = null;
let reboticsUserId = DEFAULT_USER_ID;
let reboticsTokenRefreshedAt = null;
let reboticsTokenStale = false;
let lastReauthTriggerAt = 0;

const storeCustomToInternal = new Map();
let activeShifts = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomUuid() {
  return crypto.randomUUID();
}

async function markStaleInDb(pool, isStale) {
  try {
    await pool.query(
      `UPDATE rebotics_auth SET is_stale = $1 WHERE id = (SELECT id FROM rebotics_auth ORDER BY refreshed_at DESC LIMIT 1)`,
      [isStale]
    );
  } catch (e) {
    logger.error('markStaleInDb:', e.message);
  }
}

async function loadAuthFromDb(pool) {
  const { rows } = await pool.query(
    `SELECT username, token, user_id, refreshed_at, is_stale FROM rebotics_auth ORDER BY refreshed_at DESC LIMIT 1`
  );
  if (!rows.length) {
    reboticsToken = null;
    reboticsUsername = null;
    reboticsUserId = DEFAULT_USER_ID;
    reboticsTokenRefreshedAt = null;
    reboticsTokenStale = true;
    logger.info('No Rebotics token in database');
    return;
  }
  const r = rows[0];
  reboticsToken = r.token;
  reboticsUsername = r.username;
  reboticsUserId = r.user_id != null ? r.user_id : DEFAULT_USER_ID;
  reboticsTokenRefreshedAt = r.refreshed_at ? new Date(r.refreshed_at).toISOString() : null;
  reboticsTokenStale = !!r.is_stale;
  logger.info(`Rebotics token loaded for ${reboticsUsername}, stale=${reboticsTokenStale}`);
}

async function persistAuth(pool, { username, token, userId, isStale }) {
  await pool.query('DELETE FROM rebotics_auth');
  await pool.query(
    `INSERT INTO rebotics_auth (username, token, user_id, refreshed_at, is_stale)
     VALUES ($1, $2, $3, NOW(), $4)`,
    [username, token, userId != null ? userId : DEFAULT_USER_ID, !!isStale]
  );
  reboticsToken = token;
  reboticsUsername = username;
  reboticsUserId = userId != null ? userId : DEFAULT_USER_ID;
  reboticsTokenRefreshedAt = new Date().toISOString();
  reboticsTokenStale = !!isStale;
}

async function refreshUserIdFromApi() {
  if (!reboticsToken) return;
  try {
    const res = await bareFetch('GET', '/api/v1/users/me/', null);
    if (!res.ok) return;
    const me = await res.json();
    const id = me?.id ?? me?.pk;
    if (typeof id === 'number') {
      reboticsUserId = id;
      logger.info(`Rebotics user id from /users/me/: ${id}`);
    }
  } catch (e) {
    logger.error('refreshUserIdFromApi:', e.message);
  }
}

async function bareFetch(method, path, body) {
  const headers = {
    Authorization: `Token ${reboticsToken}`,
    'Accept-Language': 'en',
    'X-Timezone': 'America/Los_Angeles',
    'User-Agent': 'KOMPASS-EOD/1.0',
  };
  if (body != null) headers['Content-Type'] = 'application/json';
  return fetch(`${REBOTICS_API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

async function waitFreshToken(pool, baselineIso, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const { rows } = await pool.query(
      `SELECT refreshed_at FROM rebotics_auth ORDER BY refreshed_at DESC LIMIT 1`
    );
    if (rows.length && rows[0].refreshed_at) {
      const t = new Date(rows[0].refreshed_at).toISOString();
      if (t > baselineIso) {
        await loadAuthFromDb(pool);
        return true;
      }
    }
  }
  return false;
}

async function triggerReboticsReauth(pathThatFailed) {
  const now = Date.now();
  if (now - lastReauthTriggerAt < 60_000) {
    logger.info('Rebotics re-auth email debounced (within 60s)');
    return;
  }
  lastReauthTriggerAt = now;
  if (!_resend || !process.env.RESEND_API_KEY) {
    logger.error('Cannot trigger Rebotics re-auth email: Resend not configured');
    return;
  }
  try {
    await _resend.emails.send({
      from: 'EOD System <noreply@retail-odyssey.com>',
      to: REAUTH_EMAIL_TO,
      subject: 'KOMPASS REBOTICS AUTH',
      html: `<p>Auto-triggered by KOMPASS EOD Railway for Rebotics path: <code>${(pathThatFailed || '').replace(/</g, '')}</code></p>
        <p>Your local Gmail poller should run <code>morning-auth-rebotics.js</code> and push a fresh token.</p>`,
    });
    logger.info('Sent KOMPASS REBOTICS AUTH email via Resend');
  } catch (e) {
    logger.error('Rebotics re-auth email send failed:', e.message);
  }
}

async function reboticsFetch(pool, method, path, body, { _retried = false } = {}) {
  if (!reboticsToken) {
    const err = new Error('REBOTICS_NO_TOKEN');
    err.code = 'REBOTICS_NO_TOKEN';
    throw err;
  }

  const res = await bareFetch(method, path, body);

  if (res.status === 401 || res.status === 403) {
    reboticsTokenStale = true;
    await markStaleInDb(pool, true);

    if (_retried) {
      const err = new Error('REBOTICS_STALE_TOKEN_AFTER_REAUTH');
      err.code = 'REBOTICS_STALE_TOKEN_AFTER_REAUTH';
      throw err;
    }

    const baselineIso = reboticsTokenRefreshedAt || '1970-01-01T00:00:00.000Z';
    await triggerReboticsReauth(path);
    const ok = await waitFreshToken(pool, baselineIso, 90_000);
    if (!ok) {
      const err = new Error('REBOTICS_STALE_TOKEN');
      err.code = 'REBOTICS_STALE_TOKEN';
      throw err;
    }

    return reboticsFetch(pool, method, path, body, { _retried: true });
  }

  return res;
}

async function reboticsJson(pool, method, path, body) {
  const res = await reboticsFetch(pool, method, path, body);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data && (data.detail || data.message)
      ? String(data.detail || data.message)
      : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function resolveStoreInternalId(pool, customId) {
  const key = String(customId).trim();
  if (storeCustomToInternal.has(key)) return storeCustomToInternal.get(key);

  const data = await reboticsJson(
    pool,
    'GET',
    `/api/v1/stores/?custom_id=${encodeURIComponent(key)}`,
    null
  );
  const list = Array.isArray(data) ? data : (data?.results || []);
  const first = list[0];
  if (!first?.id) {
    throw new Error(`Store not found for custom_id=${key}`);
  }
  storeCustomToInternal.set(key, first.id);
  return first.id;
}

async function fetchAllTasksForStoreAndDate(pool, storeInternalId, dateStr) {
  const all = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const q = `/api/v1/tasks/?store=${storeInternalId}&offset=${offset}&limit=${limit}&from_date=${encodeURIComponent(dateStr)}&to_date=${encodeURIComponent(dateStr)}&ordering=task_def__title`;
    const chunk = await reboticsJson(pool, 'GET', q, null);
    const results = Array.isArray(chunk) ? chunk : (chunk?.results || []);
    all.push(...results);
    if (results.length < limit) break;
    offset += limit;
  }
  return all;
}

function isNotStarted(task) {
  return task?.status?.id === 'not_started';
}

function taskToCandidate(task) {
  const storeCustom = task?.store?.custom_id || '';
  return {
    task_id: task.id,
    store_custom_id: storeCustom,
    store_internal_id: task?.store?.id,
    title: task.title || task.task_def__title || '',
    category: task?.category?.name || '',
    planogram: task?.planograms?.[0]?.name || '',
    survey_id: task?.survey?.id ?? null,
    survey_response_id: task?.result?.survey_response?.id ?? null,
  };
}

async function openShift(pool, storeInternalId) {
  if (activeShifts.has(storeInternalId)) return activeShifts.get(storeInternalId);

  const uuid = randomUuid();
  const start = new Date().toISOString();
  const body = { store: storeInternalId, user: reboticsUserId, uuid, start };
  const data = await reboticsJson(pool, 'POST', '/api/v1/shifts/', body);
  const rec = { shiftId: data.id, uuid, startIso: start };
  activeShifts.set(storeInternalId, rec);
  logger.info(`Opened Rebotics shift ${data.id} on store ${storeInternalId}`);
  return rec;
}

async function closeShift(pool, storeInternalId) {
  const s = activeShifts.get(storeInternalId);
  if (!s) return;
  const end = new Date().toISOString();
  await reboticsJson(pool, 'POST', '/api/v1/shifts/', {
    id: s.shiftId,
    store: storeInternalId,
    user: reboticsUserId,
    uuid: s.uuid,
    start: s.startIso,
    end,
  });
  activeShifts.delete(storeInternalId);
  logger.info(`Closed Rebotics shift ${s.shiftId} on store ${storeInternalId}`);
}

async function safeCloseShift(pool, storeInternalId) {
  try {
    await closeShift(pool, storeInternalId);
  } catch (e) {
    logger.error(`safeCloseShift(${storeInternalId}):`, e.message);
  }
}

async function backlogOneTask(pool, taskId) {
  const t0 = Date.now();
  const updated = await reboticsJson(pool, 'PUT', `/api/v1/tasks/${taskId}/`, { status: 'in_progress' });
  if (!isNotStarted(updated) && updated?.status?.id !== 'in_progress') {
    throw new Error(`Unexpected state after in_progress: ${updated?.status?.id || 'unknown'}`);
  }
  const surveyId = updated?.survey?.id;
  let responseId = updated?.result?.survey_response?.id;
  if (!surveyId || !responseId) {
    throw new Error('Missing survey or survey_response after in_progress step');
  }

  const startRes = await reboticsFetch(pool, 'PUT', `/api/v1/surveys/${surveyId}/responses/${responseId}/start/`, undefined);
  if (startRes.status !== 204) {
    const txt = await startRes.text();
    throw new Error(`start/ expected 204, got ${startRes.status}: ${txt.slice(0, 200)}`);
  }

  await reboticsJson(pool, 'PUT', `/api/v1/tasks/${taskId}/log/`, { logged_duration: 'PT0S' });
  await reboticsJson(pool, 'PUT', `/api/v1/tasks/${taskId}/`, {
    status: 'incomplete',
    status_reason: 'Backlog - Revisit Needed',
  });

  return { elapsed_ms: Date.now() - t0 };
}

async function fetchTaskMeta(pool, taskId) {
  try {
    return await reboticsJson(pool, 'GET', `/api/v1/tasks/${taskId}/`, null);
  } catch (e) {
    if (e.code && String(e.code).startsWith('REBOTICS')) throw e;
    const msg = e.message || '';
    if (msg.startsWith('REBOTICS_')) throw e;
    return null;
  }
}

function checkBridgeSecret(req, res) {
  if (!BRIDGE_SECRET || req.get('X-Auth-Secret') !== BRIDGE_SECRET) {
    res.status(401).json({ ok: false, error: 'Invalid X-Auth-Secret' });
    return false;
  }
  return true;
}

function authStatusPayload() {
  const now = Date.now();
  const refreshed = reboticsTokenRefreshedAt ? Date.parse(reboticsTokenRefreshedAt) : null;
  const minutesSince = refreshed != null && !Number.isNaN(refreshed)
    ? Math.floor((now - refreshed) / 60_000)
    : null;

  let stale = !reboticsToken || reboticsTokenStale;
  if (minutesSince != null && minutesSince > STALE_MINUTES) stale = true;

  return {
    ok: !!reboticsToken,
    username: reboticsUsername,
    refreshed_at: reboticsTokenRefreshedAt,
    minutes_since_refresh: minutesSince,
    stale,
  };
}

async function initReboticsDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rebotics_auth (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      token TEXT NOT NULL,
      user_id INTEGER,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_stale BOOLEAN NOT NULL DEFAULT false
    )
  `);
}

function registerReboticsRoutes(app, pool, resend) {
  _resend = resend;

  app.post('/rebotics-auth-update', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { token, username, expires_at_iso, refreshed_at_iso } = req.body || {};
    if (!token || !username) {
      return res.status(400).json({ ok: false, error: 'Missing token or username' });
    }
    try {
      reboticsToken = token;
      reboticsUsername = username;
      reboticsTokenRefreshedAt = refreshed_at_iso || new Date().toISOString();
      reboticsTokenStale = false;
      await persistAuth(pool, { username, token, userId: reboticsUserId, isStale: false });
      await refreshUserIdFromApi();
      await pool.query(
        `UPDATE rebotics_auth SET user_id = $1 WHERE id = (SELECT id FROM rebotics_auth ORDER BY refreshed_at DESC LIMIT 1)`,
        [reboticsUserId]
      );
      logger.info(`Rebotics token updated for ${username}${expires_at_iso ? ` exp=${expires_at_iso}` : ''}`);
      return res.json({ ok: true, user_id: reboticsUserId });
    } catch (e) {
      logger.error('rebotics-auth-update failed:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/rebotics-auth-status', requireAuth, (req, res) => {
    res.json(authStatusPayload());
  });

  // INTERNAL: returns the raw Rebotics token to authorized scripts only.
  // Protected exclusively by X-Auth-Secret (Railway shared secret) — NOT a
  // Supabase Bearer endpoint. Reserved for trusted server-side / local CLI
  // tools (e.g. carry-forward.js) that need to call Rebotics directly without
  // re-authenticating the user. Do NOT expose to the frontend.
  app.get('/rebotics-token-internal', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!reboticsToken) {
      return res.status(404).json({ ok: false, error: 'NO_TOKEN' });
    }
    const status = authStatusPayload();
    return res.json({
      ok: true,
      token: reboticsToken,
      username: reboticsUsername,
      user_id: reboticsUserId,
      refreshed_at: reboticsTokenRefreshedAt,
      stale: status.stale,
    });
  });

  app.get('/rebotics/tasks/candidates', requireAuth, async (req, res) => {
    const storeIdsRaw = req.query.store_ids || '';
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const customIds = String(storeIdsRaw)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!customIds.length) {
      return res.status(400).json({ ok: false, error: 'store_ids required' });
    }

    if (!reboticsToken) {
      return res.json({
        ok: false,
        stale_token: true,
        candidates: [],
        by_store: {},
        total: 0,
        error: 'REBOTICS_NO_TOKEN',
      });
    }

    let stale_token = false;
    if (!reboticsToken || reboticsTokenStale) {
      stale_token = true;
    }
    const status = authStatusPayload();
    if (status.stale) stale_token = true;

    try {
      const candidates = [];
      const byStore = {};

      for (const cid of customIds) {
        const internalId = await resolveStoreInternalId(pool, cid);
        const tasks = await fetchAllTasksForStoreAndDate(pool, internalId, date);
        const notStarted = tasks.filter(isNotStarted).map(taskToCandidate);
        for (const c of notStarted) {
          candidates.push(c);
        }
        byStore[cid] = { candidates: notStarted.length, store_internal_id: internalId };
      }

      return res.json({
        ok: true,
        stale_token,
        candidates,
        by_store: byStore,
        total: candidates.length,
      });
    } catch (e) {
      if (e.code === 'REBOTICS_NO_TOKEN' || e.code === 'REBOTICS_STALE_TOKEN' || e.code === 'REBOTICS_STALE_TOKEN_AFTER_REAUTH') {
        stale_token = true;
        return res.status(503).json({ ok: false, stale_token, error: e.message });
      }
      logger.error('candidates:', e.message);
      return res.status(500).json({ ok: false, stale_token, error: e.message });
    }
  });

  app.post('/rebotics/tasks/bulk-backlog', requireAuth, async (req, res) => {
    const { task_ids: taskIdsIn, dry_run: dryRun } = req.body || {};
    if (!Array.isArray(taskIdsIn) || !taskIdsIn.length) {
      return res.status(400).json({ ok: false, error: 'task_ids array required' });
    }

    const taskIds = [...new Set(taskIdsIn.map(id => parseInt(String(id), 10)).filter(n => !Number.isNaN(n)))];
    activeShifts = new Map();

    let stale_token = !reboticsToken || reboticsTokenStale;
    const results = [];
    let completed = 0;
    let failed = 0;

    try {
      const byStore = new Map();
      for (const tid of taskIds) {
        const meta = await fetchTaskMeta(pool, tid);
        if (!meta) {
          results.push({ task_id: tid, status: 'error', error: 'Task not found' });
          failed++;
          continue;
        }
        if (dryRun) {
          if (!isNotStarted(meta)) {
            results.push({
              task_id: tid,
              status: 'error',
              error: `Task is no longer not_started (current: ${meta?.status?.id || 'unknown'})`,
            });
            failed++;
          } else {
            results.push({ task_id: tid, status: 'ok', dry_run: true });
            completed++;
          }
          continue;
        }
        if (!isNotStarted(meta)) {
          results.push({
            task_id: tid,
            status: 'error',
            error: `Task is no longer not_started (current: ${meta?.status?.id || 'unknown'})`,
          });
          failed++;
          continue;
        }
        const sid = meta?.store?.id;
        if (!sid) {
          results.push({ task_id: tid, status: 'error', error: 'Task missing store' });
          failed++;
          continue;
        }
        if (!byStore.has(sid)) byStore.set(sid, []);
        byStore.get(sid).push(tid);
      }

      if (!dryRun) {
        for (const [storeInternalId, ids] of byStore) {
          try {
            await openShift(pool, storeInternalId);
            for (const tid of ids) {
              const t0 = Date.now();
              try {
                await backlogOneTask(pool, tid);
                results.push({ task_id: tid, status: 'ok', elapsed_ms: Date.now() - t0 });
                completed++;
              } catch (err) {
                logger.error(`bulk-backlog task ${tid}:`, err.message);
                results.push({ task_id: tid, status: 'error', error: err.message });
                failed++;
              }
              await sleep(TASK_PAUSE_MS);
            }
          } finally {
            await safeCloseShift(pool, storeInternalId);
          }
        }
      }

      const out = { ok: true, stale_token, completed, failed, results };
      return res.json(out);
    } catch (e) {
      if (e.code === 'REBOTICS_STALE_TOKEN' || e.code === 'REBOTICS_STALE_TOKEN_AFTER_REAUTH' || e.code === 'REBOTICS_NO_TOKEN') {
        stale_token = true;
      }
      logger.error('bulk-backlog fatal:', e.message);
      for (const tid of taskIds) {
        if (!results.find(r => r.task_id === tid)) {
          results.push({ task_id: tid, status: 'error', error: e.message || 'aborted' });
          failed++;
        }
      }
      return res.status(503).json({
        ok: false,
        stale_token,
        completed,
        failed,
        results,
        error: e.message,
      });
    }
  });
}

module.exports = {
  init: async (app, pool, { resend }) => {
    await initReboticsDb(pool);
    await loadAuthFromDb(pool);
    registerReboticsRoutes(app, pool, resend);
    logger.info('Rebotics bridge registered');
  },
  authStatusPayload,
  loadAuthFromDb,
};
