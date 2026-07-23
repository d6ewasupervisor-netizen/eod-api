'use strict';

/**
 * Local Rebotics username/password login (same 2FA simple flow as sas-auth
 * morning-auth-rebotics.js). Used to bind district-scoped SI work to different
 * accounts without pushing alternate tokens to Railway.
 *
 * Creds (eod-api/.env):
 *   REBOTICS_USERNAME / REBOTICS_PASSWORD     — primary (District 8)
 *   REBOTICS_USERNAME2 / REBOTICS_PASSWORD2   — secondary (District 6)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EOD_API_ROOT = path.resolve(__dirname, '../../..');
const SESSION_DIR = path.join(EOD_API_ROOT, '.rebotics-session-local');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function loadEodApiReboticsEnv() {
  loadEnvFile(path.join(EOD_API_ROOT, '.env'));
}

function ensureDeviceId(username) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const safe = String(username || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const deviceFile = path.join(SESSION_DIR, `device-${safe}.txt`);
  if (fs.existsSync(deviceFile)) return fs.readFileSync(deviceFile, 'utf8').trim();
  const id = crypto.randomUUID();
  fs.writeFileSync(deviceFile, id, { encoding: 'utf8', mode: 0o600 });
  return id;
}

async function getHost() {
  const res = await fetch('https://r3us-admin.rebotics.net/retailers/host/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'company=kroger',
  });
  if (!res.ok) throw new Error(`retailers/host/ failed HTTP ${res.status}`);
  const body = await res.json();
  const host = String(body.host || '').replace(/\/$/, '');
  if (!host) throw new Error('No host in retailers/host response');
  return host;
}

function tfaRequiresInteract(twoFactorType) {
  if (twoFactorType == null || twoFactorType === '' || twoFactorType === 'none') return false;
  const t = String(twoFactorType).toLowerCase();
  return !(t === 'simple' || t === 'none');
}

async function twoFaStatus(api, username, password, deviceId) {
  const body = new URLSearchParams({ username, password, device_id: deviceId });
  const res = await fetch(`${api}/api/v1/2fa/status/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`2fa/status HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function twoFaVerify(api, username, password, deviceId) {
  const body = new URLSearchParams({
    username,
    password,
    device_id: deviceId,
    token_type: 'simple',
  });
  const res = await fetch(`${api}/api/v1/2fa/verify/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`2fa/verify HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function obtainTokenWithPassword(username, password) {
  if (!username || !password) {
    throw new Error('username and password are required for Rebotics password login');
  }
  const api = await getHost();
  const deviceId = ensureDeviceId(username);
  const status = await twoFaStatus(api, username, password, deviceId);
  if (tfaRequiresInteract(status.two_factor_type)) {
    throw new Error(
      `2FA type "${status.two_factor_type}" for ${username} is not handled by password login helper`,
    );
  }
  const verified = await twoFaVerify(api, username, password, deviceId);
  const token = verified.token;
  if (!token) throw new Error(`No token in 2fa/verify response for ${username}`);
  const userId = typeof verified.user_id === 'number'
    ? verified.user_id
    : (typeof verified.user?.id === 'number' ? verified.user.id : null);
  return {
    token: String(token),
    username: String(username),
    userId,
    api,
  };
}

async function fetchUsersMe(token, apiBase) {
  const base = (apiBase || process.env.REBOTICS_API_BASE || 'https://krcs.rebotics.net').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/users/me/`, {
    headers: {
      Authorization: `Token ${token}`,
      'Accept-Language': 'en',
      'X-Timezone': 'America/Los_Angeles',
    },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Primary (D8) = REBOTICS_USERNAME/PASSWORD
 * Secondary (D6) = REBOTICS_USERNAME2/PASSWORD2
 */
async function loadDistrictReboticsSessions() {
  loadEodApiReboticsEnv();
  const primaryUser = process.env.REBOTICS_USERNAME;
  const primaryPass = process.env.REBOTICS_PASSWORD;
  const secondaryUser = process.env.REBOTICS_USERNAME2;
  const secondaryPass = process.env.REBOTICS_PASSWORD2;

  if (!primaryUser || !primaryPass) {
    throw new Error('REBOTICS_USERNAME / REBOTICS_PASSWORD missing from eod-api/.env');
  }
  if (!secondaryUser || !secondaryPass) {
    throw new Error('REBOTICS_USERNAME2 / REBOTICS_PASSWORD2 missing from eod-api/.env');
  }

  console.log(`[rebotics-auth] logging in primary (D8)=${primaryUser}`);
  const primary = await obtainTokenWithPassword(primaryUser, primaryPass);
  console.log(`[rebotics-auth] logging in secondary (D6)=${secondaryUser}`);
  const secondary = await obtainTokenWithPassword(secondaryUser, secondaryPass);

  // Optional explicit ids from env (april.omeara cannot call /users/me — 403).
  const primaryUserIdEnv = process.env.REBOTICS_USER_ID;
  const secondaryUserIdEnv = process.env.REBOTICS_USER_ID2 || process.env.REBOTICS_DEFAULT_USER_ID;

  for (const [session, envId] of [
    [primary, primaryUserIdEnv],
    [secondary, secondaryUserIdEnv],
  ]) {
    if (session.userId == null) {
      const me = await fetchUsersMe(session.token, session.api);
      const id = me?.id ?? me?.pk;
      if (typeof id === 'number') session.userId = id;
    }
    if (session.userId == null && envId && /^\d+$/.test(String(envId))) {
      session.userId = Number(envId);
      console.warn(`[rebotics-auth] ${session.username}: using env user id ${session.userId} (/users/me unavailable)`);
    }
    if (session.userId == null) {
      // Last resort for shift open: primary account id (works under secondary token in practice).
      session.userId = 211;
      console.warn(`[rebotics-auth] ${session.username}: falling back to userId=211 for shift open`);
    }
    console.log(`[rebotics-auth] ok user=${session.username} userId=${session.userId}`);
  }

  return {
    primary, // District 8
    secondary, // District 6
    byDistrict: {
      6: secondary,
      8: primary,
    },
  };
}

function envForReboticsSession(session) {
  return {
    REBOTICS_TOKEN: session.token,
    REBOTICS_USERNAME: session.username,
    REBOTICS_USER_ID: session.userId != null ? String(session.userId) : '',
  };
}

module.exports = {
  loadEodApiReboticsEnv,
  obtainTokenWithPassword,
  loadDistrictReboticsSessions,
  envForReboticsSession,
};
