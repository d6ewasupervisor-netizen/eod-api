// Authentication gate for the EOD API.
//
// Two modes, selected by AUTH_MODE env var:
//
//   AUTH_MODE=cf-access  (legacy, default while migrating)
//     The request is expected to come through Cloudflare Access, which puts a
//     verified JWT in Cf-Access-Jwt-Assertion. We re-verify it against the
//     team JWKS and read req.user.email from the payload. Email-vs-role
//     mapping is driven by env vars (KOMPASS_ADMIN_EMAILS, KOMPASS_SUPERVISOR_EMAILS,
//     KOMPASS_LEAD_EMAILS) AND the request is rejected unless the email is on
//     EOD_APP_ALLOWED_EMAILS (when that env is set).
//
//   AUTH_MODE=session    (target state after Phase C)
//     The request carries a session JWT issued by /api/verify-token in the
//     Authorization: Bearer header. We verify the JWT locally with JWT_SECRET
//     and require typ='session'. Email-vs-role mapping is the same env-driven
//     resolver. Access is granted iff the email exists in `allowed_emails`
//     OR matches a corporate work domain (see lib/allowed-emails.js).
//
// PUBLIC_PATHS / public lists are owned by src/index.js and applied OUTSIDE
// this middleware -- nothing here changes which routes are public.
//
// Once we are confident in AUTH_MODE=session in production, the cf-access
// branch (and its `jose` dependency) can be deleted. See migration notes
// in docs/cloudflare-access-setup.md and the AUTH_MODE rollback procedure.

const { createRemoteJWKSet, jwtVerify } = require('jose');
const { verifySessionToken } = require('./lib/session-jwt');
const { isEmailAllowed } = require('./lib/allowed-emails');

const AUTH_MODE = (process.env.AUTH_MODE || 'cf-access').trim().toLowerCase();

// ─── cf-access mode setup ────────────────────────────────────────────────────
const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const AUD = process.env.CF_ACCESS_AUD;
const JWKS = TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

if (AUTH_MODE === 'cf-access') {
  if (!TEAM_DOMAIN) console.warn('[auth] CF_ACCESS_TEAM_DOMAIN not set \u2014 all auth will fail');
  if (!AUD) console.warn('[auth] CF_ACCESS_AUD not set \u2014 all auth will fail');
} else if (AUTH_MODE === 'session') {
  if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET not set \u2014 all session auth will fail');
} else {
  console.warn(`[auth] AUTH_MODE='${AUTH_MODE}' is not recognized; falling back to cf-access`);
}

// ─── env-driven role + allowlist (used by both modes) ────────────────────────
function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS = parseEmailList(process.env.KOMPASS_ADMIN_EMAILS);
const SUPERVISOR_EMAILS = parseEmailList(process.env.KOMPASS_SUPERVISOR_EMAILS);
const LEAD_EMAILS = parseEmailList(process.env.KOMPASS_LEAD_EMAILS);

// Only consulted in AUTH_MODE=cf-access. After we move to AUTH_MODE=session
// access is governed exclusively by the `allowed_emails` DB table + the
// corporate-domain rule in lib/allowed-emails.js.
const EOD_APP_ALLOWED_EMAILS = new Set(parseEmailList(process.env.EOD_APP_ALLOWED_EMAILS));
if (AUTH_MODE === 'cf-access' && EOD_APP_ALLOWED_EMAILS.size === 0) {
  console.warn(
    '[auth] EOD_APP_ALLOWED_EMAILS is unset \u2014 any valid Cloudflare Access JWT may use authenticated EOD API routes'
  );
}

function rolesForEmail(email) {
  const e = (email || '').trim().toLowerCase();
  const roles = [];
  if (ADMIN_EMAILS.includes(e)) roles.push('admin');
  if (SUPERVISOR_EMAILS.includes(e)) roles.push('supervisor');
  if (LEAD_EMAILS.includes(e)) roles.push('lead');
  return roles;
}

// ─── cf-access verifier ──────────────────────────────────────────────────────
async function verifyCfAccess(req, res) {
  const token = req.headers['cf-access-jwt-assertion'];
  if (!token) {
    res.status(401).json({ error: 'Missing Cloudflare Access JWT' });
    return null;
  }
  if (!JWKS || !AUD) {
    res.status(500).json({ error: 'Cloudflare Access not configured on the server' });
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${TEAM_DOMAIN}`,
      audience: AUD,
    });
    const email = (payload.email || '').toString();
    const emailLower = email.trim().toLowerCase();
    if (EOD_APP_ALLOWED_EMAILS.size > 0 && !EOD_APP_ALLOWED_EMAILS.has(emailLower)) {
      res.status(403).json({ error: 'EOD API access is not enabled for this account' });
      return null;
    }
    return { id: payload.sub || email, email, roles: rolesForEmail(email) };
  } catch (err) {
    console.error('[auth] CF JWT verify failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired Cloudflare Access JWT' });
    return null;
  }
}

// ─── session verifier ────────────────────────────────────────────────────────
function readBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

async function verifySession(req, res) {
  const token = readBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }
  let payload;
  try {
    payload = verifySessionToken(token);
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
      return null;
    }
    console.error('[auth] session verify threw:', err);
    res.status(500).json({ error: 'Could not authorize request' });
    return null;
  }
  const email = (payload.email || '').toString();
  const emailLower = email.trim().toLowerCase();

  // Defence in depth: even if a session JWT survives, the email must still be
  // currently on the allowlist (corporate domain OR allowed_emails row).
  // Revoking access = `DELETE FROM allowed_emails WHERE email = ...`.
  try {
    const allowed = await isEmailAllowed(emailLower);
    if (!allowed) {
      res.status(403).json({ error: 'EOD access is not enabled for this account' });
      return null;
    }
  } catch (err) {
    console.error('[auth] allowlist check failed:', err);
    res.status(500).json({ error: 'Could not authorize request' });
    return null;
  }

  return { id: payload.sub || email, email, roles: rolesForEmail(email) };
}

// ─── public requireAuth ──────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const user = AUTH_MODE === 'session'
    ? await verifySession(req, res)
    : await verifyCfAccess(req, res);
  if (!user) return; // response already sent
  req.user = user;
  next();
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];
    if (!allowed.some((r) => userRoles.includes(r))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, rolesForEmail, AUTH_MODE };
