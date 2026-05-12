// Admin-session JWT for /EOD/admin.html. `typ: 'admin'` keeps these distinct
// from link tokens (typ: 'link') and end-user session tokens (typ: 'session')
// even though all three share JWT_SECRET.

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET;
const ADMIN_TYP = 'admin';

const ADMIN_SESSION_TTL = process.env.ADMIN_SESSION_DAYS
  ? `${Number(process.env.ADMIN_SESSION_DAYS)}d`
  : '45d';

function ensureSecret() {
  if (!SECRET) throw new Error('JWT_SECRET is required');
  return SECRET;
}

function issueAdminSessionToken(adminEmail) {
  const jwtid = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    { email: adminEmail, typ: ADMIN_TYP },
    ensureSecret(),
    { expiresIn: ADMIN_SESSION_TTL, jwtid },
  );
}

function verifyAdminSessionToken(token) {
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== ADMIN_TYP) {
    const err = new Error('Invalid admin session');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

module.exports = { issueAdminSessionToken, verifyAdminSessionToken };
