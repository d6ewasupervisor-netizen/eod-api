'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  putCache,
  getCache,
  listCaches,
} = require('../src/lib/trackers/tracker-cache-store');

test('tracker-cache-store merge confirmed sets on volume path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-cache-'));
  process.env.TRACKER_CACHE_DIR = root;

  const first = await putCache('D6D8', 'confirmed_sets', {
    sets: {
      'P05W2|28|201|9009204': { source: 'a' },
    },
  });
  assert.equal(first.counts.sets, 1);

  const second = await putCache('D6D8', 'confirmed_sets', {
    sets: {
      'P05W2|28|4|9011792': { source: 'b' },
    },
  });
  assert.equal(second.counts.sets, 2);
  assert.equal(second.merge.added, 1);

  const got = await getCache('D6D8', 'confirmed_sets');
  assert.equal(got.exists, true);
  assert.equal(Object.keys(got.data.sets).length, 2);

  const listing = await listCaches();
  assert.equal(listing.labels.length, 1);
  assert.equal(listing.labels[0].label, 'D6D8');

  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.TRACKER_CACHE_DIR;
});
