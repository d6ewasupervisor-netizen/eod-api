'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyResponse,
  processKind,
  resolveForceSet,
  shouldSkipLocal,
} = require('./run');

function testConfig(overrides = {}) {
  return {
    apiBaseUrl: 'https://example.test',
    token: 'secret-token',
    workbookPaths: {
      ise: 'C:\\Trackers\\ISE.xlsm',
      blitz: 'C:\\Trackers\\Blitz.xlsx',
    },
    forceKinds: new Set(),
    localFloor: 50,
    retryDelayMs: 0,
    ...overrides,
  };
}

function testLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

test('resolveForceSet merges env and repeated CLI flags', () => {
  assert.deepEqual([...resolveForceSet({}, [])], []);
  assert.deepEqual([...resolveForceSet({ TRACKER_INGEST_FORCE_KIND: 'ise' }, [])], ['ise']);
  assert.deepEqual([...resolveForceSet({}, ['--force-kind', 'blitz'])], ['blitz']);
  assert.deepEqual(
    [...resolveForceSet({ TRACKER_INGEST_FORCE_KIND: 'ise' }, ['--force-kind', 'blitz', '--force-kind=ise'])].sort(),
    ['blitz', 'ise'],
  );
});

test('shouldSkipLocal enforces floor unless forced', () => {
  assert.deepEqual(shouldSkipLocal({ rowsLength: 0, forced: false, floor: 50 }), { skip: true, reason: 'zero_rows' });
  assert.deepEqual(shouldSkipLocal({ rowsLength: 49, forced: false, floor: 50 }), { skip: true, reason: 'below_local_floor' });
  assert.deepEqual(shouldSkipLocal({ rowsLength: 50, forced: false, floor: 50 }), { skip: false, reason: null });
  assert.deepEqual(shouldSkipLocal({ rowsLength: 51, forced: false, floor: 50 }), { skip: false, reason: null });
  assert.deepEqual(shouldSkipLocal({ rowsLength: 0, forced: true, floor: 50 }), { skip: false, reason: null });
  assert.deepEqual(shouldSkipLocal({ rowsLength: 49, forced: true, floor: 50 }), { skip: false, reason: null });
});

test('classifyResponse summarizes ingest endpoint outcomes', () => {
  assert.deepEqual(classifyResponse(200, {
    kind: 'ise',
    rowsStored: 10,
    normalizedRows: 10,
    forced: false,
    bucketCounts: { matched_both: 2 },
  }), {
    ok: true,
    kind: 'ise',
    outcome: 'posted',
    bucketCounts: { matched_both: 2 },
    rowsStored: 10,
    normalizedRows: 10,
    forced: false,
  });
  assert.deepEqual(classifyResponse(409, {
    reason: 'short_payload',
    newCount: 5,
    lastGood: 10,
    floorRatio: 0.6,
  }), {
    ok: false,
    outcome: 'rejected',
    reason: 'short_payload',
    newCount: 5,
    lastGood: 10,
    floorRatio: 0.6,
  });
  assert.equal(classifyResponse(401, { error: 'bad token' }).outcome, 'auth_or_config_error');
  assert.equal(classifyResponse(503, { error: 'token unset' }).outcome, 'auth_or_config_error');
  assert.equal(classifyResponse(502, { error: 'compare failed' }).outcome, 'post_failed');
});

test('failed read retries once and never attempts POST, even when forced', async () => {
  let readAttempts = 0;
  let postAttempts = 0;
  const result = await processKind({
    kindConfig: { kind: 'ise' },
    config: testConfig({ forceKinds: new Set(['ise']) }),
    logger: testLogger(),
    reader: async () => {
      readAttempts += 1;
      throw new Error('workbook locked');
    },
    fetchImpl: async () => {
      postAttempts += 1;
      throw new Error('POST should not be called');
    },
  });

  assert.equal(readAttempts, 2);
  assert.equal(postAttempts, 0);
  assert.equal(result.kind, 'ise');
  assert.equal(result.outcome, 'read_failed_skipped');
  assert.equal(result.posted, false);
  assert.equal(result.forced, true);
});

test('successful forced zero-row read proceeds to POST with force true', async () => {
  let postBody = null;
  const result = await processKind({
    kindConfig: { kind: 'ise' },
    config: testConfig({ forceKinds: new Set(['ise']) }),
    logger: testLogger(),
    reader: async () => [],
    fetchImpl: async (_url, options) => {
      postBody = JSON.parse(options.body);
      return {
        status: 200,
        json: async () => ({ ok: true, kind: 'ise', rowsStored: 0, normalizedRows: 0, forced: true, bucketCounts: {} }),
      };
    },
  });

  assert.deepEqual(postBody, { workbookKind: 'ise', rows: [], force: true });
  assert.equal(result.posted, true);
  assert.equal(result.status, 200);
  assert.equal(result.forced, true);
});

test('successful unforced zero-row read skips locally and does not POST', async () => {
  let postAttempts = 0;
  const result = await processKind({
    kindConfig: { kind: 'ise' },
    config: testConfig(),
    logger: testLogger(),
    reader: async () => [],
    fetchImpl: async () => {
      postAttempts += 1;
      throw new Error('POST should not be called');
    },
  });

  assert.equal(postAttempts, 0);
  assert.equal(result.outcome, 'local_floor_skipped');
  assert.equal(result.reason, 'zero_rows');
  assert.equal(result.posted, false);
});
