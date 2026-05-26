const crypto = require('node:crypto');

function getReviewApprovers() {
  return (process.env.REVIEW_REQUEST_APPROVERS || 'tyson.gauthier@retailodyssey.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function computeReviewToken(reviewId, action, approverEmail) {
  const secret = process.env.REVIEW_REQUEST_SECRET;
  if (!secret) throw new Error('REVIEW_REQUEST_SECRET is not configured');
  return crypto
    .createHmac('sha256', secret)
    .update(`${reviewId}|${action}|${approverEmail}`)
    .digest('hex');
}

function buildBackendBase() {
  const fallback = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://eod-api.the-dump-bin.com';
  return (process.env.BACKEND_BASE_URL || fallback).replace(/\/+$/, '');
}

function buildReviewUrl(reviewId, approverEmail) {
  const token = computeReviewToken(reviewId, 'review', approverEmail);
  return `${buildBackendBase()}/api/review/${encodeURIComponent(reviewId)}?token=${token}&by=${encodeURIComponent(approverEmail)}`;
}

module.exports = {
  getReviewApprovers,
  computeReviewToken,
  buildReviewUrl,
  buildBackendBase,
};
