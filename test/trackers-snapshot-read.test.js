const test = require('node:test');
const assert = require('node:assert/strict');

const { loadSnapshotRows } = require('../src/lib/trackers/snapshot-ingest');

function makeFakePool({ metaRow, sourceRow, dataRows }) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('refreshed_at, row_count')) {
        return { rows: metaRow ? [metaRow] : [] };
      }
      if (sql.includes('si_source, si_fallback_reason')) {
        return { rows: sourceRow ? [sourceRow] : [] };
      }
      if (sql.includes('FROM tracker_snapshot_rows')) {
        return { rows: dataRows || [] };
      }
      throw new Error('Unexpected query: ' + sql);
    },
  };
}

const DATA_ROW = {
  store: '70123',
  period_week: 'P05W3',
  category_id: 55,
  dbkey: '12345',
  row_index: 7,
  set_type: 'ISE',
  current_k: 'Yes',
  current_l: null,
  bucket: 'done',
  bucket_reason: null,
  expectation: null,
  refreshed_at: '2026-06-09T12:00:00.000Z',
};

test('loadSnapshotRows: missing workbookKind throws 400', async () => {
  const pool = makeFakePool({});
  await assert.rejects(() => loadSnapshotRows(pool, {}), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('loadSnapshotRows: maps columns to camelCase, categoryId is a string', async () => {
  const recent = new Date(Date.now() - 5 * 60000).toISOString();
  const pool = makeFakePool({
    metaRow: { refreshed_at: recent, row_count: 1, normalized_row_count: 1, last_error: null },
    sourceRow: { si_source: 'grafana', si_fallback_reason: null },
    dataRows: [DATA_ROW],
  });
  const result = await loadSnapshotRows(pool, { workbookKind: 'ise' });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.categoryId, '55');
  assert.equal(typeof row.categoryId, 'string');
  assert.equal(row.periodWeek, 'P05W3');
  assert.equal(row.bucketReason, null);
  assert.equal(result.meta.siSource, 'grafana');
  assert.equal(result.meta.stale, false);
});

test('loadSnapshotRows: stale after 20 minutes', async () => {
  const old = new Date(Date.now() - 25 * 60000).toISOString();
  const pool = makeFakePool({
    metaRow: { refreshed_at: old, row_count: 1, normalized_row_count: 1, last_error: null },
    sourceRow: {},
    dataRows: [DATA_ROW],
  });
  const result = await loadSnapshotRows(pool, { workbookKind: 'ise' });
  assert.equal(result.meta.stale, true);
  assert.ok(result.meta.ageMinutes >= 25);
});

test('loadSnapshotRows: no meta row means stale true, never silently fresh', async () => {
  const pool = makeFakePool({ metaRow: null, sourceRow: null, dataRows: [] });
  const result = await loadSnapshotRows(pool, { workbookKind: 'blitz' });
  assert.equal(result.meta.stale, true);
  assert.equal(result.meta.refreshedAt, null);
  assert.equal(result.meta.ageMinutes, null);
  assert.deepEqual(result.rows, []);
});

test('loadSnapshotRows: filters appear in SQL with ordered params', async () => {
  const pool = makeFakePool({
    metaRow: { refreshed_at: new Date().toISOString(), row_count: 0, normalized_row_count: 0, last_error: null },
    sourceRow: {},
    dataRows: [],
  });
  await loadSnapshotRows(pool, {
    workbookKind: 'ise',
    setType: 'Blitz',
    store: '70123',
    periodWeek: 'P05W3',
  });
  const dataQuery = pool.queries.find((q) => q.sql.includes('FROM tracker_snapshot_rows'));
  assert.ok(dataQuery.sql.includes('set_type = $2'));
  assert.ok(dataQuery.sql.includes('store = $3'));
  assert.ok(dataQuery.sql.includes('period_week = $4'));
  assert.deepEqual(dataQuery.params, ['ise', 'Blitz', '70123', 'P05W3']);
});

test('loadSnapshotRows: fallback source surfaces in meta', async () => {
  const pool = makeFakePool({
    metaRow: { refreshed_at: new Date().toISOString(), row_count: 1, normalized_row_count: 1, last_error: null },
    sourceRow: { si_source: 'si-api-fallback', si_fallback_reason: 'cookie expired' },
    dataRows: [DATA_ROW],
  });
  const result = await loadSnapshotRows(pool, { workbookKind: 'ise' });
  assert.equal(result.meta.siSource, 'si-api-fallback');
  assert.match(result.meta.siFallbackReason, /cookie expired/);
});
