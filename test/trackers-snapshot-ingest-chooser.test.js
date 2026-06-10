const test = require('node:test');
const assert = require('node:assert/strict');

const { defaultFetchSourceRows } = require('../src/lib/trackers/snapshot-ingest');
const { SiGrafanaSessionError } = require('../src/lib/trackers/si-grafana-source');

const TRACKER_ROWS = [
  { store: '70123', periodWeek: 'P05W3' },
  { store: '70456', periodWeek: 'P05W3' },
];

function makeSeams({ grafanaImpl } = {}) {
  const calls = { grafana: 0, prod: 0, slowSi: 0 };
  return {
    calls,
    options: {
      settings: {},
      fetchSiGrafana: async (args) => {
        calls.grafana += 1;
        if (grafanaImpl) return grafanaImpl(args);
        return [];
      },
      fetchProdRows: async () => {
        calls.prod += 1;
        return [{ prod: true }];
      },
      fetchSlowSiRows: async () => {
        calls.slowSi += 1;
        return [{ slowSi: true }];
      },
    },
  };
}

test('chooser: flag off - slow path runs, siSource is si-api, grafana never called', async () => {
  const { calls, options } = makeSeams();
  const result = await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: false,
  });
  assert.equal(calls.grafana, 0);
  assert.equal(calls.prod, 1);
  assert.equal(calls.slowSi, 1);
  assert.equal(result.siSourceInfo.siSource, 'si-api');
  assert.equal(result.siSourceInfo.siFallbackReason, null);
  assert.deepEqual(result.siRows, [{ slowSi: true }]);
  assert.deepEqual(result.prodRows, [{ prod: true }]);
});

test('chooser: grafana primary success - grafana rows used, slow SI never called, canonical SQL passed', async () => {
  const grafanaRows = [
    { periodWeek: 'P05W3', storeNumber: '70123', categoryId: '55', dbkey: '12345', status: 'Completed' },
  ];
  const { calls, options } = makeSeams({
    grafanaImpl: ({ rawSql }) => {
      assert.ok(rawSql && rawSql.includes('kompass compliance report'), 'canonical query46.sql is passed');
      return grafanaRows;
    },
  });
  const result = await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: true,
  });
  assert.equal(calls.grafana, 1);
  assert.equal(calls.prod, 1);
  assert.equal(calls.slowSi, 0);
  assert.equal(result.siSourceInfo.siSource, 'grafana');
  assert.equal(result.siSourceInfo.siFallbackReason, null);
  assert.deepEqual(result.siRows, grafanaRows);
});

test('chooser: stale session - falls back to slow SI loudly, source and reason recorded', async () => {
  const { calls, options } = makeSeams({
    grafanaImpl: () => {
      throw new SiGrafanaSessionError('cookie expired test');
    },
  });
  const result = await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: true,
  });
  assert.equal(calls.grafana, 1);
  assert.equal(calls.slowSi, 1, 'fallback must reach the slow SI path');
  assert.equal(result.siSourceInfo.siSource, 'si-api-fallback');
  assert.match(result.siSourceInfo.siFallbackReason, /cookie expired test/);
  assert.deepEqual(result.siRows, [{ slowSi: true }]);
});

test('chooser: non-session grafana error - rethrows, slow path never substituted', async () => {
  const { calls, options } = makeSeams({
    grafanaImpl: () => {
      throw new Error('query broke');
    },
  });
  await assert.rejects(
    () => defaultFetchSourceRows(TRACKER_ROWS, {
      ...options,
      grafanaPrimary: true,
    }),
    /query broke/,
  );
  assert.equal(calls.slowSi, 0, 'broken query must not silently fall back');
});

test('chooser: empty tracker rows - early return with inert si-api source info', async () => {
  const { calls, options } = makeSeams();
  const result = await defaultFetchSourceRows([], { ...options, grafanaPrimary: true });
  assert.equal(calls.grafana, 0);
  assert.equal(calls.prod, 0);
  assert.deepEqual(result, { prodRows: [], siRows: [], siSourceInfo: { siSource: 'si-api', siFallbackReason: null } });
});
