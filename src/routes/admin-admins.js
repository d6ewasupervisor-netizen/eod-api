// POST /invite, GET /, DELETE / -- site_admins roster + emailed invite flow.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool, query } = require('../lib/db');
const { requireAdmin } = require('../lib/admin-auth');
const { issueAdminInviteToken } = require('../lib/tokens');
const { sendAdminInviteEmail } = require('../lib/auth-email');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX_LEN = 2000;

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again shortly.' },
});

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function frontendBaseUrl() {
  return (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').trim().replace(/\/+$/, '');
}

router.use(adminLimiter);
router.use(requireAdmin);

router.get('/', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT lower(trim(email)) AS email,
              password_set_at,
              invited_at
       FROM site_admins
       ORDER BY email ASC`,
    );
    return res.json({
      ok: true,
      admins: rows.map((r) => ({
        email: r.email,
        password_set_at: r.password_set_at,
        invited_at: r.invited_at,
      })),
    });
  } catch (err) {
    console.error('[admin-admins] list', err);
    return res.status(500).json({ ok: false, error: 'Could not load admins.' });
  }
});

router.post('/invite', async (req, res) => {
  const rawEmail = req.body && req.body.email != null ? String(req.body.email) : '';
  let emailNorm = normalizeEmail(rawEmail);
  let note =
    req.body && req.body.note != null && String(req.body.note).trim()
      ? String(req.body.note).trim()
      : null;
  if (note && note.length > NOTE_MAX_LEN) {
    return res.status(400).json({ ok: false, error: 'Note is too long.' });
  }
  if (!emailNorm || !EMAIL_RE.test(emailNorm)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }

  const inviter = normalizeEmail(req.adminEmail);
  if (emailNorm === inviter) {
    return res.status(400).json({ ok: false, error: 'You cannot invite yourself.' });
  }

  let jtiIssued;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adminSel = await client.query(
      `SELECT email, password_hash
       FROM site_admins WHERE lower(trim(email)) = $1 FOR UPDATE`,
      [emailNorm],
    );
    const existing = adminSel.rows[0];
    if (existing?.password_hash) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'Could not invite that address.' });
    }

    if (!existing) {
      await client.query(
        `INSERT INTO site_admins (email, password_hash, invited_at)
         VALUES ($1, NULL, NOW())`,
        [emailNorm],
      );
    } else {
      await client.query(
        `UPDATE site_admins SET invited_at = NOW()
         WHERE lower(trim(email)) = $1 AND password_hash IS NULL`,
        [emailNorm],
      );
    }

    await client.query(
      `DELETE FROM site_admin_invites
       WHERE lower(trim(email)) = $1 AND used_at IS NULL`,
      [emailNorm],
    );

    const { token: inviteJwt, jti } = issueAdminInviteToken(emailNorm);
    jtiIssued = jti;
    await client.query(
      `INSERT INTO site_admin_invites (email, jti, invited_by, note)
       VALUES ($1, $2, $3, $4)`,
      [emailNorm, jti, inviter || null, note],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin-admins] invite tx', err);
    return res.status(500).json({ ok: false, error: 'Could not send invitation.' });
  } finally {
    client.release();
  }

  const base = frontendBaseUrl();
  const inviteUrl = `${base}/admin.html?invite=${encodeURIComponent(inviteJwt)}`;

  try {
    await sendAdminInviteEmail({
      to: emailNorm,
      inviteUrl,
      note: note || undefined,
      invitedByEmail: inviter,
    });
  } catch (sendErr) {
    console.error('[admin-admins] invite email failed', sendErr);
    try {
      await query(
        `DELETE FROM site_admin_invites WHERE jti = $1 AND used_at IS NULL`,
        [jtiIssued],
      );
    } catch (_) {}
    return res.status(503).json({
      ok: false,
      error: 'Could not send invitation email. Try again shortly.',
    });
  }

  console.log(`[admin-admins] invited ${emailNorm} by ${inviter}`);
  return res.json({ ok: true });
});

router.delete('/', async (req, res) => {
  try {
    const raw = req.body && req.body.email != null ? String(req.body.email) : '';
    const target = normalizeEmail(raw);
    const self = normalizeEmail(req.adminEmail);

    if (!target || !EMAIL_RE.test(target)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }
    if (target === self) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot remove your own administrator account.',
      });
    }

    const { rows: cnt } = await query(`SELECT COUNT(*)::int AS n FROM site_admins`);
    if (cnt[0].n <= 1) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot remove the last administrator.',
      });
    }

    const del = await query(
      `DELETE FROM site_admins WHERE lower(trim(email)) = $1 RETURNING email`,
      [target],
    );
    if (del.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Could not remove that administrator.' });
    }

    await query(`DELETE FROM site_admin_invites WHERE lower(trim(email)) = $1`, [target]);

    console.log(`[admin-admins] removed ${target} by ${self}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin-admins] delete', err);
    return res.status(500).json({ ok: false, error: 'Could not remove administrator.' });
  }
});

module.exports = router;
