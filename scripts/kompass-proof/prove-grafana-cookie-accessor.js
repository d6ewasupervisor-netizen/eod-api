#!/usr/bin/env node
'use strict';

// Hermetic proof for the in-process Grafana cookie accessor seam.
// ZERO network: never requires grafana-auth-core, never constructs a real
// bridge. A fake bridge object stands in for the live instance so we prove
// the accessor's only job: delegate to the registered instance, and return
// null (never a fabricated or stale value) when there is none.
//
// Run: node scripts/kompass-proof/prove-grafana-cookie-accessor.js

const accessor = require('../../src/lib/trackers/grafana-cookie-accessor');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createFakeBridge(cookieValue) {
  let calls = 0;
  return {
    calls: () => calls,
    getGrafanaCookie() {
      calls += 1;
      return cookieValue;
    },
  };
}

function printPass(name, details = {}) {
  console.log(`${name}: PASS ${JSON.stringify(details)}`);
}

function printFail(name, error) {
  console.error(`${name}: FAIL ${error?.message || String(error)}`);
}

async function runTest(name, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    printFail(name, error);
    return false;
  }
}

async function main() {
  const results = [];

  // Reset to a known-empty state; the module is a singleton across requires.
  accessor.setGrafanaBridge(null);

  results.push(await runTest('A1 null when no bridge registered', () => {
    assert(accessor.getGrafanaBridge() === null, 'expected no bridge registered');
    assert(accessor.getGrafanaCookie() === null, 'expected null cookie with no bridge');
    printPass('A1 null when no bridge registered', { cookie: null });
  }));

  results.push(await runTest('A2 delegates to live instance', () => {
    const fake = createFakeBridge('live-cookie-123');
    const returned = accessor.setGrafanaBridge(fake);
    assert(returned === fake, 'setGrafanaBridge should return the registered instance');
    assert(accessor.getGrafanaBridge() === fake, 'accessor should hold the same instance');
    assert(accessor.getGrafanaCookie() === 'live-cookie-123', 'cookie should delegate to bridge');
    assert(fake.calls() === 1, 'bridge getGrafanaCookie should be called exactly once');
    printPass('A2 delegates to live instance', { cookie: 'live-cookie-123', calls: fake.calls() });
  }));

  results.push(await runTest('A3 passes through bridge null (disabled/not-seeded)', () => {
    const fake = createFakeBridge(null);
    accessor.setGrafanaBridge(fake);
    assert(accessor.getGrafanaCookie() === null, 'accessor must not fabricate a cookie when bridge returns null');
    assert(fake.calls() === 1, 'bridge getGrafanaCookie should be called exactly once');
    printPass('A3 passes through bridge null (disabled/not-seeded)', { cookie: null });
  }));

  results.push(await runTest('A4 re-clearing to null follows live registration', () => {
    accessor.setGrafanaBridge(createFakeBridge('transient-cookie'));
    assert(accessor.getGrafanaCookie() === 'transient-cookie', 'precondition: cookie present');
    accessor.setGrafanaBridge(null);
    assert(accessor.getGrafanaBridge() === null, 'bridge should be cleared');
    assert(accessor.getGrafanaCookie() === null, 'accessor must not cache a once-seen cookie');
    printPass('A4 re-clearing to null follows live registration', { cookie: null });
  }));

  // Leave the module in a clean state for any subsequent in-process consumer.
  accessor.setGrafanaBridge(null);

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\ngrafana-cookie-accessor proof: ${passed}/${total} PASS`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((error) => {
  printFail('grafana-cookie-accessor proof', error);
  process.exitCode = 1;
});
