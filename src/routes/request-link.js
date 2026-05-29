// POST /api/request-link  body: { email }
//
// Rate-limited 5/hr/IP. Validates the email against the corporate-domain rule
// + the allowed_emails table, issues a single-use link JWT, inserts a row in
// link_requests, and emails the user the URL pointing at /EOD/index.html?token=...

const express = require('express');
const rateLimit = require('express-rate-limit');
const { issueLinkToken } = require('../lib/tokens');
const { query } = require('../lib/db');
const { sendLinkEmail } = require('../lib/auth-email');
const { isEmailAllowed } = require('../lib/allowed-emails');
const { buildMagicLink } = require('../lib/magic-link');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', limiter, async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    if (!(await isEmailAllowed(email))) {
      return res.status(400).json({
        ok: false,
        error: 'This email is not on the access list. Contact your supervisor if you believe this is in error.',
      });
    }

    const { token, jti } = issueLinkToken(email);
    const ip = req.ip;
    const ua = req.get('user-agent') || null;

    await query(
      `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [email, jti, ip, ua],
    );

    const rawReturnTo = (req.body && req.body.returnTo) ? String(req.body.returnTo).trim() : '';
    const link = buildMagicLink(token, rawReturnTo || null);
    if (!link) {
      return res.status(400).json({ ok: false, error: 'Invalid return URL.' });
    }

    await sendLinkEmail({ to: email, link });

    console.log(`[request-link] issued jti=${jti.slice(0, 6)}\u2026 for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[request-link] error', err);
    return res.status(500).json({ ok: false, error: 'Could not send link. Please try again.' });
  }
});

module.exports = router;
