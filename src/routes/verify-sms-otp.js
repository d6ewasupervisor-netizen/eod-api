// POST /api/verify-sms-otp  body: { email, code }
// Verifies Twilio SMS PIN and returns the same long-lived session JWT as magic-link.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { isEmailAllowed } = require('../lib/allowed-emails');
const { verifyPin } = require('../lib/sms-otp');
const { issueSessionToken } = require('../lib/session-jwt');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many PIN attempts. Wait a few minutes.' },
});

router.post('/', limiter, async (req, res) => {
  try {
    const email = (req.body?.email ? String(req.body.email) : '').trim().toLowerCase();
    const code = req.body?.code != null ? String(req.body.code) : '';

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    if (!(await isEmailAllowed(email))) {
      return res.status(400).json({
        ok: false,
        error: 'This email is not on the access list.',
      });
    }

    const { email: verified } = await verifyPin({ email, pin: code });
    const sessionToken = issueSessionToken(verified);
    console.log(`[verify-sms-otp] session issued for ${verified}`);
    return res.json({ ok: true, email: verified, token: sessionToken });
  } catch (err) {
    const clientCodes = new Set(['BAD_FORMAT', 'NO_CHALLENGE', 'EXPIRED', 'LOCKED', 'MISMATCH']);
    if (err && clientCodes.has(err.code)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[verify-sms-otp]', err);
    return res.status(500).json({ ok: false, error: 'Could not verify code. Try again or use email sign-in.' });
  }
});

module.exports = router;
