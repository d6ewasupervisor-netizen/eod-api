'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareRows } = require('../src/lib/trackers/compare');

function prod(overrides = {}) {
  return {
    source: 'prod',
    storeNumber: '214',
    workDate: '2026-05-25',
    dbkey: '1234567',
    status: 'completed',
    photoCount: 2,
    images: [],
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
    images: [],
    raw: {},
    ...overrides,
  };
}

test('compareRows marks a matched source pair high confidence', () => {
  const result = compareRows([prod()], [si()]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].confidence, 'high');
  assert.equal(result.summary.needsReview, 0);
});

test('compareRows marks missing dbkey as needs_review', () => {
  const result = compareRows([prod({ dbkey: '' })], []);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.match(result.items[0].notes, /Missing dbkey/);
});

test('compareRows marks source-only rows as needs_review', () => {
  const result = compareRows([prod()], []);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.match(result.items[0].notes, /Missing SI match/);
});

test('compareRows marks photo-count mismatches as needs_review', () => {
  const result = compareRows([prod({ photoCount: 3 })], [si({ photoCount: 1 })]);
  assert.equal(result.items[0].confidence, 'needs_review');
  assert.match(result.items[0].notes, /Photo count mismatch/);
});
