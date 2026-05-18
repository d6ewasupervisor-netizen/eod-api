'use strict';

/**
 * Reply-To for Resend sends: explicit mailbox (e.g. access requester) first,
 * then authenticated user email, then RESEND_REPLY_TO for a deployment default.
 */

function trimAddr(value) {
  if (value == null || value === '') return undefined;
  const t = String(value).trim();
  return t || undefined;
}

function resolveResendReplyTo({ explicit, userEmail } = {}) {
  return (
    trimAddr(explicit) ||
    trimAddr(userEmail) ||
    trimAddr(process.env.RESEND_REPLY_TO) ||
    undefined
  );
}

/** @param {Record<string, unknown>} payload Resend emails.send payload (mutated if resolved) */
function addReplyTo(payload, opts) {
  const rt = resolveResendReplyTo(opts);
  if (rt) payload.reply_to = rt;
  return payload;
}

/** Basic check for a bare email string (e.g. shift request "requestedBy"). */
function looksLikeEmail(value) {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

module.exports = { resolveResendReplyTo, addReplyTo, looksLikeEmail };
