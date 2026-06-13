'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DISTRICT_STORES } = require('../src/lib/trackers/metadata');
const {
  REBOTICS_STORE_IDS,
  TRACKER_DISTRICT_CUSTOM_IDS,
  seededMissingCustomIds,
} = require('../src/lib/trackers/rebotics-store-id-cache');

function toCustomId(storeNumber) {
  return `701-${String(storeNumber).padStart(5, '0')}`;
}

test('Rebotics store cache coverage list includes every tracker district store', () => {
  const expected = [...new Set(Object.values(DISTRICT_STORES).flat())]
    .sort((a, b) => a - b)
    .map(toCustomId);
  assert.deepEqual(TRACKER_DISTRICT_CUSTOM_IDS, expected);
});

test('Rebotics committed cache includes known Kompass Tyson stores', () => {
  assert.equal(REBOTICS_STORE_IDS['701-00019'], 3837);
  assert.equal(REBOTICS_STORE_IDS['701-00023'], 3838);
  assert.equal(REBOTICS_STORE_IDS['701-00682'], 3890);
});

test('Rebotics committed cache includes all D9 Kompass stores', () => {
  assert.equal(REBOTICS_STORE_IDS['701-00156'], 3773);
  assert.equal(REBOTICS_STORE_IDS['701-00198'], 3774);
  assert.equal(REBOTICS_STORE_IDS['701-00226'], 3775);
  assert.equal(REBOTICS_STORE_IDS['701-00260'], 3776);
  assert.equal(REBOTICS_STORE_IDS['701-00383'], 3777);
  assert.equal(REBOTICS_STORE_IDS['701-00439'], 3778);
  assert.equal(REBOTICS_STORE_IDS['701-00449'], 3779);
  assert.equal(REBOTICS_STORE_IDS['701-00613'], 3780);
  assert.equal(REBOTICS_STORE_IDS['701-00662'], 3781);
  assert.equal(REBOTICS_STORE_IDS['701-00685'], 3782);
});

test('Rebotics committed cache includes verified non-fuel tracker stores', () => {
  assert.equal(Object.keys(REBOTICS_STORE_IDS).length, 126);
  assert.equal(REBOTICS_STORE_IDS['701-00035'], 3786);
  assert.equal(REBOTICS_STORE_IDS['701-00140'], 268);
  assert.equal(REBOTICS_STORE_IDS['701-00668'], 3771);
});

test('Rebotics committed cache intentionally leaves only fuel-center tracker stores unresolved', () => {
  assert.deepEqual(seededMissingCustomIds(), [
    '701-00004',
    '701-00007',
    '701-00051',
  ]);
});
