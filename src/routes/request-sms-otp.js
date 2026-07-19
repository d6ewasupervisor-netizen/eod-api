// POST /api/request-sms-otp  body: { email }
// Sends a 6-digit PIN via Twilio to the phone on the survey roster (or employees).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { isEmailAllowed } = require('../lib/allowed-emails');
const { issueAndSendPin, twilioConfigured } = require('../lib/sms-otp');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many text-code requests. Wait a bit, or use the email sign-in link.' },
});

router.get('/status', (_req, res) => {
  res.json({ ok: true, smsEnabled: twilioConfigured() });
});

router.post('/', limiter, async (req, res) => {
  try {
    if (!twilioConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'Text sign-in is not enabled yet. Use the email sign-in link.',
      });
    }

    const email = (req.body?.email ? String(req.body.email) : '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    if (!(await isEmailAllowed(email))) {
      return res.status(400).json({
        ok: false,
        error: 'This email is not on the access list. Contact your supervisor if you believe this is in error.',
      });
    }

    const result = await issueAndSendPin({
      email,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    console.log(`[request-sms-otp] sent to ${result.maskedPhone} for ${email}`);
    return res.json({
      ok: true,
      maskedPhone: result.maskedPhone,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (err) {
    if (err && err.code === 'NO_PHONE') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err && err.code === 'TWILIO_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: err.message });
    }
    console.error('[request-sms-otp]', err);
    return res.status(500).json({ ok: false, error: 'Could not send text code. Try the email link instead.' });
  }
});

module.exports = router;
