#!/usr/bin/env node
'use strict';

const {
  GrafanaStaleSessionError,
  coldLogin,
  parseGrafanaSetCookie,
  rotateSession,
  validateSession,
} = require('../../src/lib/trackers/grafana-auth-core');

const GRAFANA_BASE = 'https://krcs-reporting.rebotics.net';
const USER_URL = `${GRAFANA_BASE}/api/user`;
const POLL_INTERVAL_MS = 45 * 1000;
const MAX_POLL_MS = 11 * 60 * 1000;
const SLIDE_WAIT_MS = 90 * 1000;
const SLIDE_TOLERANCE_SECONDS = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieNames(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.includes('='))
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}

function hasGrafanaSession(parsed) {
  const names = cookieNames(parsed?.cookieHeader);
  return names.includes('grafana_session') && names.includes('grafana_session_expiry');
}

async function discardBody(response) {
  try {
    await response.arrayBuffer();
  } catch (_) {
    // This proof is about status and Set-Cookie metadata only.
  }
}

async function getUser(cookieHeader) {
  const started = Date.now();
  const response = await fetch(USER_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Cookie: cookieHeader,
      'x-grafana-org-id': '1',
    },
  });
  const rotated = parseGrafanaSetCookie(response.headers);
  await discardBody(response);
  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    rotated,
  };
}

async function validateBoolean(cookieHeader) {
  const validation = await validateSession(cookieHeader);
  return validation.ok === true && validation.status === 200;
}

function printJson(label, value) {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

function printError(error) {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  if (Number.isFinite(error?.status)) {
    console.error(`status: ${error.status}`);
  }
}

async function runTestB(cookieHeader) {
  console.log('TEST B notice: long-runner polling every 45s for up to 11 minutes; this is not a hang.');
  const started = Date.now();
  let poll = 0;

  while (Date.now() - started <= MAX_POLL_MS) {
    poll += 1;
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    const result = await getUser(cookieHeader);
    const rotated = hasGrafanaSession(result.rotated);

    printJson('testB.poll', {
      poll,
      elapsedSeconds,
      status: result.status,
      requestElapsedMs: result.elapsedMs,
      rotated,
    });

    if (rotated) {
      const rotatedValidates = await validateBoolean(result.rotated.cookieHeader);
      printJson('testB', {
        rotatedAtElapsedSeconds: Math.round((Date.now() - started) / 1000),
        rotatedValidates,
      });
      return;
    }

    const remainingMs = MAX_POLL_MS - (Date.now() - started);
    if (remainingMs <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  console.log('GET-based auto-rotation NOT observed — warm path must use re-login fallback');
}

async function runTestC({ username, password }) {
  const seedStarted = Date.now();
  const seed = await coldLogin({ username, password });
  console.log('waiting 90s (not a hang)…');
  await sleep(SLIDE_WAIT_MS);

  const rotateStarted = Date.now();
  let rotatedSession = null;
  let rotateStatus = null;
  let rotateError = null;
  try {
    rotatedSession = await rotateSession(seed.cookieHeader);
    rotateStatus = 200;
  } catch (error) {
    rotateError = error;
    rotateStatus = Number.isFinite(error?.status) ? error.status : null;
  }
  const elapsedSeconds = Math.round((Date.now() - seedStarted) / 1000);
  const rotated = hasGrafanaSession(rotatedSession);
  const rotatedValidates = rotated && !rotateError
    ? await validateBoolean(rotatedSession.cookieHeader)
    : false;
  const expiryDeltaSeconds = (
    Number.isFinite(seed.expiryEpoch)
    && Number.isFinite(rotatedSession?.expiryEpoch)
  )
    ? rotatedSession.expiryEpoch - seed.expiryEpoch
    : null;

  printJson('testC', {
    seedExpiryIso: seed.expiryIso,
    rotatedExpiryIso: rotated ? rotatedSession.expiryIso : null,
    expiryDeltaSeconds,
    elapsedSeconds,
    rotateStatus,
    requestElapsedMs: Date.now() - rotateStarted,
    rotatedValidates,
  });

  const slides = rotatedValidates
    && Number.isFinite(expiryDeltaSeconds)
    && Math.abs(expiryDeltaSeconds - elapsedSeconds) <= SLIDE_TOLERANCE_SECONDS;
  if (slides) {
    console.log('ROTATION SLIDES (expiryDelta ≈ elapsed) — warm path keeps session alive');
    return;
  }
  console.log('ROTATION DOES NOT SLIDE — expiry pinned; redesign cadence');
}

async function main() {
  const username = process.env.REBOTICS_USERNAME;
  const password = process.env.REBOTICS_PASSWORD;
  if (!username || !password) {
    console.error('Missing required env: REBOTICS_USERNAME and REBOTICS_PASSWORD must both be set.');
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--slide')) {
    await runTestC({ username, password });
    return;
  }

  let current = await coldLogin({ username, password });
  const seedValidation = await validateSession(current.cookieHeader);
  printJson('seed', {
    cookieNames: cookieNames(current.cookieHeader),
    expiryIso: current.expiryIso,
    validationStatus: seedValidation.status,
  });

  const testAStarted = Date.now();
  let testAResponse = null;
  let testAStatus = null;
  let testAError = null;
  try {
    testAResponse = await rotateSession(current.cookieHeader);
    testAStatus = 200;
  } catch (error) {
    testAError = error;
    testAStatus = Number.isFinite(error?.status) ? error.status : null;
    if (!(error instanceof GrafanaStaleSessionError)) throw error;
  }
  const testARotated = hasGrafanaSession(testAResponse);
  let testARotatedValidates = false;
  if (testARotated && !testAError) {
    current = testAResponse;
    testARotatedValidates = await validateBoolean(current.cookieHeader);
  }

  printJson('testA', {
    status: testAStatus,
    requestElapsedMs: Date.now() - testAStarted,
    rotated: testARotated,
    rotatedValidates: testARotatedValidates,
    newExpiryIso: testARotated ? testAResponse.expiryIso : null,
  });

  if (testARotated && testARotatedValidates) {
    console.log('WARM PATH = explicit rotate endpoint');
    return;
  }

  await runTestB(current.cookieHeader);
}

main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
