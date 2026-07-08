'use strict';

const express = require('express');
const crypto = require('node:crypto');
const {
  getDcScanAccessRequest,
  markDcScanAccessRequestDecided,
  grantVolunteerEmail,
} = require('../lib/dc-scan-access-db');
const {
  addGrantedVolunteerEmail,
  supervisorEmails,
  normalizeEmail,
} = require('../lib/dc-scan-inventory');
const { notifyDcScanAccessResolved } = require('../lib/dc-scan-notify');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
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
    .actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:20px}
    button{font:inherit;border:0;border-radius:8px;padding:14px 18px;font-weight:700;cursor:pointer}
    .approveBtn{background:#15803d;color:#fff}
    .denyBtn{background:#b91c1c;color:#fff}
  </style>`;

function getApprovers() {
  return [...supervisorEmails()];
}

function computeDecisionToken(id, action, approverEmail) {
  const secret = process.env.ACCESS_REQUEST_SECRET;
  if (!secret) throw new Error('ACCESS_REQUEST_SECRET is not configured');
  return crypto
    .createHmac('sha256', secret)
    .update(`dcscan-access|${id}|${action}|${approverEmail}`)
    .digest('hex');
}

function detailHtml(record) {
  return `<div class="detail">
    <div class="row"><dt>Name: </dt><dd>${esc(record.name || '—')}</dd></div>
    <div class="row"><dt>Email: </dt><dd>${esc(record.email)}</dd></div>
    ${record.reason ? `<div class="row"><dt>Reason: </dt><dd>${esc(record.reason)}</dd></div>` : ''}
  </div>`;
}

function renderError(title, msg) {
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${esc(title)}</title></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

function renderConfirmation(action, record) {
  const label = action === 'approve' ? 'approved' : 'denied';
  const badge = action === 'approve' ? '<span class="ok">Approved</span>' : '<span class="deny">Denied</span>';
  const title =
    action === 'approve'
      ? `DC Scan access approved for ${esc(record.email)}`
      : `DC Scan access denied for ${esc(record.email)}`;
  const note = action === 'approve'
    ? `<p><strong>${esc(record.name || record.email)}</strong> can now claim stores on the DC Scan board. Ask them to refresh the page.</p>`
    : `<p>${esc(record.name || record.email)} has been notified that their DC Scan access request was not approved.</p>`;
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>DC Scan ${label}</title></head>
<body><div class="card"><h1>${title} ${badge}</h1>${detailHtml(record)}${note}</div></body></html>`;
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
  ${detailHtml(record)}
</div></body></html>`;
}

function renderDecisionPrompt(action, record, token, approverEmail) {
  const label = action === 'approve' ? 'approve' : 'deny';
  const title = action === 'approve' ? 'Confirm DC Scan approval' : 'Confirm DC Scan denial';
  const buttonClass = action === 'approve' ? 'approveBtn' : 'denyBtn';
  const buttonText = action === 'approve' ? 'Yes, approve DC Scan access' : 'Yes, deny DC Scan access';
  const note = action === 'approve'
    ? 'This adds the requester to the DC Scan volunteer list so they can claim stores.'
    : 'This marks the request denied and emails the requester.';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${title}</title></head>
<body><div class="card">
  <h1>${title}</h1>
  <p>${esc(note)}</p>
  ${detailHtml(record)}
  <form method="post" action="/api/dc-scan-access-requests/${encodeURIComponent(record.id)}/${label}">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="by" value="${esc(approverEmail)}">
    <div class="actions"><button type="submit" class="${buttonClass}">${buttonText}</button></div>
  </form>
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

  const normalizedApprover = normalizeEmail(approverEmail);
  if (!getApprovers().includes(normalizedApprover)) {
    res.status(403).send(renderError('Invalid approver', 'This decision link is not valid for your account.'));
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

  const existing = await getDcScanAccessRequest(id);
  if (!existing) {
    res.status(404).send(renderError('Request not found', 'This DC Scan access request could not be found.'));
    return null;
  }

  return { id, token, approverEmail, existing };
}

async function showDecisionPrompt(req, res, action) {
  try {
    const validated = await validateDecisionRequest(req, res, action);
    if (!validated) return;
    if (validated.existing.status !== 'pending') {
      return res.send(renderAlreadyDecided(validated.existing));
    }
    return res.send(renderDecisionPrompt(
      action,
      validated.existing,
      validated.token,
      validated.approverEmail,
    ));
  } catch (err) {
    console.error('[dc-scan-access-decision] showDecisionPrompt', err);
    if (!res.headersSent) {
      return res.status(500).send(renderError('Could not load this page', 'Something went wrong. Please try again.'));
    }
  }
}

async function handleDecision(req, res, action) {
  try {
    const validated = await validateDecisionRequest(req, res, action);
    if (!validated) return;
    const { id, approverEmail } = validated;

    const decided = await markDcScanAccessRequestDecided(id, action, approverEmail);
    if (!decided) {
      const current = await getDcScanAccessRequest(id);
      if (current) return res.send(renderAlreadyDecided(current));
      return res.status(404).send(renderError('Request not found', 'This DC Scan access request could not be found.'));
    }

    if (action === 'approve') {
      await grantVolunteerEmail({
        email: decided.email,
        name: decided.name,
        grantedBy: approverEmail,
      });
      addGrantedVolunteerEmail(decided.email);
    }

    notifyDcScanAccessResolved(null, { record: decided, action }).catch((err) => {
      console.error('[dc-scan-access-decision] notify', err.message);
    });

    return res.send(renderConfirmation(action, decided));
  } catch (err) {
    console.error('[dc-scan-access-decision] handleDecision', err);
    if (!res.headersSent) {
      return res.status(500).send(renderError('Could not complete this action', 'Something went wrong. Please try again.'));
    }
  }
}

router.get('/:id/approve', (req, res) => showDecisionPrompt(req, res, 'approve'));
router.get('/:id/deny', (req, res) => showDecisionPrompt(req, res, 'deny'));
router.post('/:id/approve', (req, res) => handleDecision(req, res, 'approve'));
router.post('/:id/deny', (req, res) => handleDecision(req, res, 'deny'));

module.exports = router;
module.exports.computeDecisionToken = computeDecisionToken;
module.exports.getApprovers = getApprovers;
