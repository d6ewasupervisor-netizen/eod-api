const crypto = require('node:crypto');
const { query } = require('./db');

function newReviewId() {
  return crypto.randomUUID();
}

function ttlDays() {
  return Number(process.env.REVIEW_SESSION_TTL_DAYS) || 7;
}

function decisionGraceHours() {
  return Number(process.env.REVIEW_DECISION_GRACE_HOURS) || 72;
}

/**
 * @param {object} params
 */
async function createReviewSession(params) {
  const {
    id,
    surfaceId,
    periodWeek,
    approverEmail,
    draft,
    findings,
    promotionOffers,
  } = params;
  const days = ttlDays();
  const { rows } = await query(
    `INSERT INTO review_sessions
       (id, surface_id, period_week, approver_email, draft_json, findings_json, promotion_offers_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::interval)
     RETURNING *`,
    [
      id,
      surfaceId,
      periodWeek || null,
      approverEmail,
      JSON.stringify(draft),
      JSON.stringify(findings || []),
      JSON.stringify(promotionOffers || []),
      String(days),
    ],
  );
  return rows[0];
}

async function getReviewSession(id) {
  const { rows } = await query('SELECT * FROM review_sessions WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Atomic first-submit-wins. Purges draft/findings; retains decision payload until ack or grace TTL.
 */
async function submitReviewDecision(id, decisionPayload, action) {
  const status = action === 'reject' ? 'rejected' : 'approved';
  const graceH = decisionGraceHours();
  const { rows } = await query(
    `UPDATE review_sessions
     SET status = $2,
         decided_at = NOW(),
         decision_payload = $3,
         draft_json = NULL,
         findings_json = NULL,
         promotion_offers_json = NULL,
         decision_grace_expires_at = NOW() + ($4 || ' hours')::interval
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, JSON.stringify(decisionPayload), String(graceH)],
  );
  return rows[0] || null;
}

/**
 * Local flow ack after successful publish — purge decision payload, keep metadata.
 */
async function ackReviewDecision(id) {
  const { rows } = await query(
    `UPDATE review_sessions
     SET decision_payload = NULL,
         payload_acked_at = NOW()
     WHERE id = $1
       AND decision_payload IS NOT NULL
       AND payload_acked_at IS NULL
     RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

async function purgeExpiredReviewSessions() {
  await query(
    `UPDATE review_sessions
     SET draft_json = NULL,
         findings_json = NULL,
         promotion_offers_json = NULL,
         status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END
     WHERE expires_at < NOW()
       AND status = 'pending'
       AND (draft_json IS NOT NULL OR findings_json IS NOT NULL)`,
  );
}

async function purgeExpiredDecisionPayloads() {
  const { rowCount } = await query(
    `UPDATE review_sessions
     SET decision_payload = NULL,
         status = 'purged'
     WHERE decision_payload IS NOT NULL
       AND payload_acked_at IS NULL
       AND decision_grace_expires_at IS NOT NULL
       AND decision_grace_expires_at < NOW()`,
  );
  return rowCount;
}

module.exports = {
  newReviewId,
  createReviewSession,
  getReviewSession,
  submitReviewDecision,
  ackReviewDecision,
  purgeExpiredReviewSessions,
  purgeExpiredDecisionPayloads,
  decisionGraceHours,
};
