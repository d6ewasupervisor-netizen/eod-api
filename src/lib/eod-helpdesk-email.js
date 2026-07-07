'use strict';

const { resolveResendReplyTo } = require('./resend-reply-to');

const EOD_HELPDESK_TO = (process.env.EOD_HELPDESK_TO || 'tgauthier2011@gmail.com').trim();
const EOD_HELPDESK_FROM = (process.env.EOD_HELPDESK_FROM || 'reports@retail-odyssey.com').trim();

const RETAIL_ODYSSEY_TEAM_CC = [
  'mashabranner@retailodyssey.com',
  'seth.newman@retailodyssey.com',
  'tyson.gauthier@retailodyssey.com',
  'aiyana.natarisalazar@retailodyssey.com',
  'amanda.mathews@retailodyssey.com',
];

function eodHelpdeskFromAddress() {
  const mailbox = EOD_HELPDESK_FROM;
  if (/<[^>]+>/.test(mailbox)) return mailbox;
  return `KOMPASS Reports <${mailbox}>`;
}

function formatMmDdYyyy(isoOrUs) {
  const s = String(isoOrUs || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${m}/${d}/${y}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  }
  return s || '';
}

function buildEodHelpdeskSubject({ storeNumber, categoryNumber, version, workDate }) {
  const store = String(storeNumber).replace(/\D/g, '').replace(/^0+(?=\d)/, '').padStart(3, '0');
  const parts = [`FM${store}`];
  if (categoryNumber != null && String(categoryNumber).trim() !== '') {
    parts.push(`C${String(categoryNumber).trim()}`);
  }
  if (version != null && String(version).trim() !== '') {
    parts.push(`V${String(version).trim()}`);
  }
  parts.push(formatMmDdYyyy(workDate));
  return parts.join(' ');
}

function buildEodHelpdeskGreeting({ storeNumber, issueTypeId, setLabel, issueDetails, customIssue }) {
  const store = String(storeNumber).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const setName = setLabel || customIssue || 'the reported set';
  const templates = {
    not_in_store: `Hello, store ${store} is missing the following set: ${setName}.`,
    missing_fixture: `Hello, store ${store} is missing a fixture needed for set ${setName}.`,
    reverse_flow: `Hello, the flow of set ${setName} at store ${store} is reversed compared to what is currently in the store.`,
    incorrect_version: `Hello, store ${store} received the wrong planogram version for set ${setName}.`,
    incorrect_footage: `Hello, set ${setName} at store ${store} is the wrong footage — the materials we received do not match what is in the store.`,
    incorrect_planogram: `Hello, store ${store} received an incorrect planogram for set ${setName}.`,
    obstruction: `Hello, set ${setName} at store ${store} is obstructed by a permanent store feature (pole, case, or similar).`,
    missing_hardware: `Hello, store ${store} is missing hardware required for set ${setName}.`,
    custom: `Hello, store ${store} has reported the following issue regarding ${setName}.`,
  };
  const base = templates[issueTypeId] || templates.custom;
  const extra = (issueDetails || '').trim();
  return extra ? `${base} ${extra}` : base;
}

function parseHelpdeskDataUrl(value, fallbackMime = 'image/jpeg') {
  const raw = String(value || '');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return {
      contentType: fallbackMime,
      content: raw.replace(/^data:[^;]+;base64,/, ''),
    };
  }
  return {
    contentType: match[1] || fallbackMime,
    content: match[2],
  };
}

function buildEodHelpdeskAttachments(photos = []) {
  return (photos || []).map((photo, i) => {
    const { contentType, content } = parseHelpdeskDataUrl(photo, 'image/jpeg');
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return {
      filename: `issue_photo_${i + 1}.${ext}`,
      content,
      contentId: `eod_help_${i}`,
      content_type: contentType,
    };
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEodHelpdeskHtml({
  greeting,
  storeNumber,
  workDate,
  shiftLabel,
  setLabel,
  issueTypeLabel,
  issueDetails,
  additionalDetails,
  userName,
  userEmail,
  photoCount,
}) {
  const photosHtml =
    photoCount > 0
      ? Array.from({ length: photoCount })
          .map(
            (_, i) =>
              `<div style="margin-bottom:16px;"><img src="cid:eod_help_${i}" style="max-width:100%;border:1px solid #ddd;"></div>`,
          )
          .join('')
      : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#222;max-width:700px;margin:0 auto;">
<p>${escHtml(greeting)}</p>
<p>
  <strong>Store:</strong> FM${escHtml(String(storeNumber).padStart(3, '0'))}<br>
  <strong>Date:</strong> ${escHtml(formatMmDdYyyy(workDate))}<br>
  <strong>Shift:</strong> ${escHtml(shiftLabel || 'N/A')}<br>
  <strong>Set:</strong> ${escHtml(setLabel || 'N/A')}<br>
  <strong>Issue type:</strong> ${escHtml(issueTypeLabel || '')}<br>
  <strong>Reported by:</strong> ${escHtml(userName || '')}${userEmail ? ` (${escHtml(userEmail)})` : ''}
</p>
${issueDetails ? `<p><strong>Details:</strong><br>${escHtml(issueDetails)}</p>` : ''}
${additionalDetails ? `<p><strong>Additional notes:</strong><br>${escHtml(additionalDetails)}</p>` : ''}
${photoCount > 0 ? `<p><strong>Photos (${photoCount}):</strong></p>${photosHtml}` : ''}
<p>Thank you for your assistance.</p>
<p style="font-size:13px;color:#555;">
  ${escHtml(userName || '')}<br>
  Retail Odyssey<br>
  ${userEmail ? escHtml(userEmail) : ''}
</p>
</body>
</html>`;
}

function normalizeEmail(value) {
  if (value == null || value === '') return null;
  const t = String(value).trim().toLowerCase();
  return t || null;
}

function buildEodHelpdeskCc({ userEmail, extraRecipients, addRetailOdysseyTeam }) {
  const set = new Set();
  const initiator = normalizeEmail(userEmail);
  if (initiator) set.add(initiator);
  if (Array.isArray(extraRecipients)) {
    for (const addr of extraRecipients) {
      const n = normalizeEmail(addr);
      if (n) set.add(n);
    }
  }
  if (addRetailOdysseyTeam) {
    for (const addr of RETAIL_ODYSSEY_TEAM_CC) set.add(addr);
  }
  return [...set];
}

function resolveEodHelpdeskReplyTo(userEmail) {
  return resolveResendReplyTo({ userEmail });
}

module.exports = {
  EOD_HELPDESK_TO,
  EOD_HELPDESK_FROM,
  eodHelpdeskFromAddress,
  buildEodHelpdeskSubject,
  buildEodHelpdeskGreeting,
  buildEodHelpdeskAttachments,
  buildEodHelpdeskHtml,
  buildEodHelpdeskCc,
  resolveEodHelpdeskReplyTo,
  formatMmDdYyyy,
};
