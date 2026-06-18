'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const reboticsBridge = require('../src/rebotics-bridge');
const reboticsReports = require('../src/lib/trackers/rebotics-reports');

function mockJsonRequest(body) {
  const req = new EventEmitter();
  req.end = () => {
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      req._callback(res);
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    });
  };
  req.destroy = (err) => {
    process.nextTick(() => req.emit('error', err));
  };
  return req;
}

test('fetchRows keeps partial SI rows when one task page times out', async (t) => {
  t.mock.method(reboticsBridge, 'getTokenForServer', () => 'test-token');
  t.mock.method(reboticsBridge, 'getApiBase', () => 'https://krcs.rebotics.net');
  let storeLookups = 0;
  let actionScans = 0;
  t.mock.method(https, 'request', (url, _options, callback) => {
    const path = url.pathname;
    const params = url.searchParams;
    const date = params.get('from_date');
    const store = params.get('store');

    if (path === '/api/v1/stores/') {
      throw new Error('Store custom_id endpoint should not be used');
    }

    if (path === '/api/v1/tasks/' && !store && date === '2026-06-01') {
      storeLookups += 1;
      const req = mockJsonRequest({
        results: [{
          store: { custom_id: '701-00019', id: 3837 },
        }],
        next: null,
      });
      req._callback = callback;
      return req;
    }

    if (path === '/api/v1/tasks/' && store === '3837' && date === '2026-05-31') {
      const req = new EventEmitter();
      req.end = () => {
        process.nextTick(() => {
          const err = new Error('timed out');
          err.name = 'AbortError';
          req.emit('error', err);
        });
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err));
      };
      return req;
    }

    if (path === '/api/v1/tasks/' && store === '3837') {
      const req = mockJsonRequest({
        results: [{
          id: 99,
          store: { custom_id: '701-00019', id: 3837 },
          title: 'P05W2-2026 8732361 082-SINGLE SERVE BEVERAGE 861 NII',
          status: { id: 'COMPLETED' },
          category: { name: 'FIRST AID PRODUCTS' },
          planograms: [{ custom_id: '8732361', store_planogram_id: 444, name: 'FIRST AID PRODUCTS' }],
        }],
        next: null,
      });
      req._callback = callback;
      return req;
    }

    if (path === '/api/v1/tasks/99/processing/actions/') {
      actionScans += 1;
      assert.equal(params.get('show_actions'), 'below');
      const req = mockJsonRequest({
        results: [{
          id: 500,
          captured_at: '2026-06-01T15:00:00Z',
          stage: 'pre_photo',
          deactivated: false,
          rejected: false,
          merged_image: 'https://example.test/merged.jpg',
          section_info: { name: '1' },
          store_planogram_id: 444,
          store_planogram: { id: 444, planogram: {} },
        }],
        next: null,
      });
      req._callback = callback;
      return req;
    }

    throw new Error(`Unexpected Rebotics URL: ${url}`);
  });

  const warnings = [];
  const result = await reboticsReports.fetchRows({
    stores: ['19'],
    dates: ['2026-05-31', '2026-06-01'],
    settings: { reboticsMaxAttempts: 1 },
    onWarning: (message) => warnings.push(message),
  });
  const rows = result.rows;

  assert.equal(rows.length, 1);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.skipped.length, 1);
  const skip = result.skipped[0];
  assert.equal(skip.storeNumber, '19');
  assert.equal(skip.customId, '701-00019');
  assert.equal(skip.date, '2026-05-31');
  assert.equal(skip.reason, 'unit_fetch_failed');
  assert.match(skip.message, /timed out/);
  assert.equal(rows[0].dbkey, '8732361');
  assert.equal(rows[0].categoryId, '82');
  assert.equal(rows[0].source, 'si');
  assert.equal(rows[0].photoCount, 1);
  assert.equal(rows[0].images.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Rebotics tasks skipped/);
  assert.match(warnings[0], /2026-05-31/);
  assert.equal(storeLookups, 0);
  assert.equal(actionScans, 1);
});

test('categoryIdFromTask normalizes title and label category ids', () => {
  assert.equal(
    reboticsReports.categoryIdFromTask({ title: 'P05W3-2026 9014910 055-BAG SNACKS D701 S02 NII' }),
    '55',
  );
  assert.equal(
    reboticsReports.categoryIdFromTask({ title: 'P05W3-2026 9088146 201-CANDY - CHECKLANE 417 Reset' }),
    '201',
  );
  assert.equal(
    reboticsReports.categoryIdFromTask({ title: 'unexpected title', category: { name: '082-SINGLE SERVE BEVERAGE' } }),
    '82',
  );
});

test('fetchRows skips SI-excluded stores without scanning or breaking coverage', async (t) => {
  t.mock.method(reboticsBridge, 'getTokenForServer', () => 'test-token');
  t.mock.method(reboticsBridge, 'getApiBase', () => 'https://krcs.rebotics.net');
  let dateWideScans = 0;
  let excludedFetches = 0;
  t.mock.method(https, 'request', (url, _options, callback) => {
    const path = url.pathname;
    const params = url.searchParams;
    const store = params.get('store');
    if (path === '/api/v1/stores/') {
      throw new Error('Store custom_id endpoint should not be used');
    }
    // Date-wide resolver scan (no store param). An excluded store must never
    // get here — if it does, the deep-scan/timeout bug is back.
    if (path === '/api/v1/tasks/' && !store) {
      dateWideScans += 1;
      const req = mockJsonRequest({
        results: [{ store: { custom_id: '701-00019', id: 3837 } }],
        next: null,
      });
      req._callback = callback;
      return req;
    }
    // Per-store fetch for the real store (701-00019 -> internal 3837).
    if (path === '/api/v1/tasks/' && store === '3837') {
      const req = mockJsonRequest({
        results: [{
          id: 9001,
          store: { custom_id: '701-00019', id: 3837 },
          title: 'P05W2-2026 8723240 201-CANDY - CHECKLANE 417 Reset',
          status: { id: 'COMPLETED' },
          category: { name: 'CANDY' },
          planograms: [{ custom_id: '8723240', store_planogram_id: 444, name: 'CANDY' }],
        }],
        next: null,
      });
      req._callback = callback;
      return req;
    }
    if (path === '/api/v1/tasks/9001/processing/actions/') {
      const req = mockJsonRequest({ results: [], next: null });
      req._callback = callback;
      return req;
    }
    // Any fetch for the excluded store's hypothetical internal id is a failure.
    excludedFetches += 1;
    const req = mockJsonRequest({ results: [], next: null });
    req._callback = callback;
    return req;
  });
  const warnings = [];
  const result = await reboticsReports.fetchRows({
    stores: ['4', '19'],
    dates: ['2026-06-13'],
    settings: { reboticsMaxAttempts: 1 },
    onWarning: (message) => warnings.push(message),
  });
  // 701-00019 is in the committed cache, so the only legitimate path is a
  // cache hit -> zero date-wide scans. The excluded store 701-00004 must add
  // no scans and no per-store fetches.
  assert.equal(dateWideScans, 0, 'no date-wide scan should occur for cached + excluded stores');
  assert.equal(excludedFetches, 0, 'excluded store must never be fetched');
  // The excluded store is intentionally skipped, NOT a coverage gap.
  assert.equal(result.coverageComplete, true, 'excluded store must not degrade coverage');
  assert.equal(result.skipped.length, 0, 'excluded store must not appear in skipped');
  // The real store's SI rows still come through.
  assert.ok(result.rows.some((r) => String(r.storeNumber) === '19'), 'real store SI rows present');
});
