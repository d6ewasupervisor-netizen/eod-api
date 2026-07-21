#!/usr/bin/env node
// Seed survey module: roster, store access, store supervisors, allowed_emails bulk insert,
// v2 question set, and 2025 baseline. Idempotent (upserts throughout).
// Usage: DATABASE_URL=... node scripts/seed-survey.js [--dir ./seed]
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const dirArg = process.argv.indexOf('--dir');
const SEED_DIR = dirArg > -1 ? process.argv[dirArg + 1] : path.join(__dirname, '..', 'seed');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL ? { rejectUnauthorized: false } : undefined });

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
}

async function main() {
  const roster = load('seed_roster.json');
  const baseline = load('seed_baseline.json');
  const questionSet = load('question_set_v2.json');
  let storeNames = {};
  try {
    storeNames = load('store_names.json').names || {};
  } catch (_) {
    storeNames = {};
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Roster
    let n = 0;
    for (const r of roster.roster) {
      await client.query(
        `INSERT INTO survey_roster (email, name, phone, workday_id, title, role, team, supervisor_email, district)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (email) DO UPDATE SET
           name=EXCLUDED.name, phone=EXCLUDED.phone, workday_id=EXCLUDED.workday_id,
           title=EXCLUDED.title, role=EXCLUDED.role, team=EXCLUDED.team,
           supervisor_email=EXCLUDED.supervisor_email, district=EXCLUDED.district,
           active=TRUE, updated_at=now()`,
        [r.email, r.name, r.phone || null, r.workday_id || null, r.title || null, r.role, r.team || null, r.supervisor_email || null, r.district || null]
      );
      n++;
    }
    console.log(`roster upserted: ${n}`);

    // 1b. Store districts (derived from team names; Traveling Team Seattle 2 = Kompass 8C / district 8)
    n = 0;
    for (const [store, district] of Object.entries(roster.store_districts || {})) {
      const storeName = storeNames[String(store)] || storeNames[Number(store)] || null;
      await client.query(
        `INSERT INTO survey_store_districts (store_num, district, store_name) VALUES ($1,$2,$3)
         ON CONFLICT (store_num) DO UPDATE SET
           district = EXCLUDED.district,
           store_name = COALESCE(EXCLUDED.store_name, survey_store_districts.store_name)`,
        [Number(store), district, storeName]
      );
      n++;
    }
    console.log(`store districts: ${n}`);

    // 1c. Store names from FM name/number list (overlay; do not invent missing districts)
    n = 0;
    for (const [store, name] of Object.entries(storeNames)) {
      const { rowCount } = await client.query(
        `UPDATE survey_store_districts SET store_name = $2 WHERE store_num = $1`,
        [Number(store), name]
      );
      if (rowCount) n++;
    }
    console.log(`store names applied: ${n}`);

    // 2. Store access
    n = 0;
    for (const [email, stores] of Object.entries(roster.store_access)) {
      for (const store of stores) {
        await client.query(
          `INSERT INTO survey_store_access (email, store_num) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [email, store]
        );
        n++;
      }
    }
    console.log(`store access rows: ${n}`);

    // 3. Store supervisors ("both" rule already applied in seed generation)
    n = 0;
    for (const [store, sups] of Object.entries(roster.store_supervisors)) {
      for (const sup of sups) {
        await client.query(
          `INSERT INTO survey_store_supervisors (store_num, supervisor_email) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [Number(store), sup]
        );
        n++;
      }
    }
    console.log(`store supervisor rows: ${n}`);

    // 4. Bulk insert allowed_emails so magic-link sign-in works for every roster member
    n = 0;
    for (const r of roster.roster) {
      await client.query(
        `INSERT INTO allowed_emails (email, note) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING`,
        [r.email, 'survey roster seed']
      );
      n++;
    }
    console.log(`allowed_emails processed: ${n}`);

    // 5. Question set v2 (activate, deactivate others)
    await client.query('UPDATE survey_question_sets SET active = FALSE');
    await client.query(
      `INSERT INTO survey_question_sets (version, title, spec, active)
       VALUES ($1, $2, $3::jsonb, TRUE)
       ON CONFLICT (version) DO UPDATE SET title=EXCLUDED.title, spec=EXCLUDED.spec, active=TRUE`,
      [questionSet.version, questionSet.title, JSON.stringify(questionSet)]
    );
    console.log(`question set v${questionSet.version} active`);

    // 6. Baseline (2025 mapped answers) — replace source batch for idempotency
    await client.query(`DELETE FROM survey_baseline WHERE source = 'ms-forms-2025'`);
    for (const b of baseline) {
      await client.query(
        `INSERT INTO survey_baseline (store_num, respondent, submitted, answers, source)
         VALUES ($1,$2,$3,$4::jsonb,'ms-forms-2025')`,
        [b.store, b.respondent || null, b.submitted || null, JSON.stringify(b.answers)]
      );
    }
    console.log(`baseline rows: ${baseline.length}`);

    await client.query('COMMIT');
    console.log('seed complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('seed failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
