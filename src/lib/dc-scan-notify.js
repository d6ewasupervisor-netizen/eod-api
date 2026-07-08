'use strict';

const { issueReviewToken } = require('./decision-review-jwt');
const { retailOdysseyFrom } = require('./email-from');
const { dispatchTrackedEmail } = require('./resend-outbox');
const {
  DEFAULT_SUPERVISOR_EMAIL,
  normalizeEmail,
} = require('./dc-scan-inventory');

const DUMP_BIN_SITE = (process.env.DUMP_BIN_SITE || 'https://the-dump-bin.com').replace(
  /\/$/,
  '',
);
const DASHBOARD_URL =
  process.env.DC_SCAN_DASHBOARD_URL ||
  'https://the-dump-bin.com/dc-scan/';

function approverEmail() {
  return (
    normalizeEmail(process.env.DC_SCAN_APPROVER_EMAIL) ||
    normalizeEmail(process.env.OVERRIDE_APPROVER_EMAIL) ||
    normalizeEmail(process.env.SHIFT_REQUEST_APPROVER_EMAIL) ||
    DEFAULT_SUPERVISOR_EMAIL
  );
}

function fromAddress() {
  return process.env.DC_SCAN_FROM_ADDRESS || retailOdysseyFrom('DC Scan Board');
}

async function sendMail(resend, { to, subject, html, text, tag }) {
  if (!resend) {
    console.warn('[dc-scan-notify] no resend client; skip', subject);
    return null;
  }
  const recipients = Array.isArray(to) ? to : [to];
  return dispatchTrackedEmail(
    resend,
    {
      sourceSystem: 'eod-api',
      sourceType: tag || 'dc-scan',
    },
    {
      from: fromAddress(),
      to: recipients,
      subject,
      html,
      text,
    },
  );
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function notifyClaim(resend, { pledge }) {
  const subject = `[DC Scan] ${pledge.name} claimed FM ${pledge.storeId} (${pledge.scheduledDate})`;
  const html = `
    <p><strong>${esc(pledge.name)}</strong> claimed <strong>FM ${esc(pledge.storeId)}</strong>
    for <strong>${esc(pledge.scheduledDate)}</strong> (${esc(pledge.scope)} / ${esc(pledge.weekKey)}).</p>
    <p><a href="${esc(DASHBOARD_URL)}">Open DC Scan board</a></p>`;
  return sendMail(resend, {
    to: approverEmail(),
    subject,
    html,
    text: `${pledge.name} claimed FM ${pledge.storeId} on ${pledge.scheduledDate}`,
    tag: 'dc-scan-claim',
  }).catch((err) => console.error('[dc-scan-notify] claim', err.message));
}

async function notifyChangeRequest(resend, { request, pledge }) {
  const token = issueReviewToken({
    requestId: request.id,
    decisionType: 'dcscan',
    approverEmail: approverEmail(),
  });
  const reviewUrl = `${DUMP_BIN_SITE}/decide.html?type=dcscan&id=${encodeURIComponent(request.id)}&token=${encodeURIComponent(token)}`;
  const verb = request.type === 'swap' ? 'swap' : 'release';
  const subject = `[DC Scan] ${request.requestedByName} requested ${verb} of FM ${request.storeId}`;
  const details =
    request.type === 'swap'
      ? `Swap FM ${request.storeId} (${request.scheduledDate}) → FM ${request.swapToStoreId} (${request.swapToDate})`
      : `Release FM ${request.storeId} on ${request.scheduledDate}`;
  const html = `
    <p><strong>${esc(request.requestedByName)}</strong> (${esc(request.requestedByEmail)})
    requested a <strong>${esc(verb)}</strong>.</p>
    <p>${esc(details)}</p>
    ${request.note ? `<p>Note: ${esc(request.note)}</p>` : ''}
    <p><a href="${esc(reviewUrl)}" style="display:inline-block;background:#0d4f8b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Review approve / deny</a></p>
    <p><a href="${esc(DASHBOARD_URL)}">Open board</a></p>`;
  return sendMail(resend, {
    to: approverEmail(),
    subject,
    html,
    text: `${details}\nReview: ${reviewUrl}`,
    tag: 'dc-scan-change',
  });
}

async function notifyChangeResolved(resend, { request, status }) {
  const subject = `[DC Scan] Your ${request.type} request was ${status}`;
  const html = `
    <p>Your request to <strong>${esc(request.type)}</strong> FM <strong>${esc(request.storeId)}</strong>
    was <strong>${esc(status)}</strong>.</p>
    <p><a href="${esc(DASHBOARD_URL)}">Open DC Scan board</a></p>`;
  return sendMail(resend, {
    to: request.requestedByEmail,
    subject,
    html,
    text: `Your ${request.type} for FM ${request.storeId} was ${status}.`,
    tag: 'dc-scan-change-result',
  }).catch((err) => console.error('[dc-scan-notify] resolved', err.message));
}

async function notifyFinalize(resend, { email, name, pledges, buildResults }) {
  const lines = pledges
    .map((p) => {
      const br = (buildResults || []).find((r) => r.pledgeId === p.id);
      const buildBit = br
        ? br.ok
          ? `built visit ${br.visitId || p.sasVisitId || '?'}`
          : `ERROR: ${br.error || 'failed'}`
        : p.buildStatus;
      return `• FM ${p.storeId} on ${p.scheduledDate} (${p.scope}) — ${buildBit}`;
    })
    .join('<br/>');
  const subject = `[DC Scan] ${name} finalized selections (${pledges.length})`;
  const html = `
    <p><strong>${esc(name)}</strong> (${esc(email)}) finalized DC Scan selections.</p>
    <p>${lines}</p>
    <p><a href="${esc(DASHBOARD_URL)}">Open board</a></p>`;
  await sendMail(resend, {
    to: approverEmail(),
    subject,
    html,
    text: `${name} finalized ${pledges.length} selections`,
    tag: 'dc-scan-finalize',
  }).catch((err) => console.error('[dc-scan-notify] finalize admin', err.message));

  const userHtml = `
    <p>Thanks ${esc(name)} — your DC Scan selections are locked and we queued SAS builds for your stores.</p>
    <p>${lines}</p>
    <p><a href="${esc(DASHBOARD_URL)}">View board</a></p>`;
  await sendMail(resend, {
    to: email,
    subject: '[DC Scan] Your selections are locked',
    html: userHtml,
    text: 'Your DC Scan selections are locked.',
    tag: 'dc-scan-finalize-user',
  }).catch((err) => console.error('[dc-scan-notify] finalize user', err.message));
}

module.exports = {
  approverEmail,
  notifyClaim,
  notifyChangeRequest,
  notifyChangeResolved,
  notifyFinalize,
  DASHBOARD_URL,
};
