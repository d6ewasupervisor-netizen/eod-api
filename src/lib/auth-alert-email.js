'use strict';

const { addReplyTo } = require('./resend-reply-to');

async function sendAuthAlertEmail(resend, {
  from,
  to,
  subject,
  html,
  replyToOptions = {},
  loggerLabel = 'auth-alert',
} = {}) {
  if (!resend?.emails || typeof resend.emails.send !== 'function' || !process.env.RESEND_API_KEY) {
    return { ok: false, error: 'Resend not configured' };
  }

  try {
    const payload = { from, to, subject, html };
    addReplyTo(payload, replyToOptions);
    await resend.emails.send(payload);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      loggerLabel,
    };
  }
}

module.exports = {
  sendAuthAlertEmail,
};
