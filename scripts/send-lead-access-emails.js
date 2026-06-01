#!/usr/bin/env node
/**
 * Grant Checklane Hub lead standing (rank 2) and email magic links to team leads.
 *
 *   node scripts/send-lead-access-emails.js [--dry-run]
 *
 * Override recipients with LEAD_EMAILS env (comma-separated hub emails).
 */
'use strict';

if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const path = require('path');
const { query, pool } = require('../src/lib/db');
const { issueLinkToken } = require('../src/lib/tokens');
const { buildMagicLink } = require('../src/lib/magic-link');
const { sendHubLeadAccessEmail } = require('../src/lib/auth-email');

const DRY_RUN = process.argv.includes('--dry-run');

/** Default team lead emails (Tyson's blitz team). */
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

function pickPrimaryStore(accessRows) {
  if (!accessRows.length) {
    return { storeNumber: null, visitId: null, labels: [] };
  }
  const leadStores = accessRows
    .filter((row) => row.role === 'lead')
    .sort((a, b) => Number(a.store_number) - Number(b.store_number));
  const primary = leadStores[0] || accessRows[0];
  const labels = accessRows.map((row) => (
    row.role === 'lead' ? `FM ${row.store_number} (lead)` : `FM ${row.store_number}`
  ));
  return {
    storeNumber: primary.store_number,
    visitId: primary.default_visit_id || null,
    labels,
  };
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

async function loadStoreAccess(hubUserId) {
  const { rows } = await query(
    `SELECT hsa.store_number, hsa.store_role AS role, hs.default_visit_id
     FROM hub_store_assignments hsa
     JOIN hub_stores hs ON hs.store_number = hsa.store_number
     WHERE hsa.user_id = $1
       AND hs.is_test = FALSE
     ORDER BY hsa.store_number::int`,
    [hubUserId],
  );
  return rows;
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

async function sendLeadInvite({ hubUser, accessRows }) {
  const loginEmail = signInEmail(hubUser);
  const { storeNumber, visitId, labels } = pickPrimaryStore(accessRows);
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

  const leadEmails = (process.env.LEAD_EMAILS || '')
    .split(',')
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  const targets = leadEmails.length ? leadEmails : DEFAULT_LEAD_EMAILS;

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Sending lead access to ${targets.length} team leads...`);

  for (const email of targets) {
    const hubUser = await resolveHubUserByEmail(email);
    if (!hubUser) {
      console.warn(`  SKIP ${email}: hub_users row not found`);
      continue;
    }

    const accessRows = await loadStoreAccess(hubUser.id);
    console.log(`\n${hubUser.name} <${hubUser.email}>`);
    console.log(`  standing_rank was ${hubUser.standing_rank}`);

    try {
      const sent = await sendLeadInvite({ hubUser, accessRows });
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
