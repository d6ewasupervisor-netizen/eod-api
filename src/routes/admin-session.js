// /api/admin/session/* -- admin password setup, login, forgot-password,
// change-password. Ported from district6/backend/routes/admin-session.js
// with the namespace updated for EOD branding and JWT_SECRET reused.

const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const {
  PRIMARY_ADMIN_EMAIL,
  getAdminRow,
  getPrimaryBootstrapAdmin,
  maskAdminEmail,
  setPasswordHashIfUnset,
  setPasswordHashForEmail,
} = require('../lib/site-admin');
const { issueAdminSessionToken } = require('../lib/admin-jwt');
const { requireAdmin } = require('../lib/admin-auth');
const { pool, query } = require('../lib/db');
const { sendAdminPasswordResetEmail } = require('../lib/auth-email');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = Number(process.env.ADMIN_PASSWORD_MIN_LENGTH || 10);
const MIN_SETUP_TOKEN_LENGTH = 16;
const bcryptCost = Number(process.env.ADMIN_BCRYPT_COST || 12);
const RESET_LINK_TTL_MS = 60 * 60 * 1000;

function setupTokenConfigured() {
  const t = (process.env.ADMIN_SETUP_TOKEN || '').trim();
  return t.length >= MIN_SETUP_TOKEN_LENGTH;
}

function readSetupToken(body) {
  const raw =
    (body && (body.setupToken ?? body.bootstrapToken ?? body.oneTimeCode)) != null
      ? String(body.setupToken ?? body.bootstrapToken ?? body.oneTimeCode)
      : '';
  return raw.trim();
}

function normalizePassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const trimmed = s.trim();
  const needsTrimWarn = trimmed !== s;
  return { trimmed, needsTrimWarn };
}

function validateTrimmedPassword(trimmedPw, trimmedConfirm) {
  if (trimmedPw.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.` };
  }
  if (trimmedPw !== trimmedConfirm) {
    return { error: 'Passwords do not match.' };
  }
  return { ok: true };
}

function hashResetTokenOpaque(plainToken) {
  return crypto.createHash('sha256').update(String(plainToken).trim(), 'utf8').digest('hex');
}

function resolveFrontendBaseUrl() {
  return (process.env.FRONTEND_BASE_URL || '').trim().replace(/\/+$/, '');
}

const statusLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again shortly.' },
});
const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 15,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many setup attempts. Try again later.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many sign-in attempts. Try again later.' },
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many reset requests. Try again later.' },
});
const resetCompleteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 25,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again later.' },
});
const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many password changes. Try again later.' },
});

router.get('/status', statusLimiter, async (_req, res) => {
  try {
    const row = await getPrimaryBootstrapAdmin();
    if (!row) {
      return res.status(503).json({ ok: false, error: 'Admin profile is not ready.' });
    }
    const email = row.email;
    const needsPasswordSetup = !row.password_hash;
    return res.json({
      ok: true,
      needsPasswordSetup,
      primaryAdminEmail: email,
      adminEmail: email,
      maskedEmail: maskAdminEmail(email),
      setupTokenConfigured: needsPasswordSetup ? setupTokenConfigured() : true,
    });
  } catch (err) {
    console.error('[admin-session] status', err);
    return res.status(500).json({ ok: false, error: 'Could not load status.' });
  }
});

router.post('/setup', setupLimiter, async (req, res) => {
  try {
    const bootstrap = await getPrimaryBootstrapAdmin();
    if (!bootstrap) {
      return res.status(503).json({ ok: false, error: 'Admin profile is not ready.' });
    }
    if (bootstrap.password_hash) {
      return res.status(400).json({
        ok: false,
        error: `A password is already set for ${PRIMARY_ADMIN_EMAIL}. Sign in with your email and password.`,
      });
    }
    if (!setupTokenConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'First-time setup is not enabled on the server (missing ADMIN_SETUP_TOKEN).',
      });
    }
    const token = readSetupToken(req.body);
    if (token !== (process.env.ADMIN_SETUP_TOKEN || '').trim()) {
      return res.status(401).json({ ok: false, error: 'Invalid one-time setup code.' });
    }

    const rawPw = req.body && req.body.password != null ? String(req.body.password) : '';
    const rawConfirm = req.body && req.body.passwordConfirm != null ? String(req.body.passwordConfirm) : '';
    const a = normalizePassword(rawPw);
    const b = normalizePassword(rawConfirm);
    if (a.needsTrimWarn || b.needsTrimWarn) {
      return res.status(400).json({ ok: false, error: 'Password cannot start or end with spaces.' });
    }
    const v = validateTrimmedPassword(a.trimmed, b.trimmed);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });

    const hash = bcrypt.hashSync(a.trimmed, bcrypt.genSaltSync(bcryptCost));
    const saved = await setPasswordHashIfUnset(PRIMARY_ADMIN_EMAIL, hash);
    if (!saved) {
      return res.status(409).json({ ok: false, error: 'Password was set by another request. Sign in instead.' });
    }

    const sessionToken = issueAdminSessionToken(PRIMARY_ADMIN_EMAIL);
    console.log(`[admin-session] initial password configured for ${PRIMARY_ADMIN_EMAIL}`);
    return res.json({ ok: true, token: sessionToken, email: PRIMARY_ADMIN_EMAIL });
  } catch (err) {
    console.error('[admin-session] setup', err);
    return res.status(500).json({ ok: false, error: 'Could not save password.' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }

    const row = await getAdminRow(email);
    if (!row?.password_hash) {
      return res.status(401).json({
        ok: false,
        error: email === PRIMARY_ADMIN_EMAIL
          ? 'Password is not set yet. Complete first-time setup first.'
          : 'Incorrect email or password.',
      });
    }

    const rawPw = req.body && req.body.password != null ? String(req.body.password) : '';
    const match = bcrypt.compareSync(rawPw, row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
    }

    const sessionToken = issueAdminSessionToken(row.email);
    return res.json({ ok: true, token: sessionToken, email: row.email });
  } catch (err) {
    console.error('[admin-session] login', err);
    return res.status(500).json({ ok: false, error: 'Could not sign in.' });
  }
});

const FORGOT_OK_MESSAGE =
  'If this email is registered as an administrator, a reset link was sent. Check your inbox.';

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }

    const base = resolveFrontendBaseUrl();
    if (!base) {
      console.error('[admin-session] forgot-password: FRONTEND_BASE_URL is not set');
      return res.status(503).json({
        ok: false,
        error: 'Password reset is not configured on the server (missing FRONTEND_BASE_URL).',
      });
    }

    const row = await getAdminRow(email);
    if (!row?.password_hash) {
      return res.json({ ok: true, message: FORGOT_OK_MESSAGE });
    }

    const opaque = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashResetTokenOpaque(opaque);
    const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS).toISOString();

    await query(
      `DELETE FROM admin_password_resets
       WHERE lower(trim(email)) = $1 AND used_at IS NULL`,
      [email],
    );
    await query(
      `INSERT INTO admin_password_resets (email, token_hash, expires_at)
       VALUES ($1, $2, $3::timestamptz)`,
      [email, tokenHash, expiresAt],
    );

    const resetUrl = `${base}/admin.html?reset=${encodeURIComponent(opaque)}`;
    try {
      await sendAdminPasswordResetEmail({ to: email, resetUrl });
    } catch (sendErr) {
      console.error('[admin-session] forgot-password email failed', sendErr);
      await query(
        `DELETE FROM admin_password_resets WHERE token_hash = $1 AND used_at IS NULL`,
        [tokenHash],
      );
      return res.status(503).json({ ok: false, error: 'Could not send reset email. Try again shortly.' });
    }

    console.log(`[admin-session] password reset email queued for ${email}`);
    return res.json({ ok: true, message: FORGOT_OK_MESSAGE });
  } catch (err) {
    console.error('[admin-session] forgot-password', err);
    return res.status(500).json({ ok: false, error: 'Could not process reset request.' });
  }
});

router.post('/complete-password-reset', resetCompleteLimiter, async (req, res) => {
  const genericErr = 'This reset link is invalid or has expired. Request a new one from Sign in.';
  try {
    const rawTok = req.body && req.body.token != null ? String(req.body.token).trim() : '';
    if (rawTok.length < 24) {
      return res.status(400).json({ ok: false, error: genericErr });
    }

    const rawPw = req.body && req.body.password != null ? String(req.body.password) : '';
    const rawConfirm = req.body && req.body.passwordConfirm != null ? String(req.body.passwordConfirm) : '';

    const a = normalizePassword(rawPw);
    const b = normalizePassword(rawConfirm);
    if (a.needsTrimWarn || b.needsTrimWarn) {
      return res.status(400).json({ ok: false, error: 'Password cannot start or end with spaces.' });
    }
    const v = validateTrimmedPassword(a.trimmed, b.trimmed);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });

    const bcryptHash = bcrypt.hashSync(a.trimmed, bcrypt.genSaltSync(bcryptCost));
    const th = hashResetTokenOpaque(rawTok);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query(
        `SELECT id, lower(trim(email)) AS email_norm
         FROM admin_password_resets
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [th],
      );
      if (sel.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: genericErr });
      }
      const { id: resetId, email_norm: emailNorm } = sel.rows[0];
      await client.query(`UPDATE admin_password_resets SET used_at = NOW() WHERE id = $1`, [resetId]);
      const up = await client.query(
        `UPDATE site_admins SET password_hash = $1, password_set_at = NOW()
         WHERE lower(trim(email)) = $2`,
        [bcryptHash, emailNorm],
      );
      if (up.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: genericErr });
      }
      await client.query('COMMIT');

      const sessionToken = issueAdminSessionToken(emailNorm);
      console.log(`[admin-session] password reset completed for ${emailNorm}`);
      return res.json({ ok: true, token: sessionToken, email: emailNorm });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin-session] complete-password-reset', err);
    return res.status(500).json({ ok: false, error: 'Could not update password.' });
  }
});

router.post('/password', changePasswordLimiter, requireAdmin, async (req, res) => {
  try {
    const email = req.adminEmail;
    const row = await getAdminRow(email);
    if (!row?.password_hash) {
      return res.status(400).json({ ok: false, error: 'Account is not ready for password changes.' });
    }

    const rawCur = req.body && req.body.currentPassword != null ? String(req.body.currentPassword) : '';
    if (!bcrypt.compareSync(rawCur, row.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
    }

    const rawPw = req.body && req.body.newPassword != null ? String(req.body.newPassword) : '';
    const rawConfirm = req.body && req.body.newPasswordConfirm != null ? String(req.body.newPasswordConfirm) : '';
    const a = normalizePassword(rawPw);
    const b = normalizePassword(rawConfirm);

    const curNorm = normalizePassword(rawCur);
    if (!curNorm.needsTrimWarn && a.trimmed === curNorm.trimmed) {
      return res.status(400).json({ ok: false, error: 'New password must differ from your current password.' });
    }

    if (a.needsTrimWarn || b.needsTrimWarn) {
      return res.status(400).json({ ok: false, error: 'Password cannot start or end with spaces.' });
    }
    const v = validateTrimmedPassword(a.trimmed, b.trimmed);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });

    const bcryptHash = bcrypt.hashSync(a.trimmed, bcrypt.genSaltSync(bcryptCost));
    const ok = await setPasswordHashForEmail(email, bcryptHash);
    if (!ok) {
      return res.status(400).json({ ok: false, error: 'Could not update password.' });
    }

    console.log(`[admin-session] password changed for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin-session] password change', err);
    return res.status(500).json({ ok: false, error: 'Could not update password.' });
  }
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true, email: req.adminEmail });
});

module.exports = router;
