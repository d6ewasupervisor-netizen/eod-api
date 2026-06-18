#!/usr/bin/env node
/**
 * Grant Checklane Hub access for blitz / store-assignment team members.
 *
 *   node scripts/grant-checklanes-team-access.js [--dry-run]
 */
'use strict';

if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { query, pool } = require('../src/lib/db');

const DRY_RUN = process.argv.includes('--dry-run');

const TEAM = [
  {
    email: 'chris.metzger@retailodyssey.com',
    name: 'Chris Metzger S',
    sasEmployeeId: 15071,
    standingRank: 2,
    assignments: [{ storeNumber: '652', role: 'lead' }],
    allowlistNote: null,
  },
  {
    email: 'monique.perez73@yahoo.com',
    name: 'Monique Barron Perez Theressa',
    sasEmployeeId: 404705,
    standingRank: 1,
    assignments: [{ storeNumber: '652', role: 'rep' }],
    allowlistNote: 'Checklane Hub rep (FM 652, Chris Metzger team)',
  },
  {
    email: 'lily.thiphakhinkeo@sasretailservices.com',
    name: 'Vikanda Thiphakhinkeo Lily',
    sasEmployeeId: 226147,
    standingRank: 2,
    assignments: [
      { storeNumber: '214', role: 'lead' },
      { storeNumber: '657', role: 'lead' },
    ],
    allowlistNote: null,
  },
  {
    email: 'dennis.baker@sasretailservices.com',
    name: 'Dennis Baker III Lloyd',
    sasEmployeeId: 378774,
    standingRank: 1,
    assignments: [{ storeNumber: '652', role: 'rep' }],
    allowlistNote: null,
  },
  {
    email: 'chancefsss@gmail.com',
    name: 'Chance Ward Jaxon',
    sasEmployeeId: 407929,
    standingRank: 1,
    assignments: [{ storeNumber: '652', role: 'rep' }],
    allowlistNote: 'Checklane Hub rep (FM 652 blitz, Chris Metzger team)',
  },
];

async function ensureAllowedEmail(email, note) {
  if (!note) return;
  if (DRY_RUN) {
    console.log(`  [dry-run] allowed_emails -> ${email}`);
    return;
  }
  await query(
    `INSERT INTO allowed_emails (email, note)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
    [email, note],
  );
}

async function ensureHubStore(storeNumber) {
  const sn = String(storeNumber);
  const { rows } = await query(
    'SELECT store_number FROM hub_stores WHERE store_number = $1',
    [sn],
  );
  if (rows.length) return;
  if (DRY_RUN) {
    console.log(`  [dry-run] hub_stores -> ${sn}`);
    return;
  }
  await query(
    `INSERT INTO hub_stores (store_number, name)
     VALUES ($1, $2)
     ON CONFLICT (store_number) DO NOTHING`,
    [sn, `Store ${sn.padStart(5, '0')}`],
  );
}

async function upsertHubUser(person) {
  if (DRY_RUN) {
    console.log(`  [dry-run] hub_users -> ${person.email} (rank ${person.standingRank})`);
    return { id: null, email: person.email };
  }
  const { rows } = await query(
    `INSERT INTO hub_users (email, name, sas_user_id, standing_rank, is_active, hub_invited_at)
     VALUES ($1, $2, $3, $4, TRUE, now())
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), hub_users.name),
       sas_user_id = COALESCE(EXCLUDED.sas_user_id, hub_users.sas_user_id),
       standing_rank = GREATEST(COALESCE(hub_users.standing_rank, 1), EXCLUDED.standing_rank),
       is_active = TRUE,
       hub_invited_at = COALESCE(hub_users.hub_invited_at, now())
     RETURNING id, email, name, standing_rank`,
    [person.email, person.name, person.sasEmployeeId, person.standingRank],
  );
  return rows[0];
}

async function upsertAssignment(userId, storeNumber, role) {
  const sn = String(storeNumber);
  const storeRole = role === 'lead' ? 'lead' : 'rep';
  if (DRY_RUN) {
    console.log(`  [dry-run] assignment -> store ${sn} as ${storeRole}`);
    return;
  }
  await query(
    `INSERT INTO hub_store_assignments (store_number, user_id, store_role)
     VALUES ($1, $2, $3)
     ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = EXCLUDED.store_role`,
    [sn, userId, storeRole],
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Granting Checklane Hub access...`);

  for (const person of TEAM) {
    console.log(`\n${person.name} <${person.email}>`);
    await ensureAllowedEmail(person.email, person.allowlistNote);
    const hubUser = await upsertHubUser(person);
    for (const assignment of person.assignments) {
      await ensureHubStore(assignment.storeNumber);
      await upsertAssignment(hubUser.id, assignment.storeNumber, assignment.role);
      console.log(`  store ${assignment.storeNumber}: ${assignment.role}`);
    }
    if (!DRY_RUN && hubUser.id) {
      console.log(`  hub_user id ${hubUser.id}, standing_rank ${hubUser.standing_rank}`);
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
