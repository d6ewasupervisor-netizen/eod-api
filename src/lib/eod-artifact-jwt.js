'use strict';

const jwt = require('jsonwebtoken');

const EOD_FILE_TYP = 'eod_file';

/** Default 30 days — public no-login download/view links. */
function artifactUrlTtlDays() {
  const v = process.env.EOD_FILE_URL_TTL_DAYS;
  if (v == null || v === '') return 30;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function apiPublicBase() {
  const fromEnv = String(process.env.BACKEND_BASE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, '')}`;
  return 'https://eod-api.the-dump-bin.com';
}

function issueEodArtifactToken(artifactId, { days } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const aid = Number(artifactId);
  if (!Number.isFinite(aid) || aid <= 0) throw new Error('artifactId required');
  const ttl = days != null ? Number(days) : artifactUrlTtlDays();
  const expiresIn = `${Number.isFinite(ttl) && ttl > 0 ? ttl : 30}d`;
  return jwt.sign({ typ: EOD_FILE_TYP, aid }, secret, { expiresIn });
}

function verifyEodArtifactToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const payload = jwt.verify(String(token || ''), secret);
  if (payload.typ !== EOD_FILE_TYP) {
    const err = new Error('Invalid artifact token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const aid = Number(payload.aid);
  if (!Number.isFinite(aid) || aid <= 0) {
    const err = new Error('Invalid artifact token payload');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return { artifactId: aid };
}

function publicArtifactUrl(artifactId, opts) {
  const t = issueEodArtifactToken(artifactId, opts);
  return `${apiPublicBase()}/api/eod-files/${Number(artifactId)}?t=${encodeURIComponent(t)}`;
}

module.exports = {
  EOD_FILE_TYP,
  artifactUrlTtlDays,
  apiPublicBase,
  issueEodArtifactToken,
  verifyEodArtifactToken,
  publicArtifactUrl,
};
