'use strict';

/**
 * Shared Resend helpers for Checklanes / set-related emails.
 *
 * From:     info@retail-odyssey.com (override via CHECKLANES_EMAIL_FROM)
 * Reply-To: person who triggered the action
 * CC:       trigger person + ops (tyson) when not already the primary recipient
 */

const { addReplyTo } = require('./resend-reply-to');

const { retailOdysseyFrom } = require('./email-from');
const CHECKLANES_FROM =
  process.env.CHECKLANES_EMAIL_FROM || retailOdysseyFrom('Checklanes');

const CHECKLANES_OPS_EMAIL = (
  process.env.CHECKLANES_OPS_EMAIL ||
  process.env.OVERRIDE_APPROVER_EMAIL ||
  'tyson.gauthier@retailodyssey.com'
).trim();

function normalizeEmail(value) {
  if (value == null || value === '') return undefined;
  const t = String(value).trim();
  return t || undefined;
}

function toLowerSet(addresses) {
  return (Array.isArray(addresses) ? addresses : [addresses])
    .map((a) => normalizeEmail(a))
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

/**
 * Build CC list: actor + ops, excluding anyone already in `to`.
 */
function buildCcList({ to, actorEmail, extraCc = [] }) {
  const toLower = toLowerSet(to);
  const set = new Set();

  for (const addr of extraCc) {
    const a = normalizeEmail(addr);
    if (a && !toLower.includes(a.toLowerCase())) set.add(a);
  }

  const actor = normalizeEmail(actorEmail);
  if (actor && !toLower.includes(actor.toLowerCase())) set.add(actor);

  const ops = normalizeEmail(CHECKLANES_OPS_EMAIL);
  if (ops && !toLower.includes(ops.toLowerCase())) set.add(ops);

  return set.size ? [...set] : undefined;
}

/**
 * Resend payload for set-related notifications (helpdesk, shifts, hub actions).
 */
function buildSetRelatedEmailPayload({
  to,
  subject,
  html,
  actorEmail,
  extraCc,
  attachments,
  replyToExplicit,
  from,
}) {
  const toList = (Array.isArray(to) ? to : [to]).map(normalizeEmail).filter(Boolean);
  const payload = {
    from: from || CHECKLANES_FROM,
    to: toList,
    subject,
    html,
  };

  const cc = buildCcList({ to: toList, actorEmail, extraCc });
  if (cc) payload.cc = cc;

  addReplyTo(payload, {
    explicit: replyToExplicit || actorEmail,
    userEmail: actorEmail,
  });

  if (attachments?.length) payload.attachments = attachments;
  return payload;
}

module.exports = {
  CHECKLANES_FROM,
  CHECKLANES_OPS_EMAIL,
  buildCcList,
  buildSetRelatedEmailPayload,
};
