// requireAdmin: gate for /api/admin/* sub-routes. Bearer token must be a
// `typ: 'admin'` JWT AND the email must still resolve to a row in site_admins
// with a non-null password_hash (so revoking an admin = deleting the row).

const { verifyAdminSessionToken } = require('./admin-jwt');
const { getAdminRow } = require('./site-admin');

function readBearer(req) {
  const auth = req.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function requireAdmin(req, res, next) {
  void (async () => {
    try {
      const token = readBearer(req);
      if (!token) {
        res.status(401).json({ ok: false, error: 'Sign in required.' });
        return;
      }
      const payload = verifyAdminSessionToken(token);
      const emailClaim = (payload.email || '').trim().toLowerCase();
      const row = await getAdminRow(emailClaim);
      if (!row?.password_hash) {
        res.status(401).json({ ok: false, error: 'Session expired. Sign in again.' });
        return;
      }
      req.adminEmail = row.email;
      next();
    } catch (err) {
      if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
        res.status(401).json({ ok: false, error: 'Session expired. Sign in again.' });
        return;
      }
      console.error('[admin-auth]', err);
      res.status(500).json({ ok: false, error: 'Could not authorize request.' });
    }
  })();
}

module.exports = { requireAdmin };
