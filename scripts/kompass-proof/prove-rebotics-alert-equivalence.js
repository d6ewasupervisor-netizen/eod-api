#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'rebotics-reauth-payload.golden.json');
const FIXED_PATH_THAT_FAILED = 'TEST_PATH';

function normalizePayload(payload) {
  return {
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    reply_to: payload.reply_to,
  };
}

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value).sort(), 2);
}

function createFakeApp() {
  const app = {};
  for (const method of ['delete', 'get', 'patch', 'post', 'put', 'use']) {
    app[method] = () => app;
  }
  return app;
}

function createFakePool() {
  return {
    async query(sql) {
      const text = String(sql || '').toLowerCase();
      if (text.includes('select username, token, user_id')) {
        return { rows: [] };
      }
      if (text.includes('select refreshed_at')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function capturePayload() {
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'proof-only-no-send';
  delete process.env.REBOTICS_REAUTH_NOTIFY_EMAIL;
  delete process.env.RESEND_REPLY_TO;

  const captured = [];
  const resend = {
    emails: {
      async send(payload) {
        captured.push(normalizePayload(payload));
        return { data: { id: 'proof-no-send' } };
      },
    },
  };

  const reboticsBridge = require('../../src/rebotics-bridge');
  await reboticsBridge.init(createFakeApp(), createFakePool(), { resend });
  const result = await reboticsBridge.triggerManualReauth(FIXED_PATH_THAT_FAILED);
  if (result?.ok === false) {
    throw new Error(`triggerManualReauth failed: ${result.error || 'unknown error'}`);
  }
  if (captured.length !== 1) {
    throw new Error(`expected one captured email payload, saw ${captured.length}`);
  }
  return captured[0];
}

async function writeGolden() {
  const payload = await capturePayload();
  const fixture = {
    transformSource: 'pre-extraction',
    pathThatFailed: FIXED_PATH_THAT_FAILED,
    payload,
  };
  await fs.writeFile(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log('goldenPayload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log(`goldenWritten: ${path.relative(REPO_ROOT, GOLDEN_PATH).replace(/\\/g, '/')}`);
}

async function verifyGolden() {
  const payload = await capturePayload();
  const fixture = JSON.parse(await fs.readFile(GOLDEN_PATH, 'utf8'));
  const actual = stableStringify(payload);
  const expected = stableStringify(fixture.payload);
  const ok = actual === expected;
  console.log('capturedPayload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log(`equivalence: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    console.error('expectedPayload:');
    console.error(JSON.stringify(fixture.payload, null, 2));
    process.exitCode = 1;
  }
}

async function main() {
  if (process.argv.includes('--write-golden')) {
    await writeGolden();
    return;
  }
  if (process.argv.includes('--verify')) {
    await verifyGolden();
    return;
  }
  console.error('Usage: node scripts/kompass-proof/prove-rebotics-alert-equivalence.js --write-golden|--verify');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
