'use strict';

/**
 * Short-lived JWTs for supervisor review links (GET-safe; POST carries decision).
 * typ: decision_review — distinct from session, admin, link, dump_dl.
 */

const jwt = require('jsonwebtoken');

const TYP = 'decision_review';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function ensureSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

/** 24h review links — matches product expectation */
function normalizeDecisionType(decisionType) {
  if (decisionType === 'shift') return 'shift';
  if (decisionType === 'prod') return 'prod';
  if (decisionType === 'dcscan') return 'dcscan';
  return 'store';
}

function issueReviewToken({ requestId, decisionType, approverEmail }) {
  const rid = String(requestId || '').trim();
  const dt = normalizeDecisionType(decisionType);
  const em = normalizeEmail(approverEmail);
  if (!rid || !em) {
    throw new Error('issueReviewToken requires requestId and approverEmail');
  }
  return jwt.sign(
    {
      typ: TYP,
      action: 'review',
      requestId: rid,
      decisionType: dt,
      approverEmail: em,
    },
    ensureSecret(),
    { expiresIn: '24h' }
  );
}

/**
 * @returns {{ requestId: string, decisionType: 'store'|'shift', approverEmail: string, exp?: number }}
 */
function verifyReviewToken(token, { expectedRequestId, expectedType }) {
  const payload = jwt.verify(String(token || ''), ensureSecret());
  if (payload.typ !== TYP || payload.action !== 'review') {
    const e = new Error('Invalid review token scope');
    e.name = 'JsonWebTokenError';
    throw e;
  }
  if (String(payload.requestId) !== String(expectedRequestId)) {
    const e = new Error('Request id mismatch');
    e.name = 'JsonWebTokenError';
    throw e;
  }
  const dt = normalizeDecisionType(payload.decisionType);
  if (dt !== expectedType) {
    const e = new Error('Decision type mismatch');
    e.name = 'JsonWebTokenError';
    throw e;
  }
  return {
    requestId: String(payload.requestId),
    decisionType: dt,
    approverEmail: normalizeEmail(payload.approverEmail),
    exp: payload.exp,
  };
}

module.exports = {
  issueReviewToken,
  verifyReviewToken,
  normalizeDecisionType,
  normalizeApproverEmail: normalizeEmail,
  REVIEW_JWT_TYP: TYP,
};
