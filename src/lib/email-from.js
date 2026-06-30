'use strict';

/**
 * Default outbound From addresses for eod-api (Resend).
 *
 * EOD reports use a single shared mailbox; everything else on retail-odyssey.com
 * defaults to info@ unless overridden via env.
 */

const DEFAULT_INFO_ADDRESS = 'info@retail-odyssey.com';
const DEFAULT_EOD_ADDRESS = 'eod_reports@retail-odyssey.com';

/** Bare email or `Name <email>` — never double-wrap for Resend. */
function normalizeMailbox(raw, fallbackAddress) {
  const s = String(raw || fallbackAddress).trim();
  if (!s) return fallbackAddress;
  if (/<[^>]+>/.test(s)) return s;
  return s;
}

const RETAIL_ODYSSEY_INFO_ADDRESS = normalizeMailbox(
  process.env.RETAIL_ODYSSEY_INFO_FROM,
  DEFAULT_INFO_ADDRESS,
);

const EOD_REPORTS_FROM = normalizeMailbox(
  process.env.EOD_EMAIL_FROM,
  DEFAULT_EOD_ADDRESS,
);

function retailOdysseyFrom(label) {
  const mailbox = RETAIL_ODYSSEY_INFO_ADDRESS;
  if (/<[^>]+>/.test(mailbox)) return mailbox;
  return label ? `${label} <${mailbox}>` : mailbox;
}

function eodReportsFrom() {
  const mailbox = EOD_REPORTS_FROM;
  if (/<[^>]+>/.test(mailbox)) return mailbox;
  return `EOD Reports <${mailbox}>`;
}

module.exports = {
  RETAIL_ODYSSEY_INFO_ADDRESS,
  EOD_REPORTS_FROM,
  retailOdysseyFrom,
  eodReportsFrom,
};
