// POST /api/review/create — called by local flow-automation to open a session.

const express = require('express');
const {
  newReviewId,
  createReviewSession,
} = require('../lib/review-sessions-db');
const { sendReviewLinkEmail } = require('../lib/auth-email');
const { buildReviewUrl } = require('./review-tokens');

const router = express.Router();

// This router is mounted ahead of the app's global express.json() (see
// index.js — access-request/review routes self-parse the same way
// review-decision.js does with express.urlencoded()), so it needs its own
// JSON body parser or req.body is always undefined here.
router.use(express.json({ limit: '50mb' }));

function authorizeCreate(req, res, next) {
  const secret = process.env.REVIEW_REQUEST_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'REVIEW_REQUEST_SECRET is not configured' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== secret) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

router.post('/create', authorizeCreate, async (req, res) => {
  try {
    const {
      surfaceId,
      periodWeek,
      draft,
      findings,
      promotionOffers,
      approverEmail,
    } = req.body || {};

    if (!surfaceId || !draft || !approverEmail) {
      return res.status(400).json({ ok: false, error: 'surfaceId, draft, and approverEmail are required.' });
    }

    const id = newReviewId();
    await createReviewSession({
      id,
      surfaceId,
      periodWeek,
      approverEmail,
      draft,
      findings: findings || [],
      promotionOffers: promotionOffers || [],
    });

    const reviewUrl = buildReviewUrl(id, approverEmail);
    await sendReviewLinkEmail({
      to: approverEmail,
      surfaceId,
      periodWeek: periodWeek || '',
      reviewUrl,
    });

    console.log(`[review-create] session ${id} for ${surfaceId} ${periodWeek || ''} → ${approverEmail}`);
    return res.json({ ok: true, reviewId: id });
  } catch (err) {
    console.error('[review-create]', err);
    return res.status(500).json({ ok: false, error: 'Could not create review session.' });
  }
});

module.exports = router;
