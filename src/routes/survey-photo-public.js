'use strict';

/**
 * Public (no session / no Cloudflare Access) survey photo serve.
 * Mounted at /api/survey/photos — only GET /:id/public?t=…
 * Token typ: survey_photo (see lib/survey-photo-jwt.js).
 */
const express = require('express');
const { pool } = require('../lib/db');
const { verifySurveyPhotoToken } = require('../lib/survey-photo-jwt');

const router = express.Router();

router.get('/:id/public', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid photo id' });
    }
    let verified;
    try {
      verified = verifySurveyPhotoToken(req.query.t);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return res.status(401).json({ ok: false, error: 'Photo link expired' });
      }
      return res.status(401).json({ ok: false, error: 'Invalid photo link' });
    }
    if (verified.photoId !== id) {
      return res.status(401).json({ ok: false, error: 'Photo link mismatch' });
    }

    const { rows } = await pool.query(
      'SELECT mime, bytes FROM survey_photos WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Photo not found' });

    const mime = rows[0].mime || 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(rows[0].bytes);
  } catch (e) {
    return next(e);
  }
});

module.exports = router;
