// Cloudflare Access JWT verification.
//
// Every request from the EOD frontend (https://the-dump-bin.com/EOD/) is routed
// through Cloudflare Access, which terminates the user session and forwards the
// request to Railway with a verified JWT in the Cf-Access-Jwt-Assertion header.
// We re-verify it here against the team JWKS so a request that somehow reaches
// Railway directly cannot bypass auth.
//
// Roles are not carried in the Cloudflare token (Access has no user metadata),
// so we resolve them from env-var allowlists keyed by email.

const { createRemoteJWKSet, jwtVerify } = require('jose');

const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN; // e.g. retailodyssey.cloudflareaccess.com
const AUD = process.env.CF_ACCESS_AUD;                 // AUD tag from the Access app

const JWKS = TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

if (!TEAM_DOMAIN) console.warn('[auth] CF_ACCESS_TEAM_DOMAIN not set — all auth will fail');
if (!AUD) console.warn('[auth] CF_ACCESS_AUD not set — all auth will fail');

const PUBLIC_PATHS = new Set([
  '/rebotics-auth-update',
  '/rebotics-token-internal',
]);

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS = parseEmailList(process.env.KOMPASS_ADMIN_EMAILS);
const SUPERVISOR_EMAILS = parseEmailList(process.env.KOMPASS_SUPERVISOR_EMAILS);
const LEAD_EMAILS = parseEmailList(process.env.KOMPASS_LEAD_EMAILS);

// When non-empty, only these emails may call authenticated EOD API routes (JWT must
// still validate). Set on Railway to match the EOD SPA allowlist in the-dump-bin.
const EOD_APP_ALLOWED_EMAILS = new Set(parseEmailList(process.env.EOD_APP_ALLOWED_EMAILS));

if (EOD_APP_ALLOWED_EMAILS.size === 0) {
  console.warn(
    '[auth] EOD_APP_ALLOWED_EMAILS is unset — any valid Cloudflare Access JWT may use authenticated EOD API routes'
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

async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const token = req.headers['cf-access-jwt-assertion'];
  if (!token) {
    return res.status(401).json({ error: 'Missing Cloudflare Access JWT' });
  }
  if (!JWKS || !AUD) {
    return res.status(500).json({ error: 'Cloudflare Access not configured on the server' });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${TEAM_DOMAIN}`,
      audience: AUD,
    });

    const email = (payload.email || '').toString();
    const emailLower = email.trim().toLowerCase();
    if (EOD_APP_ALLOWED_EMAILS.size > 0 && !EOD_APP_ALLOWED_EMAILS.has(emailLower)) {
      return res.status(403).json({ error: 'EOD API access is not enabled for this account' });
    }

    req.user = {
      id: payload.sub || email,
      email,
      roles: rolesForEmail(email),
    };

    next();
  } catch (err) {
    console.error('[auth] JWT verify failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired Cloudflare Access JWT' });
  }
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

module.exports = { requireAuth, requireRole, rolesForEmail };
