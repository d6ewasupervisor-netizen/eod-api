'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SiGrafanaSessionError,
  fetchSiRowsViaGrafana,
  fetchQuery46Payload,
  DATASOURCE_UID,
  DATASOURCE_TYPE,
} = require('../src/lib/trackers/si-grafana-source');

const ROOT = path.resolve(__dirname, '..');
const SI_FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'si-p05w3-query46.raw.json');
const RAW_SQL = 'SELECT 1; -- query46 stand-in for hermetic transport test';

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Builds a fake fetch-like transport returning a single canned response and
// recording exactly what the module sent. No network is ever touched.
function fakeTransport(response) {
  const calls = [];
  async function transport(url, init) {
    calls.push({ url, init });
    return response;
  }
  transport.calls = calls;
  return transport;
}

// Minimal Response stand-in matching the subset the module reads:
// .status, .ok, .headers.get('content-type'), .text().
function makeResponse({ status = 200, contentType = 'application/json', body = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

const okPayload = loadJson(SI_FIXTURE_PATH);

test('happy path: frozen payload normalizes to the proven 2306 rows', async () => {
  const transport = fakeTransport(makeResponse({ body: okPayload }));
  const rows = await fetchSiRowsViaGrafana({
    rawSql: RAW_SQL,
    getGrafanaCookie: () => 'grafana_session=live; grafana_session_expiry=9999999999',
    transport,
  });
  assert.equal(rows.length, 2306);
  const bagSnacks = rows.find((row) => row.categoryId === '55');
  assert.ok(bagSnacks, 'expected the 055-BAG SNACKS row to survive normalization with categoryId 55');
  assert.equal(transport.calls.length, 1, 'transport should be called exactly once on the happy path');
});

test('request body and headers exactly match the proven Grafana shape', async () => {
  const transport = fakeTransport(makeResponse({ body: okPayload }));
  const fixedNow = 1_700_000_000_000;
  await fetchSiRowsViaGrafana({
    rawSql: RAW_SQL,
    getGrafanaCookie: () => 'grafana_session=live',
    transport,
    now: () => fixedNow,
  });
  const { init } = transport.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Cookie, 'grafana_session=live');
  assert.equal(init.headers['x-datasource-uid'], DATASOURCE_UID);
  assert.equal(init.headers['x-grafana-org-id'], '1');
  assert.equal(init.headers['x-plugin-id'], DATASOURCE_TYPE);

  const sent = JSON.parse(init.body);
  assert.equal(Number(sent.to) - Number(sent.from), 21600000, 'window must be exactly 6h');
  assert.equal(Number(sent.to), fixedNow);
  assert.equal(sent.queries.length, 1);
  assert.equal(sent.queries[0].refId, 'A');
  assert.equal(sent.queries[0].format, 'table');
  assert.equal(sent.queries[0].datasource.uid, DATASOURCE_UID);
  assert.equal(sent.queries[0].datasource.type, DATASOURCE_TYPE);
  assert.equal(sent.queries[0].rawSql, RAW_SQL);
});

test('null cookie throws SiGrafanaSessionError before any transport call', async () => {
  const transport = fakeTransport(makeResponse({ body: okPayload }));
  await assert.rejects(
    () => fetchSiRowsViaGrafana({
      rawSql: RAW_SQL,
      getGrafanaCookie: () => null,
      transport,
    }),
    (err) => err instanceof SiGrafanaSessionError,
  );
  assert.equal(transport.calls.length, 0, 'transport must never be called when the cookie is null');
});

for (const status of [302, 401, 403]) {
  test(`HTTP ${status} throws SiGrafanaSessionError`, async () => {
    const transport = fakeTransport(makeResponse({ status, body: '' }));
    await assert.rejects(
      () => fetchQuery46Payload({ rawSql: RAW_SQL, cookie: 'grafana_session=stale', transport }),
      (err) => err instanceof SiGrafanaSessionError,
    );
  });
}

test('HTML login body (200) throws SiGrafanaSessionError', async () => {
  const transport = fakeTransport(makeResponse({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Grafana</title></head><body>login</body></html>',
  }));
  await assert.rejects(
    () => fetchQuery46Payload({ rawSql: RAW_SQL, cookie: 'grafana_session=stale', transport }),
    (err) => err instanceof SiGrafanaSessionError,
  );
});

test('results.A.status 401 in a 200 body throws SiGrafanaSessionError', async () => {
  const transport = fakeTransport(makeResponse({
    status: 200,
    body: { results: { A: { status: 401 } } },
  }));
  await assert.rejects(
    () => fetchQuery46Payload({ rawSql: RAW_SQL, cookie: 'grafana_session=stale', transport }),
    (err) => err instanceof SiGrafanaSessionError,
  );
});

test('query-level error throws a generic Error, NOT a session error', async () => {
  const transport = fakeTransport(makeResponse({
    status: 200,
    body: { results: { A: { error: 'relation "query46" does not exist' } } },
  }));
  await assert.rejects(
    () => fetchQuery46Payload({ rawSql: RAW_SQL, cookie: 'grafana_session=live', transport }),
    (err) => err instanceof Error && !(err instanceof SiGrafanaSessionError),
  );
});

test('non-JSON 200 body throws a generic Error', async () => {
  const transport = fakeTransport(makeResponse({
    status: 200,
    contentType: 'application/json',
    body: 'not json at all',
  }));
  await assert.rejects(
    () => fetchQuery46Payload({ rawSql: RAW_SQL, cookie: 'grafana_session=live', transport }),
    (err) => err instanceof Error && !(err instanceof SiGrafanaSessionError),
  );
});
