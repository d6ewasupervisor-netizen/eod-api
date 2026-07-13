// Resend wrappers for the email-magic-link / admin / access-request flows.
//
// We use a separate Resend client from index.js so this module is independently
// require-able. Both clients share the same RESEND_API_KEY -- there is no
// per-client state, so two SDK instances cost nothing.
//
// Named `auth-email.js` (not `email.js`) to avoid colliding with future
// EOD-domain email helpers and to keep this file's scope obvious: it only
// sends authentication-flow messages.

const { Resend } = require('resend');
const { addReplyTo } = require('./resend-reply-to');

if (!process.env.RESEND_API_KEY) {
  console.warn('[auth-email] RESEND_API_KEY is not set; magic-link emails will throw.');
}

const resend = new Resend(process.env.RESEND_API_KEY || 'unset');

const { retailOdysseyFrom } = require('./email-from');
const FROM = process.env.AUTH_EMAIL_FROM || retailOdysseyFrom('The Dump Bin');

const MOBILE_LINK_INSTRUCTIONS_TEXT =
  'On a phone, do not tap the link — your mail app may open it in a mini browser where sign-in fails. '
  + 'Press and hold the link, then choose "Open in browser" (or "Open in Chrome" / "Open in Safari").';

const MOBILE_LINK_INSTRUCTIONS_HTML = `
      <p style="margin:0 0 16px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;color:#1e3a8a;font-size:14px;line-height:1.5;">
        <strong>On your phone:</strong> do not tap the link. <strong>Press and hold</strong> the Sign in button or link below,
        then choose <strong>Open in browser</strong> (or Open in Chrome / Open in Safari).
      </p>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendHubLeadAccessEmail({
  to,
  link,
  leadName,
  storeLabels,
}) {
  const greeting = leadName ? `Hi ${escapeHtml(leadName.split(/\s+/).slice(0, 2).join(' '))},` : 'Hello,';
  const storeLine = storeLabels && storeLabels.length
    ? `Your Checklane Hub lead access covers: <strong>${escapeHtml(storeLabels.join(', '))}</strong>.`
    : 'You have lead-level access to Checklane Hub for your assigned stores.';
  const subject = 'Checklane Hub — lead access';
  const safeLink = escapeHtml(link);
  const text = [
    greeting,
    '',
    'You have lead-level access to Checklane Hub for this reset cycle.',
    storeLabels && storeLabels.length
      ? `Stores: ${storeLabels.join(', ')}.`
      : 'Open the link below to sign in and pick your store.',
    'Use the link below to sign in. It is unique to you, expires in 30 days,',
    'and can only be used once. After signing in you stay signed in for 45 days on this device.',
    '',
    MOBILE_LINK_INSTRUCTIONS_TEXT,
    '',
    link,
    '',
    'If you were not expecting this, contact your supervisor.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">Checklane Hub — lead access</h2>
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">You have <strong>lead-level access</strong> to Checklane Hub for this reset cycle.
         ${storeLine}</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:14px;">The link is unique to you, expires in 30 days, and can only be used once.</p>
${MOBILE_LINK_INSTRUCTIONS_HTML}
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open Checklane Hub</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can&apos;t click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">If you were not expecting this, contact your supervisor. &mdash; Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, { explicit: 'tyson.gauthier@retailodyssey.com' });
  return resend.emails.send(payload);
}

async function sendHubTeamInviteEmail({
  to,
  cc,
  link,
  inviteeName,
  inviterName,
  inviterEmail,
  storeNumber,
}) {
  const storeLabel = storeNumber
    ? `Store ${String(storeNumber).replace(/\D/g, '').padStart(5, '0')}`
    : 'your store';
  const greeting = inviteeName ? `Hi ${escapeHtml(inviteeName)},` : 'Hello,';
  const subject = `Checklane assignments — sign in (${storeLabel})`;
  const safeLink = escapeHtml(link);
  const text = [
    greeting,
    '',
    `${inviterName || 'Your lead'} invited you to work Checklane sets on ${storeLabel}.`,
    'Use the link below to sign in and open your assignments. The link is unique to you,',
    'expires in 30 days, and can only be used once. After signing in you stay signed in',
    'for 45 days on this device.',
    '',
    MOBILE_LINK_INSTRUCTIONS_TEXT,
    '',
    link,
    '',
    'If you were not expecting this, contact your lead or supervisor.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">Checklane assignments</h2>
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;"><strong>${escapeHtml(inviterName || 'Your lead')}</strong> invited you to work Checklane sets on <strong>${escapeHtml(storeLabel)}</strong>.
         Open the link below to sign in and go straight to your assignments hub.</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:14px;">The link is unique to you, expires in 30 days, and can only be used once.</p>
${MOBILE_LINK_INSTRUCTIONS_HTML}
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open assignments</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can&apos;t click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">If you were not expecting this, contact your lead. &mdash; Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  addReplyTo(payload, { explicit: inviterEmail });
  return resend.emails.send(payload);
}

async function sendLinkEmail({ to, link }) {
  const subject = 'Your sign-in link for The Dump Bin';
  const text = [
    'Hello,',
    '',
    'Use the link below to sign in to The Dump Bin. One link signs you in to every',
    'Retail Odyssey tool on the site (EOD, claims, shirt orders, suncare lookup, etc.).',
    'It is unique to you, expires in 30 days, and can only be clicked once. Clicking',
    'it will keep you signed in for the next 45 days on this device.',
    '',
    MOBILE_LINK_INSTRUCTIONS_TEXT,
    '',
    link,
    '',
    'If you did not request this, you can ignore this message.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const safeLink = escapeHtml(link);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">Sign in to The Dump Bin</h2>
      <p style="margin:0 0 12px;">Use the button below to sign in. One link signs you in to every Retail Odyssey tool on the site (EOD cover sheet, claims, shirt orders, suncare lookup, and more).
         The link is unique to you, expires in 30 days, and can only be clicked once.
         After signing in you will stay signed in for the next 45 days on this device.</p>
${MOBILE_LINK_INSTRUCTIONS_HTML}
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Sign in</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can&apos;t click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">If you did not request this, you can ignore this message. &mdash; Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, {});
  return resend.emails.send(payload);
}

async function sendAdminInviteEmail({
  to,
  inviteUrl,
  note,
  invitedByEmail,
}) {
  const subject = 'You\'ve been invited as an admin for The Dump Bin';
  const noteBlock = note
    ? `\nNote from whoever invited you:\n${note}\n`
    : '';
  const byLine = invitedByEmail ? `\nInvitation sent by ${invitedByEmail}.\n` : '';
  const text = [
    'Hello,',
    '',
    'You\'ve been invited as an administrator for The Dump Bin (allowlist management, etc.).',
    'Open the link below (valid 7 days, one-time use). You will choose your password.',
    '',
    inviteUrl,
    '',
    `${byLine}${noteBlock}`,
    'If you did not expect this, ignore this email.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const safeUrl = escapeHtml(inviteUrl);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">You've been invited as an admin</h2>
      <p style="margin:0 0 12px;">You've been invited as an administrator for <strong>The Dump Bin</strong> (manage who may sign in, etc.). Click the button below — the link expires in seven days and can only be used once. You will choose your password on the next page.</p>
      ${invitedByEmail ? `<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Invitation sent by <strong>${escapeHtml(invitedByEmail)}</strong>.</p>` : ''}
      ${note ? `<p style="margin:0 0 12px;padding:12px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;"><span style="color:#6b7280;font-size:12px;display:block;margin-bottom:4px;">Note</span>${escapeHtml(note)}</p>` : ''}
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Accept invitation</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can't click the button? Paste this link:<br>${safeUrl}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">If you didn't expect this, you can ignore this message. \u2014 Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, { explicit: invitedByEmail });
  return resend.emails.send(payload);
}

async function sendAdminPasswordResetEmail({ to, resetUrl }) {
  const subject = 'Reset your Dump Bin admin password';
  const safeUrl = escapeHtml(resetUrl);
  const text = [
    'Hello,',
    '',
    'Someone requested a password reset for your Dump Bin administrator account.',
    'Open the secure link below. It expires in one hour.',
    '',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this message.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const html = `
    <p>Hello,</p>
    <p>Someone requested a password reset for your Dump Bin administrator account.
       Open the secure link below. It expires in <strong>one hour</strong>.</p>
    <p><a href="${safeUrl}">${safeUrl}</a></p>
    <p>If you did not request this, you can safely ignore this message.</p>
    <p>&mdash; Retail Odyssey</p>
  `;
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, {});
  return resend.emails.send(payload);
}

async function sendAccessApprovedEmail({ to, name, link }) {
  const subject = 'You\'re approved \u2014 The Dump Bin access';
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hello,';
  const safeLink = escapeHtml(link);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
      <p style="margin:0 0 12px;">Your access to The Dump Bin has been approved.</p>
      <p style="margin:0 0 12px;">Click the button below to sign in. The link is unique to you, expires in 30 days,
         and signs you in for 45 days on this device.</p>
${MOBILE_LINK_INSTRUCTIONS_HTML}
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Sign in</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can&apos;t click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">&mdash; Retail Odyssey</p>
    </div>
  `;
  const text = [
    greeting,
    '',
    'Your access to The Dump Bin has been approved.',
    'Use the link below to sign in. It is unique to you and expires in 30 days.',
    '',
    MOBILE_LINK_INSTRUCTIONS_TEXT,
    '',
    link,
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, {});
  return resend.emails.send(payload);
}

async function sendAccessRequestApprovalEmail({ record, approverEmail, approveUrl, denyUrl }) {
  const reasonRow = record.reason
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Reason / supervisor</td>
           <td style="padding:6px 0 6px 16px;font-size:14px;">${escapeHtml(record.reason)}</td></tr>`
    : '';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;padding:32px 16px;">
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;">
      <h2 style="margin:0 0 4px;color:#1a3a6e;font-size:18px;">Access request \u2014 The Dump Bin</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">Someone is asking for access to The Dump Bin (EOD, claims, suncare, and the other Retail Odyssey tools).</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Name</td>
          <td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;">${escapeHtml(record.name || '\u2014')}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Email</td>
          <td style="padding:6px 0 6px 16px;font-size:14px;">${escapeHtml(record.email)}</td>
        </tr>
        ${reasonRow}
      </table>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding-right:8px;">
            <a href="${escapeHtml(approveUrl)}"
               style="display:block;background:#15803d;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
              \u2713 Approve
            </a>
          </td>
          <td style="padding-left:8px;">
            <a href="${escapeHtml(denyUrl)}"
               style="display:block;background:#b91c1c;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
              \u2717 Deny
            </a>
          </td>
        </tr>
      </table>
      <p style="margin-top:16px;color:#9ca3af;font-size:12px;">
        Approve adds this person to the Dump Bin allowlist and sends them a sign-in link immediately.
      </p>
    </div></div>
  `;
  const text = [
    `Access request \u2014 The Dump Bin`,
    '',
    `Name: ${record.name || '\u2014'}`,
    `Email: ${record.email}`,
    record.reason ? `Reason: ${record.reason}` : '',
    '',
    `Approve: ${approveUrl}`,
    `Deny: ${denyUrl}`,
  ].filter((l) => l !== null).join('\n');
  const payload = {
    from: FROM,
    to: approverEmail,
    subject: `Dump Bin access request: ${record.name || record.email} (${record.email})`,
    text,
    html,
  };
  addReplyTo(payload, { explicit: record.email });
  return resend.emails.send(payload);
}

async function sendAccessRequestDenialEmail({ to, name }) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hello,';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
      <p style="margin:0 0 12px;">Your request to access The Dump Bin has been reviewed and was not approved at this time.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px;">If you believe this is an error, please contact your supervisor directly.</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">&mdash; Retail Odyssey</p>
    </div>
  `;
  const text = [
    greeting,
    '',
    'Your request to access The Dump Bin has been reviewed and was not approved at this time.',
    '',
    'If you believe this is an error, please contact your supervisor directly.',
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const payload = { from: FROM, to, subject: 'The Dump Bin \u2014 access request update', text, html };
  addReplyTo(payload, {});
  return resend.emails.send(payload);
}

async function sendAccessRequestOtherApproverEmail({ to, decidedBy, action, record }) {
  // Only used when there is >1 approver; with the current single-approver
  // configuration this stays callable but won't be invoked.
  const label = action === 'approve' ? 'approved' : 'denied';
  const outcomeColor = action === 'approve' ? '#15803d' : '#b91c1c';
  const outcomeBg    = action === 'approve' ? '#ecfdf5' : '#fef2f2';
  const outcomeBorder = action === 'approve' ? '#bbf7d0' : '#fecaca';
  const detail = action === 'approve'
    ? `A sign-in link was sent automatically to <strong>${escapeHtml(record.email)}</strong>.`
    : `<strong>${escapeHtml(record.name || record.email)}</strong> was notified that their request was not approved.`;
  const reasonRow = record.reason
    ? `<tr><td style="color:#6b7280;padding:4px 12px 4px 0;font-size:13px;vertical-align:top;">Reason</td><td style="font-size:14px;padding:4px 0;">${escapeHtml(record.reason)}</td></tr>`
    : '';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;padding:32px 16px;">
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;">
      <h2 style="margin:0 0 4px;color:#1a3a6e;font-size:18px;">Access request \u2014 The Dump Bin</h2>
      <div style="background:${outcomeBg};border:1px solid ${outcomeBorder};border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:14px;color:${outcomeColor};">
        <strong>${escapeHtml(decidedBy)}</strong> already <strong>${label}</strong> this request. ${detail}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;vertical-align:top;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(record.name || '\u2014')}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;vertical-align:top;">Email</td><td style="padding:4px 0;">${escapeHtml(record.email)}</td></tr>
        ${reasonRow}
      </table>
    </div></div>
  `;
  const text = [
    `[FYI] Dump Bin access request ${label}`,
    '',
    `${decidedBy} already ${label} this request. No action needed.`,
    '',
    `Name:  ${record.name || '\u2014'}`,
    `Email: ${record.email}`,
    record.reason ? `Reason: ${record.reason}` : '',
  ].filter((l) => l !== null).join('\n');
  const payload = {
    from: FROM,
    to,
    subject: `[FYI] Dump Bin access request ${label}: ${record.name || record.email}`,
    text,
    html,
  };
  addReplyTo(payload, { explicit: decidedBy });
  return resend.emails.send(payload);
}

function surfaceLabelFromId(surfaceId) {
  return String(surfaceId || 'Review')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function sendReviewLinkEmail({ to, surfaceId, periodWeek, reviewUrl }) {
  const surfaceLabel = surfaceLabelFromId(surfaceId);
  const weekSuffix = periodWeek ? ` — ${periodWeek}` : '';
  const subject = `${surfaceLabel} ready for review${weekSuffix}`;
  const safeLink = escapeHtml(reviewUrl);
  const text = [
    `${surfaceLabel}${periodWeek ? ` (${periodWeek})` : ''} is ready for your review.`,
    '',
    'Open the link below to review, edit, and approve or reject.',
    '',
    MOBILE_LINK_INSTRUCTIONS_TEXT,
    '',
    reviewUrl,
    '',
    '\u2014 Retail Odyssey',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">${escapeHtml(surfaceLabel)} ready for review</h2>
      <p style="margin:0 0 12px;">${periodWeek ? `<strong>${escapeHtml(periodWeek)}</strong> is` : 'This item is'} ready for your review, edits, and approval.</p>
${MOBILE_LINK_INSTRUCTIONS_HTML}
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open review</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can&apos;t click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">\u2014 Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  addReplyTo(payload, {});
  return resend.emails.send(payload);
}

module.exports = {
  sendLinkEmail,
  sendReviewLinkEmail,
  sendHubLeadAccessEmail,
  sendHubTeamInviteEmail,
  sendAdminInviteEmail,
  sendAdminPasswordResetEmail,
  sendAccessApprovedEmail,
  sendAccessRequestApprovalEmail,
  sendAccessRequestDenialEmail,
  sendAccessRequestOtherApproverEmail,
};
