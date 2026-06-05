'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reboticsBridge = require('../src/rebotics-bridge');
const reboticsReports = require('../src/lib/trackers/rebotics-reports');

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetchRows keeps partial SI rows when one task page times out', async (t) => {
  t.mock.method(reboticsBridge, 'getTokenForServer', () => 'test-token');
  t.mock.method(reboticsBridge, 'getApiBase', () => 'https://krcs.rebotics.net');
  let storeLookups = 0;
  let actionScans = 0;
  t.mock.method(global, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    const params = new URL(url).searchParams;
    const date = params.get('from_date');
    const store = params.get('store');

    if (path === '/api/v1/stores/') {
      storeLookups += 1;
      assert.equal(params.get('custom_id'), '701-00019');
      return jsonResponse({
        results: [{
          custom_id: '701-00019',
          id: 3837,
        }],
        next: null,
      });
    }

    if (path === '/api/v1/tasks/' && store === '3837' && date === '2026-05-31') {
      const err = new Error('timed out');
      err.name = 'AbortError';
      throw err;
    }

    if (path === '/api/v1/tasks/' && store === '3837') {
      return jsonResponse({
        results: [{
          id: 99,
          store: { custom_id: '701-00019', id: 3837 },
          title: 'P05W2 - 2026 8732361',
          status: { id: 'COMPLETED' },
          category: { name: 'FIRST AID PRODUCTS' },
          planograms: [{ custom_id: '8732361', name: 'FIRST AID PRODUCTS' }],
        }],
        next: null,
      });
    }

    if (path === '/api/v4/processing/actions/') {
      actionScans += 1;
      return jsonResponse({
        results: [{
          id: 500,
          captured_at: '2026-06-01T15:00:00Z',
          stage: 'pre_photo',
          deactivated: false,
          rejected: false,
          merged_image: 'https://example.test/merged.jpg',
          section_info: { name: '1' },
          store_planogram: { planogram: { custom_id: '8732361' } },
        }, {
          id: 499,
          captured_at: '2026-05-31T15:00:00Z',
          stage: 'pre_photo',
          deactivated: false,
          rejected: false,
          merged_image: 'https://example.test/older.jpg',
          section_info: { name: '1' },
          store_planogram: { planogram: { custom_id: '1111111' } },
        }],
        next: null,
      });
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
  assert.equal(storeLookups, 1);
  assert.equal(actionScans, 1);
});
