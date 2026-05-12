// POST /api/access-request  body: { name, email, reason? }
//
// Self-serve flow when an unrecognized user hits signin.html. Stores a pending
// row in access_requests and emails each approver an HMAC-signed Approve/Deny
// URL pointing at /api/access-requests/:id/(approve|deny).

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const {
  isEmailAllowed,
  isCorporateWorkDomainEmail,
  corporateDomainListForMessage,
} = require('../lib/allowed-emails');
const { newRequestId, createAccessRequest } = require('../lib/access-requests-db');
const { sendAccessRequestApprovalEmail } = require('../lib/auth-email');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again later.' },
});

function getApprovers() {
  return (process.env.ACCESS_REQUEST_APPROVERS || 'tyson.gauthier@retailodyssey.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function computeDecisionToken(id, action, approverEmail) {
  const secret = process.env.ACCESS_REQUEST_SECRET;
  if (!secret) throw new Error('ACCESS_REQUEST_SECRET is not configured');
  return crypto
    .createHmac('sha256', secret)
    .update(`${id}|${action}|${approverEmail}`)
    .digest('hex');
}

function buildDecisionUrl(id, action, approverEmail) {
  const fallback = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://eod-api.the-dump-bin.com';
  const base = (process.env.BACKEND_BASE_URL || fallback).replace(/\/+$/, '');
  const token = computeDecisionToken(id, action, approverEmail);
  return `${base}/api/access-requests/${encodeURIComponent(id)}/${action}?token=${token}&by=${encodeURIComponent(approverEmail)}`;
}

router.post('/', limiter, async (req, res) => {
  try {
    const rawEmail = req.body?.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    const rawName = req.body?.name ? String(req.body.name) : '';
    const name = rawName.trim().slice(0, 200);
    const rawReason = req.body?.reason ? String(req.body.reason) : '';
    const reason = rawReason.trim().slice(0, 1000);

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Please enter your full name.' });
    }
    if (isCorporateWorkDomainEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: `Work addresses (${corporateDomainListForMessage()}) are automatically allowed. Go back and request your link directly.`,
      });
    }
    if (await isEmailAllowed(email)) {
      return res.status(400).json({
        ok: false,
        error: 'This email is already on the access list. Go back and request your link directly.',
      });
    }

    const id = newRequestId();
    await createAccessRequest({ id, name, email, reason });

    const approvers = getApprovers();
    for (const approverEmail of approvers) {
      const approveUrl = buildDecisionUrl(id, 'approve', approverEmail);
      const denyUrl = buildDecisionUrl(id, 'deny', approverEmail);
      try {
        await sendAccessRequestApprovalEmail({ record: { id, name, email, reason }, approverEmail, approveUrl, denyUrl });
      } catch (err) {
        console.error(`[access-request] failed to email approver ${approverEmail}:`, err);
      }
    }

    console.log(`[access-request] created request ${id} for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[access-request] error', err);
    return res.status(500).json({ ok: false, error: 'Could not submit your request. Please try again.' });
  }
});

module.exports = router;
module.exports.computeDecisionToken = computeDecisionToken;
module.exports.getApprovers = getApprovers;
