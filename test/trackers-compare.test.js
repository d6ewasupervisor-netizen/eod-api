'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareRows, PHASE2_ROSTER_NOTE } = require('../src/lib/trackers/compare');

function prod(overrides = {}) {
  return {
    source: 'prod',
    storeNumber: '214',
    workDate: '2026-05-25',
    dbkey: '1234567',
    status: 'completed',
    photoCount: 2,
    images: [{ sourceSystem: 'prod', sourceRef: `prod:${overrides.workDate || '2026-05-25'}`, sourceUrl: 'https://example.test/prod.jpg' }],
    raw: {},
    ...overrides,
  };
}

function si(overrides = {}) {
  return {
    source: 'si',
    storeNumber: '214',
    workDate: '2026-05-25',
    dbkey: '1234567',
    status: 'completed',
    photoCount: 2,
    images: [{ sourceSystem: 'si', sourceRef: `si:${overrides.workDate || '2026-05-25'}`, actionId: 1 }],
    raw: {},
    ...overrides,
  };
}

test('compareRows marks matched done when both systems complete with equal photos', () => {
  const result = compareRows([prod()], [si()]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].confidence, 'high');
  assert.equal(result.items[0].rowState, 'matched_done');
  assert.equal(result.items[0].prodPresenceState, 'done');
  assert.equal(result.items[0].siPresenceState, 'done');
  assert.equal(result.summary.needsReview, 0);
});

test('compareRows marks missing dbkey as needs_review', () => {
  const result = compareRows([prod({ dbkey: '' })], []);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.match(result.items[0].notes, /Missing dbkey/);
});

test('compareRows marks PROD done with no SI task as missing_in_si with reason', () => {
  const result = compareRows([prod()], []);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.equal(result.items[0].rowState, 'missing_in_si');
  assert.equal(result.items[0].siPresenceState, 'absent');
  assert.match(result.items[0].reason, /SI has no task/);
  assert.match(result.items[0].notes, /Missing SI match/);
});

test('compareRows treats completed photo-count mismatches as done_photo_mismatch', () => {
  const result = compareRows([prod({ photoCount: 3 })], [si({ photoCount: 1 })]);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.equal(result.items[0].rowState, 'done_photo_mismatch');
  assert.match(result.items[0].notes, /Photo count mismatch/);
});

test('compareRows filters incomplete off-scope SI rows by default and can surface them', () => {
  const prodRows = [prod({ dbkey: '1111111' })];
  const siRows = [
    si({ dbkey: '1111111' }),
    si({ dbkey: '2222222', status: 'started' }),
  ];
  const hidden = compareRows(prodRows, siRows, { projectMode: true });
  assert.equal(hidden.items.length, 1);
  assert.equal(hidden.summary.offScopeHidden, 1);
  const visible = compareRows(prodRows, siRows, { projectMode: true, includeOffScope: true });
  assert.equal(visible.items.length, 2);
  assert.equal(visible.items.find((item) => item.dbkey === '2222222').rowState, 'off_scope_si');
});

test('compareRows treats completed SI outside project scope as missing_in_prod', () => {
  const result = compareRows([prod({ dbkey: '1111111' })], [si({ dbkey: '2222222' })], { projectMode: true });
  const item = result.items.find((row) => row.dbkey === '2222222');
  assert.equal(item.rowState, 'missing_in_prod');
  assert.equal(item.expectation, 'in_project_scope');
});

test('compareRows performs full outer reconciliation without project filtering', () => {
  const result = compareRows([], [si({ dbkey: '2222222' })], { projectMode: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].rowState, 'missing_in_prod');
  assert.equal(result.summary.byStatus.off_scope_si || 0, 0);
});

test('compareRows collapses dates and attaches all contributing images to one item key', () => {
  const result = compareRows(
    [
      prod({ workDate: '2026-06-01', photoCount: 1 }),
      prod({ workDate: '2026-06-03', photoCount: 1 }),
    ],
    [
      si({ workDate: '2026-06-01', photoCount: 1, images: [{ sourceSystem: 'si', sourceRef: 'si:6-1', actionId: 101 }] }),
      si({ workDate: '2026-06-03', photoCount: 1, images: [{ sourceSystem: 'si', sourceRef: 'si:6-3', actionId: 103 }] }),
    ],
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].workDate, '2026-06-03');
  assert.equal(result.images.length, 4);
  assert.deepEqual([...new Set(result.images.map((img) => img.itemKey))], [result.items[0].itemKey]);
});

test('compareRows does not emit missing_in_both in Phase 1 and returns roster note', () => {
  const result = compareRows([prod()], [], { expectedProdRows: [] });
  assert.equal(result.summary.byStatus.missing_in_both || 0, 0);
  assert.ok(result.summary.notes.includes(PHASE2_ROSTER_NOTE));
});
