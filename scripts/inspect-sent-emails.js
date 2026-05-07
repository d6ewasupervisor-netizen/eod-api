/**
 * inspect-sent-emails.js
 * Shows the to/from/subject of all EOD emails found in Resend history.
 */
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_RE = /EOD_FM(\d+)@retail-odyssey\.com/i;

async function fetchAll() {
  const all = [];
  let after = undefined;
  while (true) {
    const opts = { limit: 100 };
    if (after) opts.after = after;
    const { data, error } = await resend.emails.list(opts);
    if (error) throw new Error(error.message ?? JSON.stringify(error));
    const page = data.data ?? [];
    all.push(...page);
    if (!data.has_more || page.length === 0) break;
    after = page[page.length - 1].id;
  }
  return all;
}

async function main() {
  const emails = await fetchAll();
  const eodEmails = emails.filter(e => FROM_RE.test(e.from || ''));

  process.stdout.write(`Total sent: ${emails.length}, EOD emails: ${eodEmails.length}\n\n`);

  // Collect all unique recipient domains across EOD emails
  const domainCounts = {};
  const allRecipients = new Set();

  eodEmails.forEach(e => {
    const toList = Array.isArray(e.to) ? e.to : (e.to ? [e.to] : []);
    toList.forEach(addr => {
      allRecipients.add(addr);
      const domain = addr.split('@')[1] || 'unknown';
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    });
  });

  process.stdout.write('=== Recipient domains across all EOD emails ===\n');
  Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([d, n]) => process.stdout.write(`  ${d}: ${n} occurrences\n`));

  process.stdout.write('\n=== All unique recipients ===\n');
  [...allRecipients].sort().forEach(e => process.stdout.write(`  ${e}\n`));

  // Sample the first 5 EOD emails in full
  process.stdout.write('\n=== Sample EOD emails (first 5) ===\n');
  eodEmails.slice(0, 5).forEach(e => {
    process.stdout.write(`  from: ${e.from}\n  to: ${JSON.stringify(e.to)}\n  subject: ${e.subject}\n  status: ${e.last_event}\n\n`);
  });

  process.exit(0);
}

main().catch(err => {
  process.stdout.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
