// Access control for requesting an EOD magic link:
//   - Any email whose domain is in CORPORATE_EMAIL_DOMAINS is allowed, OR
//   - Email exists in the Postgres `allowed_emails` table (managed via admin.html).
//
// This mirrors district6/backend/lib/allowed-emails.js -- if/when a 4th domain
// needs blanket access (e.g. another Advantage subsidiary), add it here AND in
// the district6 copy so the two stay aligned.

const { query } = require('./db');

const CORPORATE_EMAIL_DOMAINS = [
  'advantagesolutions.net',
  'retailodyssey.com',
  'sasretailservices.com',
  'youradv.com',
];

const domainSet = new Set(CORPORATE_EMAIL_DOMAINS);

function isCorporateWorkDomainEmail(normalizedEmail) {
  if (typeof normalizedEmail !== 'string' || !normalizedEmail) return false;
  const at = normalizedEmail.lastIndexOf('@');
  if (at < 1) return false;
  const host = normalizedEmail.slice(at + 1);
  return domainSet.has(host);
}

function corporateDomainListForMessage() {
  return CORPORATE_EMAIL_DOMAINS.map((d) => `@${d}`).join(', ');
}

async function isEmailAllowed(email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (isCorporateWorkDomainEmail(normalized)) return true;

  try {
    const { rows } = await query(
      'SELECT 1 FROM allowed_emails WHERE email = $1 LIMIT 1',
      [normalized],
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[allowed-emails] db lookup failed', err);
    return false;
  }
}

module.exports = {
  CORPORATE_EMAIL_DOMAINS,
  isCorporateWorkDomainEmail,
  corporateDomainListForMessage,
  isEmailAllowed,
};
