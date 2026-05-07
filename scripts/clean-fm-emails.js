/**
 * clean-fm-emails.js
 *
 * Audits every store's fredmeyer_emails list and removes any address that is
 * NOT @stores.fredmeyer.com.  Prints a before/after report before writing.
 *
 * Run via:  node scripts/clean-fm-emails.js
 */

const { Pool } = require('pg');
const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool  = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

function isCorrect(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith('@stores.fredmeyer.com');
}

async function main() {
  const { rows } = await pool.query(
    'SELECT store_number, fredmeyer_emails FROM store_data ORDER BY store_number'
  );

  let totalRemoved = 0;

  for (const row of rows) {
    const current = row.fredmeyer_emails || [];
    const correct  = current.filter(isCorrect);
    const removed  = current.filter(e => !isCorrect(e));

    if (removed.length === 0) {
      process.stdout.write(`  Store ${row.store_number}: OK (${correct.length} addresses)\n`);
      continue;
    }

    process.stdout.write(`  Store ${row.store_number}: removing ${removed.length} bad address(es):\n`);
    removed.forEach(e => process.stdout.write(`    ✗ ${e}\n`));
    correct.forEach(e => process.stdout.write(`    ✓ ${e}\n`));

    await pool.query(
      'UPDATE store_data SET fredmeyer_emails = $2 WHERE store_number = $1',
      [row.store_number, JSON.stringify(correct)]
    );
    totalRemoved += removed.length;
  }

  process.stdout.write(`\nDone. Removed ${totalRemoved} incorrect address(es) across ${rows.length} store(s).\n`);
  process.exit(0);
}

main().catch(err => {
  process.stdout.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
