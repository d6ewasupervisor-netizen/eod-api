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

test('compareRows excludes blank-dbkey PROD rows from planogram comparison', () => {
  const result = compareRows([prod({ dbkey: '' })], []);
  assert.equal(result.items.length, 0);
  assert.equal(result.summary.nonPlanogramProdRows, 1);
  assert.match(result.summary.notes.join(' '), /non-planogram PROD row excluded/);
});

test('compareRows marks PROD done with no SI task as missing_in_si with reason', () => {
  const result = compareRows([prod()], []);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.equal(result.items[0].rowState, 'missing_in_si');
  assert.equal(result.items[0].siPresenceState, 'absent');
  assert.match(result.items[0].reason, /SI has no task/);
  assert.match(result.items[0].notes, /Missing SI match/);
});

test('compareRows withholds missing_in_si as si_unverified when SI coverage is incomplete', () => {
  const result = compareRows([prod()], [], { siCoverageComplete: false });
  assert.equal(result.items[0].rowState, 'si_unverified');
  assert.equal(result.items[0].siPresenceState, 'absent');
  assert.match(result.items[0].reason, /coverage was incomplete/);
  assert.equal(result.summary.byStatus.si_unverified, 1);
  assert.equal(result.summary.byStatus.missing_in_si || 0, 0);
});

test('compareRows still reports matched_done under incomplete SI coverage', () => {
  const result = compareRows([prod()], [si()], { siCoverageComplete: false });
  assert.equal(result.items[0].rowState, 'matched_done');
  assert.equal(result.summary.byStatus.matched_done, 1);
  assert.equal(result.summary.byStatus.si_unverified || 0, 0);
});

test('compareRows treats completed photo-count mismatches as done_photo_mismatch', () => {
  const result = compareRows([prod({ photoCount: 3 })], [si({ photoCount: 1 })]);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.equal(result.items[0].rowState, 'done_photo_mismatch');
  assert.match(result.items[0].notes, /Photo count mismatch/);
});

test('compareRows filters off-scope SI rows by default and can surface them', () => {
  const prodRows = [prod({ dbkey: '1111111' })];
  const siRows = [
    si({ dbkey: '1111111' }),
    si({ dbkey: '2222222', status: 'started' }),
    si({ dbkey: '3333333', status: 'completed' }),
  ];
  const hidden = compareRows(prodRows, siRows, { projectMode: true });
  assert.equal(hidden.items.length, 1);
  assert.equal(hidden.summary.offScopeHidden, 2);
  const visible = compareRows(prodRows, siRows, { projectMode: true, includeOffScope: true });
  assert.equal(visible.items.length, 3);
  assert.equal(visible.items.find((item) => item.dbkey === '2222222').rowState, 'off_scope_si');
  assert.equal(visible.items.find((item) => item.dbkey === '3333333').rowState, 'off_scope_si');
  assert.equal(visible.items.find((item) => item.dbkey === '3333333').expectation, 'off_scope');
});

test('compareRows emits missing_in_prod only for in-scope expected dbkeys', () => {
  const result = compareRows([], [si({ dbkey: '2222222' })], {
    projectMode: true,
    expectedProdRows: [prod({ dbkey: '2222222', status: 'scheduled', photoCount: 0, images: [] })],
  });
  const item = result.items[0];
  assert.equal(item.rowState, 'missing_in_prod');
  assert.equal(item.expectation, 'in_project_scope');
  assert.match(item.reason, /In project scope/);
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

test('compareRows counts and excludes blank-dbkey SI rows', () => {
  const result = compareRows([prod()], [si({ dbkey: '' })], { projectMode: true, includeOffScope: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.summary.nonPlanogramSiRows, 1);
  assert.match(result.summary.notes.join(' '), /non-planogram SI row excluded/);
});

test('compareRows matches run-19 project-mode shape with hidden off-scope SI', () => {
  const prodRows = [];
  const siRows = [];
  for (let i = 1; i <= 9; i += 1) {
    const dbkey = `100000${i}`;
    prodRows.push(prod({ dbkey, photoCount: 2 }));
    siRows.push(si({ dbkey, photoCount: 2 }));
  }
  for (let i = 10; i <= 12; i += 1) {
    const dbkey = `10000${i}`;
    prodRows.push(prod({ dbkey, photoCount: 2 }));
    siRows.push(si({ dbkey, photoCount: 1 }));
  }
  for (let i = 13; i <= 15; i += 1) {
    const dbkey = `10000${i}`;
    prodRows.push(prod({ dbkey, photoCount: 0 }));
    siRows.push(si({ dbkey, status: 'started', photoCount: 0, images: [] }));
  }
  for (let i = 1; i <= 13; i += 1) {
    siRows.push(si({ dbkey: `20000${String(i).padStart(2, '0')}`, status: 'completed' }));
  }
  const result = compareRows(prodRows, siRows, { projectMode: true });
  assert.equal(result.items.length, 15);
  assert.deepEqual(result.summary.byStatus, {
    matched_done: 9,
    done_photo_mismatch: 3,
    si_incomplete: 3,
  });
  assert.equal(result.summary.offScopeHidden, 13);
  assert.equal(result.summary.byStatus.missing_in_prod || 0, 0);
  assert.equal(result.summary.byStatus.missing_in_si || 0, 0);

  const visible = compareRows(prodRows, siRows, { projectMode: true, includeOffScope: true });
  assert.equal(visible.items.length, 28);
  assert.equal(visible.summary.byStatus.off_scope_si, 13);
});

test('compareRows buckets an excluded store as si_excluded, not missing_in_si', () => {
  const result = compareRows([prod({ storeNumber: '4' })], []);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].rowState, 'si_excluded');
  assert.equal(result.items[0].comparisonStatus, 'si_excluded');
  assert.match(result.items[0].reason, /not assigned to this login/);
  assert.equal(result.summary.byStatus.si_excluded, 1);
  assert.equal(result.summary.byStatus.missing_in_si || 0, 0);
});

test('compareRows si_excluded wins even when SI coverage is incomplete', () => {
  const result = compareRows([prod({ storeNumber: '4' })], [], { siCoverageComplete: false });
  assert.equal(result.items[0].rowState, 'si_excluded');
  assert.equal(result.summary.byStatus.si_excluded, 1);
  assert.equal(result.summary.byStatus.si_unverified || 0, 0);
  assert.equal(result.summary.byStatus.missing_in_si || 0, 0);
});

test('compareRows does not exclude a non-excluded store', () => {
  const result = compareRows([prod({ storeNumber: '60' })], []);
  assert.equal(result.items[0].rowState, 'missing_in_si');
  assert.equal(result.summary.byStatus.si_excluded || 0, 0);
  assert.equal(result.summary.byStatus.missing_in_si, 1);
});
