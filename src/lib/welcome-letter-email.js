'use strict';

const LOGO_URL = 'https://the-dump-bin.com/welcome/assets/retail-odyssey-banner.png';

const FROM_ADDRESS = 'Tyson Gauthier <tyson.gauthier@retail-odyssey.com>';
const REPLY_TO = 'tyson.gauthier@retailodyssey.com';
const CC_ADDRESSES = [
  'tyson.gauthier@retailodyssey.com',
  'aiyana.natarisalazar@retailodyssey.com',
];
const SUBJECT = 'Welcome to Retail Odyssey from your supervisor!';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeFirstName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function validateWelcomeLetterInput({ firstName, email } = {}) {
  const name = normalizeFirstName(firstName);
  const addr = normalizeEmail(email);
  const errors = [];
  if (!name) errors.push('First name is required');
  else if (name.length > 80) errors.push('First name is too long');
  if (!addr) errors.push('Email address is required');
  else if (!EMAIL_RE.test(addr) || addr.length > 254) errors.push('Email address is invalid');
  return { ok: errors.length === 0, errors, firstName: name, email: addr };
}

function link(href, label) {
  return `<a href="${escapeHtml(href)}" style="color:#2F6FB0;text-decoration:underline;">${escapeHtml(label)}</a>`;
}

function sectionHeading(text) {
  return `<tr><td style="padding:28px 28px 8px 28px;font-family:Calibri,Arial,sans-serif;font-size:18px;font-weight:bold;color:#2F6FB0;line-height:1.3;">${escapeHtml(text)}</td></tr>`;
}

function bodyPara(html) {
  return `<tr><td style="padding:0 28px 12px 28px;font-family:Calibri,Arial,sans-serif;font-size:15px;color:#1C2733;line-height:1.55;">${html}</td></tr>`;
}

function callout(html) {
  return `<tr><td style="padding:0 28px 14px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td style="background-color:#EAF1F8;border:1px solid #BFD6EC;padding:12px 14px;font-family:Calibri,Arial,sans-serif;font-size:15px;color:#0E2A47;line-height:1.5;">
          ${html}
        </td>
      </tr>
    </table>
  </td></tr>`;
}

function bulletList(items) {
  const lis = items
    .map((item) => `<li style="margin:0 0 6px 0;padding:0;">${item}</li>`)
    .join('');
  return bodyPara(`<ul style="margin:0;padding:0 0 0 22px;">${lis}</ul>`);
}

function resourceRow(bg, resource, purpose, linksHtml) {
  return `<tr>
    <td style="background-color:${bg};border:1px solid #BFD6EC;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1C2733;vertical-align:top;width:22%;">${resource}</td>
    <td style="background-color:${bg};border:1px solid #BFD6EC;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1C2733;vertical-align:top;width:48%;">${purpose}</td>
    <td style="background-color:${bg};border:1px solid #BFD6EC;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1C2733;vertical-align:top;width:30%;">${linksHtml}</td>
  </tr>`;
}

function buildWelcomeLetterHtml(firstName) {
  const name = escapeHtml(firstName);
  const rows = [
    // Header logo
    `<tr><td style="padding:0;background-color:#0E2A47;">
      <img src="${LOGO_URL}" alt="Retail Odyssey" width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;text-decoration:none;">
    </td></tr>`,

    // Title block
    `<tr><td style="padding:28px 28px 6px 28px;font-family:Calibri,Arial,sans-serif;font-size:26px;font-weight:bold;color:#0E2A47;line-height:1.25;">Welcome!</td></tr>`,
    `<tr><td style="padding:0 28px 18px 28px;font-family:Calibri,Arial,sans-serif;font-size:15px;font-style:italic;color:#5A6B7D;line-height:1.45;">Everything you need to get started — please save this letter and its links.</td></tr>`,

    // Greeting
    bodyPara(`Hello, <strong>${name}</strong>! Congratulations, and welcome to the Retail Odyssey team. We're thrilled to have you on board and appreciate your dedication throughout the hiring process. This letter contains everything you need to get started — please save it along with its links; you'll be referring back to them often. <strong>You will receive your credentials and employee ID within 24 hours.</strong>`),

    // Step 1
    sectionHeading('Step 1 — Attend Orientation'),
    callout('<strong>No credentials needed for orientation.</strong> Simply enter your name when prompted.'),
    bodyPara(`Orientation is held in virtual Microsoft Teams sessions daily at <strong>9:00 AM</strong> and <strong>1:00 PM</strong>. Please attend the next available session. <strong>You cannot be scheduled for any shifts until orientation is complete.</strong>`),
    bodyPara(`${link('https://drive.google.com/file/d/1AhheGIMO9Ucs_KCIofhshlcu7MwuwCRP/view?usp=sharing', 'Click here')} for detailed instructions on attending orientation.`),

    // Step 2
    sectionHeading('Step 2 — Set Up System Access'),
    callout('<strong>Wait until you receive your credentials before attempting this step.</strong>'),
    bodyPara(`Doing your job requires access to company resources, which means you must be able to log in to our systems. ${link('https://drive.google.com/file/d/127lASxX58ajdAlhYzvL6kouNjzuGjRnT/view?usp=drive_link', 'Click here')} for a guide on logging in to company resources.`),

    // What We Do
    sectionHeading('What We Do'),
    bodyPara(`In short, we reset and rearrange products on retail shelves. You'll be working across <strong>ten Fred Meyer locations in Central Seattle</strong>: Burien, N. Benson Plaza, Renton, Maple Valley, Bellevue, Kirkland, Issaquah, Auburn, Covington, and Redondo.`),
    bodyPara(`For a look at a day in the life of a merchandiser, watch ${link('https://drive.google.com/file/d/17bUGWGmm4jK4suOJzYfdMx8II4Cp9tBe/view?usp=drive_link', 'Working at Retail Odyssey')}.`),

    // Work Schedule
    sectionHeading('Work Schedule'),
    bodyPara(`Our typical schedule is <strong>5:00 AM to 2:00 PM, Monday through Friday</strong>. There are always exceptions, so please don't expect a set number of hours each week.`),

    // Dress Code
    sectionHeading('Dress Code'),
    bulletList([
      'Closed-toe shoes',
      'Pants',
      'Solid-color polo with no logos (a company work shirt will be provided soon)',
    ]),

    // What to Bring
    sectionHeading('What to Bring to Work'),
    bulletList([
      'Tape measure',
      'Pen',
      'Highlighter',
      "Gloves that are tactile and don't restrict finger dexterity",
      'Step ladder (if you have an extra)',
      'A garden kneeling pad or knee pads are also recommended',
    ]),

    // Recommended Actions
    sectionHeading('Recommended Actions Before Your First Shift'),
    bulletList([
      `Set up direct deposit — it's the fastest, most reliable way to receive your pay. ${link('https://drive.google.com/file/d/1Cy7crZsmNDL4UV9vgB8twtMU-EzqeC5C/view?usp=sharing', 'Click here')} for a step-by-step setup guide.`,
      `Double-check your address details so your first paycheck arrives promptly. Both can be handled in ${link('https://hrispub.asmnet.com/', 'Oracle')}.`,
    ]),

    // Key Resources
    sectionHeading('Key Resources &amp; Links'),
    bodyPara('Save all of the following — you\'ll use them regularly.'),
    `<tr><td style="padding:0 28px 18px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
        <tr>
          <th align="left" style="background-color:#2F6FB0;border:1px solid #2F6FB0;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;width:22%;">Resource</th>
          <th align="left" style="background-color:#2F6FB0;border:1px solid #2F6FB0;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;width:48%;">What It's For</th>
          <th align="left" style="background-color:#2F6FB0;border:1px solid #2F6FB0;padding:10px 12px;font-family:Calibri,Arial,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;width:30%;">Link</th>
        </tr>
        ${resourceRow('#FFFFFF', 'Associate Tip Sheet', 'Essential contacts, account access help, password resets, and payroll information', link('https://drive.google.com/file/d/1WvagulEV4awYEoBZg0U8mPd3qmo8-k4l/view?usp=drive_link', 'Open Tip Sheet'))}
        ${resourceRow('#F4F8FC', 'Associate Handbook', 'Full details on policies and working for Advantage Solutions', link('https://drive.google.com/file/d/1LIHte4IUkG0k8MaAt9MV-PfTpFQO8kRn/view?usp=sharing', 'Open Handbook'))}
        ${resourceRow('#FFFFFF', '2026 Payroll Calendar', 'Holiday and pay schedule for the year', link('https://d6ewasupervisor-netizen.github.io/PayrollCalendar/', 'Open Calendar'))}
        ${resourceRow('#F4F8FC', 'Connects Hub', 'Your central hub for all things Advantage — resources, employee groups, and more', link('https://advantagesolutionsnet.sharepoint.com/sites/ConnectsHub', 'Open Connects Hub'))}
        ${resourceRow('#FFFFFF', 'Oracle (HRIS)', 'Manage personal information, benefits, time-off requests, pay stubs, tax forms, and direct deposit', link('https://hrispub.asmnet.com/', 'Open Oracle'))}
        ${resourceRow(
          '#F4F8FC',
          'PROD (SAS App)',
          'Also called the tablet or Retail Logic — view your schedule, log your time (if you\'re a lead), track your work, and complete surveys. To verify your recorded hours or set your PIN, click the avatar in the top-right and select <strong>My Profile</strong>.',
          `${link('https://prod.sasretail.com/en/field/', 'Open PROD')}<br><br>${link('https://drive.google.com/file/d/1z__YVE0tKlPYfMkWCDNHs3d_Tvm2kqNq/view?usp=drivesdk', 'PIN Setup Guide')}`,
        )}
        ${resourceRow(
          '#FFFFFF',
          'Associate Support Center',
          'IT, HR, benefits, payroll, and field support. Call <strong>1-888-900-4276</strong> or submit a ticket online.',
          link('https://helpdesk.asmnet.com/', 'Submit a Ticket'),
        )}
      </table>
    </td></tr>`,

    // Supervisor
    sectionHeading('Your Supervisor'),
    bodyPara(`Please don't hesitate to reach out with any questions or concerns. My preferred method of contact is <strong>text</strong>, but calls are always welcome. My office hours are <strong>6:00 AM to 3:00 PM, Monday through Friday</strong>, and I'm occasionally reachable by email outside those hours.`),
    bodyPara(`<strong>Tyson Gauthier</strong><br>
Central Seattle Supervisor — Retail Odyssey<br>
Cell: (509) 572-7660<br>
Fax: (858) 431-7768<br>
Email: <a href="mailto:tyson.gauthier@retailodyssey.com" style="color:#2F6FB0;text-decoration:underline;">tyson.gauthier@retailodyssey.com</a>`),

    // Closing
    bodyPara(`If there's anything I haven't covered, just let me know. We look forward to working with you and helping you succeed in your new role, <strong>${name}</strong> — welcome aboard!`),

    // Footer spacer
    `<tr><td style="padding:12px 28px 28px 28px;font-family:Calibri,Arial,sans-serif;font-size:12px;color:#8A9AAB;line-height:1.4;">Retail Odyssey · Central Seattle</td></tr>`,
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome!</title>
</head>
<body style="margin:0;padding:0;background-color:#F2F5F8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:#F2F5F8;">
    <tr>
      <td align="center" style="padding:16px 8px;">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:640px;background-color:#FFFFFF;">
          ${rows.join('\n')}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildWelcomeLetterText(firstName) {
  return `Welcome!

Everything you need to get started — please save this letter and its links.

Hello, ${firstName}! Congratulations, and welcome to the Retail Odyssey team. We're thrilled to have you on board and appreciate your dedication throughout the hiring process. This letter contains everything you need to get started — please save it along with its links; you'll be referring back to them often. You will receive your credentials and employee ID within 24 hours.

STEP 1 — ATTEND ORIENTATION
No credentials needed for orientation. Simply enter your name when prompted.
Orientation is held in virtual Microsoft Teams sessions daily at 9:00 AM and 1:00 PM. Please attend the next available session. You cannot be scheduled for any shifts until orientation is complete.
Detailed instructions: https://drive.google.com/file/d/1AhheGIMO9Ucs_KCIofhshlcu7MwuwCRP/view?usp=sharing

STEP 2 — SET UP SYSTEM ACCESS
Wait until you receive your credentials before attempting this step.
Guide to logging in to company resources: https://drive.google.com/file/d/127lASxX58ajdAlhYzvL6kouNjzuGjRnT/view?usp=drive_link

WHAT WE DO
In short, we reset and rearrange products on retail shelves. You'll be working across ten Fred Meyer locations in Central Seattle: Burien, N. Benson Plaza, Renton, Maple Valley, Bellevue, Kirkland, Issaquah, Auburn, Covington, and Redondo.
Day in the life video: https://drive.google.com/file/d/17bUGWGmm4jK4suOJzYfdMx8II4Cp9tBe/view?usp=drive_link

WORK SCHEDULE
Our typical schedule is 5:00 AM to 2:00 PM, Monday through Friday. There are always exceptions, so please don't expect a set number of hours each week.

DRESS CODE
- Closed-toe shoes
- Pants
- Solid-color polo with no logos (a company work shirt will be provided soon)

WHAT TO BRING TO WORK
- Tape measure
- Pen
- Highlighter
- Gloves that are tactile and don't restrict finger dexterity
- Step ladder (if you have an extra)
- A garden kneeling pad or knee pads are also recommended

RECOMMENDED ACTIONS BEFORE YOUR FIRST SHIFT
- Set up direct deposit — it's the fastest, most reliable way to receive your pay.
  Guide: https://drive.google.com/file/d/1Cy7crZsmNDL4UV9vgB8twtMU-EzqeC5C/view?usp=sharing
- Double-check your address details so your first paycheck arrives promptly. Both can be handled in Oracle: https://hrispub.asmnet.com/

KEY RESOURCES & LINKS
Save all of the following — you'll use them regularly.

Associate Tip Sheet — Essential contacts, account access help, password resets, and payroll information
https://drive.google.com/file/d/1WvagulEV4awYEoBZg0U8mPd3qmo8-k4l/view?usp=drive_link

Associate Handbook — Full details on policies and working for Advantage Solutions
https://drive.google.com/file/d/1LIHte4IUkG0k8MaAt9MV-PfTpFQO8kRn/view?usp=sharing

2026 Payroll Calendar — Holiday and pay schedule for the year
https://d6ewasupervisor-netizen.github.io/PayrollCalendar/

Connects Hub — Your central hub for all things Advantage
https://advantagesolutionsnet.sharepoint.com/sites/ConnectsHub

Oracle (HRIS) — Personal information, benefits, time-off, pay stubs, tax forms, direct deposit
https://hrispub.asmnet.com/

PROD (SAS App) — Schedule, time, work tracking, surveys. My Profile (avatar, top-right) for hours/PIN.
https://prod.sasretail.com/en/field/
PIN Setup Guide: https://drive.google.com/file/d/1z__YVE0tKlPYfMkWCDNHs3d_Tvm2kqNq/view?usp=drivesdk

Associate Support Center — IT, HR, benefits, payroll, and field support. Call 1-888-900-4276.
https://helpdesk.asmnet.com/

YOUR SUPERVISOR
Please don't hesitate to reach out with any questions or concerns. My preferred method of contact is text, but calls are always welcome. My office hours are 6:00 AM to 3:00 PM, Monday through Friday, and I'm occasionally reachable by email outside those hours.

Tyson Gauthier
Central Seattle Supervisor — Retail Odyssey
Cell: (509) 572-7660
Fax: (858) 431-7768
Email: tyson.gauthier@retailodyssey.com

If there's anything I haven't covered, just let me know. We look forward to working with you and helping you succeed in your new role, ${firstName} — welcome aboard!

Retail Odyssey · Central Seattle
`;
}

function buildWelcomeLetter({ firstName, email }) {
  const validated = validateWelcomeLetterInput({ firstName, email });
  if (!validated.ok) {
    const err = new Error(validated.errors.join('; '));
    err.statusCode = 400;
    err.errors = validated.errors;
    throw err;
  }

  const html = buildWelcomeLetterHtml(validated.firstName);
  const text = buildWelcomeLetterText(validated.firstName);

  return {
    firstName: validated.firstName,
    email: validated.email,
    from: FROM_ADDRESS,
    to: validated.email,
    cc: [...CC_ADDRESSES],
    replyTo: REPLY_TO,
    subject: SUBJECT,
    html,
    text,
  };
}

function buildResendPayload(letter) {
  return {
    from: letter.from,
    to: [letter.to],
    cc: letter.cc,
    subject: letter.subject,
    html: letter.html,
    text: letter.text,
    reply_to: letter.replyTo,
  };
}

module.exports = {
  LOGO_URL,
  FROM_ADDRESS,
  REPLY_TO,
  CC_ADDRESSES,
  SUBJECT,
  validateWelcomeLetterInput,
  buildWelcomeLetter,
  buildWelcomeLetterHtml,
  buildWelcomeLetterText,
  buildResendPayload,
};
