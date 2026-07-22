'use strict';

/**
 * Public (no session) EOD artifact serve.
 * Mounted at /api/eod-files — GET /:id?t=…
 * Token typ: eod_file (see lib/eod-artifact-jwt.js).
 */
const express = require('express');
const { verifyEodArtifactToken } = require('../lib/eod-artifact-jwt');
const { getArtifactRow, readArtifactFile } = require('../lib/eod-artifacts');

const router = express.Router();

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid file id' });
    }

    let verified;
    try {
      verified = verifyEodArtifactToken(req.query.t);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return res.status(401).json({ ok: false, error: 'Link expired' });
      }
      return res.status(401).json({ ok: false, error: 'Invalid link' });
    }
    if (verified.artifactId !== id) {
      return res.status(401).json({ ok: false, error: 'Link mismatch' });
    }

    const row = await getArtifactRow(id);
    if (!row) return res.status(404).json({ ok: false, error: 'File not found' });

    let bytes;
    try {
      bytes = await readArtifactFile(row);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return res.status(404).json({ ok: false, error: 'File missing on disk' });
      }
      throw e;
    }

    const mime = row.mime || 'application/octet-stream';
    const filename = row.filename || `eod-${id}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Inline so recipients can view PDF/images in-browser without downloading first.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(filename).replace(/"/g, '')}"`
    );
    return res.send(bytes);
  } catch (e) {
    return next(e);
  }
});

module.exports = router;
