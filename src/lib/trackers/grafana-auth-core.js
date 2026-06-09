'use strict';

const GRAFANA_BASE = 'https://krcs-reporting.rebotics.net';
const LOGIN_URL = `${GRAFANA_BASE}/login`;
const USER_URL = `${GRAFANA_BASE}/api/user`;
const ROTATE_URL = `${GRAFANA_BASE}/api/user/auth-tokens/rotate`;
const TARGET_COOKIE_NAMES = ['grafana_session', 'grafana_session_expiry'];

class GrafanaAuthError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GrafanaAuthError';
    if (options.status != null) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

class GrafanaStaleSessionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GrafanaStaleSessionError';
    if (options.status != null) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function splitCombinedSetCookie(value) {
  return String(value || '')
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function setCookieValues(setCookieHeaderOrArray) {
  if (!setCookieHeaderOrArray) return [];
  if (Array.isArray(setCookieHeaderOrArray)) {
    return setCookieHeaderOrArray.flatMap((value) => (
      typeof value === 'string' ? splitCombinedSetCookie(value) : setCookieValues(value)
    ));
  }
  if (typeof setCookieHeaderOrArray === 'string') {
    return splitCombinedSetCookie(setCookieHeaderOrArray);
  }
  if (typeof setCookieHeaderOrArray.getSetCookie === 'function') {
    const values = setCookieHeaderOrArray.getSetCookie();
    if (Array.isArray(values) && values.length) return values;
  }
  if (typeof setCookieHeaderOrArray.raw === 'function') {
    const raw = setCookieHeaderOrArray.raw();
    if (Array.isArray(raw?.['set-cookie'])) return raw['set-cookie'];
  }
  if (typeof setCookieHeaderOrArray.get === 'function') {
    const value = setCookieHeaderOrArray.get('set-cookie');
    if (value) return splitCombinedSetCookie(value);
  }
  return [];
}

function cookiePairsFromHeader(cookieHeader) {
  const cookies = {};
  String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return;
      const name = part.slice(0, eq).trim();
      if (!TARGET_COOKIE_NAMES.includes(name)) return;
      cookies[name] = part.slice(eq + 1).trim();
    });
  return cookies;
}

function expiryEpochToIso(expiryEpoch) {
  if (!Number.isFinite(expiryEpoch)) return null;
  const millis = expiryEpoch > 100000000000 ? expiryEpoch : expiryEpoch * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseExpiryEpoch(value) {
  const text = String(value || '').trim().replace(/^"|"$/g, '');
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsedGrafanaCookie(cookies) {
  const cookieHeader = TARGET_COOKIE_NAMES
    .filter((name) => cookies[name] != null)
    .map((name) => `${name}=${cookies[name]}`)
    .join('; ');
  const expiryEpoch = parseExpiryEpoch(cookies.grafana_session_expiry);
  return {
    cookieHeader,
    expiryEpoch,
    expiryIso: expiryEpochToIso(expiryEpoch),
  };
}

function parseGrafanaSetCookie(setCookieHeaderOrArray) {
  const cookies = {};
  for (const header of setCookieValues(setCookieHeaderOrArray)) {
    const firstPart = String(header || '').split(';')[0].trim();
    const eq = firstPart.indexOf('=');
    if (eq <= 0) continue;
    const name = firstPart.slice(0, eq).trim();
    if (!TARGET_COOKIE_NAMES.includes(name)) continue;
    cookies[name] = firstPart.slice(eq + 1).trim();
  }
  return parsedGrafanaCookie(cookies);
}

function parseGrafanaCookieHeader(cookieHeader) {
  return parsedGrafanaCookie(cookiePairsFromHeader(cookieHeader));
}

function hasCompleteGrafanaSession(parsed) {
  const cookies = cookiePairsFromHeader(parsed?.cookieHeader);
  return Boolean(cookies.grafana_session && cookies.grafana_session_expiry);
}

async function discardBody(response) {
  try {
    await response.arrayBuffer();
  } catch (_) {
    // The auth decision is based on status and headers; body drain failures are not useful here.
  }
}

async function fetchUser(cookieHeader) {
  if (!cookieHeader) {
    throw new GrafanaAuthError('Grafana cookie header is required.');
  }
  return fetch(USER_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Cookie: cookieHeader,
      'x-grafana-org-id': '1',
    },
  });
}

async function validateSession(cookieHeader) {
  let response;
  try {
    response = await fetchUser(cookieHeader);
  } catch (error) {
    if (error instanceof GrafanaAuthError) throw error;
    throw new GrafanaAuthError('Grafana session validation request failed.', { cause: error });
  }
  await discardBody(response);
  if (response.status === 200) return { ok: true, status: 200 };
  return { ok: false, status: response.status };
}

async function coldLogin({ username, password }) {
  if (!username || !password) {
    throw new GrafanaAuthError('Grafana username and password are required.');
  }

  let response;
  try {
    response = await fetch(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user: username, password }),
    });
  } catch (error) {
    throw new GrafanaAuthError('Grafana login request failed.', { cause: error });
  }

  const parsed = parseGrafanaSetCookie(response.headers);
  await discardBody(response);

  if (!response.ok) {
    throw new GrafanaAuthError(`Grafana login failed with HTTP status ${response.status}.`, {
      status: response.status,
    });
  }
  if (!hasCompleteGrafanaSession(parsed)) {
    throw new GrafanaAuthError('Grafana login response did not include required session cookies.', {
      status: response.status,
    });
  }

  const validation = await validateSession(parsed.cookieHeader);
  if (!validation.ok) {
    throw new GrafanaAuthError(`Grafana login validation failed with HTTP status ${validation.status}.`, {
      status: validation.status,
    });
  }

  return {
    ...parsed,
    validatedAt: new Date().toISOString(),
  };
}

async function rotateSession(cookieHeader) {
  if (!cookieHeader) {
    throw new GrafanaStaleSessionError('Grafana cookie header is required for rotation.');
  }

  let response;
  try {
    response = await fetch(ROTATE_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'x-grafana-org-id': '1',
      },
      body: JSON.stringify({}),
    });
  } catch (error) {
    throw new GrafanaStaleSessionError('Grafana session rotation request failed.', { cause: error });
  }

  const rotated = parseGrafanaSetCookie(response.headers);
  await discardBody(response);

  if (!response.ok) {
    throw new GrafanaStaleSessionError(`Grafana session rotation failed with HTTP status ${response.status}.`, {
      status: response.status,
    });
  }
  if (!hasCompleteGrafanaSession(rotated)) {
    throw new GrafanaStaleSessionError('Grafana session rotation did not return required session cookies.', {
      status: response.status,
    });
  }

  const validation = await validateSession(rotated.cookieHeader);
  if (!validation.ok) {
    throw new GrafanaStaleSessionError(`Grafana rotated session validation failed with HTTP status ${validation.status}.`, {
      status: validation.status,
    });
  }

  return {
    ...rotated,
    rotated: true,
    validatedAt: new Date().toISOString(),
  };
}

async function rotateOrValidate(cookieHeader) {
  return rotateSession(cookieHeader);
}

module.exports = {
  GrafanaAuthError,
  GrafanaStaleSessionError,
  coldLogin,
  parseGrafanaSetCookie,
  rotateOrValidate,
  rotateSession,
  validateSession,
};
