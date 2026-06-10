'use strict';

const fs = require('node:fs');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrackersRouter } = require('../src/routes/trackers');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackers.js'), 'utf8');

test('/trackers pages remain public in the global gate', () => {
  assert.match(indexSource, /'\/trackers'/);
  assert.match(indexSource, /'\/trackers\/admin'/);
  assert.match(indexSource, /'\/trackers\/assets\/'/);
});

test('/api/trackers remains mounted through the tracker router', () => {
  assert.match(indexSource, /app\.use\('\/api\/trackers', createTrackersRouter\(\{ pool \}\)\)/);
});

test('/api/trackers/snapshot/ingest is public to the global gate', () => {
  assert.match(indexSource, /'\/api\/trackers\/snapshot\/ingest'/);
});

test('tracker API router keeps requireAuth before tracker access checks', () => {
  const authIndex = routerSource.indexOf('router.use(requireAuth)');
  const accessIndex = routerSource.indexOf('router.use(requireTrackerAccess)');

  assert.notEqual(authIndex, -1);
  assert.notEqual(accessIndex, -1);
  assert.ok(authIndex < accessIndex);
});

test('tracker ingest route is registered before tracker user auth', () => {
  const ingestIndex = routerSource.indexOf("router.post('/snapshot/ingest'");
  const authIndex = routerSource.indexOf('router.use(requireAuth)');

  assert.notEqual(ingestIndex, -1);
  assert.notEqual(authIndex, -1);
  assert.ok(ingestIndex < authIndex);
});

test('unauthenticated tracker ingest reaches bearer guard, not session auth', async (t) => {
  const originalToken = process.env.TRACKER_INGEST_TOKEN;
  process.env.TRACKER_INGEST_TOKEN = 'secret';
  t.after(() => {
    if (originalToken == null) delete process.env.TRACKER_INGEST_TOKEN;
    else process.env.TRACKER_INGEST_TOKEN = originalToken;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/trackers', createTrackersRouter({
    pool: {
      query: async () => ({ rows: [] }),
    },
    snapshotIngest: {
      settingsLoader: async () => ({}),
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trackers/snapshot/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workbookKind: 'ise', rows: [] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid tracker ingest token');
    assert.notEqual(body.error, 'Sign in required');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function makeMetaPool() {
  return {
    query: async (sql) => {
      if (sql.includes('refreshed_at, row_count')) {
        return {
          rows: [{
            refreshed_at: new Date(Date.now() - 5 * 60000).toISOString(),
            row_count: 42,
            normalized_row_count: 42,
            last_error: null,
          }],
        };
      }
      if (sql.includes('si_source, si_fallback_reason')) {
        return {
          rows: [{
            si_source: 'grafana',
            si_fallback_reason: null,
            ingest_status: 'ok',
            ingest_started_at: null,
            ingest_completed_at: new Date(Date.now() - 2 * 60000).toISOString(),
            ingest_heartbeat_at: null,
            ingest_stage: null,
          }],
        };
      }
      return { rows: [] };
    },
  };
}

async function withMetaServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/trackers', createTrackersRouter({
    pool: makeMetaPool(),
    snapshotIngest: { settingsLoader: async () => ({}) },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function setEnvToken(t, name, value) {
  const original = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (original == null) delete process.env[name];
    else process.env[name] = original;
  });
}

test('snapshot meta returns 503 when TRACKER_META_TOKEN is not configured', async (t) => {
  setEnvToken(t, 'TRACKER_META_TOKEN', null);
  await withMetaServer(async (base) => {
    const res = await fetch(`${base}/api/trackers/snapshot/meta?workbookKind=ise`, {
      headers: { Authorization: 'Bearer anything' },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'Tracker meta token is not configured');
  });
});

test('snapshot meta returns 401 on wrong or missing bearer', async (t) => {
  setEnvToken(t, 'TRACKER_META_TOKEN', 'meta-secret');
  await withMetaServer(async (base) => {
    const wrong = await fetch(`${base}/api/trackers/snapshot/meta?workbookKind=ise`, {
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);
    const missing = await fetch(`${base}/api/trackers/snapshot/meta?workbookKind=ise`);
    assert.equal(missing.status, 401);
    const body = await wrong.json();
    assert.equal(body.error, 'Invalid tracker meta token');
  });
});

test('snapshot meta rejects the ingest token - no credential crossover', async (t) => {
  setEnvToken(t, 'TRACKER_META_TOKEN', 'meta-secret');
  setEnvToken(t, 'TRACKER_INGEST_TOKEN', 'ingest-secret');
  await withMetaServer(async (base) => {
    const res = await fetch(`${base}/api/trackers/snapshot/meta?workbookKind=ise`, {
      headers: { Authorization: 'Bearer ingest-secret' },
    });
    assert.equal(res.status, 401);
  });
});

test('snapshot meta returns meta block only with valid token - no rows key', async (t) => {
  setEnvToken(t, 'TRACKER_META_TOKEN', 'meta-secret');
  await withMetaServer(async (base) => {
    const res = await fetch(`${base}/api/trackers/snapshot/meta?workbookKind=ise`, {
      headers: { Authorization: 'Bearer meta-secret' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.workbookKind, 'ise');
    assert.equal(body.meta.siSource, 'grafana');
    assert.equal(body.meta.stale, false);
    assert.equal('rows' in body, false);
  });
});

test('/api/trackers/snapshot/meta is public to the global gate', () => {
  assert.match(indexSource, /'\/api\/trackers\/snapshot\/meta'/);
});

test('tracker meta route is registered before tracker user auth', () => {
  const metaIndex = routerSource.indexOf("router.get('/snapshot/meta'");
  const authIndex = routerSource.indexOf('router.use(requireAuth)');
  assert.notEqual(metaIndex, -1);
  assert.notEqual(authIndex, -1);
  assert.ok(metaIndex < authIndex);
});
