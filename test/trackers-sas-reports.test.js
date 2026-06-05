'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sasBridge = require('../src/sas-bridge');
const sasReports = require('../src/lib/trackers/sas-reports');

test('fetchRows reads work date from SAS headers with trailing spaces', async (t) => {
  t.mock.method(sasBridge, 'isSessionAlive', () => true);
  t.mock.method(sasBridge, 'sasGet', async (path) => {
    if (path.startsWith('/api/v1/projects/project-stores/')) {
      return { data: { results: [{ id: 42, store: { number: 23 } }] } };
    }
    if (path.startsWith('/api/v1/reports/category-reset-report/')) {
      return { data: { file_url: 'https://example.test/report.csv' } };
    }
    throw new Error(`Unexpected SAS URL: ${path}`);
  });
  t.mock.method(global, 'fetch', async () => new Response([
    'Store #,Shift Reported Date ,Planogram ID,After Pictures Link,Project,Category,Shift Status,Visit ID',
    '23,2026-06-04T15:00:00Z,P05W2_8732361_FIRST_AID,"[\'https://example.test/after.jpg\']",Kompass ISE,FIRST AID PRODUCTS,Completed,9001',
  ].join('\n'), { status: 200 }));

  const rows = await sasReports.fetchRows({
    stores: ['23'],
    projects: [1528],
    dateFrom: '2026-05-31',
    dateTo: '2026-06-06',
    settings: { sasMaxAttempts: 1 },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].workDate, '2026-06-04');
  assert.equal(rows[0].dbkey, '8732361');
  assert.equal(rows[0].photoCount, 1);
  assert.equal(rows[0].sourceRef, undefined);
  assert.equal(rows[0].images[0].sourceRef, 'visit:9001');
});
