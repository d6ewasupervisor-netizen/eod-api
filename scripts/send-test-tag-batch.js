#!/usr/bin/env node
/**
 * Seed 8 random verified missing-tag flags on the hub test visit and send the
 * tag batch email using the same production path as POST /send-tag-batch
 * (subject #999, To: CHECKLANES_OPS_EMAIL, CC: lead sender).
 *
 * Usage:
 *   node scripts/send-test-tag-batch.js [visitId] [leadEmail]
 *
 * Defaults: visitId 99999163, leadEmail d6ewa.supervisor@gmail.com
 */

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { query, pool } = require('../src/lib/db');
const { initHubTagBatch, sendTagBatch } = require('../src/hub-tag-batch');
const { validateUpc } = require('../src/lib/barcode');

const visitId = Number(process.argv[2] || 99999163);
const leadEmail = (process.argv[3] || 'd6ewa.supervisor@gmail.com').trim().toLowerCase();

const PRODUCTS_PATH = path.join(
  __dirname,
  '../../Checklanes/Checklanes/checklane-deploy/products.json',
);

const SAMPLE_LOCATIONS = [
  '601B01F02P03',
  '601B01F03P01',
  '601R02C03',
  '607B02F01P02',
  '607R01C05',
  '601B03F04P02',
  '601B02F01P04',
  '607B01F02P01',
];

const SAMPLE_DBKEYS = [
  '9086453',
  '8920139',
  '8790016',
  '8790024',
  '8920147',
  '9086461',
  '8790032',
  '8920154',
];

function pickRandomProducts(count) {
  const raw = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  const entries = Object.entries(raw).filter(([upc]) => validateUpc(upc).valid);
  if (entries.length < count) {
    throw new Error(`Need at least ${count} valid products, found ${entries.length}`);
  }

  const picked = [];
  const used = new Set();
  while (picked.length < count) {
    const idx = Math.floor(Math.random() * entries.length);
    if (used.has(idx)) continue;
    used.add(idx);
    const [upc, product] = entries[idx];
    picked.push({ upc, description: product.name || product.fallback_desc || upc });
  }
  return picked;
}

async function resolveLeadActor() {
  const { rows } = await query(
    `SELECT id, email, name, standing_rank
     FROM hub_users
     WHERE lower(email) = $1 AND is_active = true
     LIMIT 1`,
    [leadEmail],
  );
  if (!rows.length) {
    throw new Error(`Lead user not found: ${leadEmail}`);
  }
  if (Number(rows[0].standing_rank) < 2) {
    throw new Error(`${leadEmail} is not rank >= 2 (lead)`);
  }
  return rows[0];
}

async function seedVerifiedTags(actor, products) {
  await query('DELETE FROM tag_flags WHERE visit_id = $1', [visitId]);

  for (let i = 0; i < products.length; i += 1) {
    const { upc, description } = products[i];
    await query(
      `INSERT INTO tag_flags (
         visit_id, dbkey, upc, description, location,
         flagged_by, flagged_at, verified_by, verified_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, now(), $6, now(), 'verified')`,
      [
        visitId,
        SAMPLE_DBKEYS[i % SAMPLE_DBKEYS.length],
        upc,
        description,
        SAMPLE_LOCATIONS[i % SAMPLE_LOCATIONS.length],
        actor.id,
      ],
    );
  }
}

async function main() {
  if (!Number.isFinite(visitId)) {
    throw new Error('Invalid visitId');
  }
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }
  if (!process.env.DATABASE_URL && !process.env.DATABASE_PUBLIC_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  const products = pickRandomProducts(8);
  console.log('Selected products:');
  for (const p of products) {
    console.log(`  - ${p.upc}  ${p.description}`);
  }

  const actor = await resolveLeadActor();
  console.log(`Lead actor: ${actor.name} <${actor.email}>`);

  initHubTagBatch({ resend: new Resend(process.env.RESEND_API_KEY) });

  await seedVerifiedTags(actor, products);
  console.log(`Seeded ${products.length} verified tags on visit ${visitId}`);

  const result = await sendTagBatch(visitId, actor);
  if (!result.ok) {
    throw new Error(result.error || 'sendTagBatch failed');
  }

  console.log('Tag batch sent.');
  console.log(`  recipients: ${result.recipients.join(', ')}`);
  console.log(`  resendId: ${result.resendId || '(none)'}`);
  console.log(`  count: ${result.count}`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(() => pool.end());
