'use strict';

/**
 * Helpers for the KOMPASS Help Desk ticket email flow.
 *
 * Sending pattern:
 *   From:     info@retail-odyssey.com (see lib/email-from.js)
 *   To:       kompass@retailodyssey.com
 *   CC:       shift lead + initiator + fixed Retail Odyssey team
 *   Reply-To: lead email (special-cased for Alexandra Wright)
 */

const { resolveResendReplyTo } = require('./resend-reply-to');
const { retailOdysseyFrom } = require('./email-from');
const { query } = require('./db');
const { loadEmployeeLookup, findEmployeeByHint } = require('./hub-supervisor-resolve');

const HELPDESK_TO = 'kompass@retailodyssey.com';
const HELPDESK_CC_FIXED = [
  'mashabranner@retailodyssey.com',
  'seth.newman@retailodyssey.com',
  'tyson.gauthier@retailodyssey.com',
];

// --- Test-phase routing -----------------------------------------------------
// While testing, redirect To away from the real help desk inbox. CC and
// Reply-To stay on the normal production spec (fixed team + initiator).
//   HELPDESK_TEST_MODE=off   → To = kompass@retailodyssey.com
//   HELPDESK_TEST_TO=<email> → override the test To inbox (default below)
const HELPDESK_TEST_TO = (process.env.HELPDESK_TEST_TO || 'tyson.gauthier@retailodyssey.com').trim();
const HELPDESK_TEST_MODE_OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

function isHelpdeskTestMode() {
  const raw = String(process.env.HELPDESK_TEST_MODE ?? 'off').trim().toLowerCase();
  return raw !== '' && !HELPDESK_TEST_MODE_OFF.has(raw);
}

/**
 * Resolve the To / CC / Reply-To for a help desk ticket.
 *
 * CC is always fixed Retail Odyssey team + initiator + shift lead (see buildHelpdeskCc).
 * Test mode only redirects To to HELPDESK_TEST_TO; CC/Reply-To are unchanged.
 */
function resolveHelpdeskRouting({ userName, userEmail, shiftLeadEmail, extraCc } = {}) {
  const cc = buildHelpdeskCc(userEmail, collectHelpdeskExtraCc({ shiftLeadEmail, extraCc }));
  if (isHelpdeskTestMode()) {
    return {
      testMode: true,
      to: HELPDESK_TEST_TO,
      cc,
      replyTo: resolveHelpdeskReplyTo({ userName, userEmail }),
    };
  }
  return {
    testMode: false,
    to: HELPDESK_TO,
    cc,
    replyTo: resolveHelpdeskReplyTo({ userName, userEmail }),
  };
}

// Alexandra Wright always uses a personal address for Reply-To so replies
// don't go to an FM inbox she cannot access.
const ALEXANDRA_WRIGHT_REPLY_TO = 'a.wrigh1470@gmail.com';

function buildHelpdeskFromAddress(_storeNumber, _categoryNumber) {
  return retailOdysseyFrom('KOMPASS Help Desk');
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

function normalizeHelpdeskEmail(value) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function collectHelpdeskExtraCc({ shiftLeadEmail, extraCc } = {}) {
  const extras = [];
  const lead = normalizeHelpdeskEmail(shiftLeadEmail);
  if (lead) extras.push(lead);
  if (Array.isArray(extraCc)) {
    for (const addr of extraCc) {
      const normalized = normalizeHelpdeskEmail(addr);
      if (normalized) extras.push(normalized);
    }
  }
  return extras;
}

function buildHelpdeskCc(userEmail, extraEmails = []) {
  const set = new Set(HELPDESK_CC_FIXED.map((e) => e.toLowerCase()));
  const initiator = normalizeHelpdeskEmail(userEmail);
  if (initiator) set.add(initiator);
  for (const addr of extraEmails) {
    const normalized = normalizeHelpdeskEmail(addr);
    if (normalized) set.add(normalized);
  }
  return [...set];
}

async function resolveSupervisorEmailForReporter(userEmail, { shiftVisitId } = {}) {
  const email = normalizeHelpdeskEmail(userEmail);
  if (!email) return null;

  const { rows } = await query(
    `SELECT sup.email AS supervisor_email
     FROM employees e
     LEFT JOIN employees sup ON sup.workday_id = e.supervisor_id
     WHERE LOWER(TRIM(e.email)) = $1
     LIMIT 1`,
    [email],
  );
  const direct = normalizeHelpdeskEmail(rows[0]?.supervisor_email);
  if (direct) return direct;

  const visitId = Number(shiftVisitId);
  if (!Number.isFinite(visitId)) return null;

  const { rows: schedRows } = await query(
    `SELECT s.supervisor, s.visit_lead
     FROM schedules s
     WHERE s.visit_id = $1
     ORDER BY s.scheduled_date DESC NULLS LAST
     LIMIT 1`,
    [visitId],
  );
  const sched = schedRows[0];
  if (!sched) return null;

  const lookup = await loadEmployeeLookup();
  const fromSupervisor = sched.supervisor
    ? findEmployeeByHint(sched.supervisor, lookup)?.email || null
    : null;
  if (fromSupervisor) return normalizeHelpdeskEmail(fromSupervisor);

  const fromLead = sched.visit_lead
    ? (() => {
        const lead = findEmployeeByHint(sched.visit_lead, lookup);
        if (!lead?.supervisorId) return null;
        const sup = lookup.byWorkday.get(lead.supervisorId);
        return sup?.email || null;
      })()
    : null;
  return normalizeHelpdeskEmail(fromLead);
}

/**
 * Resolve the shift lead inbox for a hub visit (hub assignment, then schedule).
 */
async function resolveShiftLeadEmailForVisit(visitIdNum) {
  if (!Number.isFinite(visitIdNum)) return null;
  const { rows } = await query(
    `SELECT hu.email AS hub_lead_email, e.email AS schedule_lead_email
     FROM schedules s
     LEFT JOIN employees e
       ON LOWER(TRIM(e.name)) = LOWER(TRIM(s.visit_lead))
       OR LOWER(TRIM(e.preferred_name)) = LOWER(TRIM(s.visit_lead))
     LEFT JOIN hub_store_assignments hsa
       ON hsa.store_number = regexp_replace(CAST(s.store_number AS TEXT), '^0+', '')
       AND hsa.store_role = 'lead'
     LEFT JOIN hub_users hu ON hu.id = hsa.user_id AND hu.is_active = true
     WHERE s.visit_id = $1
       AND s.project_id = $2
     ORDER BY s.scheduled_date DESC NULLS LAST
     LIMIT 1`,
    [visitIdNum, require('./hub-blitz-config').BLITZ_PROJECT_ID],
  );
  const row = rows[0];
  if (!row) return null;
  return row.hub_lead_email || row.schedule_lead_email || null;
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
 * Parse SAS planogram_id tokens.
 * Example: P06W3_8802771_D060_L00000_D03_C812_V866_F004_MX
 *   → dbkey 8802771, category 812, version V866, footage F004 (display 4).
 */
function formatFootageDisplayValue(footageToken) {
  if (!footageToken) return null;
  const token = String(footageToken).trim();
  const m = token.match(/^([FDI])(\d+)$/i);
  if (m) {
    const n = parseInt(m[2], 10);
    return n ? String(n) : null;
  }
  const digits = token.match(/(\d+)/);
  if (digits) {
    const n = parseInt(digits[1], 10);
    return n ? String(n) : null;
  }
  return token;
}

function formatFootageLabel(footageToken) {
  const display = formatFootageDisplayValue(footageToken);
  if (!display || !footageToken) return null;
  const kind = String(footageToken)[0].toUpperCase();
  if (kind === 'F') return `${display} ft`;
  if (kind === 'D') return `${display} doors`;
  if (kind === 'I') return `${display} in`;
  return display;
}

function extractFootageTokenFromPlanogram(planogramId) {
  const parts = String(planogramId || '').trim().split('_').filter(Boolean);
  if (parts.length < 2) return null;
  const storeType = parts[parts.length - 1];
  if (!/^[A-Z]{2}$/i.test(storeType)) return null;
  return parts[parts.length - 2] || null;
}

function extractFootageFromPlanogram(planogramId) {
  const token = extractFootageTokenFromPlanogram(planogramId);
  return formatFootageLabel(token);
}

function normalizeCategoryNumber(value) {
  if (value == null || value === '') return null;
  const n = parseInt(String(value).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? String(n) : String(value).trim();
}

function extractPlanogramMeta(planogramId) {
  const empty = {
    dbkey: null,
    categoryNumber: null,
    version: null,
    versionToken: null,
    footageToken: null,
    footage: null,
    footageDisplay: null,
  };
  if (!planogramId) return empty;
  const s = String(planogramId).trim();

  let dbkey = null;
  const head = s.match(/^P\d+W\d+_(\d+)_/i);
  if (head) dbkey = head[1];
  else if (/^\d+$/.test(s)) dbkey = s;

  const catM = s.match(/_C(\d+)_/i);
  const categoryNumber = catM ? normalizeCategoryNumber(catM[1]) : null;

  const verM = s.match(/_V([A-Z0-9]+)_/i);
  const versionToken = verM ? `V${verM[1]}` : null;
  const version = verM ? verM[1] : null;

  const footageToken = extractFootageTokenFromPlanogram(s);
  const footageDisplay = formatFootageDisplayValue(footageToken);
  const footage = formatFootageLabel(footageToken);

  return {
    dbkey,
    categoryNumber,
    version,
    versionToken,
    footageToken,
    footage,
    footageDisplay,
  };
}

function parseCategoryNameFromSetLabel(setLabel) {
  const raw = String(setLabel || '').trim();
  if (!raw) return null;
  const m = raw.match(/^\d+_(.+)$/);
  return m ? m[1].trim() : raw;
}

function mergeHelpdeskSetMeta({
  planogramId,
  setLabel,
  categoryNumber,
  categoryName,
  version,
  dbkey,
  footageToken,
  parsed = {},
}) {
  const fromPog = planogramId ? extractPlanogramMeta(planogramId) : parsed;
  const mergedCategory = normalizeCategoryNumber(categoryNumber) || fromPog.categoryNumber;
  const mergedName = (categoryName || '').trim() || parseCategoryNameFromSetLabel(setLabel);
  const mergedVersion = (version || '').trim().replace(/^V/i, '') || fromPog.version;
  const versionToken = fromPog.versionToken
    || (mergedVersion ? `V${mergedVersion}` : null);
  const mergedFootageToken = footageToken || fromPog.footageToken;

  return {
    dbkey: (dbkey || '').trim() || fromPog.dbkey,
    categoryNumber: mergedCategory,
    categoryName: mergedName || null,
    version: mergedVersion || null,
    versionToken,
    footageToken: mergedFootageToken || null,
    footageDisplay: formatFootageDisplayValue(mergedFootageToken) || fromPog.footageDisplay,
  };
}

const HELPDESK_DOC_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
]);

const HELPDESK_DOC_EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

const MAX_HELPDESK_PHOTOS = 12;
const MAX_HELPDESK_DOCUMENTS = 5;

function sanitizeHelpdeskFilename(name, fallback) {
  const base = String(name || fallback)
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return base || fallback;
}

function parseHelpdeskDataUrl(value, fallbackMime = 'application/octet-stream') {
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

/**
 * Build Resend attachment objects for help desk photos (inline CID) and documents.
 */
function buildHelpdeskAttachments(photos = [], documents = []) {
  const attachments = [];

  photos.forEach((photo, i) => {
    const { contentType, content } = parseHelpdeskDataUrl(photo, 'image/jpeg');
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    attachments.push({
      filename: `helpdesk_photo_${i + 1}.${ext}`,
      content,
      contentId: `helpdesk_${i}`,
      content_type: contentType,
    });
  });

  documents.forEach((doc, i) => {
    const name = sanitizeHelpdeskFilename(doc.name, `document_${i + 1}`);
    const fallbackMime = doc.mimeType || 'application/octet-stream';
    const { contentType, content } = parseHelpdeskDataUrl(doc.dataUrl || doc.content, fallbackMime);
    if (!HELPDESK_DOC_MIME_TYPES.has(contentType)) {
      const err = new Error(`Unsupported document type: ${contentType}`);
      err.statusCode = 400;
      throw err;
    }
    const ext = HELPDESK_DOC_EXT_BY_MIME[contentType];
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
    attachments.push({
      filename: hasExt ? name : `${name}.${ext || 'bin'}`,
      content,
      content_type: contentType,
    });
  });

  return attachments;
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
  documentNames,
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

  const docs = Array.isArray(documentNames) ? documentNames.filter(Boolean) : [];
  const documentsHtml =
    docs.length > 0
      ? `<p><strong>Supporting documents (${docs.length} attached):</strong></p><ul>${docs
          .map((name) => `<li>${escHtml(name)}</li>`)
          .join('')}</ul>`
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
${documentsHtml}
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
      `Attachments too large (${mb} MB). Please reduce photo/document count or size and try again.`
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
  resolveShiftLeadEmailForVisit,
  resolveSupervisorEmailForReporter,
  buildHelpdeskSubject,
  extractPlanogramMeta,
  extractFootageFromPlanogram,
  extractFootageTokenFromPlanogram,
  formatFootageDisplayValue,
  mergeHelpdeskSetMeta,
  buildHelpdeskHtml,
  buildHelpdeskAttachments,
  sanitizeHelpdeskFilename,
  enforceAttachmentBudget,
  estimateAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_HELPDESK_PHOTOS,
  MAX_HELPDESK_DOCUMENTS,
  HELPDESK_DOC_MIME_TYPES,
};
