// Single-use email "magic link" tokens. The user clicks the link, the browser
// hands the token to /api/verify-token, which marks link_requests.used_at and
// mints a long-lived session JWT (see session-jwt.js). After that, the link
// token is dead.
//
// `typ: 'link'` keeps these distinct from admin and session JWTs even though
// they all share JWT_SECRET.

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET;
if (!SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[tokens] JWT_SECRET is not set; link issuance will throw on first call.');
}

const LINK_TYP = 'link';
const ADMIN_INVITE_TYP = 'admin_invite';
const TTL_DAYS = Number(process.env.LINK_TTL_DAYS || 30);
const ADMIN_INVITE_TTL_DAYS = Number(process.env.ADMIN_INVITE_TTL_DAYS || 7);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function ensureSecret() {
  if (!SECRET) throw new Error('JWT_SECRET is required');
  return SECRET;
}

function issueLinkToken(email) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { email, typ: LINK_TYP },
    ensureSecret(),
    { expiresIn: `${TTL_DAYS}d`, jwtid: jti },
  );
  return { token, jti };
}

function verifyLinkToken(token) {
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== LINK_TYP) {
    const err = new Error('Invalid link token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

/** Single-use invite JWT; consumes `site_admin_invites.jti`, like magic links + link_requests. */
function issueAdminInviteToken(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    throw new Error('invite email required');
  }
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { email, typ: ADMIN_INVITE_TYP },
    ensureSecret(),
    { expiresIn: `${ADMIN_INVITE_TTL_DAYS}d`, jwtid: jti },
  );
  return { token, jti };
}

/** @returns {{ email: string, jti: string, typ: string }} */
function verifyAdminInviteToken(tokenRaw) {
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';
  if (token.length < 20) {
    const err = new Error('Malformed invite token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== ADMIN_INVITE_TYP) {
    const err = new Error('Invalid invite token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const jti = payload.jti;
  if (!jti || typeof jti !== 'string') {
    const err = new Error('Malformed invite token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const email = normalizeEmail(payload.email);
  if (!email) {
    const err = new Error('Malformed invite token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return { ...payload, email, jti };
}

module.exports = {
  issueLinkToken,
  verifyLinkToken,
  issueAdminInviteToken,
  verifyAdminInviteToken,
};
