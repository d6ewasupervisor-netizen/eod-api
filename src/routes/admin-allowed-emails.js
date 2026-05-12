// /api/admin/allowed-emails -- CRUD for the `allowed_emails` table. All routes
// require a valid admin session JWT (see lib/admin-auth.js). Corporate-domain
// emails are auto-allowed by isCorporateWorkDomainEmail() so the admin UI
// refuses to insert them (it would just be noise in the list).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('../lib/db');
const { requireAdmin } = require('../lib/admin-auth');
const {
  corporateDomainListForMessage,
  isCorporateWorkDomainEmail,
} = require('../lib/allowed-emails');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const adminLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again shortly.' },
});

router.use(adminLimiter);
router.use(requireAdmin);

router.get('/', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT email, note, created_at, updated_at
       FROM allowed_emails
       ORDER BY email ASC`,
    );
    return res.json({ ok: true, emails: rows });
  } catch (err) {
    console.error('[admin allowed-emails] list', err);
    return res.status(500).json({ ok: false, error: 'Could not load list.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    const rawNote = req.body && req.body.note != null ? String(req.body.note) : '';
    const note = rawNote.trim().slice(0, 500) || null;

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }
    if (isCorporateWorkDomainEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: `Work addresses (${corporateDomainListForMessage()}) are already allowed. No need to add them here.`,
      });
    }

    await query(
      `INSERT INTO allowed_emails (email, note)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET
         note = EXCLUDED.note,
         updated_at = NOW()`,
      [email, note],
    );
    console.log(`[admin allowed-emails] upsert ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin allowed-emails] post', err);
    return res.status(500).json({ ok: false, error: 'Could not save email.' });
  }
});

router.delete('/', async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }
    await query('DELETE FROM allowed_emails WHERE email = $1', [email]);
    console.log(`[admin allowed-emails] delete ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin allowed-emails] delete', err);
    return res.status(500).json({ ok: false, error: 'Could not remove email.' });
  }
});

module.exports = router;
