/**
 * Server-side SAS auto-refresh.
 *
 * This module owns the headless Okta + TOTP + PKCE login flow that used to
 * live exclusively in `sas-auth/morning-auth.js` running on a GitHub Actions
 * runner.  Pulling it inside the API process means Railway can refresh the
 * SAS session itself — on a cron, on cold-start, AND lazily whenever any
 * logged-in user (regardless of role) hits a stale `/sas-auth-status` — with
 * no human in the loop.
 *
 * Usage:
 *   const autoRefresh = require('./sas-auto-refresh');
 *   autoRefresh.setApplyCallback(({ cookieHeader, csrfToken, authBody }) => {
 *     // install into the in-memory session, start heartbeat, etc.
 *   });
 *   await autoRefresh.runAutoRefresh({ reason: 'startup' });
 *
 * Concurrency: a single in-flight refresh is shared across every caller.
 * Two thirty-second polls landing simultaneously will share the same login,
 * not race two parallel logins against Okta.  A short cooldown (default 60s)
 * protects against tight retry loops if the heartbeat detects a dead session
 * back-to-back.
 */

const axios = require('axios');
const crypto = require('crypto');
const { authenticator } = require('otplib');

const SAS_BASE = 'https://prod.sasretail.com';
const OKTA_BASE = 'https://advantagesolutions.okta.com';
const TOTP_FACTOR_ID = 'uft1bhcligi8gUuxx1t8';
const SAS_CLIENT_ID = '0oapmlehafULkV0GI1t7';
const REDIRECT_URI = `${SAS_BASE}/en/okta/callback/`;

const REFRESH_COOLDOWN_MS = 60 * 1000;

const REQUIRED_ENV = ['SAS_USER', 'SAS_PASS', 'SAS_TOTP_SECRET'];

const logger = {
  info: (...a) => console.log('[sas-auto-refresh]', new Date().toISOString(), ...a),
  warn: (...a) => console.warn('[sas-auto-refresh]', new Date().toISOString(), ...a),
  error: (...a) => console.error('[sas-auto-refresh]', new Date().toISOString(), ...a),
};

let inFlight = null;
let lastRefreshAt = 0;
let lastRefreshError = null;
let _applySession = null;

function setApplyCallback(fn) {
  _applySession = fn;
}

function isConfigured() {
  return REQUIRED_ENV.every((k) => !!process.env[k]);
}

function missingEnvVars() {
  return REQUIRED_ENV.filter((k) => !process.env[k]);
}

function getStatus() {
  return {
    configured: isConfigured(),
    missing_env: missingEnvVars(),
    in_flight: !!inFlight,
    last_refresh_at: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    last_refresh_error: lastRefreshError,
  };
}

// ─── PKCE helpers (verbatim from morning-auth.js) ───────────────────────────

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────

function collectCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const match = h.match(/^([^=]+)=([^;]*)/);
    if (match) jar[match[1].trim()] = match[2].trim();
  }
}

function buildCookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function getCsrfToken(jar) {
  return jar['csrftoken'] || '';
}

// ─── The login flow ─────────────────────────────────────────────────────────

async function performLogin() {
  // Step 1: Okta primary auth
  logger.info('Step 1/7: Okta primary auth...');
  const authResp = await axios.post(`${OKTA_BASE}/api/v1/authn`, {
    username: process.env.SAS_USER,
    password: process.env.SAS_PASS,
    options: { multiOptionalFactorEnroll: false, warnBeforePasswordExpired: false },
  });

  const stateToken = authResp.data.stateToken;
  if (!stateToken) throw new Error('Okta primary auth: no stateToken returned');

  // Step 2: TOTP verify
  logger.info('Step 2/7: TOTP verify...');
  const passCode = authenticator.generate(process.env.SAS_TOTP_SECRET);
  const verifyResp = await axios.post(
    `${OKTA_BASE}/api/v1/authn/factors/${TOTP_FACTOR_ID}/verify?rememberDevice=true`,
    { passCode, stateToken }
  );

  const sessionToken = verifyResp.data.sessionToken;
  if (!sessionToken) throw new Error('Okta TOTP verify: no sessionToken returned');

  // Step 3: PKCE authorize via sessionCookieRedirect
  logger.info('Step 3/7: PKCE authorize redirect chain...');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const oauthState = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  const authorizeUrl = `${OKTA_BASE}/oauth2/v1/authorize?` + [
    `client_id=${SAS_CLIENT_ID}`,
    `response_type=code`,
    `scope=${encodeURIComponent('openid profile offline_access')}`,
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    `state=${oauthState}`,
    `nonce=${nonce}`,
    `code_challenge=${codeChallenge}`,
    `code_challenge_method=S256`,
  ].join('&');

  const cookieRedirectUrl = `${OKTA_BASE}/login/sessionCookieRedirect?` + [
    `token=${sessionToken}`,
    `redirectUrl=${encodeURIComponent(authorizeUrl)}`,
  ].join('&');

  const cookieJar = {};
  let currentUrl = cookieRedirectUrl;
  let authCode = null;
  let maxHops = 25;

  while (currentUrl && maxHops-- > 0) {
    const hop = await axios.get(currentUrl, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { Cookie: buildCookieHeader(cookieJar) },
    });

    collectCookies(cookieJar, hop.headers['set-cookie']);

    if (hop.status >= 300 && hop.status < 400 && hop.headers.location) {
      currentUrl = hop.headers.location;

      const codeMatch = currentUrl.match(/[?&]code=([^&]+)/);
      if (codeMatch) {
        authCode = codeMatch[1];
        break;
      }

      if (currentUrl.startsWith('/')) {
        const base = new URL(hop.config?.url || currentUrl);
        currentUrl = `${base.protocol}//${base.host}${currentUrl}`;
      }
    } else if (hop.status === 200) {
      const html = typeof hop.data === 'string' ? hop.data : '';

      if (html.includes('stateToken') || currentUrl.includes('policy')) {
        // Okta is asking for a second factor again — extract its stateToken
        // and answer with a fresh TOTP code in the next 30s window.
        const stateTokenPatterns = [
          /name="stateToken"\s+value="([^"]+)"/i,
          /stateToken['":\s]+['"]([^'"]+)['"]/,
          /"stateToken":"([^"]+)"/,
          /Token\s*=\s*'([^']+)'/,
        ];

        let pageStateToken = null;
        for (const pattern of stateTokenPatterns) {
          const match = html.match(pattern);
          if (match) {
            pageStateToken = match[1].replace(/\\x2D/gi, '-');
            break;
          }
        }
        if (!pageStateToken) {
          throw new Error('Could not extract stateToken from second-factor page');
        }

        const timeStep = 30;
        const secondsLeft = timeStep - (Math.floor(Date.now() / 1000) % timeStep);
        await new Promise((r) => setTimeout(r, (secondsLeft + 1) * 1000));

        const freshCode = authenticator.generate(process.env.SAS_TOTP_SECRET);
        const sfVerifyResp = await axios.post(
          `${OKTA_BASE}/api/v1/authn/factors/${TOTP_FACTOR_ID}/verify?rememberDevice=true`,
          { passCode: freshCode, stateToken: pageStateToken },
          { validateStatus: () => true }
        );

        if (sfVerifyResp.data?.sessionToken) {
          currentUrl = `${OKTA_BASE}/login/sessionCookieRedirect?` + [
            `token=${sfVerifyResp.data.sessionToken}`,
            `redirectUrl=${encodeURIComponent(authorizeUrl)}`,
          ].join('&');
          continue;
        }
        throw new Error('Second-factor verify did not return sessionToken');
      } else {
        currentUrl = null;
      }
    } else {
      currentUrl = null;
    }
  }

  if (!authCode) {
    throw new Error('Could not capture auth code from redirect chain');
  }

  // Step 4: ensure csrftoken
  logger.info('Step 4/7: Ensuring csrftoken...');
  if (!cookieJar['csrftoken']) {
    const csrfResp = await axios.get(`${SAS_BASE}/en/`, { validateStatus: () => true });
    collectCookies(cookieJar, csrfResp.headers['set-cookie']);
  }
  if (!cookieJar['csrftoken']) {
    throw new Error('Could not obtain csrftoken from SAS');
  }

  // Step 5: POST auth code to SAS — is_admin:true is required because our
  // REDIRECT_URI is the /en/ admin portal callback.
  logger.info('Step 5/7: POSTing auth code to SAS backend...');
  const sasAuthResp = await axios.post(`${SAS_BASE}/api/v1/auth/okta/`, {
    grant_type: 'authorization_code',
    code: authCode,
    client_id: SAS_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
    is_employee: false,
    is_fsr: false,
    is_admin: true,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCsrfToken(cookieJar),
      Cookie: buildCookieHeader(cookieJar),
      Referer: REDIRECT_URI,
    },
    validateStatus: () => true,
  });

  collectCookies(cookieJar, sasAuthResp.headers['set-cookie']);

  const authBody = sasAuthResp.data && typeof sasAuthResp.data === 'object'
    ? sasAuthResp.data
    : null;
  if (!authBody || !authBody.auth_token) {
    throw new Error(
      `SAS /api/v1/auth/okta/ did not return an auth_token (HTTP ${sasAuthResp.status})`
    );
  }

  // Step 6: ensure sessionid (some flows require a dashboard fetch to get one)
  logger.info('Step 6/7: Extracting SAS session cookies...');
  if (!cookieJar['sessionid']) {
    const dashResp = await axios.get(`${SAS_BASE}/en/sasretail/dashboard/`, {
      headers: {
        Cookie: buildCookieHeader(cookieJar),
        Authorization: `Token ${authBody.auth_token}`,
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    collectCookies(cookieJar, dashResp.headers['set-cookie']);
  }
  if (!cookieJar['csrftoken'] || !cookieJar['sessionid']) {
    throw new Error(`Missing SAS cookies after exchange. Got: ${Object.keys(cookieJar).join(', ')}`);
  }

  const cookieHeader = buildCookieHeader(cookieJar);
  const csrfToken = cookieJar['csrftoken'];

  // Step 7: validate against both API and admin-portal endpoints
  logger.info('Step 7/7: Validating session...');
  const validateResp = await axios.get(
    `${SAS_BASE}/api/v1/notifications/api/unread_list/?max=1`,
    {
      headers: {
        Cookie: cookieHeader,
        'X-CSRFToken': csrfToken,
        Referer: `${SAS_BASE}/en/sasretail/dashboard/`,
      },
      validateStatus: () => true,
    }
  );
  if (validateResp.status !== 200) {
    throw new Error(`Session validation failed at /notifications (HTTP ${validateResp.status})`);
  }

  const adminCheckResp = await axios.get(
    `${SAS_BASE}/api/v2/dashboard/app-links/`,
    {
      headers: {
        Cookie: cookieHeader,
        'X-CSRFToken': csrfToken,
        Referer: `${SAS_BASE}/en/sasretail/dashboard/`,
      },
      validateStatus: () => true,
    }
  );
  if (adminCheckResp.status !== 200) {
    throw new Error(
      `Admin-portal validation failed (HTTP ${adminCheckResp.status} at /api/v2/dashboard/app-links/)`
    );
  }

  logger.info('Session validated ✓');
  return { cookieHeader, csrfToken, authBody };
}

// ─── Public entry point ─────────────────────────────────────────────────────

async function runAutoRefresh({ reason = 'manual', force = false } = {}) {
  if (!isConfigured()) {
    const missing = missingEnvVars();
    logger.warn(`Skipping refresh — missing env vars: ${missing.join(', ')}`);
    return { ok: false, skipped: true, reason: 'not-configured', missing };
  }

  if (inFlight) {
    logger.info(`Coalescing into in-flight refresh (caller reason: ${reason})`);
    return inFlight;
  }

  if (!force && Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) {
    const ageSec = Math.round((Date.now() - lastRefreshAt) / 1000);
    logger.info(`Skipping refresh — cooldown active (${ageSec}s since last refresh, reason: ${reason})`);
    return { ok: true, skipped: true, reason: 'cooldown', age_seconds: ageSec };
  }

  logger.info(`Starting refresh (reason: ${reason})`);
  const start = Date.now();

  inFlight = (async () => {
    try {
      const session = await performLogin();
      const elapsedMs = Date.now() - start;
      lastRefreshAt = Date.now();
      lastRefreshError = null;

      if (_applySession) {
        try {
          _applySession({ ...session, source: `auto-refresh:${reason}` });
        } catch (err) {
          logger.error('applySession callback threw:', err.message);
        }
      } else {
        logger.warn('No applySession callback registered — refresh result discarded');
      }

      logger.info(`Refresh succeeded in ${elapsedMs}ms (reason: ${reason})`);
      return { ok: true, elapsed_ms: elapsedMs, reason };
    } catch (err) {
      lastRefreshError = err.message;
      logger.error(`Refresh failed (reason: ${reason}): ${err.message}`);
      if (err.response?.data) {
        logger.error('  response body:', JSON.stringify(err.response.data).slice(0, 300));
      }
      return { ok: false, error: err.message, reason };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

module.exports = {
  runAutoRefresh,
  setApplyCallback,
  isConfigured,
  missingEnvVars,
  getStatus,
};
