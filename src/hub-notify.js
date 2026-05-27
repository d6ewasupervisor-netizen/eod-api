'use strict';

/**
 * Checklane Hub — operational email notifications (reopen complete, etc.).
 */

const { query } = require('./lib/db');
const { parseVisitId } = require('./hub-auth');
const {
  CHECKLANES_OPS_EMAIL,
  buildSetRelatedEmailPayload,
} = require('./lib/checklanes-email');

let _resend = null;

function initHubNotify({ resend }) {
  _resend = resend;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resolveStore(visitIdNum) {
  const { rows } = await query(
    `SELECT store_number
     FROM schedules
     WHERE visit_id = $1
     ORDER BY scheduled_date DESC
     LIMIT 1`,
    [visitIdNum],
  );
  if (!rows.length || rows[0].store_number == null) return null;
  const n = Number(rows[0].store_number);
  if (!Number.isFinite(n)) return String(rows[0].store_number);
  return String(n).padStart(5, '0');
}

async function sendSectionReopenEmail({
  visitId,
  store,
  lane,
  dbkey,
  priorState,
  reason,
  actor,
}) {
  if (!_resend) {
    return { sent: false, error: 'Hub notify not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  const storeLabel = store || (await resolveStore(visitIdNum)) || 'unknown';
  const actorLabel = actor.name || actor.email || `User #${actor.id}`;
  const subject =
    `[Checklanes reopen] Store ${storeLabel} · Lane ${lane || '—'} · DBKey ${dbkey}`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;line-height:1.5;">
  <h2 style="margin:0 0 12px;font-size:18px;">Set reopened — was marked complete</h2>
  <p style="margin:0 0 8px;"><strong>Store:</strong> ${escHtml(storeLabel)}</p>
  <p style="margin:0 0 8px;"><strong>Visit:</strong> ${escHtml(String(visitIdNum))}</p>
  <p style="margin:0 0 8px;"><strong>Lane:</strong> ${escHtml(lane || '—')}</p>
  <p style="margin:0 0 8px;"><strong>DBKey:</strong> ${escHtml(dbkey)}</p>
  <p style="margin:0 0 8px;"><strong>Prior state:</strong> ${escHtml(priorState)}</p>
  <p style="margin:0 0 8px;"><strong>Reopened by:</strong> ${escHtml(actorLabel)} (${escHtml(actor.email || '')})</p>
  <p style="margin:16px 0 6px;font-weight:700;">Explanation</p>
  <p style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escHtml(reason)}</p>
  <p style="margin:16px 0 0;color:#6b7280;font-size:13px;">The set is back in <strong>In progress</strong> so work can continue.</p>
</body></html>`;

  const payload = buildSetRelatedEmailPayload({
    to: CHECKLANES_OPS_EMAIL,
    subject,
    html,
    actorEmail: actor.email,
    replyToExplicit: actor.email,
  });

  const { data, error } = await _resend.emails.send(payload);
  if (error) {
    console.error('[hub-notify] reopen email failed:', error.message || String(error));
    return { sent: false, error: error.message || String(error) };
  }

  return { sent: true, resendId: data?.id };
}

module.exports = {
  initHubNotify,
  sendSectionReopenEmail,
};
