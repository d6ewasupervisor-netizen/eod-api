// Admin-account helpers for /api/admin/session. One row per admin in `site_admins`;
// password_hash is NULL until `/setup` with ADMIN_SETUP_TOKEN (primary bootstrap),
// or `/complete-invite` from an emailed invite JWT.

const { query } = require('./db');

const PRIMARY_ADMIN_EMAIL = (
  process.env.PRIMARY_ADMIN_EMAIL || 'tyson.gauthier@retailodyssey.com'
).trim().toLowerCase();

async function getAdminRow(emailNorm) {
  const { rows } = await query(
    'SELECT email, password_hash FROM site_admins WHERE lower(trim(email)) = $1 LIMIT 1',
    [emailNorm],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    email: row.email.trim().toLowerCase(),
    password_hash: row.password_hash,
  };
}

async function getPrimaryBootstrapAdmin() {
  return getAdminRow(PRIMARY_ADMIN_EMAIL);
}

async function setPasswordHashIfUnset(emailNorm, passwordHash) {
  const { rowCount } = await query(
    `UPDATE site_admins SET password_hash = $1, password_set_at = NOW()
     WHERE lower(trim(email)) = $2 AND password_hash IS NULL`,
    [passwordHash, emailNorm],
  );
  return rowCount > 0;
}

async function setPasswordHashForEmail(emailNorm, passwordHash) {
  const { rowCount } = await query(
    `UPDATE site_admins SET password_hash = $1, password_set_at = NOW()
     WHERE lower(trim(email)) = $2`,
    [passwordHash, emailNorm],
  );
  return rowCount > 0;
}

function maskAdminEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = Math.min(2, local.length);
  const prefix = local.slice(0, visible);
  return `${prefix}\u2022\u2022\u2022@${domain}`;
}

module.exports = {
  PRIMARY_ADMIN_EMAIL,
  getAdminRow,
  getPrimaryBootstrapAdmin,
  setPasswordHashIfUnset,
  setPasswordHashForEmail,
  maskAdminEmail,
};
