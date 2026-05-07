/**
 * backfill-fm-emails.js
 *
 * Scans the Resend sent-email history for all EOD emails
 * (from = EOD_FM###@retail-odyssey.com), extracts every @fredmeyer.com
 * recipient, and upserts them into store_data.fredmeyer_emails.
 *
 * Also reports what is already stored in store_data for each store.
 *
 * Run via:  railway run node scripts/backfill-fm-emails.js
 */

const { Pool } = require('pg');
const { Resend } = require('resend');

// Prefer the public proxy URL when running locally outside Railway's network.
const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool  = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// Matches EOD_FM### sender addresses — captures store number.
const FROM_RE = /EOD_FM(\d+)@retail-odyssey\.com/i;

// Casts a wide net to find all FM-adjacent addresses in Resend history.
// The DB cleanup script (clean-fm-emails.js) then removes anything that isn't
// the canonical @stores.fredmeyer.com domain.
function isFredMeyerEmail(e) {
  return typeof e === 'string' && /(?:stores?\.)?fredmeyer\.com$/i.test(e);
}

async function fetchAllSentEmails() {
  const all = [];
  let after = undefined;

  process.stdout.write('Fetching sent emails from Resend...\n');

  while (true) {
    const opts = { limit: 100 };
    if (after) opts.after = after;

    const { data, error } = await resend.emails.list(opts);
    if (error) throw new Error(`Resend list error: ${error.message ?? JSON.stringify(error)}`);

    const page = data.data ?? [];
    all.push(...page);
    process.stdout.write(`  fetched ${all.length} total (page size ${page.length})\n`);

    if (!data.has_more || page.length === 0) break;
    after = page[page.length - 1].id;
  }

  return all;
}

async function getStoreData(storeNumber) {
  const { rows } = await pool.query(
    'SELECT manager_names, recipient_emails, fredmeyer_emails FROM store_data WHERE store_number = $1',
    [storeNumber]
  );
  if (!rows.length) return { managerNames: [], recipientEmails: [], fredmeyerEmails: [] };
  return {
    managerNames:    rows[0].manager_names    ?? [],
    recipientEmails: rows[0].recipient_emails ?? [],
    fredmeyerEmails: rows[0].fredmeyer_emails ?? [],
  };
}

async function upsertFredmeyerEmails(storeNumber, newEmails) {
  const existing = await getStoreData(storeNumber);
  const merged   = [...new Set([...existing.fredmeyerEmails, ...newEmails])];
  await pool.query(
    `INSERT INTO store_data (store_number, manager_names, recipient_emails, fredmeyer_emails)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_number) DO UPDATE
       SET manager_names    = EXCLUDED.manager_names,
           recipient_emails = EXCLUDED.recipient_emails,
           fredmeyer_emails = $4`,
    [
      storeNumber,
      JSON.stringify(existing.managerNames),
      JSON.stringify(existing.recipientEmails),
      JSON.stringify(merged),
    ]
  );
  return { before: existing.fredmeyerEmails.length, after: merged.length, merged };
}

async function main() {
  // 1. Show current state of store_data
  const { rows: existing } = await pool.query(
    'SELECT store_number, manager_names, fredmeyer_emails FROM store_data ORDER BY store_number'
  );
  process.stdout.write(`\n=== Current store_data (${existing.length} stores) ===\n`);
  existing.forEach(r => {
    process.stdout.write(
      `  Store ${r.store_number}: ${(r.fredmeyer_emails || []).length} FM emails, ` +
      `${(r.manager_names || []).length} manager names\n`
    );
    (r.fredmeyer_emails || []).forEach(e => process.stdout.write(`    - ${e}\n`));
  });

  // 2. Fetch all Resend history and extract FM emails per store
  const emails = await fetchAllSentEmails();
  process.stdout.write(`\nTotal emails fetched: ${emails.length}\n`);

  // Map: storeNumber (string) → Set of @fredmeyer.com addresses
  const byStore = new Map();
  let eodCount = 0;

  for (const email of emails) {
    const fromStr = email.from || '';
    const match   = FROM_RE.exec(fromStr);
    if (!match) continue;              // not an EOD email
    eodCount++;

    const storeNum = String(parseInt(match[1], 10)); // normalise e.g. "007" → "7"
    const toList   = Array.isArray(email.to) ? email.to : (email.to ? [email.to] : []);
    const fmEmails = toList
      .map(e => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
      .filter(isFredMeyerEmail);

    if (fmEmails.length === 0) continue;

    if (!byStore.has(storeNum)) byStore.set(storeNum, new Set());
    fmEmails.forEach(e => byStore.get(storeNum).add(e));
  }

  process.stdout.write(`\nEOD emails found: ${eodCount}\n`);
  process.stdout.write(`Stores with @fredmeyer.com recipients: ${byStore.size}\n`);

  if (byStore.size === 0) {
    process.stdout.write('\nNo @fredmeyer.com addresses found in Resend history.\n');
    process.exit(0);
  }

  // 3. Upsert into store_data
  process.stdout.write('\n=== Upserting FM emails into store_data ===\n');
  for (const [storeNum, emailSet] of byStore.entries()) {
    const result = await upsertFredmeyerEmails(storeNum, [...emailSet]);
    process.stdout.write(
      `  Store ${storeNum}: ${result.before} → ${result.after} FM emails\n`
    );
    result.merged.forEach(e => process.stdout.write(`    ${e}\n`));
  }

  process.stdout.write('\nDone.\n');
  process.exit(0);
}

main().catch(err => {
  process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
