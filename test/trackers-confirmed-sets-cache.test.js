'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeConfirmedKey,
  emptyCache,
  upsertConfirmed,
  isConfirmed,
  filterOutConfirmed,
  seedFromWritesCache,
  saveConfirmedSets,
  loadConfirmedSetsSync,
} = require('../src/lib/trackers/confirmed-sets-cache');

test('normalizeConfirmedKey pads period and store', () => {
  assert.equal(
    normalizeConfirmedKey('P5W2|028|201|9009204'),
    'P05W2|28|201|9009204',
  );
  assert.equal(
    normalizeConfirmedKey({
      periodWeek: 'P05W2',
      store: '28',
      categoryId: '201',
      dbkey: '9009204',
    }),
    'P05W2|28|201|9009204',
  );
});

test('upsert + filter skips confirmed keys', () => {
  const cache = emptyCache();
  upsertConfirmed(cache, [
    { key: 'P05W2|28|201|9009204', workbookKind: 'ise' },
  ], { source: 'test', label: 'D6D8' });

  assert.equal(isConfirmed(cache, 'P5W2|028|201|9009204'), true);

  const rows = [
    { key: 'P05W2|28|201|9009204', store: '28' },
    { key: 'P05W2|28|4|9011792', store: '28' },
  ];
  const filtered = filterOutConfirmed(rows, cache);
  assert.equal(filtered.skipped, 1);
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].key, 'P05W2|28|4|9011792');

  const recheck = filterOutConfirmed(rows, cache, { recheckConfirmed: true });
  assert.equal(recheck.skipped, 0);
  assert.equal(recheck.rows.length, 2);
});

test('seedFromWritesCache only takes Yes rows', () => {
  const cache = emptyCache();
  const result = seedFromWritesCache(cache, {
    ise: [
      { key: 'P06W1|49|4|111', K: 'Yes' },
      { key: 'P06W1|49|4|222', K: 'No', L: 'needs SI complete' },
    ],
    blitz: [
      { key: 'P06W1|19|201|333', K: 'Yes' },
    ],
  }, { label: 'D6D8' });
  assert.equal(result.added, 2);
  assert.equal(isConfirmed(cache, 'P06W1|49|4|111'), true);
  assert.equal(isConfirmed(cache, 'P06W1|49|4|222'), false);
  assert.equal(isConfirmed(cache, 'P06W1|19|201|333'), true);
});

test('save/load round-trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmed-sets-'));
  const file = path.join(dir, 'D6D8_confirmed_sets.json');
  const cache = emptyCache();
  upsertConfirmed(cache, ['P06W1|286|4|9999999'], { source: 'test' });
  await saveConfirmedSets(file, cache);
  const loaded = loadConfirmedSetsSync(file);
  assert.equal(isConfirmed(loaded, 'P06W1|286|4|9999999'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
