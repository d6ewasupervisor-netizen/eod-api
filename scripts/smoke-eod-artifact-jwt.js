'use strict';

/**
 * Quick unit checks for EOD artifact JWT (no DB/disk).
 * Run: node scripts/smoke-eod-artifact-jwt.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-smoke-only';
process.env.BACKEND_BASE_URL = 'https://eod-api.the-dump-bin.com';

const {
  issueEodArtifactToken,
  verifyEodArtifactToken,
  publicArtifactUrl,
  artifactUrlTtlDays,
} = require('../src/lib/eod-artifact-jwt');

const token = issueEodArtifactToken(42);
const verified = verifyEodArtifactToken(token);
if (verified.artifactId !== 42) throw new Error('artifactId mismatch');

const url = publicArtifactUrl(42);
if (!url.includes('/api/eod-files/42?t=')) throw new Error(`bad url: ${url}`);

let expiredOk = false;
try {
  const jwt = require('jsonwebtoken');
  const old = jwt.sign({ typ: 'eod_file', aid: 1 }, process.env.JWT_SECRET, { expiresIn: '-1s' });
  verifyEodArtifactToken(old);
} catch (e) {
  expiredOk = e.name === 'TokenExpiredError';
}
if (!expiredOk) throw new Error('expected TokenExpiredError');

console.log('smoke-eod-artifact-jwt ok', { ttlDays: artifactUrlTtlDays(), sampleUrlPrefix: url.slice(0, 80) });
