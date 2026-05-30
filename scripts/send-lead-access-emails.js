#!/usr/bin/env node
/**
 * Grant Checklane Hub lead standing (rank 2) and email magic links to team leads.
 *
 *   node scripts/send-lead-access-emails.js [--dry-run]
 *
 * Defaults to cycle 242292 seed associates; override with LEAD_EMAILS env (comma-separated hub emails).
 */
'use strict';

if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const fs = require('fs');
const path = require('path');
const { query, pool } = require('../src/lib/db');
const { issueLinkToken } = require('../src/lib/tokens');
const { buildMagicLink } = require('../src/lib/magic-link');
const { sendHubLeadAccessEmail } = require('../src/lib/auth-email');

const DRY_RUN = process.argv.includes('--dry-run');
const SEED_PATH = path.join(__dirname, '../src/data/kompass-cycle-242292-seed.json');

/** Hub user email keys from kompass-cycle-242292 seed (Tyson's team leads). */
const DEFAULT_LEAD_EMAILS = [
  'alex.wright2@retailodyssey.com',
  'james.duchene@retailodyssey.com',
  'jes.zumwalt@sasretailservices.com',
  'ruth.northcutt@sasretailservices.com',
  'aiyana.natarisalazar@retailodyssey.com',
];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hubBase() {
  return (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').replace(/\/+$/, '');
}

function buildChecklanesUrl(storeNumber, visitId) {
  if (storeNumber && visitId) {
    const params = new URLSearchParams({
      store: String(Number(storeNumber) || storeNumber),
      visit: String(visitId),
      view: 'assignments',
    });
    return `${hubBase()}/checklanes/hub.html?${params.toString()}`;
  }
  return `${hubBase()}/checklanes/`;
}

function pickPrimaryStore(associate, storeMap) {
  const stores = associate?.stores || {};
  const leadStores = Object.entries(stores)
    .filter(([, role]) => role === 'lead')
    .map(([sn]) => sn)
    .sort((a, b) => Number(a) - Number(b));
  const allStores = Object.keys(stores).sort((a, b) => Number(a) - Number(b));
  const primary = (leadStores[0] || allStores[0] || null);
  if (!primary) return { storeNumber: null, visitId: null, labels: [] };
  const visitId = storeMap.get(primary)?.default_visit_id || null;
  const labels = allStores.map((sn) => {
    const role = stores[sn];
    return role === 'lead' ? `FM ${sn} (lead)` : `FM ${sn}`;
  });
  return { storeNumber: primary, visitId, labels };
}

async function grantLeadAccess(hubUserId) {
  if (DRY_RUN) {
    console.log(`  [dry-run] standing_rank -> max(2) for user ${hubUserId}`);
    return;
  }
  await query(
    `UPDATE hub_users
     SET standing_rank = GREATEST(COALESCE(standing_rank, 1), 2),
         hub_invited_at = COALESCE(hub_invited_at, now()),
         login_email = NULL,
         is_active = TRUE
     WHERE id = $1`,
    [hubUserId],
  );
}

async function loadStoreMap() {
  const { rows } = await query(
    'SELECT store_number, default_visit_id FROM hub_stores ORDER BY store_number',
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.store_number), row);
  }
  return map;
}

async function resolveHubUserByEmail(email) {
  const normalized = normalizeEmail(email);
  const { rows } = await query(
    `SELECT id, email, name, login_email, standing_rank
     FROM hub_users
     WHERE lower(email) = $1
     LIMIT 1`,
    [normalized],
  );
  return rows[0] || null;
}

function signInEmail(hubUser) {
  return normalizeEmail(hubUser.email);
}

async function sendLeadInvite({ hubUser, associate, storeMap }) {
  const loginEmail = signInEmail(hubUser);
  const { storeNumber, visitId, labels } = pickPrimaryStore(associate, storeMap);
  const returnTo = buildChecklanesUrl(storeNumber, visitId);

  await grantLeadAccess(hubUser.id);

  const { token, jti } = issueLinkToken(loginEmail);
  const link = buildMagicLink(token, returnTo);
  if (!link) {
    throw new Error(`Could not build magic link for ${loginEmail}`);
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] email -> ${loginEmail}`);
    console.log(`  [dry-run] returnTo -> ${returnTo}`);
    return { loginEmail, returnTo, resendId: null };
  }

  await query(
    `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, NULL, $3)`,
    [loginEmail, jti, 'send-lead-access-emails'],
  );

  const result = await sendHubLeadAccessEmail({
    to: loginEmail,
    link,
    leadName: hubUser.name,
    storeLabels: labels,
  });

  await query(
    `UPDATE hub_users SET last_invite_sent_at = now() WHERE id = $1`,
    [hubUser.id],
  );

  return {
    loginEmail,
    returnTo,
    resendId: result?.data?.id || result?.id || null,
  };
}

async function main() {
  if (!DRY_RUN && !process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }
  if (!process.env.DATABASE_URL && !process.env.DATABASE_PUBLIC_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!fs.existsSync(SEED_PATH)) {
    throw new Error(`Missing seed file: ${SEED_PATH}`);
  }

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const associateByEmail = new Map(
    (seed.associates || []).map((a) => [normalizeEmail(a.email), a]),
  );

  const leadEmails = (process.env.LEAD_EMAILS || '')
    .split(',')
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  const targets = leadEmails.length ? leadEmails : DEFAULT_LEAD_EMAILS;

  const storeMap = await loadStoreMap();
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Sending lead access to ${targets.length} team leads...`);

  for (const email of targets) {
    const hubUser = await resolveHubUserByEmail(email);
    if (!hubUser) {
      console.warn(`  SKIP ${email}: hub_users row not found`);
      continue;
    }

    const associate = associateByEmail.get(normalizeEmail(hubUser.email)) || null;
    console.log(`\n${hubUser.name} <${hubUser.email}>`);
    console.log(`  standing_rank was ${hubUser.standing_rank}`);

    try {
      const sent = await sendLeadInvite({ hubUser, associate, storeMap });
      console.log(`  sent to ${sent.loginEmail}`);
      console.log(`  link target: ${sent.returnTo}`);
      if (sent.resendId) console.log(`  resendId: ${sent.resendId}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(() => pool.end());
