#!/usr/bin/env node
/**
 * Reset a Checklane Hub test visit to a fresh-day baseline:
 * - Clear section assignments/state, pending flags, tag drafts/flags
 * - Set one lead email; keep other active hub_users as reps (rank 1)
 *
 * Usage:
 *   node scripts/reset-hub-test-visit.js [visitId] [leadEmail]
 *
 * Defaults: visitId 99999163, leadEmail d6ewa.supervisor@gmail.com
 */

const { query, pool } = require('../src/lib/db');

const visitId = Number(process.argv[2] || 99999163);
const leadEmail = (process.argv[3] || 'd6ewa.supervisor@gmail.com').trim().toLowerCase();

if (!Number.isFinite(visitId)) {
  console.error('Invalid visitId');
  process.exit(1);
}

async function main() {
  console.log(`Resetting hub visit ${visitId} (lead: ${leadEmail})…`);

  const before = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM section_state WHERE visit_id = $1) AS sections,
       (SELECT COUNT(*)::int FROM pending_actions WHERE visit_id = $1) AS pending,
       (SELECT COUNT(*)::int FROM tag_flags WHERE visit_id = $1) AS tags,
       (SELECT COUNT(*)::int FROM role_grants WHERE visit_id = $1) AS grants,
       (SELECT COUNT(*)::int FROM audit_log WHERE visit_id = $1) AS audit_rows`,
    [visitId],
  );
  console.log('Before:', before.rows[0]);

  await query('DELETE FROM pending_actions WHERE visit_id = $1', [visitId]);
  await query('DELETE FROM tag_flags WHERE visit_id = $1', [visitId]);
  await query('DELETE FROM section_state WHERE visit_id = $1', [visitId]);
  await query('DELETE FROM role_grants WHERE visit_id = $1', [visitId]);
  await query('DELETE FROM audit_log WHERE visit_id = $1', [visitId]);

  await query(
    `UPDATE hub_users
     SET standing_rank = 1
     WHERE is_active = true
       AND lower(email) <> $1`,
    [leadEmail],
  );

  await query(
    `INSERT INTO hub_users (email, name, standing_rank)
     VALUES ($1, $2, 2)
     ON CONFLICT (email) DO UPDATE
       SET standing_rank = 2,
           is_active = true,
           name = COALESCE(NULLIF(hub_users.name, ''), EXCLUDED.name)`,
    [leadEmail, 'Supervisor Lead'],
  );

  const roster = await query(
    `SELECT id, email, name, standing_rank
     FROM hub_users
     WHERE is_active = true
     ORDER BY standing_rank DESC, name`,
  );

  const after = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM section_state WHERE visit_id = $1) AS sections,
       (SELECT COUNT(*)::int FROM pending_actions WHERE visit_id = $1) AS pending,
       (SELECT COUNT(*)::int FROM tag_flags WHERE visit_id = $1) AS tags`,
    [visitId],
  );

  console.log('After:', after.rows[0]);
  console.log('Active roster:');
  for (const row of roster.rows) {
    const role = Number(row.standing_rank) >= 2 ? 'lead' : 'rep';
    console.log(`  - ${row.name} <${row.email}> (${role})`);
  }
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
