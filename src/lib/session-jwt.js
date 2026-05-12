// Long-lived session JWT minted by /api/verify-token after a successful magic
// link exchange. The browser stores this in localStorage and sends it as
// `Authorization: Bearer <jwt>` on every API call. requireAuth (in
// auth-middleware.js, when AUTH_MODE=session) verifies it on every request.
//
// `typ: 'session'` keeps these distinct from link and admin JWTs.

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET;
const SESSION_TYP = 'session';
const SESSION_TTL = process.env.SESSION_TTL_DAYS
  ? `${Number(process.env.SESSION_TTL_DAYS)}d`
  : '45d';

function ensureSecret() {
  if (!SECRET) throw new Error('JWT_SECRET is required');
  return SECRET;
}

function issueSessionToken(email) {
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    { email, typ: SESSION_TYP },
    ensureSecret(),
    { expiresIn: SESSION_TTL, jwtid: jti },
  );
}

function verifySessionToken(token) {
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== SESSION_TYP) {
    const err = new Error('Invalid session token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

module.exports = { issueSessionToken, verifySessionToken };
