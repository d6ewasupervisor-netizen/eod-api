// Short-lived JWTs for GET /api/download?key=…&t=… so anchor tags work without
// Authorization headers. Signed with JWT_SECRET (same as session tokens), typ
// keeps them distinct from magic-link + session JWTs.

const jwt = require('jsonwebtoken');

const TYP = 'dump_dl';
const TTL =
  process.env.DUMP_BIN_DOWNLOAD_TTL_MINUTES != null
    ? `${Number(process.env.DUMP_BIN_DOWNLOAD_TTL_MINUTES) || 45}m`
    : '45m';

function ensureSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required');
  return s;
}

function issueDownloadLinkToken(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('key required');
  return jwt.sign({ typ: TYP, key: k }, ensureSecret(), { expiresIn: TTL });
}

function verifyDownloadLinkToken(token) {
  const payload = jwt.verify(String(token || ''), ensureSecret());
  if (payload.typ !== TYP) {
    const err = new Error('Invalid download token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const key = String(payload.key || '').trim();
  if (!key) {
    const err = new Error('Invalid download token payload');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return { key };
}

module.exports = { issueDownloadLinkToken, verifyDownloadLinkToken };
