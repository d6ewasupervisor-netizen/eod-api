'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TRACKER_ADMIN_EMAILS = 'admin@example.com';

const { isTrackerUserAllowed, sanitize } = require('../src/lib/trackers/settings');

test('isTrackerUserAllowed admits tracker admins regardless of settings', () => {
  assert.equal(
    isTrackerUserAllowed({ email: 'ADMIN@example.com', roles: [] }, { trackerAllowedEmails: [] }),
    true
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
    runItemsPageSizeDefault: 999,
    runItemsPageSizeMax: 50,
    maxRunDates: 999,
    trackerAllowedEmails: ['ok@example.com', 'not-an-email'],
  });

  assert.equal(settings.reboticsRequestTimeoutMs, 2000);
  assert.equal(settings.runItemsPageSizeDefault, 50);
  assert.equal(settings.maxRunDates, 60);
  assert.deepEqual(settings.trackerAllowedEmails, ['ok@example.com']);
});
