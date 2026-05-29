// Checklane Hub — invite a rep before first assignment (magic link + optional login email).

const { query } = require('./lib/db');
const { issueLinkToken } = require('./lib/tokens');
const { buildMagicLink } = require('./lib/magic-link');
const { sendHubTeamInviteEmail } = require('./lib/auth-email');
const { isEmailAllowed } = require('./lib/allowed-emails');
const { resolveStoreForVisit } = require('./lib/hub-fixture-catalog');
const { writeAuditLog, parseVisitId } = require('./hub-auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function loadHubUserForInvite(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.login_email, u.hub_invited_at, u.sas_user_id, u.is_active,
            e.email AS employee_email
     FROM hub_users u
     LEFT JOIN employees e ON e.sas_employee_id = u.sas_user_id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] || null;
}

function emailOnFile(row) {
  const fromEmployee = normalizeEmail(row.employee_email);
  if (fromEmployee && EMAIL_RE.test(fromEmployee)) return fromEmployee;
  const primary = normalizeEmail(row.email);
  if (primary && EMAIL_RE.test(primary)) return primary;
  return null;
}

function effectiveLoginEmail(row) {
  const override = normalizeEmail(row.login_email);
  if (override && EMAIL_RE.test(override)) return override;
  return emailOnFile(row);
}

function rosterInviteFields(row) {
  const onFile = emailOnFile(row);
  const login = effectiveLoginEmail(row);
  const rank = row.store_role === 'lead' ? 2 : row.store_role === 'rep' ? 1 : (Number(row.standing_rank) || 1);
  const needsInvite = rank < 2 && !row.hub_invited_at;
  return {
    emailOnFile: onFile,
    loginEmail: login !== onFile ? login : null,
    needsInvite,
    invitedAt: row.hub_invited_at ? row.hub_invited_at.toISOString() : null,
  };
}

async function ensureAllowedEmail(loginEmail, note) {
  if (await isEmailAllowed(loginEmail)) return;
  await query(
    `INSERT INTO allowed_emails (email, note)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [loginEmail, note || 'Checklane hub team invite'],
  );
}

function buildAssignmentsHubUrl(storeNumber, visitId) {
  const base = (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').replace(/\/+$/, '');
  const store = String(storeNumber || '').replace(/\D/g, '') || storeNumber;
  const params = new URLSearchParams({
    store: String(Number(store) || store),
    visit: String(visitId),
    view: 'assignments',
  });
  return `${base}/checklanes/hub.html?${params.toString()}`;
}

/**
 * @param {object} opts
 * @param {number} opts.visitId
 * @param {number} opts.userId
 * @param {boolean} opts.useOnFileEmail
 * @param {string} [opts.customEmail]
 * @param {{ id: number, email: string, name: string }} opts.inviter
 */
async function sendTeamMemberInvite({
  visitId,
  userId,
  useOnFileEmail,
  customEmail,
  inviter,
}) {
  const visitIdNum = parseVisitId(visitId);
  const row = await loadHubUserForInvite(userId);
  if (!row || !row.is_active) {
    const err = new Error('Unknown or inactive hub user');
    err.status = 404;
    throw err;
  }

  const onFile = emailOnFile(row);
  let loginEmail;
  if (useOnFileEmail) {
    if (!onFile) {
      const err = new Error('No email on file for this team member');
      err.status = 400;
      throw err;
    }
    loginEmail = onFile;
  } else {
    loginEmail = normalizeEmail(customEmail);
    if (!loginEmail || !EMAIL_RE.test(loginEmail)) {
      const err = new Error('Enter a valid email address');
      err.status = 400;
      throw err;
    }
  }

  const storeNumber = await resolveStoreForVisit(visitIdNum);
  const returnTo = buildAssignmentsHubUrl(storeNumber, visitIdNum);
  const { token, jti } = issueLinkToken(loginEmail);

  await query(
    `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, NULL, $3)`,
    [loginEmail, jti, 'hub-team-invite'],
  );

  const link = buildMagicLink(token, returnTo);
  if (!link) {
    const err = new Error('Could not build sign-in link');
    err.status = 500;
    throw err;
  }

  const loginOverride = onFile && loginEmail !== onFile ? loginEmail : null;
  if (loginOverride) {
    const { rows: conflict } = await query(
      `SELECT id FROM hub_users
       WHERE id <> $1 AND (
         lower(email) = $2 OR lower(coalesce(login_email, '')) = $2
       )
       LIMIT 1`,
      [userId, loginEmail],
    );
    if (conflict.length) {
      const err = new Error('That email is already used by another hub user');
      err.status = 409;
      throw err;
    }
  }

  await ensureAllowedEmail(
    loginEmail,
    `Checklane hub invite (store ${storeNumber || '?'})`,
  );

  await query(
    `UPDATE hub_users
     SET hub_invited_at = COALESCE(hub_invited_at, now()),
         last_invite_sent_at = now(),
         invited_by = $2,
         login_email = CASE
           WHEN $3::text IS NOT NULL THEN $3::text
           ELSE login_email
         END
     WHERE id = $1`,
    [userId, inviter.id, loginOverride],
  );

  await sendHubTeamInviteEmail({
    to: loginEmail,
    link,
    inviteeName: row.name,
    inviterName: inviter.name || inviter.email,
    inviterEmail: inviter.email,
    storeNumber,
  });

  await writeAuditLog(visitIdNum, inviter.id, 'team_invite', String(userId), {
    invitee_id: userId,
    invitee_name: row.name,
    email_on_file: onFile,
    login_email: loginEmail,
    login_override: Boolean(loginOverride),
    use_on_file: Boolean(useOnFileEmail),
  });

  return {
    ok: true,
    userId,
    loginEmail,
    emailOnFile: onFile,
    loginOverride: Boolean(loginOverride),
    returnTo,
  };
}

module.exports = {
  rosterInviteFields,
  emailOnFile,
  effectiveLoginEmail,
  sendTeamMemberInvite,
};
