#!/usr/bin/env node
'use strict';

const {
  GrafanaStaleSessionError,
  coldLogin,
  rotateSession,
} = require('../../src/lib/trackers/grafana-auth-core');

function cookieNames(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.includes('='))
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}

function epochToMillis(epoch) {
  if (!Number.isFinite(epoch)) return null;
  return epoch > 100000000000 ? epoch : epoch * 1000;
}

function lifetimeSeconds(expiryEpoch) {
  const millis = epochToMillis(expiryEpoch);
  if (!millis) return null;
  return Math.max(0, Math.round((millis - Date.now()) / 1000));
}

function printError(error) {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  if (Number.isFinite(error?.status)) {
    console.error(`status: ${error.status}`);
  }
}

async function main() {
  const username = process.env.REBOTICS_USERNAME;
  const password = process.env.REBOTICS_PASSWORD;
  if (!username || !password) {
    console.error('Missing required env: REBOTICS_USERNAME and REBOTICS_PASSWORD must both be set.');
    process.exitCode = 1;
    return;
  }

  const login = await coldLogin({ username, password });
  const names = cookieNames(login.cookieHeader);
  const seconds = lifetimeSeconds(login.expiryEpoch);

  console.log('coldLogin:');
  console.log(`  cookieNames: ${names.length ? names.join(', ') : '(none)'}`);
  console.log(`  expiryEpoch: ${login.expiryEpoch ?? '(none)'}`);
  console.log(`  expiryIso: ${login.expiryIso || '(none)'}`);
  console.log(`  approximateLifetimeSeconds: ${seconds ?? '(unknown)'}`);
  console.log(`  validationStatus: 200`);
  console.log(`  validatedAt: ${login.validatedAt}`);

  try {
    const rotated = await rotateSession(login.cookieHeader);
    console.log('rotateSession:');
    console.log(`  status: 200`);
    console.log(`  rotated: ${rotated.rotated ? 'true' : 'false'}`);
    if (rotated.rotated) {
      console.log(`  expiryIso: ${rotated.expiryIso || '(none)'}`);
    }
    console.log(`  validatedAt: ${rotated.validatedAt}`);
  } catch (error) {
    if (error instanceof GrafanaStaleSessionError) {
      console.error('rotateSession:');
      printError(error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
