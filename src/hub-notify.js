'use strict';

/**
 * Checklane Hub — operational email notifications (reopen complete, etc.).
 */

const { query } = require('./lib/db');
const { parseVisitId } = require('./hub-auth');
const {
  CHECKLANES_OPS_EMAIL,
  buildSetRelatedEmailPayload,
} = require('./lib/checklanes-email');
const { parsePogMeta, buildNisHelpdeskSubject } = require('./lib/pog-meta');
const { resolveNisSetMetadata } = require('./lib/hub-fixture-catalog');
const {
  buildHelpdeskFromAddress,
  buildHelpdeskSubject,
  resolveHelpdeskRouting,
  resolveShiftLeadEmailForVisit,
} = require('./lib/helpdesk-email');
const { addReplyTo } = require('./lib/resend-reply-to');
const { dispatchTrackedEmail } = require('./lib/resend-outbox');

let _resend = null;

function initHubNotify({ resend }) {
  _resend = resend;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resolveStore(visitIdNum) {
  const { rows } = await query(
    `SELECT store_number
     FROM schedules
     WHERE visit_id = $1
     ORDER BY (project_id = $2) DESC, scheduled_date DESC
     LIMIT 1`,
    [visitIdNum, require('./hub-blitz-config').BLITZ_PROJECT_ID],
  );
  if (!rows.length || rows[0].store_number == null) return null;
  const n = Number(rows[0].store_number);
  if (!Number.isFinite(n)) return String(rows[0].store_number);
  return String(n).padStart(5, '0');
}

async function sendSectionReopenEmail({
  visitId,
  store,
  lane,
  dbkey,
  priorState,
  reason,
  actor,
}) {
  if (!_resend) {
    return { sent: false, error: 'Hub notify not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  const storeLabel = store || (await resolveStore(visitIdNum)) || 'unknown';
  const actorLabel = actor.name || actor.email || `User #${actor.id}`;
  const subject =
    `[Checklanes reopen] Store ${storeLabel} · Lane ${lane || '—'} · DBKey ${dbkey}`;

  const priorLabel = priorState === 'not_in_store'
    ? 'Not in store'
    : priorState === 'signed_off'
      ? 'Signed off'
      : priorState;
  const reopenHeadline = priorState === 'not_in_store'
    ? 'Set reopened — was confirmed not in store'
    : 'Set reopened — was marked complete';

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;line-height:1.5;">
  <h2 style="margin:0 0 12px;font-size:18px;">${escHtml(reopenHeadline)}</h2>
  <p style="margin:0 0 8px;"><strong>Store:</strong> ${escHtml(storeLabel)}</p>
  <p style="margin:0 0 8px;"><strong>Visit:</strong> ${escHtml(String(visitIdNum))}</p>
  <p style="margin:0 0 8px;"><strong>Lane:</strong> ${escHtml(lane || '—')}</p>
  <p style="margin:0 0 8px;"><strong>DBKey:</strong> ${escHtml(dbkey)}</p>
  <p style="margin:0 0 8px;"><strong>Prior state:</strong> ${escHtml(priorLabel)}</p>
  <p style="margin:0 0 8px;"><strong>Reopened by:</strong> ${escHtml(actorLabel)} (${escHtml(actor.email || '')})</p>
  <p style="margin:16px 0 6px;font-weight:700;">Explanation</p>
  <p style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escHtml(reason)}</p>
  <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">The set is back in <strong>In progress</strong> so work can continue.</p>
</body></html>`;

  const payload = buildSetRelatedEmailPayload({
    to: CHECKLANES_OPS_EMAIL,
    subject,
    html,
    actorEmail: actor.email,
    replyToExplicit: actor.email,
  });

  const { data, error } = await dispatchTrackedEmail(_resend, {
    sourceType: 'hub-section-reopen',
    sourceRef: visitIdNum,
    sentByEmail: actor.email,
    metadata: { visitId: visitIdNum, store: storeLabel, lane, dbkey },
  }, payload);
  if (error) {
    console.error('[hub-notify] reopen email failed:', error.message || String(error));
    return { sent: false, error: error.message || String(error) };
  }

  return { sent: true, resendId: data?.id };
}

async function logHubEmail({
  visitIdNum,
  emailType,
  recipients,
  subject,
  bodySummary,
  resendId,
  sentBy,
}) {
  await query(
    `INSERT INTO email_log (visit_id, email_type, recipients, subject, body_summary, sent_by, resend_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [visitIdNum, emailType, recipients, subject, bodySummary, sentBy, resendId || null],
  );
}

function formatPerson(name, email) {
  const label = name || email || 'Unknown';
  return email && name ? `${name} (${email})` : label;
}

/** Map internal photo records to Resend attachment objects. */
function toResendAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  return attachments
    .filter((a) => a && a.content)
    .map((a) => ({
      filename: a.filename || 'photo.jpg',
      content: a.content,
      content_type: a.content_type || 'image/jpeg',
    }));
}

function photosNoteHtml(count) {
  if (!count) return '';
  return `<p style="margin:16px 0 0;color:#374151;font-size:13px;">${count} field photo${count !== 1 ? 's' : ''} attached.</p>`;
}

async function sendNisVerifiedEmail({
  visitId,
  store,
  dbkey,
  lane,
  payload,
  raiserName,
  raiserEmail,
  verifier,
  attachments,
}) {
  if (!_resend) {
    return { sent: false, error: 'Hub notify not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  const { storeNumber, payload: enrichedPayload } = await resolveNisSetMetadata({
    visitIdNum,
    lane,
    dbkey,
    payload,
  });
  const storeLabel =
    store || storeNumber || (await resolveStore(visitIdNum)) || 'unknown';
  const meta = parsePogMeta({
    manifestPogId: enrichedPayload?.manifest_pog_id,
    action: enrichedPayload?.action,
    dbkey,
  });
  const setName = enrichedPayload?.set_name || enrichedPayload?.summary || 'Not in store';
  const note = enrichedPayload?.note;

  const subjectStore = storeNumber || storeLabel;
  const subject = buildNisHelpdeskSubject({
    storeNumber: subjectStore,
    category: meta.category,
    version: meta.version,
    dbkey: meta.dbkey || dbkey,
  });

  const detailRows = [
    ['Store', storeLabel],
    ['Set', setName],
    ['Lane', lane || '—'],
    meta.category ? ['Category', `C${meta.category}`] : null,
    meta.version ? ['Version', `V${meta.version}`] : null,
    ['DBKey', meta.dbkey || dbkey || '—'],
    ['Visit', String(visitIdNum)],
    ['Raised by', formatPerson(raiserName, raiserEmail)],
    ['Verified by', formatPerson(verifier.name, verifier.email)],
  ].filter(Boolean);

  const detailsHtml = detailRows
    .map(
      ([label, value]) =>
        `<p style="margin:0 0 8px;"><strong>${escHtml(label)}:</strong> ${escHtml(value)}</p>`,
    )
    .join('');

  const noteHtml = note
    ? `<p style="margin:16px 0 6px;font-weight:700;">Note from field</p>
       <p style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escHtml(note)}</p>`
    : '';

  const resendAttachments = toResendAttachments(attachments);
  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;line-height:1.5;">
  <h2 style="margin:0 0 12px;font-size:18px;">Not in store — verified by lead</h2>
  <p style="margin:0 0 12px;color:#374151;">A supervisor or lead confirmed this set is not present in the store.</p>
  ${detailsHtml}
  ${noteHtml}
  ${photosNoteHtml(resendAttachments ? resendAttachments.length : 0)}
</body></html>`;

  const to = CHECKLANES_OPS_EMAIL;
  const emailPayload = buildSetRelatedEmailPayload({
    to,
    subject,
    html,
    actorEmail: verifier.email,
    replyToExplicit: verifier.email,
  });
  if (resendAttachments) emailPayload.attachments = resendAttachments;

  const { data, error } = await dispatchTrackedEmail(_resend, {
    sourceType: 'hub-nis-verified',
    sourceRef: visitIdNum,
    sentByEmail: verifier.email,
    metadata: { visitId: visitIdNum, dbkey, subject },
  }, emailPayload);
  if (error) {
    console.error('[hub-notify] NIS verify email failed:', error.message || String(error));
    return { sent: false, error: error.message || String(error), subject };
  }

  const recipients = [to];
  if (emailPayload.cc) recipients.push(...emailPayload.cc);

  await logHubEmail({
    visitIdNum,
    emailType: 'nis_verified',
    recipients,
    subject,
    bodySummary: setName,
    resendId: data?.id,
    sentBy: verifier.id,
  });

  return { sent: true, resendId: data?.id, subject };
}

async function sendHelpVerifiedEmail({
  visitId,
  store,
  dbkey,
  lane,
  payload,
  raiserName,
  raiserEmail,
  verifier,
  attachments,
}) {
  if (!_resend) {
    return { sent: false, error: 'Hub notify not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  const { storeNumber, payload: enrichedPayload } = await resolveNisSetMetadata({
    visitIdNum,
    lane,
    dbkey,
    payload,
  });
  const storeLabel =
    store || storeNumber || (await resolveStore(visitIdNum)) || 'unknown';
  const meta = parsePogMeta({
    manifestPogId: enrichedPayload?.manifest_pog_id,
    action: enrichedPayload?.action,
    dbkey,
  });
  const issueLabel =
    enrichedPayload?.custom_label ||
    enrichedPayload?.issue_type_label ||
    'Needs assistance';
  const issueDetails = enrichedPayload?.issue_details;
  const note = enrichedPayload?.note;
  const setName = enrichedPayload?.set_name;

  const subjectStore = storeNumber || storeLabel;
  const categoryNumber = meta.category || '0000';
  const subject = buildHelpdeskSubject({
    storeNumber: subjectStore,
    categoryNumber,
    dbkey: meta.dbkey || dbkey,
    version: meta.version,
    issueLabel,
  });

  const detailRows = [
    ['Store', storeLabel],
    setName ? ['Set', setName] : null,
    ['Lane', lane || '—'],
    meta.category ? ['Category', `C${meta.category}`] : null,
    meta.version ? ['Version', `V${meta.version}`] : null,
    ['DBKey', meta.dbkey || dbkey || '—'],
    ['Visit', String(visitIdNum)],
    ['Issue type', issueLabel],
    ['Raised by', formatPerson(raiserName, raiserEmail)],
    ['Verified by', formatPerson(verifier.name, verifier.email)],
  ].filter(Boolean);

  const detailsHtml = detailRows
    .map(
      ([label, value]) =>
        `<p style="margin:0 0 8px;"><strong>${escHtml(label)}:</strong> ${escHtml(value)}</p>`,
    )
    .join('');

  const issueHtml = issueDetails
    ? `<p style="margin:16px 0 6px;font-weight:700;">Issue details</p>
       <p style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escHtml(issueDetails)}</p>`
    : '';

  const noteHtml = note
    ? `<p style="margin:16px 0 6px;font-weight:700;">Additional notes</p>
       <p style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escHtml(note)}</p>`
    : '';

  const resendAttachments = toResendAttachments(attachments);
  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;line-height:1.5;">
  <h2 style="margin:0 0 12px;font-size:18px;">KOMPASS Help Desk — verified by lead</h2>
  <p style="margin:0 0 12px;color:#374151;">A supervisor or lead confirmed this help request and forwarded it to the help desk.</p>
  ${detailsHtml}
  ${issueHtml}
  ${noteHtml}
  ${photosNoteHtml(resendAttachments ? resendAttachments.length : 0)}
</body></html>`;

  const from = buildHelpdeskFromAddress(subjectStore, categoryNumber);
  const shiftLeadEmail = await resolveShiftLeadEmailForVisit(visitIdNum);
  const routing = resolveHelpdeskRouting({
    userName: raiserName,
    userEmail: raiserEmail,
    shiftLeadEmail,
    extraCc: verifier?.email ? [verifier.email] : [],
  });
  const replyTo = routing.replyTo;
  const cc = routing.cc;

  const emailPayload = {
    from,
    to: routing.to,
    cc,
    subject,
    html,
  };
  addReplyTo(emailPayload, { explicit: replyTo, userEmail: raiserEmail });
  if (resendAttachments) emailPayload.attachments = resendAttachments;

  const { data, error } = await dispatchTrackedEmail(_resend, {
    sourceType: 'hub-helpdesk-verified',
    sourceRef: visitIdNum,
    sentByEmail: verifier.email,
    metadata: { visitId: visitIdNum, dbkey, issueLabel, subject },
  }, emailPayload);
  if (error) {
    console.error('[hub-notify] help verify email failed:', error.message || String(error));
    return { sent: false, error: error.message || String(error), subject };
  }

  const recipients = [routing.to, ...cc];

  await logHubEmail({
    visitIdNum,
    emailType: 'help_verified',
    recipients,
    subject,
    bodySummary: issueLabel,
    resendId: data?.id,
    sentBy: verifier.id,
  });

  return { sent: true, resendId: data?.id, subject };
}

async function sendProdDispatchReviewEmail({
  request,
  photos,
  reviewUrl,
  signedOffBy,
}) {
  if (!_resend) {
    return { sent: false, error: 'Hub notify not initialized' };
  }

  const storeLabel = request.store_number || 'unknown';
  const setLabel = request.set_name || request.dbkey;
  const subject =
    `[Checklanes PROD review] Store ${storeLabel} · Lane ${request.lane || '—'} · ${setLabel}`;

  const detailRows = [
    ['Store', storeLabel],
    ['Visit', String(request.visit_id)],
    ['Lane', request.lane || '—'],
    ['DBKey', request.dbkey],
    request.set_name ? ['Set', request.set_name] : null,
    request.manifest_pog_id ? ['Manifest POG', request.manifest_pog_id] : null,
    request.action_code ? ['Action', request.action_code] : null,
    ['Signed off by', formatPerson(signedOffBy?.name, signedOffBy?.email)],
    ['Bay photos', String(photos?.length || 0)],
  ].filter(Boolean);

  const detailsHtml = detailRows
    .map(
      ([label, value]) =>
        `<p style="margin:0 0 8px;"><strong>${escHtml(label)}:</strong> ${escHtml(value)}</p>`,
    )
    .join('');

  const resendAttachments = toResendAttachments(
    (photos || []).map((p, i) => ({
      filename: `bay-${p.bay_num || i + 1}.jpg`,
      content: p.base64,
      content_type: p.content_type || 'image/jpeg',
    })),
  );

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;line-height:1.5;">
  <h2 style="margin:0 0 12px;font-size:18px;">PROD photo upload — approval needed</h2>
  <p style="margin:0 0 12px;color:#374151;">A lead signed off a Checklanes set. Review the bay photos and approve or deny uploading them to the matching PROD category reset.</p>
  ${detailsHtml}
  ${photosNoteHtml(resendAttachments ? resendAttachments.length : 0)}
  <p style="margin:20px 0 0;">
    <a href="${escHtml(reviewUrl)}" style="display:inline-block;background:#0d4f8b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Review photos &amp; approve/deny</a>
  </p>
  <p style="margin:12px 0 0;color:#6b7280;font-size:13px;">Link expires in 24 hours.</p>
</body></html>`;

  const to = (
    process.env.HUB_PROD_DISPATCH_APPROVER ||
    process.env.CHECKLANES_OPS_EMAIL ||
    'tyson.gauthier@retailodyssey.com'
  ).trim().toLowerCase();
  const emailPayload = buildSetRelatedEmailPayload({
    to,
    subject,
    html,
    actorEmail: signedOffBy?.email,
    replyToExplicit: signedOffBy?.email,
  });
  if (resendAttachments) emailPayload.attachments = resendAttachments;

  const { data, error } = await dispatchTrackedEmail(_resend, {
    sourceType: 'hub-prod-dispatch',
    sourceRef: visitIdNum,
    sentByEmail: signedOffBy?.email,
    metadata: { visitId: visitIdNum, dbkey: request.dbkey, subject },
  }, emailPayload);
  if (error) {
    console.error('[hub-notify] PROD dispatch email failed:', error.message || String(error));
    return { sent: false, error: error.message || String(error), subject };
  }

  return { sent: true, resendId: data?.id, subject };
}

module.exports = {
  initHubNotify,
  sendSectionReopenEmail,
  sendNisVerifiedEmail,
  sendHelpVerifiedEmail,
  sendProdDispatchReviewEmail,
};
