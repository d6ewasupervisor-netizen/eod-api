'use strict';

const jwt = require('jsonwebtoken');

const SURVEY_PHOTO_TYP = 'survey_photo';

/** Default 30 days — export spreadsheets need durable no-login links. */
function photoUrlTtlDays() {
  const v = process.env.SURVEY_PHOTO_URL_TTL_DAYS;
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

function issueSurveyPhotoToken(photoId, { days } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const pid = Number(photoId);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('photoId required');
  const ttl = days != null ? Number(days) : photoUrlTtlDays();
  const expiresIn = `${Number.isFinite(ttl) && ttl > 0 ? ttl : 30}d`;
  return jwt.sign({ typ: SURVEY_PHOTO_TYP, pid }, secret, { expiresIn });
}

function verifySurveyPhotoToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const payload = jwt.verify(String(token || ''), secret);
  if (payload.typ !== SURVEY_PHOTO_TYP) {
    const err = new Error('Invalid photo token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const pid = Number(payload.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    const err = new Error('Invalid photo token payload');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return { photoId: pid };
}

function publicPhotoUrl(photoId, opts) {
  const t = issueSurveyPhotoToken(photoId, opts);
  return `${apiPublicBase()}/api/survey/photos/${Number(photoId)}/public?t=${encodeURIComponent(t)}`;
}

module.exports = {
  SURVEY_PHOTO_TYP,
  photoUrlTtlDays,
  apiPublicBase,
  issueSurveyPhotoToken,
  verifySurveyPhotoToken,
  publicPhotoUrl,
};
