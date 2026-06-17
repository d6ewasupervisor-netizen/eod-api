'use strict';

/**
 * Exact Fred Meyer store-number matching for SAS PROD APIs.
 *
 * SAS list endpoints (e.g. team-scheduling/visits?store_number=28) use substring
 * matching and will return store 281 for a request of 28. Always filter with
 * these helpers after fetching.
 */

function normalizeStoreNumber(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? String(n) : digits.replace(/^0+/, '') || '0';
}

function getVisitStoreNumber(visit) {
  if (!visit) return null;
  const raw =
    visit.store?.store?.number ??
    visit.store?.number ??
    visit.store_name?.number ??
    visit.store_number ??
    null;
  return normalizeStoreNumber(raw);
}

function getFieldDataStoreNumber(row) {
  if (!row) return null;
  const raw = row.store_name?.number ?? row.store_number ?? row.storeNumber ?? null;
  return normalizeStoreNumber(raw);
}

function storesMatch(a, b) {
  const left = normalizeStoreNumber(a);
  const right = normalizeStoreNumber(b);
  if (left == null || right == null) return false;
  return left === right;
}

function visitMatchesStore(visit, requestedStore) {
  return storesMatch(getVisitStoreNumber(visit), requestedStore);
}

function filterVisitsByStore(visits, requestedStore) {
  if (requestedStore == null || requestedStore === '') {
    return Array.isArray(visits) ? visits.slice() : [];
  }
  return (visits || []).filter((visit) => visitMatchesStore(visit, requestedStore));
}

function assertVisitStore(visit, requestedStore, context) {
  const actual = getVisitStoreNumber(visit);
  const expected = normalizeStoreNumber(requestedStore);
  if (!storesMatch(actual, expected)) {
    const visitId = visit?.id ?? '?';
    throw new Error(
      `${context || 'Visit'} store mismatch: expected ${expected}, got ${actual ?? 'unknown'} (visit ${visitId})`
    );
  }
  return true;
}

module.exports = {
  normalizeStoreNumber,
  getVisitStoreNumber,
  getFieldDataStoreNumber,
  storesMatch,
  visitMatchesStore,
  filterVisitsByStore,
  assertVisitStore,
};
