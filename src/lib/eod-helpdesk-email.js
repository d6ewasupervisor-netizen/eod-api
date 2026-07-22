'use strict';

const { resolveResendReplyTo } = require('./resend-reply-to');
const { extractPlanogramMeta, mergeHelpdeskSetMeta } = require('./helpdesk-email');

const EOD_HELPDESK_TO = (process.env.EOD_HELPDESK_TO || 'kompass@retailodyssey.com').trim();
const EOD_HELPDESK_FROM = (process.env.EOD_HELPDESK_FROM || 'reports@retail-odyssey.com').trim();

const RETAIL_ODYSSEY_TEAM_CC = [
  'mashabranner@retailodyssey.com',
  'seth.newman@retailodyssey.com',
  'tyson.gauthier@retailodyssey.com',
  'aiyana.natarisalazar@retailodyssey.com',
  'amanda.mathews@retailodyssey.com',
  'april.gauthier@retailodyssey.com',
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

function todayReportDateIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function formatFmStore(storeNumber) {
  const store = String(storeNumber || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').padStart(3, '0');
  return `FM${store}`;
}

function buildEodHelpdeskSubject(meta) {
  const parts = [formatFmStore(meta.storeNumber)];
  if (meta.categoryNumber) parts.push(`C${meta.categoryNumber}`);
  if (meta.versionToken) parts.push(meta.versionToken);
  else if (meta.version) parts.push(`V${meta.version}`);
  if (meta.footageToken) parts.push(String(meta.footageToken).toUpperCase());
  parts.push(formatMmDdYyyy(meta.reportDate));
  return parts.join(' ');
}

function buildEodHelpdeskBodyLines(meta) {
  const categoryLine =
    meta.categoryNumber && meta.categoryName
      ? `${meta.categoryNumber} - ${meta.categoryName}`
      : meta.categoryName || meta.categoryNumber || 'N/A';

  const lines = [
    `Date: ${formatMmDdYyyy(meta.reportDate)}`,
    `Issue type: ${meta.issueTypeLabel || 'N/A'}`,
    `Store: ${formatFmStore(meta.storeNumber)}`,
    `Category: ${categoryLine}`,
    `Version: ${meta.version || 'N/A'}`,
    `Footage/Doors: ${meta.footageDisplay || 'N/A'}`,
    `DBKey: ${meta.dbkey || 'N/A'}`,
    `Pictures: ${meta.photoCount > 0 ? String(meta.photoCount) : 'N/A'}`,
  ];

  const details = (meta.issueDetails || '').trim();
  if (details) lines.push(`Details: ${details}`);

  return lines;
}

function buildEodHelpdeskPlainText(meta) {
  const lines = buildEodHelpdeskBodyLines(meta);
  const signature = [
    '',
    'Thank you for your assistance.',
    '',
    meta.userName || '',
    'Retail Odyssey',
    meta.userEmail || '',
  ].filter((line, i) => i < 3 || line);

  return [
    'Hello, I would like to report the issue below:',
    '',
    ...lines,
    ...signature,
  ].join('\n');
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

function buildEodHelpdeskHtml(meta) {
  const lines = buildEodHelpdeskBodyLines(meta);
  const bodyHtml = lines.map((line) => escHtml(line)).join('<br>\n');

  const photosHtml =
    meta.photoCount > 0
      ? Array.from({ length: meta.photoCount })
          .map(
            (_, i) =>
              `<div style="margin-bottom:16px;"><img src="cid:eod_help_${i}" style="max-width:100%;border:1px solid #ddd;"></div>`,
          )
          .join('')
      : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#222;max-width:700px;margin:0 auto;">
<p>Hello, I would like to report the issue below:</p>
<p>${bodyHtml}</p>
${photosHtml ? `<p><strong>Attached photos:</strong></p>${photosHtml}` : ''}
<p>Thank you for your assistance.</p>
<p style="font-size:13px;color:#555;">
  ${escHtml(meta.userName || '')}<br>
  Retail Odyssey<br>
  ${meta.userEmail ? escHtml(meta.userEmail) : ''}
</p>
</body>
</html>`;
}

function normalizeEmail(value) {
  if (value == null || value === '') return null;
  const t = String(value).trim().toLowerCase();
  return t || null;
}

function buildEodHelpdeskCc({ userEmail, supervisorEmail, extraRecipients, addRetailOdysseyTeam }) {
  const set = new Set();
  const initiator = normalizeEmail(userEmail);
  if (initiator) set.add(initiator);
  const supervisor = normalizeEmail(supervisorEmail);
  if (supervisor && supervisor !== initiator) set.add(supervisor);
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

function resolveEodHelpdeskReportMeta(body) {
  const parsed = body.planogramId ? extractPlanogramMeta(body.planogramId) : {};
  const merged = mergeHelpdeskSetMeta({
    planogramId: body.planogramId,
    setLabel: body.setLabel,
    categoryNumber: body.categoryNumber,
    categoryName: body.categoryName,
    version: body.version,
    dbkey: body.dbkey,
    footageToken: body.footageToken,
    parsed,
  });

  return {
    storeNumber: body.storeNumber,
    reportDate: body.reportDate || todayReportDateIso(),
    issueTypeLabel: body.issueTypeLabel,
    issueDetails: body.issueDetails,
    userName: body.userName,
    userEmail: body.userEmail,
    photoCount: Array.isArray(body.photos) ? body.photos.length : 0,
    ...merged,
  };
}

module.exports = {
  EOD_HELPDESK_TO,
  EOD_HELPDESK_FROM,
  eodHelpdeskFromAddress,
  buildEodHelpdeskSubject,
  buildEodHelpdeskHtml,
  buildEodHelpdeskPlainText,
  buildEodHelpdeskAttachments,
  buildEodHelpdeskCc,
  resolveEodHelpdeskReplyTo,
  resolveEodHelpdeskReportMeta,
  formatMmDdYyyy,
  todayReportDateIso,
};
