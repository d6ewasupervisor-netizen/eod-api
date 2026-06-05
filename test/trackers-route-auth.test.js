'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

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

test('tracker API router keeps requireAuth before tracker access checks', () => {
  const authIndex = routerSource.indexOf('router.use(requireAuth)');
  const accessIndex = routerSource.indexOf('router.use(requireTrackerAccess)');

  assert.notEqual(authIndex, -1);
  assert.notEqual(accessIndex, -1);
  assert.ok(authIndex < accessIndex);
});
