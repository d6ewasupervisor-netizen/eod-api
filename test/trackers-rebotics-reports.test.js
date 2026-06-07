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
          title: 'P05W2 - 2026 8732361',
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
  const rows = await reboticsReports.fetchRows({
    stores: ['19'],
    dates: ['2026-05-31', '2026-06-01'],
    settings: { reboticsMaxAttempts: 1 },
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].dbkey, '8732361');
  assert.equal(rows[0].source, 'si');
  assert.equal(rows[0].photoCount, 1);
  assert.equal(rows[0].images.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Rebotics tasks skipped/);
  assert.match(warnings[0], /2026-05-31/);
  assert.equal(storeLookups, 0);
  assert.equal(actionScans, 1);
});
