'use strict';

const express = require('express');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrackersRouter } = require('../src/routes/trackers');
const {
  claimSnapshotIngest,
  ingestTrackerSnapshot,
  sweepStuckSnapshotIngests,
} = require('../src/lib/trackers/snapshot-ingest');

class MemoryTrackerPool {
  constructor() {
    this.snapshotRows = [];
    this.meta = new Map();
    this.failNextSnapshotInsert = false;
  }

  async connect() {
    let backup = null;
    return {
      query: async (sql, params = []) => {
        const normalized = normalizeSql(sql);
        if (normalized === 'BEGIN') {
          backup = {
            snapshotRows: this.snapshotRows.map((row) => ({ ...row })),
            meta: new Map([...this.meta.entries()].map(([key, value]) => [key, { ...value }])),
          };
          return { rows: [] };
        }
        if (normalized === 'ROLLBACK') {
          if (backup) {
            this.snapshotRows = backup.snapshotRows;
            this.meta = backup.meta;
          }
          return { rows: [] };
        }
        if (normalized === 'COMMIT') {
          backup = null;
          return { rows: [] };
        }
        return this.query(sql, params);
      },
      release: () => {},
    };
  }

  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('UPDATE TRACKER_RUNS')) {
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT REFRESHED_AT, ROW_COUNT, NORMALIZED_ROW_COUNT, LAST_ERROR FROM TRACKER_SNAPSHOT_META')) {
      const row = this.meta.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (normalized.startsWith('DELETE FROM TRACKER_SNAPSHOT_ROWS WHERE WORKBOOK_KIND = $1')) {
      const kind = params[0];
      this.snapshotRows = this.snapshotRows.filter((row) => row.workbook_kind !== kind);
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_ROWS')) {
      if (this.failNextSnapshotInsert) {
        this.failNextSnapshotInsert = false;
        throw new Error('forced snapshot insert failure');
      }
      const columnsPerRow = 13;
      for (let i = 0; i < params.length; i += columnsPerRow) {
        this.snapshotRows.push({
          workbook_kind: params[i],
          store: params[i + 1],
          period_week: params[i + 2],
          category_id: params[i + 3],
          dbkey: params[i + 4],
          row_index: params[i + 5],
          set_type: params[i + 6],
          current_k: params[i + 7],
          current_l: params[i + 8],
          bucket: params[i + 9],
          bucket_reason: params[i + 10],
          expectation: params[i + 11],
          refreshed_at: params[i + 12],
        });
      }
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE TRACKER_SNAPSHOT_META') && normalized.includes("INGEST_STATUS = 'ERROR'") && normalized.includes("WHERE INGEST_STATUS = 'PROCESSING'")) {
      let swept = 0;
      for (const [kind, row] of this.meta.entries()) {
        if (row.ingest_status === 'processing') {
          this.meta.set(kind, {
            ...row,
            ingest_status: 'error',
            ingest_completed_at: new Date().toISOString(),
            last_error: 'Ingest interrupted by service restart',
          });
          swept += 1;
        }
      }
      return { rows: [], rowCount: swept };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_META') && normalized.includes('INGEST_STATUS, INGEST_STARTED_AT')) {
      const kind = params[0];
      const stuckMinutes = parseInt(params[1], 10);
      const existing = this.meta.get(kind);
      const startedAt = existing?.ingest_started_at ? new Date(existing.ingest_started_at).getTime() : null;
      const isFreshProcessing = existing
        && existing.ingest_status === 'processing'
        && startedAt !== null
        && (Date.now() - startedAt) < stuckMinutes * 60000;
      if (isFreshProcessing) {
        return { rows: [], rowCount: 0 };
      }
      this.meta.set(kind, {
        workbook_kind: kind,
        refreshed_at: existing?.refreshed_at || new Date(0).toISOString(),
        row_count: existing?.row_count || 0,
        normalized_row_count: existing?.normalized_row_count ?? null,
        last_error: existing?.last_error ?? null,
        si_source: existing?.si_source ?? null,
        si_fallback_reason: existing?.si_fallback_reason ?? null,
        ingest_status: 'processing',
        ingest_started_at: new Date().toISOString(),
        ingest_completed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_META') && params.length === 6) {
      this.meta.set(params[0], {
        workbook_kind: params[0],
        refreshed_at: params[1],
        row_count: params[2],
        normalized_row_count: params[3],
        last_error: null,
        si_source: params[4],
        si_fallback_reason: params[5],
        ingest_status: 'ok',
        ingest_completed_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_META') && params.length === 4) {
      this.meta.set(params[0], {
        workbook_kind: params[0],
        refreshed_at: params[1],
        row_count: params[2],
        normalized_row_count: params[3],
        last_error: null,
        si_source: null,
        si_fallback_reason: null,
      });
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_META') && params.length === 3) {
      this.meta.set(params[0], {
        workbook_kind: params[0],
        refreshed_at: params[1],
        row_count: params[2],
        normalized_row_count: null,
        last_error: null,
        si_source: null,
        si_fallback_reason: null,
      });
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO TRACKER_SNAPSHOT_META') && params.length === 2) {
      const existing = this.meta.get(params[0]);
      this.meta.set(params[0], {
        workbook_kind: params[0],
        refreshed_at: existing?.refreshed_at || new Date().toISOString(),
        row_count: existing?.row_count || 0,
        normalized_row_count: existing?.normalized_row_count ?? null,
        last_error: params[1],
        si_source: existing?.si_source ?? null,
        si_fallback_reason: existing?.si_fallback_reason ?? null,
        ingest_status: 'error',
        ingest_completed_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in test fake: ${normalized}`);
  }
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function trackerRow(dbkey, overrides = {}) {
  return {
    rowIndex: overrides.rowIndex || Number(dbkey.slice(-2)),
    store: overrides.store || '19',
    categoryNumber: overrides.categoryNumber || '201',
    pogName: overrides.pogName || '201-CANDY - CHECKLANE',
    pogId: overrides.pogId || `P05W3_${dbkey}_D701_L00000_D03_C201_V340_I024_MX`,
    setType: overrides.setType || 'Kompass ISE',
    currentK: overrides.currentK || '',
    currentL: overrides.currentL || '',
  };
}

function trackerRows(count, start = 1, overrides = {}) {
  return Array.from({ length: count }, (_, idx) => {
    const n = start + idx;
    return trackerRow(String(1000000 + n), { rowIndex: n, ...overrides });
  });
}

function periodPog(period, week, dbkey) {
  return `P${String(period).padStart(2, '0')}W${week}_${dbkey}_D701_L00000_D03_C201_V340_I024_MX`;
}

function periodRow({ period, week = 1, dbkey, rowIndex } = {}) {
  return trackerRow(dbkey, {
    rowIndex: rowIndex || Number(String(dbkey).slice(-4)),
    pogId: periodPog(period, week, dbkey),
  });
}

function currentPeriod(period, fiscalYear = 2026) {
  return () => ({
    period,
    week: 2,
    fiscalYear,
    periodWeek: `P${String(period).padStart(2, '0')}W2`,
  });
}

function prodRow(dbkey, overrides = {}) {
  return {
    storeNumber: '19',
    periodWeek: 'P05W3',
    categoryId: '201',
    dbkey,
    categoryCompletionStatus: 'done',
    categoryExceptionReason: '',
    comment: '',
    ...overrides,
  };
}

function siRow(dbkey, overrides = {}) {
  return {
    storeNumber: '19',
    periodWeek: 'P05W3',
    categoryId: '201',
    dbkey,
    status: 'completed',
    ...overrides,
  };
}

async function withTrackerServer(pool, snapshotIngest, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/trackers', createTrackersRouter({ pool, snapshotIngest }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitForIngestSettled(pool, kind, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = pool.meta.get(kind);
    if (row && row.ingest_status && row.ingest_status !== 'processing') return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Ingest for '${kind}' did not settle within ${timeoutMs}ms`);
}

test('snapshot ingest rejects missing/wrong bearer and unset-token fail closed', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  await withTrackerServer(pool, { settingsLoader: async () => ({}) }, async (baseUrl) => {
    delete process.env.TRACKER_INGEST_TOKEN;
    let res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 503);

    process.env.TRACKER_INGEST_TOKEN = 'secret';
    res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 401);

    res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 401);
  });
});

test('snapshot ingest stores sample ISE rows and returns bucketCounts', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  const snapshotIngest = {
    settingsLoader: async () => ({}),
    sourceFetcher: async () => ({
      prodRows: [
        prodRow('1000001'),
        prodRow('1000002', {
          categoryCompletionStatus: 'not_done',
          categoryExceptionReason: 'Backlog - Revisit Needed',
        }),
      ],
      siRows: [siRow('1000001')],
    }),
    now: new Date('2026-06-08T12:00:00.000Z'),
  };

  await withTrackerServer(pool, snapshotIngest, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workbookKind: 'ise',
        rows: [trackerRow('1000001', { rowIndex: 5 }), trackerRow('1000002', { rowIndex: 6 })],
      }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'ise');
    assert.equal(body.status, 'processing');
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'ok');
  });

  assert.equal(pool.snapshotRows.length, 2);
  assert.equal(pool.snapshotRows.find((row) => row.dbkey === '1000001').bucket, 'matched_both');
  assert.equal(pool.snapshotRows.find((row) => row.dbkey === '1000002').bucket, 'leave_alone_backlog');
  assert.equal(pool.meta.get('ise').row_count, 2);
  assert.equal(pool.meta.get('ise').normalized_row_count, 2);
  assert.equal(pool.meta.get('ise').last_error, null);
});

test('claim: concurrent ingest for same kind is rejected with 409', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });
  const pool = new MemoryTrackerPool();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const snapshotIngest = {
    settingsLoader: async () => ({}),
    sourceFetcher: async () => {
      await firstGate;
      return { prodRows: [prodRow('1000001')], siRows: [siRow('1000001')] };
    },
  };
  await withTrackerServer(pool, snapshotIngest, async (baseUrl) => {
    const post = () => fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [trackerRow('1000001')] }),
    });
    const first = await post();
    assert.equal(first.status, 202);
    const second = await post();
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.match(secondBody.error, /already processing/);
    releaseFirst();
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'ok');
  });
});

test('claim: stuck processing older than threshold is reclaimable', async () => {
  const pool = new MemoryTrackerPool();
  pool.meta.set('ise', {
    workbook_kind: 'ise',
    refreshed_at: new Date().toISOString(),
    row_count: 5,
    normalized_row_count: 5,
    last_error: null,
    si_source: null,
    si_fallback_reason: null,
    ingest_status: 'processing',
    ingest_started_at: new Date(Date.now() - 15 * 60000).toISOString(),
    ingest_completed_at: null,
  });
  const claimed = await claimSnapshotIngest(pool, 'ise');
  assert.equal(claimed, true);
  assert.equal(pool.meta.get('ise').ingest_status, 'processing');
});

test('claim: fresh processing within threshold is NOT reclaimable', async () => {
  const pool = new MemoryTrackerPool();
  pool.meta.set('ise', {
    workbook_kind: 'ise',
    refreshed_at: new Date().toISOString(),
    row_count: 5,
    normalized_row_count: 5,
    last_error: null,
    si_source: null,
    si_fallback_reason: null,
    ingest_status: 'processing',
    ingest_started_at: new Date(Date.now() - 2 * 60000).toISOString(),
    ingest_completed_at: null,
  });
  const claimed = await claimSnapshotIngest(pool, 'ise');
  assert.equal(claimed, false);
});

test('sweep: orphaned processing rows are marked error, settled rows untouched', async () => {
  const pool = new MemoryTrackerPool();
  pool.meta.set('ise', {
    workbook_kind: 'ise',
    refreshed_at: new Date().toISOString(),
    row_count: 5,
    normalized_row_count: 5,
    last_error: null,
    si_source: null,
    si_fallback_reason: null,
    ingest_status: 'processing',
    ingest_started_at: new Date().toISOString(),
    ingest_completed_at: null,
  });
  pool.meta.set('blitz', {
    workbook_kind: 'blitz',
    refreshed_at: new Date().toISOString(),
    row_count: 3,
    normalized_row_count: 3,
    last_error: null,
    si_source: 'grafana',
    si_fallback_reason: null,
    ingest_status: 'ok',
    ingest_started_at: new Date().toISOString(),
    ingest_completed_at: new Date().toISOString(),
  });
  const swept = await sweepStuckSnapshotIngests(pool);
  assert.equal(swept, 1);
  assert.equal(pool.meta.get('ise').ingest_status, 'error');
  assert.match(pool.meta.get('ise').last_error, /interrupted by service restart/);
  assert.equal(pool.meta.get('blitz').ingest_status, 'ok');
});

test('active period window sends current and prior period rows to live reconciliation only', async () => {
  const pool = new MemoryTrackerPool();
  const seen = [];
  const sourceFetcher = async (trackerRows) => {
    seen.push(trackerRows.map((row) => row.periodWeek));
    return {
      prodRows: trackerRows.map((row) => prodRow(row.dbkey, { periodWeek: row.periodWeek })),
      siRows: trackerRows.map((row) => siRow(row.dbkey, { periodWeek: row.periodWeek })),
    };
  };

  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [
      periodRow({ period: 5, week: 1, dbkey: '1000101' }),
      periodRow({ period: 4, week: 4, dbkey: '1000102' }),
      periodRow({ period: 3, week: 4, dbkey: '1000103' }),
    ],
    sourceFetcher,
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  assert.deepEqual(seen, [['P05W1', 'P04W4']]);
  assert.deepEqual(result.bucketCounts, {
    matched_both: 2,
    leave_alone_backlog: 1,
  });
  assert.equal(pool.snapshotRows.length, 3);
  assert.equal(pool.snapshotRows.find((row) => row.dbkey === '1000103').bucket, 'leave_alone_backlog');
});

test('active period window treats P13 as prior period when current period is P01', async () => {
  const pool = new MemoryTrackerPool();
  let liveRows = [];
  const sourceFetcher = async (trackerRows) => {
    liveRows = trackerRows;
    return {
      prodRows: trackerRows.map((row) => prodRow(row.dbkey, { periodWeek: row.periodWeek })),
      siRows: trackerRows.map((row) => siRow(row.dbkey, { periodWeek: row.periodWeek })),
    };
  };

  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [
      periodRow({ period: 1, week: 1, dbkey: '1000201' }),
      periodRow({ period: 13, week: 4, dbkey: '1000202' }),
      periodRow({ period: 12, week: 4, dbkey: '1000203' }),
    ],
    sourceFetcher,
    currentPeriodWeek: currentPeriod(1, 2026),
    settings: {},
    now: new Date('2026-02-02T12:00:00.000Z'),
  });

  assert.deepEqual(liveRows.map((row) => row.periodWeek), ['P01W1', 'P13W4']);
  assert.equal(result.bucketCounts.matched_both, 2);
  assert.equal(result.bucketCounts.leave_alone_backlog, 1);
  assert.equal(pool.snapshotRows.find((row) => row.dbkey === '1000203').bucket, 'leave_alone_backlog');
});

test('unknown period rows are stored distinctly and never sent to live lookup', async () => {
  const pool = new MemoryTrackerPool();
  let sourceCalls = 0;

  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [trackerRow('1000301', { pogId: '1000301' })],
    sourceFetcher: async () => {
      sourceCalls += 1;
      return { prodRows: [], siRows: [] };
    },
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  assert.equal(sourceCalls, 0);
  assert.deepEqual(result.bucketCounts, { unknown_period: 1 });
  assert.equal(pool.snapshotRows.length, 1);
  assert.equal(pool.snapshotRows[0].period_week, '');
  assert.equal(pool.snapshotRows[0].bucket, 'unknown_period');
  assert.equal(pool.snapshotRows[0].bucket_reason, 'Tracker row period could not be parsed; skipped live reconciliation.');
});

test('out-of-window rows are stored as backlog and never sent to live lookup', async () => {
  const pool = new MemoryTrackerPool();
  let sourceCalls = 0;

  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [periodRow({ period: 3, week: 4, dbkey: '1000401' })],
    sourceFetcher: async () => {
      sourceCalls += 1;
      return { prodRows: [], siRows: [] };
    },
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  assert.equal(sourceCalls, 0);
  assert.deepEqual(result.bucketCounts, { leave_alone_backlog: 1 });
  assert.equal(pool.snapshotRows[0].bucket, 'leave_alone_backlog');
  assert.equal(pool.snapshotRows[0].bucket_reason, 'Outside active period window; not reconciled live.');
});

test('mixed window payload passes only active rows live and stores full normalized count', async () => {
  const pool = new MemoryTrackerPool();
  let liveRows = [];
  const sourceFetcher = async (trackerRows) => {
    liveRows = trackerRows;
    return {
      prodRows: trackerRows.map((row) => prodRow(row.dbkey, { periodWeek: row.periodWeek })),
      siRows: trackerRows.map((row) => siRow(row.dbkey, { periodWeek: row.periodWeek })),
    };
  };

  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [
      periodRow({ period: 5, week: 2, dbkey: '1000501' }),
      periodRow({ period: 3, week: 4, dbkey: '1000502' }),
      trackerRow('1000503', { rowIndex: 503, pogId: '1000503' }),
    ],
    sourceFetcher,
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  assert.deepEqual(liveRows.map((row) => row.dbkey), ['1000501']);
  assert.equal(pool.snapshotRows.length, 3);
  assert.equal(pool.meta.get('ise').normalized_row_count, 3);
  assert.deepEqual(result.bucketCounts, {
    matched_both: 1,
    leave_alone_backlog: 1,
    unknown_period: 1,
  });
});

test('calendar failure returns 502, preserves prior snapshot, and stamps active_window error', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [periodRow({ period: 5, week: 2, dbkey: '1000601' })],
    sourceFetcher: async (trackerRows) => ({
      prodRows: trackerRows.map((row) => prodRow(row.dbkey, { periodWeek: row.periodWeek })),
      siRows: trackerRows.map((row) => siRow(row.dbkey, { periodWeek: row.periodWeek })),
    }),
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const beforeRows = pool.snapshotRows.map((row) => ({ ...row }));
  const beforeMeta = { ...pool.meta.get('ise') };

  await withTrackerServer(pool, {
    settingsLoader: async () => ({}),
    sourceFetcher: async () => {
      throw new Error('source should not be called');
    },
    currentPeriodWeek: () => {
      throw new Error('calendar unavailable');
    },
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [periodRow({ period: 5, week: 2, dbkey: '1000602' })] }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /calendar unavailable/);
  });

  assert.deepEqual(pool.snapshotRows, beforeRows);
  assert.equal(pool.meta.get('ise').refreshed_at, beforeMeta.refreshed_at);
  assert.equal(pool.meta.get('ise').row_count, beforeMeta.row_count);
  assert.equal(pool.meta.get('ise').normalized_row_count, beforeMeta.normalized_row_count);
  assert.match(pool.meta.get('ise').last_error, /"stage":"active_window"/);
  assert.match(pool.meta.get('ise').last_error, /calendar unavailable/);
});

test('short-payload guard still evaluates total normalized rows before active-window split', async () => {
  const pool = new MemoryTrackerPool();
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [
      periodRow({ period: 5, week: 2, dbkey: '1000701' }),
      periodRow({ period: 5, week: 2, dbkey: '1000702' }),
      periodRow({ period: 5, week: 2, dbkey: '1000703' }),
      periodRow({ period: 3, week: 4, dbkey: '1000704' }),
      periodRow({ period: 3, week: 4, dbkey: '1000705' }),
      periodRow({ period: 3, week: 4, dbkey: '1000706' }),
      periodRow({ period: 3, week: 4, dbkey: '1000707' }),
      periodRow({ period: 3, week: 4, dbkey: '1000708' }),
      periodRow({ period: 3, week: 4, dbkey: '1000709' }),
      periodRow({ period: 3, week: 4, dbkey: '1000710' }),
    ],
    sourceFetcher: async () => ({ prodRows: [], siRows: [] }),
    currentPeriodWeek: currentPeriod(5),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  await assert.rejects(
    ingestTrackerSnapshot({
      pool,
      workbookKind: 'ise',
      rows: [
        periodRow({ period: 5, week: 2, dbkey: '1000801' }),
        periodRow({ period: 5, week: 2, dbkey: '1000802' }),
        periodRow({ period: 5, week: 2, dbkey: '1000803' }),
        periodRow({ period: 5, week: 2, dbkey: '1000804' }),
        periodRow({ period: 5, week: 2, dbkey: '1000805' }),
      ],
      sourceFetcher: async () => {
        throw new Error('source should not be called');
      },
      currentPeriodWeek: currentPeriod(5),
      settings: {},
      now: new Date('2026-06-08T12:01:00.000Z'),
    }),
    /short_payload/,
  );
  assert.equal(pool.snapshotRows.length, 10);
  assert.equal(pool.meta.get('ise').normalized_row_count, 10);
  assert.match(pool.meta.get('ise').last_error, /"reason":"short_payload"/);
});

test('short-payload guard allows above-floor unforced payloads and updates normalized count', async () => {
  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });

  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(10),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(7, 20),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:01:00.000Z'),
  });

  assert.equal(result.forced, false);
  assert.equal(result.normalizedRows, 7);
  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 7);
  assert.equal(pool.meta.get('ise').row_count, 7);
  assert.equal(pool.meta.get('ise').normalized_row_count, 7);
  assert.equal(pool.meta.get('ise').last_error, null);
});

test('short-payload guard allows exactly 60 percent of last good count', async () => {
  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });

  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(10),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const result = await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(6, 20),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:01:00.000Z'),
  });

  assert.equal(result.forced, false);
  assert.equal(result.normalizedRows, 6);
  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 6);
  assert.equal(pool.meta.get('ise').normalized_row_count, 6);
});

test('short-payload guard rejects below-floor unforced payloads without moving good meta fields', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(10),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const beforeRows = pool.snapshotRows.map((row) => ({ ...row }));
  const beforeMeta = { ...pool.meta.get('ise') };

  await withTrackerServer(pool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: trackerRows(5, 20) }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /"reason":"short_payload"/);
    assert.match(settled.last_error, /"newCount":5/);
  });

  assert.deepEqual(pool.snapshotRows, beforeRows);
  assert.equal(pool.meta.get('ise').refreshed_at, beforeMeta.refreshed_at);
  assert.equal(pool.meta.get('ise').row_count, beforeMeta.row_count);
  assert.equal(pool.meta.get('ise').normalized_row_count, beforeMeta.normalized_row_count);
  assert.match(pool.meta.get('ise').last_error, /"reason":"short_payload"/);
  assert.match(pool.meta.get('ise').last_error, /"newCount":5/);
});

test('short-payload guard allows forced below-floor payloads and emits a log', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  const warnMessages = [];
  t.mock.method(console, 'warn', (...args) => warnMessages.push(args));
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(10),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  await withTrackerServer(pool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: trackerRows(5, 20), force: true }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'ise');
    assert.equal(body.status, 'processing');
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'ok');
  });

  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 5);
  assert.equal(pool.meta.get('ise').normalized_row_count, 5);
  assert.equal(pool.meta.get('ise').last_error, null);
  assert.equal(warnMessages.length, 1);
  assert.match(String(warnMessages[0][0]), /FORCED ingest/);
  assert.equal(warnMessages[0][1].kind, 'ise');
  assert.equal(warnMessages[0][1].newNormalizedCount, 5);
  assert.equal(warnMessages[0][1].lastGoodNormalized, 10);
});

test('short-payload guard rejects zero rows unforced with and without prior snapshot', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });
  const priorPool = new MemoryTrackerPool();
  await ingestTrackerSnapshot({
    pool: priorPool,
    workbookKind: 'ise',
    rows: trackerRows(2),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const beforeRows = priorPool.snapshotRows.map((row) => ({ ...row }));
  const beforeMeta = { ...priorPool.meta.get('ise') };

  await withTrackerServer(priorPool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(priorPool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /"reason":"zero_rows"/);
    assert.match(settled.last_error, /"newCount":0/);
  });
  assert.deepEqual(priorPool.snapshotRows, beforeRows);
  assert.equal(priorPool.meta.get('ise').refreshed_at, beforeMeta.refreshed_at);
  assert.equal(priorPool.meta.get('ise').row_count, beforeMeta.row_count);
  assert.equal(priorPool.meta.get('ise').normalized_row_count, beforeMeta.normalized_row_count);
  assert.match(priorPool.meta.get('ise').last_error, /"reason":"zero_rows"/);

  const emptyPool = new MemoryTrackerPool();
  await withTrackerServer(emptyPool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(emptyPool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /"reason":"zero_rows"/);
    assert.match(settled.last_error, /"newCount":0/);
  });
  assert.equal(emptyPool.snapshotRows.length, 0);
  assert.equal(emptyPool.meta.get('ise').row_count, 0);
  assert.equal(emptyPool.meta.get('ise').normalized_row_count, null);
  assert.match(emptyPool.meta.get('ise').last_error, /"reason":"zero_rows"/);
});

test('short-payload guard allows forced zero rows as a deliberate clear', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(2),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });

  await withTrackerServer(pool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [], force: true }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'ise');
    assert.equal(body.status, 'processing');
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'ok');
  });

  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 0);
  assert.equal(pool.meta.get('ise').row_count, 0);
  assert.equal(pool.meta.get('ise').normalized_row_count, 0);
  assert.equal(pool.meta.get('ise').last_error, null);
});

test('short-payload guard rejects ise without touching blitz snapshot or meta', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'blitz',
    rows: trackerRows(3, 1, { setType: 'Blitz' }),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: trackerRows(10, 20),
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:01:00.000Z'),
  });
  const blitzRows = pool.snapshotRows.filter((row) => row.workbook_kind === 'blitz').map((row) => ({ ...row }));
  const blitzMeta = { ...pool.meta.get('blitz') };

  await withTrackerServer(pool, { sourceFetcher, settingsLoader: async () => ({}) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: trackerRows(5, 40) }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /short_payload/);
  });

  assert.deepEqual(pool.snapshotRows.filter((row) => row.workbook_kind === 'blitz'), blitzRows);
  assert.deepEqual(pool.meta.get('blitz'), blitzMeta);
  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 10);
  assert.match(pool.meta.get('ise').last_error, /short_payload/);
});

test('per-kind replace removes ghosts without touching the other workbook kind', async () => {
  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });

  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'blitz',
    rows: [trackerRow('9000001', { setType: 'Blitz' })],
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [trackerRow('1000001'), trackerRow('1000002'), trackerRow('1000003')],
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:01:00.000Z'),
  });
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [trackerRow('1000001'), trackerRow('1000002')],
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:02:00.000Z'),
  });

  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 2);
  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'blitz').length, 1);
  assert.equal(pool.snapshotRows.some((row) => row.workbook_kind === 'ise' && row.dbkey === '1000003'), false);
  assert.equal(pool.meta.get('ise').row_count, 2);
  assert.equal(pool.meta.get('ise').last_error, null);
});

test('mid-replace insert failure rolls back the delete and preserves prior snapshot', async () => {
  const pool = new MemoryTrackerPool();
  const sourceFetcher = async () => ({ prodRows: [], siRows: [] });

  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [trackerRow('1000001'), trackerRow('1000002')],
    sourceFetcher,
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const beforeRows = pool.snapshotRows.map((row) => ({ ...row }));

  pool.failNextSnapshotInsert = true;
  await assert.rejects(
    ingestTrackerSnapshot({
      pool,
      workbookKind: 'ise',
      rows: [trackerRow('1000003'), trackerRow('1000004')],
      sourceFetcher,
      settings: {},
      now: new Date('2026-06-08T12:01:00.000Z'),
    }),
    /forced snapshot insert failure/,
  );

  assert.deepEqual(pool.snapshotRows, beforeRows);
  assert.equal(pool.snapshotRows.filter((row) => row.workbook_kind === 'ise').length, 2);
  assert.equal(pool.snapshotRows.some((row) => row.dbkey === '1000003'), false);
  assert.equal(pool.meta.get('ise').row_count, 2);
  assert.match(pool.meta.get('ise').last_error, /forced snapshot insert failure/);
});

test('reconciliation failure returns 502 and leaves the previous snapshot intact', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const pool = new MemoryTrackerPool();
  await ingestTrackerSnapshot({
    pool,
    workbookKind: 'ise',
    rows: [trackerRow('1000001')],
    sourceFetcher: async () => ({ prodRows: [prodRow('1000001')], siRows: [siRow('1000001')] }),
    settings: {},
    now: new Date('2026-06-08T12:00:00.000Z'),
  });
  const beforeRows = pool.snapshotRows.map((row) => ({ ...row }));

  await withTrackerServer(pool, {
    settingsLoader: async () => ({}),
    sourceFetcher: async () => {
      throw new Error('compare unavailable');
    },
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [trackerRow('1000002')] }),
    });
    assert.equal(res.status, 202);
    const settled = await waitForIngestSettled(pool, 'ise');
    assert.equal(settled.ingest_status, 'error');
    assert.match(settled.last_error, /compare unavailable/);
  });

  assert.deepEqual(pool.snapshotRows, beforeRows);
  assert.equal(pool.meta.get('ise').row_count, 1);
  assert.match(pool.meta.get('ise').last_error, /compare unavailable/);
});
