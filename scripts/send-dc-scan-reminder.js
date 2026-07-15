#!/usr/bin/env node
/**
 * Remind DC Scan volunteers (+ supervisor) that shifts still need commitment/finalize.
 *
 *   node scripts/send-dc-scan-reminder.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Resend } = require('resend');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile();

async function loadResendFromRailway() {
  if (process.env.RESEND_API_KEY) return;
  const cfg = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.railway', 'config.json'), 'utf8'),
  );
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new Error('RESEND_API_KEY is not set and Railway is not logged in locally.');
  }
  const query = `
    query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`;
  const resp = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        projectId: '5bc0629e-2ebb-49f2-9e13-8b878a16bf93',
        environmentId: '082a323e-a570-4ed0-8ee6-8eee60e28e95',
        serviceId: '7478ebb4-8bae-4e30-a2d5-9cb41723d2e2',
      },
    }),
  });
  const data = await resp.json();
  if (data.errors?.length) {
    throw new Error(data.errors[0].message || 'Railway variables query failed');
  }
  const key = data.data?.variables?.RESEND_API_KEY;
  if (!key) {
    throw new Error('RESEND_API_KEY not found in Railway service variables.');
  }
  process.env.RESEND_API_KEY = key;
}

const {
  notifyCommitmentReminder,
  volunteerInviteFrom,
  DASHBOARD_URL,
} = require('../src/lib/dc-scan-notify');
const { VOLUNTEERS, DEFAULT_SUPERVISOR_EMAIL } = require('../src/lib/dc-scan-inventory');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const to = [...VOLUNTEERS.map((v) => v.email), DEFAULT_SUPERVISOR_EMAIL];
  console.log('From:', volunteerInviteFrom());
  console.log('To:', to.join(', '));
  console.log('Dashboard:', DASHBOARD_URL);

  if (DRY_RUN) {
    console.log('[dry-run] Skipping send.');
    return;
  }

  await loadResendFromRailway();

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await notifyCommitmentReminder(resend, { to });
  if (result?.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }
  console.log('Sent:', result?.data?.id || result?.recordId || 'ok');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
