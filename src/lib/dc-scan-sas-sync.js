'use strict';

const { fetchProdSchedule } = require('./dc-scan-sas-prod');
const { weekContext } = require('./dc-scan-inventory');

const DEFAULT_INTERVAL_MS = Number(process.env.DC_SCAN_PROD_SYNC_MS || 60000);
const MIN_INTERVAL_MS = 15000;

let liveProd = {
  ok: false,
  sessionAlive: false,
  projectId: 8081,
  syncedAt: null,
  error: 'Not synced yet',
  visits: [],
  byStoreDate: {},
};

let timer = null;
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

async function runSync() {
  if (syncing) return liveProd;
  syncing = true;
  try {
    const ctx = weekContext(new Date());
    const range = mergeWeekRange(ctx);
    const next = await fetchProdSchedule(range);
    liveProd = {
      ...next,
      syncedAt: next.syncedAt || new Date().toISOString(),
    };
    if (reconcileFn && next.ok && next.visits?.length) {
      await reconcileFn(next);
    }
    if (broadcastFn) broadcastFn();
    return liveProd;
  } catch (err) {
    liveProd = {
      ...liveProd,
      ok: false,
      error: err.message || 'Sync failed',
      syncedAt: new Date().toISOString(),
    };
    if (broadcastFn) broadcastFn();
    return liveProd;
  } finally {
    syncing = false;
  }
}

function startDcScanProdSync({ broadcast, reconcileFromProd }) {
  broadcastFn = broadcast;
  reconcileFn = reconcileFromProd;
  const interval = Math.max(MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS);

  if (timer) clearInterval(timer);

  // Initial pull soon after boot (SAS bridge may still be warming up).
  setTimeout(() => {
    runSync().catch((err) => {
      console.error('[dc-scan-prod-sync] initial', err.message);
    });
  }, 3000);

  timer = setInterval(() => {
    runSync().catch((err) => {
      console.error('[dc-scan-prod-sync] poll', err.message);
    });
  }, interval);

  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[dc-scan-prod-sync] Started PROD project 8081 sync every ${interval}ms`,
  );
  return { runSync, getLiveProd };
}

function stopDcScanProdSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startDcScanProdSync,
  stopDcScanProdSync,
  getLiveProd,
  runSync,
};
