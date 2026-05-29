'use strict';

/**
 * Helpers for the KOMPASS Help Desk ticket email flow.
 *
 * Sending pattern:
 *   From:     FM035_C1234@retail-odyssey.com
 *   To:       kompass@retail-odyssey.com
 *   CC:       lead + fixed Retail Odyssey team
 *   Reply-To: lead email (special-cased for Alexandra Wright)
 */

const { resolveResendReplyTo } = require('./resend-reply-to');

const HELPDESK_TO = 'kompass@retail-odyssey.com';
const HELPDESK_CC_FIXED = [
  'mashabranner@retailodyssey.com',
  'seth.newman@retailodyssey.com',
  'tyson.gauthier@retailodyssey.com',
];

// --- Test-phase routing -----------------------------------------------------
// While testing, KOMPASS help desk tickets must NOT reach the real help desk.
// Instead they go to a single test inbox, CC the person who initiated the
// ticket, and set Reply-To to that same initiator. Controlled by env so it can
// be flipped off for go-live without a code change:
//   HELPDESK_TEST_MODE=off   → normal delivery to kompass@retail-odyssey.com
//   HELPDESK_TEST_TO=<email> → override the test inbox (default below)
const HELPDESK_TEST_TO = (process.env.HELPDESK_TEST_TO || 'tyson.gauthier@retailodyssey.com').trim();
const HELPDESK_TEST_MODE_OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

function isHelpdeskTestMode() {
  const raw = String(process.env.HELPDESK_TEST_MODE ?? 'on').trim().toLowerCase();
  return raw !== '' && !HELPDESK_TEST_MODE_OFF.has(raw);
}

/**
 * Resolve the To / CC / Reply-To for a help desk ticket.
 *
 * In test mode: To = test inbox, CC = initiator, Reply-To = initiator.
 * In normal mode: To = KOMPASS, CC = fixed team + initiator, Reply-To resolved
 * from the initiator (special-cased for Alexandra Wright).
 */
function resolveHelpdeskRouting({ userName, userEmail } = {}) {
  const initiator = userEmail ? String(userEmail).trim() : '';
  if (isHelpdeskTestMode()) {
    return {
      testMode: true,
      to: HELPDESK_TEST_TO,
      cc: initiator ? [initiator] : [],
      replyTo: resolveHelpdeskReplyTo({ userEmail: initiator }),
    };
  }
  return {
    testMode: false,
    to: HELPDESK_TO,
    cc: buildHelpdeskCc(userEmail),
    replyTo: resolveHelpdeskReplyTo({ userName, userEmail }),
  };
}

// Alexandra Wright always uses a personal address for Reply-To so replies
// don't go to an FM inbox she cannot access.
const ALEXANDRA_WRIGHT_REPLY_TO = 'a.wrigh1470@gmail.com';

function buildHelpdeskFromAddress(storeNumber, categoryNumber) {
  const store = String(storeNumber).padStart(3, '0');
  return `FM${store}_C${categoryNumber}@retail-odyssey.com`;
}

function resolveHelpdeskReplyTo({ userName, userEmail } = {}) {
  if (userName && /alexandra\s+wright/i.test(String(userName).trim())) {
    return ALEXANDRA_WRIGHT_REPLY_TO;
  }
  if (
    userEmail &&
    String(userEmail).trim().toLowerCase() === 'alex.wright2@retailodyssey.com'
  ) {
    return ALEXANDRA_WRIGHT_REPLY_TO;
  }
  return resolveResendReplyTo({ userEmail });
}

function buildHelpdeskCc(userEmail) {
  const set = new Set(HELPDESK_CC_FIXED.map((e) => e.toLowerCase()));
  if (userEmail) set.add(String(userEmail).trim().toLowerCase());
  return [...set];
}

/**
 * Build the email subject.
 * Format: KOMPASS Help Desk FM035 C1234 [dbkey] [version] — <issueLabel>
 * dbkey and version are omitted when absent.
 */
function buildHelpdeskSubject({ storeNumber, categoryNumber, dbkey, version, issueLabel }) {
  const store = String(storeNumber).padStart(3, '0');
  const parts = [`KOMPASS Help Desk FM${store} C${categoryNumber}`];
  if (dbkey) parts.push(String(dbkey));
  if (version) parts.push(String(version));
  parts.push(`\u2014 ${issueLabel}`);
  return parts.join(' ');
}

/**
 * Parse the dbkey and version token from a SAS planogram_id.
 * Examples:
 *   "P04W2_8509659_D701_L00000_..." → { dbkey: "8509659", version: "D701" }
 *   "8509659"                       → { dbkey: "8509659", version: null }
 *   null / ""                       → { dbkey: null, version: null }
 */
function extractPlanogramMeta(planogramId) {
  if (!planogramId) return { dbkey: null, version: null };
  const s = String(planogramId).trim();
  // Full POG ID: P##W##_<dbkey>_<version>_...
  const full = s.match(/^P\d+W\d+_(\d+)_([A-Z]\d+)/);
  if (full) return { dbkey: full[1], version: full[2] };
  // Bare numeric dbkey
  if (/^\d+$/.test(s)) return { dbkey: s, version: null };
  return { dbkey: null, version: null };
}

/**
 * Build the HTML email body for a help desk ticket.
 * Photos are embedded as inline CIDs (helpdesk_0, helpdesk_1, …).
 */
function buildHelpdeskHtml({
  storeName,
  storeNumber,
  workDate,
  userName,
  userEmail,
  categoryName,
  categoryNumber,
  dbkey,
  version,
  issueTypeLabel,
  issueTemplateSentence,
  issueDetails,
  measurements,
  additionalNotes,
  photoCount,
  photoCaptions,
}) {
  const storeLine = storeName
    ? `FM${String(storeNumber).padStart(3, '0')} — ${storeName}`
    : `FM${String(storeNumber).padStart(3, '0')}`;

  const pogMeta = [
    dbkey ? `Planogram DB Key: <strong>${dbkey}</strong>` : '',
    version ? `Version: <strong>${version}</strong>` : '',
  ]
    .filter(Boolean)
    .join('<br>');

  const detailsText = [issueTemplateSentence, issueDetails].filter(Boolean).join(' ');

  const measurementsHtml = measurements
    ? `<p><strong>Measurements:</strong><br>${escHtml(measurements)}</p>`
    : '';

  const notesHtml = additionalNotes
    ? `<p><strong>Additional notes:</strong><br>${escHtml(additionalNotes)}</p>`
    : '';

  const captions = Array.isArray(photoCaptions) ? photoCaptions : [];
  const photosHtml =
    photoCount > 0
      ? Array.from({ length: photoCount })
          .map((_, i) => {
            const caption = captions[i] ? `<p style="font-size:12px;color:#666;">${escHtml(captions[i])}</p>` : '';
            return `<div style="margin-bottom:16px;"><img src="cid:helpdesk_${i}" style="max-width:100%;border:1px solid #ddd;"><br>${caption}</div>`;
          })
          .join('')
      : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#222;max-width:700px;margin:0 auto;">
<p>Hello KOMPASS Team,</p>
<p>Please see the following issue report submitted by a Retail Odyssey team member for your attention.</p>
<hr>
<p>
  <strong>Store:</strong> ${storeLine}<br>
  <strong>Date:</strong> ${escHtml(workDate || '')}<br>
  <strong>Reported by:</strong> ${escHtml(userName || '')}${userEmail ? ` (<a href="mailto:${escHtml(userEmail)}">${escHtml(userEmail)}</a>)` : ''}
</p>
<p>
  <strong>Category:</strong> ${escHtml(categoryName || '')} (C${categoryNumber})<br>
  ${pogMeta}
</p>
<p><strong>Issue:</strong> ${escHtml(issueTypeLabel || '')}</p>
${detailsText ? `<p><strong>Details:</strong><br>${escHtml(detailsText)}</p>` : ''}
${measurementsHtml}
${notesHtml}
${photoCount > 0 ? `<p><strong>Visual evidence (${photoCount} photo${photoCount !== 1 ? 's' : ''} attached):</strong></p>` : ''}
${photosHtml}
<p>Thank you for your assistance.</p>
<hr>
<p style="font-size:13px;color:#555;">
  ${escHtml(userName || '')}<br>
  Retail Odyssey<br>
  ${userEmail ? `<a href="mailto:${escHtml(userEmail)}">${escHtml(userEmail)}</a>` : ''}
</p>
</body>
</html>`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Estimate decoded byte size of an array of Resend attachment objects.
 * Each attachment.content is a base64 string; each base64 char ≈ 0.75 bytes.
 */
function estimateAttachmentBytes(attachments) {
  return attachments.reduce((sum, a) => {
    const b64 = typeof a.content === 'string' ? a.content : '';
    return sum + Math.floor(b64.length * 0.75);
  }, 0);
}

const MAX_ATTACHMENT_BYTES = 23 * 1024 * 1024; // 23 MB — 2 MB below the 25 MB target

/**
 * Throw a structured 413 error if attachments exceed the budget.
 */
function enforceAttachmentBudget(attachments) {
  const bytes = estimateAttachmentBytes(attachments);
  if (bytes > MAX_ATTACHMENT_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const err = new Error(
      `Attachments too large (${mb} MB). Please reduce photo count or quality and try again.`
    );
    err.statusCode = 413;
    throw err;
  }
}

module.exports = {
  HELPDESK_TO,
  HELPDESK_TEST_TO,
  isHelpdeskTestMode,
  resolveHelpdeskRouting,
  buildHelpdeskFromAddress,
  resolveHelpdeskReplyTo,
  buildHelpdeskCc,
  buildHelpdeskSubject,
  extractPlanogramMeta,
  buildHelpdeskHtml,
  enforceAttachmentBudget,
  estimateAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
};
