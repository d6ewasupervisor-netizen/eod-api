'use strict';

/**
 * Default outbound From addresses for eod-api (Resend).
 *
 * EOD reports use a single shared mailbox; everything else on retail-odyssey.com
 * defaults to info@ unless overridden via env.
 */

const RETAIL_ODYSSEY_INFO_ADDRESS =
  process.env.RETAIL_ODYSSEY_INFO_FROM || 'info@retail-odyssey.com';

const EOD_REPORTS_ADDRESS =
  process.env.EOD_EMAIL_FROM || 'eod_reports@retail-odyssey.com';

function retailOdysseyFrom(label) {
  return label ? `${label} <${RETAIL_ODYSSEY_INFO_ADDRESS}>` : RETAIL_ODYSSEY_INFO_ADDRESS;
}

function eodReportsFrom() {
  return `EOD Reports <${EOD_REPORTS_ADDRESS}>`;
}

module.exports = {
  RETAIL_ODYSSEY_INFO_ADDRESS,
  EOD_REPORTS_ADDRESS,
  retailOdysseyFrom,
  eodReportsFrom,
};
