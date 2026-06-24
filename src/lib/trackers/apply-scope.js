'use strict';

const { DISTRICT_STORES, normalizeDistricts, storesForDistricts } = require('./metadata');

function districtForStore(store) {
  const normalized = String(Number(store));
  if (normalized === 'NaN') return null;
  for (const [district, stores] of Object.entries(DISTRICT_STORES)) {
    if (stores.map(String).includes(normalized)) return Number(district);
  }
  return null;
}

/**
 * Build the allowed store set for a mutating PROD→SI / blurry closeout run.
 *
 * @param {{ districts: number[]|string, stores?: string[] }} input
 */
function buildApplyScope(input) {
  const districts = normalizeDistricts(input.districts);
  if (!districts.length) {
    throw new Error('At least one valid --districts value is required (e.g. --districts 1 or --districts 1,8)');
  }

  const explicitStores = (input.stores || [])
    .map((store) => String(Number(store)))
    .filter((store) => store !== 'NaN');

  const allowedStores = explicitStores.length
    ? explicitStores
    : storesForDistricts(districts);

  const outOfScope = allowedStores.filter((store) => {
    const district = districtForStore(store);
    return district == null || !districts.includes(district);
  });
  if (outOfScope.length) {
    const detail = outOfScope.map((store) => {
      const district = districtForStore(store);
      return `${store}${district != null ? ` (D${district})` : ''}`;
    });
    throw new Error(
      `Store(s) outside --districts ${districts.map((d) => `D${d}`).join(',')}: ${detail.join(', ')}`
    );
  }

  const expectedConfirm = districts.map((d) => `D${d}`).join(',');

  return {
    districts,
    allowedStores: new Set(allowedStores),
    expectedConfirm,
  };
}

function formatConfirmScope(confirmScope) {
  return String(confirmScope || '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

/**
 * Live mutations require an explicit confirmation token matching --districts.
 */
function assertApplyScopeConfirmed(scope, confirmScope) {
  const expected = formatConfirmScope(scope.expectedConfirm);
  const got = formatConfirmScope(confirmScope);
  if (got !== expected) {
    throw new Error(
      `Live apply requires --confirm-scope ${scope.expectedConfirm} (received: ${confirmScope || 'missing'})`
    );
  }
}

function assertStoreInScope(scope, store, context) {
  const normalized = String(Number(store));
  if (scope.allowedStores.has(normalized)) return;
  const district = districtForStore(normalized);
  const suffix = context ? ` (${context})` : '';
  throw new Error(
    `Scope violation: store ${normalized}${district != null ? ` is D${district}` : ''} — not in allowed set [${[...scope.allowedStores].sort((a, b) => Number(a) - Number(b)).join(', ')}]${suffix}`
  );
}

function scopeSummary(scope) {
  return {
    districts: scope.districts,
    expectedConfirm: scope.expectedConfirm,
    storeCount: scope.allowedStores.size,
    stores: [...scope.allowedStores].sort((a, b) => Number(a) - Number(b)),
  };
}

module.exports = {
  districtForStore,
  buildApplyScope,
  assertApplyScopeConfirmed,
  assertStoreInScope,
  scopeSummary,
};
