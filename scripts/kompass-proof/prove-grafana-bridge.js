#!/usr/bin/env node
'use strict';

const realAuthCore = require('../../src/lib/trackers/grafana-auth-core');
const { createGrafanaBridge } = require('../../src/grafana-bridge');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createFakeResend() {
  const sent = [];
  return {
    sent,
    resend: {
      emails: {
        async send(payload) {
          sent.push({
            from: payload.from,
            to: payload.to,
            subject: payload.subject,
            html: payload.html,
            reply_to: payload.reply_to,
          });
          return { data: { id: 'proof-no-send' } };
        },
      },
    },
  };
}

function createSession(nowMs, offsetSeconds = 600) {
  const expiryEpoch = Math.floor(nowMs / 1000) + offsetSeconds;
  return {
    cookieHeader: `proof-cookie-${expiryEpoch}`,
    expiryEpoch,
    expiryIso: new Date(expiryEpoch * 1000).toISOString(),
    validatedAt: new Date(nowMs).toISOString(),
  };
}

function printPass(name, details = {}) {
  console.log(`${name}: PASS ${JSON.stringify(details)}`);
}

function printFail(name, error) {
  console.error(`${name}: FAIL ${error?.message || String(error)}`);
}

async function runTest(name, fn) {
  try {
    const details = await fn();
    printPass(name, details);
    return true;
  } catch (error) {
    printFail(name, error);
    return false;
  }
}

async function t1HappySeed() {
  const bridge = createGrafanaBridge({ authCore: realAuthCore });
  const result = await bridge.seed();
  const status = bridge.getStatus();
  assert(result.ok === true, 'seed did not return ok');
  assert(status.hasCookie === true, 'seed did not store a cookie');
  assert(status.healthy === true, 'seed did not mark bridge healthy');
  assert(Boolean(status.expiryIso), 'seed did not set expiryIso');
  return {
    hasCookie: status.hasCookie,
    healthy: status.healthy,
    expiryIso: status.expiryIso,
  };
}

async function t2HappyRotate(shared) {
  const result = await shared.bridge.rotate();
  const status = shared.bridge.getStatus();
  assert(result.ok === true, 'rotate did not return ok');
  assert(status.healthy === true, 'rotate did not keep bridge healthy');
  assert(Boolean(status.lastRotatedAt), 'rotate did not set lastRotatedAt');
  return {
    hasCookie: status.hasCookie,
    healthy: status.healthy,
    expiryIso: status.expiryIso,
    lastRotatedAt: status.lastRotatedAt,
  };
}

async function t3StaleRecover() {
  let currentTime = Date.UTC(2026, 5, 9, 19, 0, 0);
  let coldLoginAttempts = 0;
  const authCore = {
    GrafanaStaleSessionError: realAuthCore.GrafanaStaleSessionError,
    async rotateSession() {
      throw new realAuthCore.GrafanaStaleSessionError('proof stale');
    },
    async coldLogin() {
      coldLoginAttempts += 1;
      return createSession(currentTime);
    },
  };
  const bridge = createGrafanaBridge({
    authCore,
    now: () => currentTime,
    creds: { username: 'proof-user', password: 'proof-pass' },
  });
  bridge.applySession(createSession(currentTime, 300));
  const result = await bridge.rotate();
  const status = bridge.getStatus();
  assert(result.ok === true && result.recovered === true, 'stale rotate did not recover');
  assert(coldLoginAttempts === 1, `expected one cold login, saw ${coldLoginAttempts}`);
  assert(status.healthy === true, 'recover did not mark bridge healthy');
  return {
    coldLoginAttempts,
    healthy: status.healthy,
    hasCookie: status.hasCookie,
  };
}

async function t4RecoverFailAlert() {
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'proof-only-no-send';
  const fake = createFakeResend();
  let currentTime = Date.UTC(2026, 5, 9, 19, 10, 0);
  let coldLoginAttempts = 0;
  const authCore = {
    GrafanaStaleSessionError: realAuthCore.GrafanaStaleSessionError,
    async rotateSession() {
      throw new realAuthCore.GrafanaStaleSessionError('proof stale');
    },
    async coldLogin() {
      coldLoginAttempts += 1;
      throw new Error('proof cold login failure');
    },
  };
  const bridge = createGrafanaBridge({
    authCore,
    resend: fake.resend,
    now: () => currentTime,
    creds: { username: 'proof-user', password: 'proof-pass' },
  });
  bridge.applySession(createSession(currentTime, 300));
  const result = await bridge.rotate();
  const status = bridge.getStatus();
  assert(result.ok === false, 'failed recovery unexpectedly returned ok');
  assert(coldLoginAttempts === 1, `expected one cold login, saw ${coldLoginAttempts}`);
  assert(fake.sent.length === 1, `expected one alert, saw ${fake.sent.length}`);
  assert(fake.sent[0].subject === 'KOMPASS GRAFANA AUTH', 'alert subject mismatch');
  assert(fake.sent[0].html.includes('Railway Grafana auth automatic recovery FAILED after a single clean attempt'), 'alert wording missing failure sentence');
  assert(fake.sent[0].html.includes('Investigate Railway Grafana/Rebotics auth recovery'), 'alert wording missing investigate sentence');
  assert(status.healthy === false, 'failed recovery did not mark bridge unhealthy');
  return {
    coldLoginAttempts,
    alerts: fake.sent.length,
    alertSubject: fake.sent[0].subject,
    healthy: status.healthy,
  };
}

async function t5Cooldown() {
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'proof-only-no-send';
  const fake = createFakeResend();
  let currentTime = Date.UTC(2026, 5, 9, 19, 20, 0);
  let coldLoginAttempts = 0;
  const authCore = {
    async coldLogin() {
      coldLoginAttempts += 1;
      throw new Error('proof cold login failure');
    },
  };
  const bridge = createGrafanaBridge({
    authCore,
    resend: fake.resend,
    now: () => currentTime,
    cooldownMs: 10 * 60 * 1000,
    creds: { username: 'proof-user', password: 'proof-pass' },
  });
  const first = await bridge.coldRecover();
  const second = await bridge.coldRecover();
  currentTime += 10 * 60 * 1000 + 1;
  const third = await bridge.coldRecover();
  assert(first.ok === false, 'first failing recovery should be false');
  assert(second.deferred === true, 'second recovery inside cooldown should defer');
  assert(third.ok === false && third.deferred !== true, 'third recovery after cooldown should attempt');
  assert(coldLoginAttempts === 2, `expected two attempts after cooldown, saw ${coldLoginAttempts}`);
  assert(fake.sent.length === 2, `expected two alerts after cooldown, saw ${fake.sent.length}`);
  return {
    firstAttemptOk: first.ok,
    secondDeferred: second.deferred,
    coldLoginAttempts,
    alerts: fake.sent.length,
  };
}

async function t6KillSwitch() {
  const previous = process.env.GRAFANA_AUTH_DISABLED;
  process.env.GRAFANA_AUTH_DISABLED = 'true';
  let seedAttempts = 0;
  const authCore = {
    async coldLogin() {
      seedAttempts += 1;
      return createSession(Date.now());
    },
  };
  const bridge = createGrafanaBridge({ authCore });
  const result = await bridge.init(null, null, { resend: createFakeResend().resend });
  const status = bridge.getStatus();
  if (previous == null) {
    delete process.env.GRAFANA_AUTH_DISABLED;
  } else {
    process.env.GRAFANA_AUTH_DISABLED = previous;
  }
  assert(result.disabled === true, 'init did not report disabled');
  assert(seedAttempts === 0, `disabled init attempted seed ${seedAttempts} times`);
  assert(status.heartbeatActive === false, 'disabled init started heartbeat');
  assert(bridge.getGrafanaCookie() === null, 'disabled bridge returned a cookie');
  return {
    disabled: result.disabled,
    seedAttempts,
    heartbeatActive: status.heartbeatActive,
  };
}

async function main() {
  const shared = {};
  let passed = 0;
  let failed = 0;

  const t1 = await runTest('T1 happy seed', async () => {
    shared.bridge = createGrafanaBridge({ authCore: realAuthCore });
    const result = await shared.bridge.seed();
    const status = shared.bridge.getStatus();
    assert(result.ok === true, 'seed did not return ok');
    assert(status.hasCookie === true, 'seed did not store a cookie');
    assert(status.healthy === true, 'seed did not mark bridge healthy');
    assert(Boolean(status.expiryIso), 'seed did not set expiryIso');
    return {
      hasCookie: status.hasCookie,
      healthy: status.healthy,
      expiryIso: status.expiryIso,
    };
  });
  t1 ? passed += 1 : failed += 1;

  for (const [name, fn] of [
    ['T2 happy rotate', () => t2HappyRotate(shared)],
    ['T3 stale recover', t3StaleRecover],
    ['T4 recover fail alert', t4RecoverFailAlert],
    ['T5 cooldown', t5Cooldown],
    ['T6 kill switch', t6KillSwitch],
  ]) {
    const ok = await runTest(name, fn);
    ok ? passed += 1 : failed += 1;
  }

  console.log(`summary: ${JSON.stringify({ passed, failed })}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
