// /api/access-requests/:id/(approve|deny) -- the URLs in the approver email.
//
// SECURITY: Email security scanners can prefetch GET links, so GET routes only
// render a confirmation page; the actual decision requires a POST from that
// page. The HMAC signature in the query string binds (id, action, approverEmail)
// to the secret, so even a leaked URL can't be replayed for a different action.

const express = require('express');
const crypto = require('node:crypto');
const { query } = require('../lib/db');
const { issueLinkToken } = require('../lib/tokens');
const {
  getAccessRequest,
  markAccessRequestDecided,
} = require('../lib/access-requests-db');
const { computeDecisionToken, getApprovers } = require('./access-request');
const {
  sendAccessApprovedEmail,
  sendAccessRequestDenialEmail,
  sendAccessRequestOtherApproverEmail,
} = require('../lib/auth-email');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDatetime(iso) {
  if (!iso) return 'unknown time';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

const PAGE_CSS = `
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6fa;margin:0;padding:40px 16px;color:#1f2937}
    .card{background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:500px;margin:0 auto;border:1px solid #e5e7eb}
    h1{font-size:20px;color:#1a3a6e;margin:0 0 16px}
    p{margin:0 0 10px;font-size:15px;line-height:1.55}
    .detail{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:14px}
    .detail .row{margin-bottom:6px}
    .detail dt{font-weight:600;color:#1a3a6e;display:inline}
    .detail dd{display:inline;margin:0}
    .ok{display:inline-block;background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0;border-radius:6px;padding:2px 10px;font-size:13px}
    .deny{display:inline-block;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;padding:2px 10px;font-size:13px}
    .muted{color:#6b7280;font-size:13px}
    .warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:12px 14px;font-size:14px;margin-top:16px}
    .actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:20px}
    button{font:inherit;border:0;border-radius:8px;padding:14px 18px;font-weight:700;cursor:pointer}
    .approveBtn{background:#15803d;color:#fff}
    .denyBtn{background:#b91c1c;color:#fff}
    .cancelLink{display:block;text-align:center;margin-top:12px;color:#6b7280;font-size:13px;text-decoration:none}
  </style>`;

function detailHtml(record) {
  return `<div class="detail">
    <div class="row"><dt>Name: </dt><dd>${esc(record.name || '\u2014')}</dd></div>
    <div class="row"><dt>Email: </dt><dd>${esc(record.email)}</dd></div>
    ${record.reason ? `<div class="row"><dt>Reason: </dt><dd>${esc(record.reason)}</dd></div>` : ''}
  </div>`;
}

function renderConfirmation(action, record, warning) {
  const label = action === 'approve' ? 'approved' : 'denied';
  const badge = action === 'approve' ? '<span class="ok">Approved</span>' : '<span class="deny">Denied</span>';
  const note = action === 'approve'
    ? `<p>A sign-in link has been sent to <strong>${esc(record.email)}</strong>.</p>`
    : `<p>${esc(record.name || record.email)} has been notified that their request was not approved.</p>`;
  const warnHtml = warning ? `<div class="warn"><strong>Note:</strong> ${esc(warning)}</div>` : '';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>Request ${label}</title></head>
<body><div class="card">
  <h1>Request ${label} ${badge}</h1>
  ${detailHtml(record)}
  ${note}
  ${warnHtml}
</div></body></html>`;
}

function renderAlreadyDecided(record) {
  const label = record.decided_action === 'approve' ? 'approved' : 'denied';
  const badge = record.decided_action === 'approve' ? '<span class="ok">Approved</span>' : '<span class="deny">Denied</span>';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>Already decided</title></head>
<body><div class="card">
  <h1>Already ${label} ${badge}</h1>
  <p>This request was already <strong>${label}</strong> by
     <strong>${esc(record.decided_by || 'someone')}</strong>
     at ${esc(formatDatetime(record.decided_at))}.</p>
  <p class="muted">No action needed.</p>
  ${detailHtml(record)}
</div></body></html>`;
}

function renderError(title, msg) {
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${esc(title)}</title></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

function renderDecisionPrompt(action, record, token, approverEmail) {
  const label = action === 'approve' ? 'approve' : 'deny';
  const title = action === 'approve' ? 'Confirm Approval' : 'Confirm Denial';
  const buttonClass = action === 'approve' ? 'approveBtn' : 'denyBtn';
  const buttonText = action === 'approve' ? 'Yes, approve access' : 'Yes, deny access';
  const note = action === 'approve'
    ? 'This will add the requester to the EOD allowlist and email them a sign-in link immediately.'
    : 'This will mark the request denied and email the requester that access was not approved.';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${title}</title></head>
<body><div class="card">
  <h1>${title}</h1>
  <p>${esc(note)}</p>
  ${detailHtml(record)}
  <form method="post" action="/api/access-requests/${encodeURIComponent(record.id)}/${label}">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="by" value="${esc(approverEmail)}">
    <div class="actions">
      <button type="submit" class="${buttonClass}">${buttonText}</button>
    </div>
  </form>
  <a class="cancelLink" href="javascript:window.close()">Cancel \u2014 close this page</a>
</div></body></html>`;
}

function getDecisionParams(req) {
  const { id } = req.params;
  const token = req.method === 'POST' ? req.body?.token : req.query.token;
  const approverEmail = req.method === 'POST' ? req.body?.by : req.query.by;
  return { id, token, approverEmail };
}

async function validateDecisionRequest(req, res, action) {
  const { id, token, approverEmail } = getDecisionParams(req);
  if (!id || !token || !approverEmail) {
    res.status(400).send(renderError('Invalid link', 'This link is missing required parameters.'));
    return null;
  }

  let expectedToken;
  try {
    expectedToken = computeDecisionToken(id, action, approverEmail);
  } catch {
    res.status(500).send(renderError('Configuration error', 'The server is missing its signing key. Please contact your supervisor.'));
    return null;
  }

  const tokBuf = Buffer.from(token, 'hex');
  const expBuf = Buffer.from(expectedToken, 'hex');
  const valid = tokBuf.length === expBuf.length && crypto.timingSafeEqual(tokBuf, expBuf);
  if (!valid) {
    res.status(403).send(renderError('Invalid link', 'This link is invalid or has been tampered with.'));
    return null;
  }

  const existing = await getAccessRequest(id);
  if (!existing) {
    res.status(404).send(renderError('Request not found', 'This access request could not be found. It may have expired.'));
    return null;
  }

  return { id, token, approverEmail, existing };
}

async function showDecisionPrompt(req, res, action) {
  const validated = await validateDecisionRequest(req, res, action);
  if (!validated) return;
  if (validated.existing.status !== 'pending') {
    return res.send(renderAlreadyDecided(validated.existing));
  }
  return res.send(renderDecisionPrompt(action, validated.existing, validated.token, validated.approverEmail));
}

async function handleDecision(req, res, action) {
  const validated = await validateDecisionRequest(req, res, action);
  if (!validated) return;
  const { id, approverEmail } = validated;

  const decided = await markAccessRequestDecided(id, action, approverEmail);
  if (!decided) {
    const current = await getAccessRequest(id);
    return res.send(current ? renderAlreadyDecided(current) : renderError('Not found', 'This access request could not be found.'));
  }

  console.log(`[access-request-decision] ${action} by ${approverEmail} for request ${id} (${decided.email})`);

  let warning = null;

  if (action === 'approve') {
    try {
      await query(
        `INSERT INTO allowed_emails (email, note)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
        [decided.email, `Approved via access request by ${approverEmail} on ${formatDatetime(decided.decided_at)}`],
      );
    } catch (err) {
      console.error('[access-request-decision] failed to insert allowed_email:', err);
      warning = 'The approval was recorded but the email could not be added to the allowlist automatically. Please add it manually via the admin page.';
    }

    if (!warning) {
      try {
        const { token: linkJwt, jti } = issueLinkToken(decided.email);
        await query(
          `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
          [decided.email, jti, null, 'access-request-auto-link'],
        );
        const base = (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com/EOD').replace(/\/+$/, '');
        const link = `${base}/index.html?token=${encodeURIComponent(linkJwt)}`;
        await sendAccessApprovedEmail({ to: decided.email, name: decided.name, link });
        console.log(`[access-request-decision] magic link sent to ${decided.email}`);
      } catch (err) {
        console.error('[access-request-decision] failed to send magic link:', err);
        warning = 'The approval was recorded but the sign-in link email failed to send. Please send them a link manually from the admin page.';
      }
    }
  } else {
    try {
      await sendAccessRequestDenialEmail({ to: decided.email, name: decided.name });
    } catch (err) {
      console.error('[access-request-decision] failed to send denial email:', err);
    }
  }

  // With a single approver this loop is a no-op; left in so adding a second
  // approver via ACCESS_REQUEST_APPROVERS "just works".
  const approvers = getApprovers();
  for (const other of approvers) {
    if (other.toLowerCase() !== approverEmail.toLowerCase()) {
      try {
        await sendAccessRequestOtherApproverEmail({ to: other, decidedBy: approverEmail, action, record: decided });
      } catch (err) {
        console.error(`[access-request-decision] failed to notify other approver ${other}:`, err);
      }
    }
  }

  return res.send(renderConfirmation(action, decided, warning));
}

router.get('/:id/approve', (req, res) => showDecisionPrompt(req, res, 'approve'));
router.get('/:id/deny', (req, res) => showDecisionPrompt(req, res, 'deny'));
router.post('/:id/approve', (req, res) => handleDecision(req, res, 'approve'));
router.post('/:id/deny', (req, res) => handleDecision(req, res, 'deny'));

module.exports = router;
