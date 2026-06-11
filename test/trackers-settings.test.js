'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TRACKER_ADMIN_EMAILS = 'admin@example.com';

const { DEFAULTS, isTrackerUserAllowed, sanitize, trackerAdminEmails } = require('../src/lib/trackers/settings');

test('isTrackerUserAllowed admits tracker admins regardless of settings', () => {
  assert.equal(
    isTrackerUserAllowed({ email: 'ADMIN@example.com', roles: [] }, { trackerAllowedEmails: [] }),
    true
  );
});

test('trackerAdminEmails always includes the built-in owner account', () => {
  assert.deepEqual(
    trackerAdminEmails().sort(),
    ['admin@example.com', 'd6ewa.supervisor@gmail.com'].sort()
  );
});

test('isTrackerUserAllowed honors explicit email allowlist', () => {
  assert.equal(
    isTrackerUserAllowed(
      { email: 'person@example.com', roles: [] },
      { trackerAllowedEmails: ['person@example.com'], trackerAllowAdmins: false, trackerAllowSupervisors: false }
    ),
    true
  );
});

test('isTrackerUserAllowed denies unlisted non-role users', () => {
  assert.equal(
    isTrackerUserAllowed(
      { email: 'viewer@example.com', roles: ['lead'] },
      { trackerAllowedEmails: [], trackerAllowAdmins: false, trackerAllowSupervisors: false }
    ),
    false
  );
});

test('sanitize clamps runtime settings and drops invalid emails', () => {
  const settings = sanitize({
    reboticsRequestTimeoutMs: 1,
    reboticsConcurrency: 99,
    sasConcurrency: 0,
    runItemsPageSizeDefault: 999,
    runItemsPageSizeMax: 50,
    maxRunDates: 999,
    trackerAllowedEmails: ['ok@example.com', 'not-an-email'],
  });

  assert.equal(settings.reboticsRequestTimeoutMs, 2000);
  assert.equal(settings.reboticsConcurrency, 10);
  assert.equal(settings.sasConcurrency, DEFAULTS.sasConcurrency);
  assert.equal(settings.runItemsPageSizeDefault, 50);
  assert.equal(settings.maxRunDates, 60);
  assert.deepEqual(settings.trackerAllowedEmails, ['ok@example.com']);
});

test('default Rebotics request timeout allows slower SI pages', () => {
  assert.equal(DEFAULTS.reboticsRequestTimeoutMs, 30000);
});

test('default SAS concurrency is raised to 6 for faster PROD range fetches', () => {
  assert.equal(DEFAULTS.sasConcurrency, 6);
});

test('sanitize preserves explicit sasConcurrency overrides within the 1..10 clamp', () => {
  assert.equal(sanitize({ sasConcurrency: 4 }).sasConcurrency, 4);
  assert.equal(sanitize({ sasConcurrency: 10 }).sasConcurrency, 10);
  assert.equal(sanitize({ sasConcurrency: 15 }).sasConcurrency, 10);
  assert.equal(sanitize({ sasConcurrency: 1 }).sasConcurrency, 1);
  assert.equal(sanitize({}).sasConcurrency, 6);
});

test('default SAS range concurrency is 1 to preserve sequential range fetching', () => {
  assert.equal(DEFAULTS.sasRangeConcurrency, 1);
});

test('sanitize preserves explicit sasRangeConcurrency overrides within the 1..3 clamp', () => {
  assert.equal(sanitize({ sasRangeConcurrency: 2 }).sasRangeConcurrency, 2);
  assert.equal(sanitize({ sasRangeConcurrency: 3 }).sasRangeConcurrency, 3);
  assert.equal(sanitize({ sasRangeConcurrency: 4 }).sasRangeConcurrency, 3);
  assert.equal(sanitize({ sasRangeConcurrency: 1 }).sasRangeConcurrency, 1);
  assert.equal(sanitize({}).sasRangeConcurrency, 1);
});
