'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildApplyScope,
  assertApplyScopeConfirmed,
  assertStoreInScope,
  districtForStore,
} = require('../src/lib/trackers/apply-scope');

test('districtForStore resolves D1 and D10', () => {
  assert.equal(districtForStore(60), 1);
  assert.equal(districtForStore(126), 10);
  assert.equal(districtForStore(999), null);
});

test('buildApplyScope expands districts to store lists', () => {
  const scope = buildApplyScope({ districts: [1] });
  assert.ok(scope.allowedStores.has('60'));
  assert.ok(!scope.allowedStores.has('126'));
  assert.equal(scope.expectedConfirm, 'D1');
});

test('explicit stores must belong to declared districts', () => {
  assert.throws(
    () => buildApplyScope({ districts: [1], stores: ['126'] }),
    /outside --districts D1/
  );
});

test('assertApplyScopeConfirmed requires exact district token', () => {
  const scope = buildApplyScope({ districts: [1, 8] });
  assert.doesNotThrow(() => assertApplyScopeConfirmed(scope, 'D1,D8'));
  assert.throws(() => assertApplyScopeConfirmed(scope, 'D1'), /--confirm-scope D1,D8/);
});

test('assertStoreInScope blocks out-of-district stores', () => {
  const scope = buildApplyScope({ districts: [1] });
  assert.doesNotThrow(() => assertStoreInScope(scope, 60, 'test'));
  assert.throws(() => assertStoreInScope(scope, 126, 'test'), /Scope violation/);
});
