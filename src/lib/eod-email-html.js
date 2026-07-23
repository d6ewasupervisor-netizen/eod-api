'use strict';

/**
 * Branded HTML wrapper for KOMPASS EOD emails.
 * Outlook-safe table layout, Retail Odyssey colors, hosted logo.
 */

const LOGO_URL = 'https://the-dump-bin.com/welcome/assets/retail-odyssey-banner.png';

const BRAND = {
  navy: '#0E2A47',
  accent: '#2F6FB0',
  accentSoft: '#E8F1F8',
  border: '#BFD6EC',
  text: '#1C2733',
  muted: '#5A6B7D',
  white: '#FFFFFF',
  rowAlt: '#F5F9FC',
  success: '#0F766E',
  warn: '#B45309',
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ynTone(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'true') return BRAND.success;
  if (v === 'no' || v === 'n' || v === 'false') return BRAND.warn;
  return BRAND.text;
}

function displayValue(value) {
  const s = String(value ?? '').trim();
  return s || '—';
}

function row(label, value, { alt = false, emphasize = false } = {}) {
  const bg = alt ? BRAND.rowAlt : BRAND.white;
  const color = emphasize ? ynTone(value) : BRAND.text;
  const weight = emphasize ? '600' : '400';
  return `<tr>
    <td style="background:${bg};border:1px solid ${BRAND.border};padding:10px 12px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;color:${BRAND.navy};font-weight:600;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="background:${bg};border:1px solid ${BRAND.border};padding:10px 12px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;color:${color};font-weight:${weight};vertical-align:top;white-space:pre-wrap;word-break:break-word;">${escapeHtml(displayValue(value))}</td>
  </tr>`;
}

function notesBlock(notes) {
  const text = String(notes || '').trim();
  if (!text) return '';
  return `<tr><td colspan="2" style="background:${BRAND.white};border:1px solid ${BRAND.border};padding:12px 14px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;color:${BRAND.text};">
    <div style="font-weight:700;color:${BRAND.navy};margin:0 0 6px;">Notes</div>
    <div style="white-space:pre-wrap;word-break:break-word;line-height:1.45;">${escapeHtml(text)}</div>
  </td></tr>`;
}

/**
 * Build a structured report table from either an explicit `report` object
 * or a legacy plain-text `body` (Lead Name: …\\nDate: …).
 */
function normalizeReport(report, body) {
  if (report && typeof report === 'object') {
    return {
      leadName: report.leadName,
      date: report.date,
      storeNumber: report.storeNumber,
      beforeTaken: report.beforeTaken,
      checkInManager: report.checkInManager,
      instaworkSupport: report.instaworkSupport,
      calledHelpDesk: report.calledHelpDesk,
      commodities: report.commodities,
      issue: report.issue,
      issueResolved: report.issueResolved,
      tempSolution: report.tempSolution,
      checkOutManager: report.checkOutManager,
      signedOutProd: report.signedOutProd,
      signedOutSi: report.signedOutSi,
      notInStore: report.notInStore,
      notInSi: report.notInSi,
      afterTaken: report.afterTaken,
      signoffDone: report.signoffDone,
      signoffCount: report.signoffCount,
      notes: report.notes,
    };
  }

  const parsed = {};
  String(body || '').split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    const map = {
      'lead name': 'leadName',
      date: 'date',
      'store number': 'storeNumber',
      'before picture of kompass cart taken': 'beforeTaken',
      'manager checked in with': 'checkInManager',
      'instawork support': 'instaworkSupport',
      'called kompass help desk': 'calledHelpDesk',
      commodities: 'commodities',
      issue: 'issue',
      'issue resolved': 'issueResolved',
      'temporary solution': 'tempSolution',
      'manager checked out with': 'checkOutManager',
      'signed out in prod': 'signedOutProd',
      'signed out in si': 'signedOutSi',
      'not in store': 'notInStore',
      'not in si': 'notInSi',
      'after picture of kompass cart taken': 'afterTaken',
      'sign-off sheets photographed': 'signoffDone',
      'number of sign-off photos': 'signoffCount',
    };
    if (map[key]) parsed[map[key]] = val;
  });
  // Notes are multi-line after "Notes:"
  const notesMatch = String(body || '').match(/Notes:\s*\n?([\s\S]*)$/i);
  if (notesMatch) parsed.notes = notesMatch[1].trim();
  return parsed;
}

function buildReportTable(report) {
  const r = report || {};
  const rows = [
    row('Lead name', r.leadName, { alt: false }),
    row('Date', r.date, { alt: true }),
    row('Store number', r.storeNumber, { alt: false }),
    row('Before picture of KOMPASS cart', r.beforeTaken, { alt: true, emphasize: true }),
    row('Manager checked in with', r.checkInManager, { alt: false }),
    row('InstaWork support', r.instaworkSupport, { alt: true, emphasize: true }),
    row('Called KOMPASS Help Desk', r.calledHelpDesk, { alt: false, emphasize: true }),
    row('Commodities', r.commodities, { alt: true }),
    row('Issue', r.issue, { alt: false }),
    row('Issue resolved', r.issueResolved, { alt: true, emphasize: true }),
    row('Temporary solution', r.tempSolution, { alt: false }),
    row('Manager checked out with', r.checkOutManager, { alt: true }),
    row('Signed out in PROD', r.signedOutProd, { alt: false, emphasize: true }),
    row('Signed out in SI', r.signedOutSi, { alt: true, emphasize: true }),
    row('Not in store', r.notInStore, { alt: false }),
    row('Not in SI', r.notInSi, { alt: true }),
    row('After picture of KOMPASS cart', r.afterTaken, { alt: false, emphasize: true }),
    row('Sign-off sheets photographed', r.signoffDone, { alt: true, emphasize: true }),
    row('Number of sign-off photos', r.signoffCount, { alt: false }),
  ];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
    ${rows.join('')}
    ${notesBlock(r.notes)}
  </table>`;
}

function buildEodEmailHtml({
  body,
  report,
  userName,
  userEmail,
  pdfUrl,
  pdfFilename,
  signoffUrls,
  linkTtlDays,
  testMode,
  storeNumber,
}) {
  const ttl = linkTtlDays != null ? Number(linkTtlDays) : 30;
  const ttlNote = Number.isFinite(ttl) && ttl > 0 ? ttl : 30;
  const normalized = normalizeReport(report, body);
  const storeLabel = escapeHtml(
    String(normalized.storeNumber || storeNumber || '').replace(/^0+/, '') || '—'
  );
  const dateLabel = escapeHtml(displayValue(normalized.date));
  const testBanner = testMode
    ? `<tr><td style="padding:10px 24px;background:#FEF3C7;border-bottom:1px solid #F59E0B;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:13px;color:#92400E;">
        <strong>TEST MODE</strong> — this EOD was redirected to the tester inbox only.
      </td></tr>`
    : '';

  const pdfSection = pdfUrl
    ? `<tr><td style="padding:0 24px 14px 24px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;">
        <a href="${escapeHtml(pdfUrl)}" style="display:inline-block;background:${BRAND.accent};color:${BRAND.white};text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:700;">
          Download EOD PDF${pdfFilename ? ` · ${escapeHtml(pdfFilename)}` : ''}
        </a>
      </td></tr>`
    : '';

  const signoffs = Array.isArray(signoffUrls) ? signoffUrls : [];
  const photoSection = signoffs.length
    ? `<tr><td style="padding:8px 24px 6px 24px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${BRAND.navy};">Sign-off sheets</td></tr>
       <tr><td style="padding:0 24px 18px 24px;">
         ${signoffs.map((item, i) => `
           <div style="margin:0 0 14px;">
             <div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};margin:0 0 4px;">${escapeHtml(item.filename || `signoff_${i + 1}`)}</div>
             <img src="${escapeHtml(item.url)}" alt="Sign-off sheet ${i + 1}" style="max-width:100%;border:1px solid ${BRAND.border};border-radius:6px;display:block;">
           </div>`).join('')}
       </td></tr>`
    : '';

  const signature = (userName || userEmail)
    ? `<tr><td style="padding:18px 24px 24px 24px;border-top:1px solid ${BRAND.border};font-family:Calibri,Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.5;">
        ${userName ? `<strong style="color:${BRAND.navy};">${escapeHtml(userName)}</strong><br>` : ''}
        Retail Odyssey<br>
        ${userEmail ? `<a href="mailto:${escapeHtml(userEmail)}" style="color:${BRAND.accent};text-decoration:none;">${escapeHtml(userEmail)}</a>` : ''}
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EEF3F8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF3F8;padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:${BRAND.white};border:1px solid ${BRAND.border};border-radius:10px;overflow:hidden;">
        <tr><td style="padding:16px 20px;background:${BRAND.white};border-bottom:3px solid ${BRAND.accent};">
          <img src="${LOGO_URL}" alt="The Retail Odyssey Company" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
        </td></tr>
        ${testBanner}
        <tr><td style="padding:22px 24px 6px 24px;font-family:Calibri,Arial,Helvetica,sans-serif;">
          <div style="font-size:22px;font-weight:700;color:${BRAND.navy};letter-spacing:0.02em;">KOMPASS End of Day</div>
          <div style="margin-top:4px;font-size:14px;color:${BRAND.muted};">Store #${storeLabel} · ${dateLabel}</div>
        </td></tr>
        <tr><td style="padding:10px 24px 16px 24px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.45;">
          Photos and the EOD PDF are hosted links (no sign-in). Links stay valid for <strong style="color:${BRAND.navy};">${ttlNote} days</strong>.
        </td></tr>
        ${pdfSection}
        <tr><td style="padding:4px 24px 8px 24px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${BRAND.navy};">Shift summary</td></tr>
        <tr><td style="padding:0 24px 18px 24px;">
          ${buildReportTable(normalized)}
        </td></tr>
        ${photoSection}
        ${signature}
        <tr><td style="padding:12px 24px;background:${BRAND.accentSoft};font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11px;color:${BRAND.muted};text-align:center;">
          Sent via The Dump Bin · Retail Odyssey KOMPASS EOD
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = {
  buildEodEmailHtml,
  normalizeReport,
  LOGO_URL,
  BRAND,
};
