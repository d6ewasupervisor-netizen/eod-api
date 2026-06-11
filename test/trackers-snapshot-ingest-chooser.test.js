const test = require('node:test');
const assert = require('node:assert/strict');

const { defaultFetchSourceRows, periodWeekToRange } = require('../src/lib/trackers/snapshot-ingest');
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

test('timing: grafana primary success records one siGrafanaMs and one prodRanges entry', async () => {
  const { options } = makeSeams({
    grafanaImpl: () => [{ periodWeek: 'P05W3', storeNumber: '70123' }],
  });
  const timingCollector = {};
  await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: true,
    timingCollector,
  });
  assert.equal(typeof timingCollector.siGrafanaMs, 'number');
  assert.ok(timingCollector.siGrafanaMs >= 0);
  assert.equal(timingCollector.prodRanges.length, 1);
  assert.equal(timingCollector.slowSiRanges.length, 0);
  const entry = timingCollector.prodRanges[0];
  assert.equal(entry.dateFrom !== undefined, true);
  assert.equal(entry.dateTo !== undefined, true);
  assert.equal(typeof entry.prodRows, 'number');
  assert.equal(typeof entry.ms, 'number');
  assert.equal(typeof timingCollector.sourceFetchMs, 'number');
});

test('timing: multi-period rows record one prodRanges entry per range, order preserved', async () => {
  const multiPeriodRows = [
    { store: '70123', periodWeek: 'P05W2' },
    { store: '70456', periodWeek: 'P05W3' },
  ];
  const { options } = makeSeams({
    grafanaImpl: () => [],
  });
  const timingCollector = {};
  await defaultFetchSourceRows(multiPeriodRows, {
    ...options,
    grafanaPrimary: true,
    timingCollector,
  });
  const expectedRanges = [...new Set(multiPeriodRows.map((r) => r.periodWeek))];
  assert.equal(timingCollector.prodRanges.length, expectedRanges.length);
  const seenFrom = timingCollector.prodRanges.map((e) => e.dateFrom);
  assert.equal(new Set(seenFrom).size, expectedRanges.length);
  assert.equal(timingCollector.slowSiRanges.length, 0);
});

test('timing: stale grafana fallback records siGrafanaMs plus per-range slowSiRanges', async () => {
  const { options } = makeSeams({
    grafanaImpl: () => {
      throw new SiGrafanaSessionError('cookie expired timing test');
    },
  });
  const timingCollector = {};
  const result = await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: true,
    timingCollector,
  });
  assert.equal(result.siSourceInfo.siSource, 'si-api-fallback');
  assert.equal(typeof timingCollector.siGrafanaMs, 'number');
  assert.ok(timingCollector.siGrafanaMs >= 0);
  assert.equal(timingCollector.prodRanges.length, 1);
  assert.equal(timingCollector.slowSiRanges.length, 1);
  const entry = timingCollector.slowSiRanges[0];
  assert.equal(typeof entry.siRows, 'number');
  assert.equal(typeof entry.ms, 'number');
});

test('substage: grafana primary fires si-grafana then one prod stage for single range', async () => {
  const { options } = makeSeams({
    grafanaImpl: () => [{ periodWeek: 'P05W3', storeNumber: '70123' }],
  });
  const stages = [];
  await defaultFetchSourceRows(TRACKER_ROWS, {
    ...options,
    grafanaPrimary: true,
    onStage: (label) => stages.push(label),
  });
  assert.deepEqual(stages, ['fetching:si-grafana', 'fetching:prod:1-of-1-done']);
});

test('substage: multi-period fires si-grafana then one prod stage per range in order', async () => {
  const multiPeriodRows = [
    { store: '70123', periodWeek: 'P05W2' },
    { store: '70456', periodWeek: 'P05W3' },
  ];
  const { options } = makeSeams({
    grafanaImpl: () => [],
  });
  const stages = [];
  await defaultFetchSourceRows(multiPeriodRows, {
    ...options,
    grafanaPrimary: true,
    onStage: (label) => stages.push(label),
  });
  const expectedRanges = [...new Set(multiPeriodRows.map((r) => r.periodWeek))];
  assert.equal(stages[0], 'fetching:si-grafana');
  assert.equal(stages.length, 1 + expectedRanges.length);
  for (let i = 0; i < expectedRanges.length; i += 1) {
    assert.equal(stages[i + 1], `fetching:prod:${i + 1}-of-${expectedRanges.length}-done`);
  }
});

test('range concurrency 1 (default) fetches ranges sequentially, peak in-flight is 1', async () => {
  const multiPeriodRows = [
    { store: '70123', periodWeek: 'P05W1' },
    { store: '70456', periodWeek: 'P05W2' },
    { store: '70789', periodWeek: 'P05W3' },
  ];
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchProdRows = async ({ dateFrom }) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return [{ tag: dateFrom }];
  };
  const timingCollector = {};
  const result = await defaultFetchSourceRows(multiPeriodRows, {
    settings: {},
    grafanaPrimary: true,
    fetchSiGrafana: async () => [],
    fetchProdRows,
    fetchSlowSiRows: async () => [],
    timingCollector,
  });
  assert.equal(peakInFlight, 1, 'default range concurrency must keep ranges sequential');
  assert.equal(timingCollector.rangeConcurrency, 1);
  assert.equal(result.prodRows.length, 3);
});

test('range concurrency 2 overlaps ranges (peak in-flight 2) and preserves range order in output', async () => {
  const multiPeriodRows = [
    { store: '70123', periodWeek: 'P05W1' },
    { store: '70456', periodWeek: 'P05W2' },
    { store: '70789', periodWeek: 'P05W3' },
  ];
  let inFlight = 0;
  let peakInFlight = 0;
  const delayByRange = { '2026-04-26': 40, '2026-05-03': 10, '2026-05-10': 25 };
  const fetchProdRows = async ({ dateFrom }) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const delay = delayByRange[dateFrom] ?? 15;
    await new Promise((resolve) => setTimeout(resolve, delay));
    inFlight -= 1;
    return [{ tag: dateFrom }];
  };
  const timingCollector = {};
  const result = await defaultFetchSourceRows(multiPeriodRows, {
    settings: { sasRangeConcurrency: 2 },
    grafanaPrimary: true,
    fetchSiGrafana: async () => [],
    fetchProdRows,
    fetchSlowSiRows: async () => [],
    timingCollector,
  });
  assert.equal(timingCollector.rangeConcurrency, 2);
  assert.equal(peakInFlight, 2, 'range concurrency 2 must run two ranges at once');
  assert.equal(result.prodRows.length, 3);
  const timingOrder = timingCollector.prodRanges.map((entry) => entry.dateFrom);
  const sortedRanges = [...new Set(multiPeriodRows.map((r) => r.periodWeek))]
    .map(periodWeekToRange)
    .filter(Boolean)
    .map((range) => range.dateFrom);
  assert.deepEqual(timingOrder, sortedRanges,
    'prodRanges must be in range order even when ranges complete out of order');
});

test('range concurrency 2: one range failure rejects the fetch with no partial rows', async () => {
  const multiPeriodRows = [
    { store: '70123', periodWeek: 'P05W1' },
    { store: '70456', periodWeek: 'P05W2' },
    { store: '70789', periodWeek: 'P05W3' },
  ];
  let prodCalls = 0;
  const fetchProdRows = async ({ dateFrom }) => {
    prodCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (dateFrom === periodWeekToRange('P05W2').dateFrom) {
      throw new Error('SAS range fetch failed under outer concurrency');
    }
    return [{ tag: dateFrom }];
  };
  const timingCollector = {};
  await assert.rejects(
    () => defaultFetchSourceRows(multiPeriodRows, {
      settings: { sasRangeConcurrency: 2 },
      grafanaPrimary: true,
      fetchSiGrafana: async () => [],
      fetchProdRows,
      fetchSlowSiRows: async () => [],
      timingCollector,
    }),
    /SAS range fetch failed under outer concurrency/,
  );
  assert.ok(prodCalls >= 1, 'at least one range fetch must have started');
});
