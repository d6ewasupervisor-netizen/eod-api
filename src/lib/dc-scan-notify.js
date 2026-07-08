'use strict';

const { issueReviewToken } = require('./decision-review-jwt');
const { retailOdysseyFrom } = require('./email-from');
const { dispatchTrackedEmail } = require('./resend-outbox');
const { VOLUNTEERS, DEFAULT_SUPERVISOR_EMAIL, normalizeEmail, supervisorEmails } = require('./dc-scan-inventory');

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

async function sendMail(resend, { to, cc, replyTo, subject, html, text, tag, from }) {
  if (!resend) {
    console.warn('[dc-scan-notify] no resend client; skip', subject);
    return null;
  }
  const recipients = Array.isArray(to) ? to : [to];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
  return dispatchTrackedEmail(
    resend,
    {
      sourceSystem: 'eod-api',
      sourceType: tag || 'dc-scan',
    },
    {
      from: from || fromAddress(),
      to: recipients,
      cc: ccList,
      reply_to: replyTo || DEFAULT_SUPERVISOR_EMAIL,
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

function volunteerInviteFrom() {
  return process.env.DC_SCAN_FROM_ADDRESS || 'DC Scans <dcscans@retail-odyssey.com>';
}

function buildVolunteerInviteContent() {
  const stores = 'FM 19, 28, 31, 53, 215, 459, and 682';
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:640px;">
      <p>Hi team,</p>
      <p>We set up a live <strong>DC Scan signup board</strong> for project <strong>8081</strong> (RO8 DC Scans).
      Please use it to claim stores for <strong>this week (P06W3)</strong> and to lock in your
      <strong>going-forward</strong> semi-permanent stores starting next week.</p>
      <p style="margin:24px 0;">
        <a href="${esc(DASHBOARD_URL)}"
           style="display:inline-block;background:#0d4f8b;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;">
          Open DC Scan board
        </a>
      </p>
      <h3 style="margin:24px 0 8px;font-size:16px;">How to sign in</h3>
      <ol style="padding-left:20px;margin:0;">
        <li>Open the link above on your phone or laptop.</li>
        <li>Enter <strong>your work email</strong> on the sign-in page.</li>
        <li>Click the magic link we email you (check spam if needed).</li>
      </ol>
      <h3 style="margin:24px 0 8px;font-size:16px;">How to use the board</h3>
      <ul style="padding-left:20px;margin:0;">
        <li><strong>This week</strong> — urgent P06W3 coverage. Claim any open store among ${esc(stores)}.</li>
        <li><strong>Going forward</strong> — pick the semi-permanent store(s) you want to keep covering.</li>
        <li>Scans run <strong>Wed–Fri, 9:00 AM – 5:00 PM</strong>. Pick the day when you claim.</li>
        <li>You may claim <strong>more than one store</strong>.</li>
        <li>When your picks are right, tap <strong>Finalize</strong> to lock them and queue SAS visit/shift builds.</li>
        <li>A store shows <strong>In PROD</strong> or <strong>Completed</strong> only after we confirm it live in SAS — claimed is not the same as built.</li>
        <li>Use <strong>Release / swap</strong> on your claim if plans change; Tyson approves those requests.</li>
        <li>If the banner says PROD is pending, tap <strong>Resync SAS PROD</strong> (no page refresh needed).</li>
      </ul>
      <p style="margin-top:24px;">Wolf is already on <strong>FM 31</strong> and James on <strong>FM 53</strong> for today — you'll see those on the board once PROD syncs.</p>
      <p>Reply on this thread if anything looks wrong or you need a store released.</p>
      <p>Thanks,<br/>Tyson</p>
    </div>`;
  const text = [
    'DC Scan signup board (project 8081 / RO8 DC Scans)',
    '',
    `Dashboard: ${DASHBOARD_URL}`,
    '',
    'Sign in: open the link, enter your work email, click the magic link.',
    '',
    'Instructions:',
    '- This week (P06W3): claim open stores — ' + stores,
    '- Going forward: claim semi-permanent stores for P06W4+',
    '- Wed–Fri 9 AM – 5 PM; pick a day when claiming',
    '- Multiple stores allowed',
    '- Finalize locks your picks and queues SAS builds',
    '- In PROD / Completed = confirmed in SAS; Claimed ≠ built',
    '- Release/swap sends a request to Tyson for approval',
    '- Use Resync SAS PROD if the live banner is stuck pending',
    '',
    'FM 31 (Wolf) and FM 53 (James) are already on the board for today.',
  ].join('\n');
  return { html, text };
}

async function notifyVolunteerInvite(resend, { cc } = {}) {
  const to = VOLUNTEERS.map((v) => normalizeEmail(v.email));
  const ccList = cc || [DEFAULT_SUPERVISOR_EMAIL];
  const { html, text } = buildVolunteerInviteContent();
  const subject = '[DC Scan] Sign up for your stores — live board (P06W3+)';
  return sendMail(resend, {
    from: volunteerInviteFrom(),
    to,
    cc: ccList,
    subject,
    html,
    text,
    tag: 'dc-scan-volunteer-invite',
  });
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

function buildDcScanAccessDecisionUrl(id, action, approverEmail) {
  const { computeDecisionToken } = require('../routes/dc-scan-access-decision');
  const fallback = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://eod-api.the-dump-bin.com';
  const base = (process.env.BACKEND_BASE_URL || fallback).replace(/\/+$/, '');
  const token = computeDecisionToken(id, action, approverEmail);
  return `${base}/api/dc-scan-access-requests/${encodeURIComponent(id)}/${action}?token=${token}&by=${encodeURIComponent(approverEmail)}`;
}

async function notifyDcScanAccessRequest(resend, { record }) {
  const approvers = [...supervisorEmails()];
  for (const approver of approvers) {
    const reasonRow = record.reason
      ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Note</td>
             <td style="padding:6px 0 6px 16px;font-size:14px;">${esc(record.reason)}</td></tr>`
      : '';
    const approveUrl = buildDcScanAccessDecisionUrl(record.id, 'approve', approver);
    const denyUrl = buildDcScanAccessDecisionUrl(record.id, 'deny', approver);
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;padding:32px 16px;">
      <div style="background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 4px;color:#1a3a6e;font-size:18px;">DC Scan volunteer access request</h2>
        <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">Someone signed in to The Dump Bin but is not on the DC Scan volunteer list yet.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Name</td>
            <td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;">${esc(record.name || '—')}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Email</td>
            <td style="padding:6px 0 6px 16px;font-size:14px;">${esc(record.email)}</td>
          </tr>
          ${reasonRow}
        </table>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding-right:8px;">
              <a href="${esc(approveUrl)}"
                 style="display:block;background:#15803d;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
                ✓ Approve
              </a>
            </td>
            <td style="padding-left:8px;">
              <a href="${esc(denyUrl)}"
                 style="display:block;background:#b91c1c;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
                ✗ Deny
              </a>
            </td>
          </tr>
        </table>
        <p style="margin-top:16px;color:#9ca3af;font-size:12px;">
          Approve adds this person to the DC Scan volunteer list. They can refresh the board to claim stores.
        </p>
      </div></div>`;
    const text = [
      'DC Scan volunteer access request',
      '',
      `Name: ${record.name || '—'}`,
      `Email: ${record.email}`,
      record.reason ? `Note: ${record.reason}` : '',
      '',
      `Approve: ${approveUrl}`,
      `Deny: ${denyUrl}`,
    ].filter((line) => line !== null).join('\n');

    await sendMail(resend, {
      to: approver,
      subject: `[DC Scan] Access request: ${record.name || record.email} (${record.email})`,
      html,
      text,
      tag: 'dc-scan-access-request',
      replyTo: record.email,
    }).catch((err) => console.error('[dc-scan-notify] access request', err.message));
  }
}

async function notifyDcScanAccessResolved(resend, { record, action }) {
  const approved = action === 'approve';
  const greeting = record.name ? `Hi ${esc(record.name)},` : 'Hello,';
  const html = approved
    ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
        <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
        <p style="margin:0 0 12px;">Your DC Scan volunteer access request was approved. Refresh the board and claim your stores.</p>
        <p style="margin:0;"><a href="${esc(DASHBOARD_URL)}">Open DC Scan board</a></p>
      </div>`
    : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
        <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
        <p style="margin:0 0 12px;">Your DC Scan volunteer access request was reviewed and was not approved at this time.</p>
        <p style="margin:0;color:#6b7280;font-size:14px;">If you believe this is an error, contact your supervisor directly.</p>
      </div>`;
  await sendMail(resend, {
    to: record.email,
    subject: approved ? '[DC Scan] Access approved — you can claim stores' : '[DC Scan] Access request update',
    html,
    text: approved
      ? `Your DC Scan access was approved. Open ${DASHBOARD_URL}`
      : 'Your DC Scan access request was not approved.',
    tag: approved ? 'dc-scan-access-approved' : 'dc-scan-access-denied',
  }).catch((err) => console.error('[dc-scan-notify] access resolved', err.message));
}

module.exports = {
  approverEmail,
  notifyClaim,
  notifyChangeRequest,
  notifyChangeResolved,
  notifyFinalize,
  notifyVolunteerInvite,
  notifyDcScanAccessRequest,
  notifyDcScanAccessResolved,
  buildVolunteerInviteContent,
  volunteerInviteFrom,
  DASHBOARD_URL,
};
