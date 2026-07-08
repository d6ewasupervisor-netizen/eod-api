'use strict';

const { fetchProdSchedule } = require('./dc-scan-sas-prod');
const { weekContext } = require('./dc-scan-inventory');
const { isSessionAlive } = require('../sas-bridge');
const sasAutoRefresh = require('../sas-auto-refresh');

const DEFAULT_INTERVAL_MS = Number(process.env.DC_SCAN_PROD_SYNC_MS || 60000);
const MIN_INTERVAL_MS = 15000;
const STARTUP_DELAY_MS = Number(process.env.DC_SCAN_PROD_START_DELAY_MS || 8000);

let liveProd = {
  ok: false,
  sessionAlive: false,
  projectId: 8081,
  syncedAt: null,
  error: 'Not synced yet',
  visits: [],
  byStoreDate: {},
  sas: null,
};

let timer = null;
let startupTimer = null;
let syncing = false;
let broadcastFn = null;
let reconcileFn = null;

function getLiveProd() {
  return liveProd;
}

function mergeWeekRange(ctx) {
  const start = ctx.thisWeek.startDate;
  const end = ctx.ongoingWeek.endDate;
  return { startDate: start, endDate: end };
}

async function refreshSasSession({ force = false, reason = 'dc-scan-prod-sync' } = {}) {
  const alive = isSessionAlive();
  if (alive && !force) {
    return {
      ok: true,
      sessionAlive: true,
      refreshed: false,
      skipped: true,
      reason: 'already-alive',
    };
  }

  if (!sasAutoRefresh.isConfigured()) {
    return {
      ok: false,
      sessionAlive: alive,
      refreshed: false,
      skipped: true,
      reason: 'not-configured',
      error:
        'SAS auto-refresh is not configured on eod-api (set SAS_USER, SAS_PASS, SAS_TOTP_SECRET).',
    };
  }

  const result = await sasAutoRefresh.runAutoRefresh({ reason, force });
  const sessionAlive = isSessionAlive();
  return {
    ok: Boolean(sessionAlive),
    sessionAlive,
    refreshed: !result.skipped,
    skipped: Boolean(result.skipped),
    reason: result.reason || reason,
    error: result.error || null,
    elapsedMs: result.elapsed_ms || null,
  };
}

async function runSync({ refreshSas = false, forceSas = false } = {}) {
  if (syncing) {
    return { liveProd, busy: true };
  }
  syncing = true;
  let sasMeta = null;
  try {
    if (refreshSas || forceSas || !isSessionAlive()) {
      sasMeta = await refreshSasSession({
        force: forceSas,
        reason: forceSas ? 'dc-scan-resync' : 'dc-scan-prod-sync',
      });
    } else {
      sasMeta = {
        ok: true,
        sessionAlive: true,
        refreshed: false,
        skipped: true,
        reason: 'already-alive',
      };
    }

    const ctx = weekContext(new Date());
    const range = mergeWeekRange(ctx);
    const next = await fetchProdSchedule(range);
    liveProd = {
      ...next,
      syncedAt: next.syncedAt || new Date().toISOString(),
      sas: sasMeta,
    };

    if (reconcileFn && next.ok && next.visits?.length) {
      await reconcileFn(liveProd);
    }
    if (broadcastFn) broadcastFn();
    return { liveProd, busy: false, sas: sasMeta };
  } catch (err) {
    liveProd = {
      ...liveProd,
      ok: false,
      sessionAlive: isSessionAlive(),
      error: err.message || 'Sync failed',
      syncedAt: new Date().toISOString(),
      sas: sasMeta,
    };
    if (broadcastFn) broadcastFn();
    return { liveProd, busy: false, sas: sasMeta, error: err.message };
  } finally {
    syncing = false;
  }
}

function startDcScanProdSync({ broadcast, reconcileFromProd }) {
  broadcastFn = broadcast;
  reconcileFn = reconcileFromProd;
  const interval = Math.max(MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS);

  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);

  startupTimer = setTimeout(() => {
    runSync({ refreshSas: true, forceSas: true }).catch((err) => {
      console.error('[dc-scan-prod-sync] startup', err.message);
    });
  }, STARTUP_DELAY_MS);

  timer = setInterval(() => {
    runSync({ refreshSas: !isSessionAlive() }).catch((err) => {
      console.error('[dc-scan-prod-sync] poll', err.message);
    });
  }, interval);

  if (typeof timer.unref === 'function') timer.unref();
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  console.log(
    `[dc-scan-prod-sync] Started PROD project 8081 sync every ${interval}ms (first run in ${STARTUP_DELAY_MS}ms)`,
  );
  return { runSync, getLiveProd };
}

function stopDcScanProdSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

module.exports = {
  startDcScanProdSync,
  stopDcScanProdSync,
  getLiveProd,
  runSync,
  refreshSasSession,
};
