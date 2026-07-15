'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('magic-link return URLs', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    process.env.FRONTEND_BASE_URL = 'https://the-dump-bin.com';
  });

  afterEach(() => {
    process.env = { ...orig };
    delete require.cache[require.resolve('../src/lib/magic-link.js')];
  });

  function load() {
    delete require.cache[require.resolve('../src/lib/magic-link.js')];
    return require('../src/lib/magic-link.js');
  }

  it('allows cp_scheduler host when listed in ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS =
      'https://the-dump-bin.com,https://cpscheduler-production.up.railway.app';
    const { buildMagicLink } = load();
    const link = buildMagicLink('test-token', 'https://cpscheduler-production.up.railway.app/');
    assert.ok(link);
    assert.match(link, /open-sign-in\.html/);
    assert.match(link, /cpscheduler-production\.up\.railway\.app/);
  });

  it('allows cpscheduler Railway host by default (hub tools)', () => {
    process.env.ALLOWED_ORIGINS = 'https://the-dump-bin.com';
    const { buildMagicLink } = load();
    const link = buildMagicLink(
      'test-token',
      'https://cpscheduler-production.up.railway.app/shiftday.html'
    );
    assert.ok(link);
    assert.match(link, /cpscheduler-production\.up\.railway\.app/);
  });

  it('allows central-pet hub path on the-dump-bin.com', () => {
    process.env.ALLOWED_ORIGINS = 'https://the-dump-bin.com';
    const { buildMagicLink } = load();
    const link = buildMagicLink('test-token', 'https://the-dump-bin.com/central-pet/?to=shiftday');
    assert.ok(link);
  });

  it('rejects unknown external hosts', () => {
    process.env.ALLOWED_ORIGINS = 'https://the-dump-bin.com';
    const { buildMagicLink } = load();
    assert.equal(buildMagicLink('test-token', 'https://evil.example.com/'), null);
  });
});
