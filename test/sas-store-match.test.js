'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStoreNumber,
  getVisitStoreNumber,
  storesMatch,
  visitMatchesStore,
  filterVisitsByStore,
  assertVisitStore,
} = require('../lib/sas-store-match');

test('normalizeStoreNumber strips leading zeros and non-digits', () => {
  assert.equal(normalizeStoreNumber('028'), '28');
  assert.equal(normalizeStoreNumber('FM 28'), '28');
  assert.equal(normalizeStoreNumber(281), '281');
});

test('storesMatch requires whole-number equality', () => {
  assert.equal(storesMatch('28', '28'), true);
  assert.equal(storesMatch('028', 28), true);
  assert.equal(storesMatch('28', '128'), false);
  assert.equal(storesMatch('28', '281'), false);
  assert.equal(storesMatch('28', '286'), false);
  assert.equal(storesMatch('28', '428'), false);
});

test('getVisitStoreNumber reads nested visit store fields', () => {
  assert.equal(
    getVisitStoreNumber({ id: 1, store: { store: { number: 281 } } }),
    '281'
  );
  assert.equal(getVisitStoreNumber({ store_name: { number: 28 } }), '28');
});

test('filterVisitsByStore rejects substring API false positives', () => {
  const visits = [
    { id: 1, store: { store: { number: 28 } } },
    { id: 2, store: { store: { number: 281 } } },
    { id: 3, store: { store: { number: 128 } } },
  ];
  const matched = filterVisitsByStore(visits, 28);
  assert.deepEqual(matched.map((v) => v.id), [1]);
});

test('visitMatchesStore and assertVisitStore enforce exact store', () => {
  const visit = { id: 99, store: { store: { number: 281 } } };
  assert.equal(visitMatchesStore(visit, 28), false);
  assert.throws(
    () => assertVisitStore(visit, 28, 'Cycle visit'),
    /expected 28, got 281/
  );
});
