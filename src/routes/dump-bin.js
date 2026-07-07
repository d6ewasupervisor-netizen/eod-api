'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth, authenticateRequest } = require('../auth-middleware');
const r2 = require('../lib/dump-bin-r2');
const { addReplyTo } = require('../lib/resend-reply-to');
const { dispatchTrackedEmail } = require('../lib/resend-outbox');

const DUMP_DL_TYP = 'dump_dl';

function downloadTtlMinutes() {
  const v = process.env.DUMP_BIN_DOWNLOAD_TTL_MINUTES;
  if (v == null || v === '') return 15;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

function issueDownloadLinkToken(key) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const k = String(key || '').trim();
  if (!k) throw new Error('key required');
  return jwt.sign({ typ: DUMP_DL_TYP, key: k }, secret, {
    expiresIn: `${downloadTtlMinutes()}m`,
  });
}

function verifyDownloadLinkToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const payload = jwt.verify(String(token || ''), secret);
  if (payload.typ !== DUMP_DL_TYP) {
    const err = new Error('Invalid download token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  const key = String(payload.key || '').trim();
  if (!key) {
    const err = new Error('Invalid download token payload');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return { key };
}

function senderLocalPart(userEmail) {
  if (!userEmail) return 'noreply';
  const localPart = userEmail.split('@')[0];
  const firstSegment = localPart.split('.')[0];
  return (firstSegment || localPart).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function contentDispositionForFilename(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const inlineTypes = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'html'];
  const disposition = inlineTypes.includes(ext) ? 'inline' : 'attachment';
  return `${disposition}; filename="${encodeURIComponent(filename)}"`;
}

function pipeObjectStreamToResponse(readStream, res, log) {
  readStream.on('error', (err) => {
    log.error('[dump-bin download] R2 body stream error:', err.message || err);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  readStream.pipe(res);
}

function createDumpBinRouter({ resend, logger }) {
  const router = express.Router();
  const log = logger || {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };

  router.get('/list', requireAuth, async (req, res) => {
    const prefix = String(req.query.prefix || '');
    try {
      const { prefix: normalizedPrefix, folders, files } = await r2.listByPrefix(prefix);
      const filesWithTokens = files.map((f) => ({
        ...f,
        t: issueDownloadLinkToken(f.key),
      }));
      return res.json({ prefix: normalizedPrefix, folders, files: filesWithTokens });
    } catch (err) {
      if (err.code === 'DUMP_BIN_NOT_CONFIGURED') {
        return res.status(503).json({ ok: false, error: err.message });
      }
      log.error('[dump-bin list]', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/download-token', requireAuth, async (req, res) => {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
    try {
      const t = issueDownloadLinkToken(key);
      return res.json({ ok: true, t });
    } catch (err) {
      log.error('[dump-bin download-token]', err);
      return res.status(500).json({ ok: false, error: 'Could not issue token' });
    }
  });

  router.get('/download', async (req, res) => {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'missing key' });

    const t = String(req.query.t || '').trim();
    if (t) {
      try {
        const payload = verifyDownloadLinkToken(t);
        if (payload.key !== key) {
          return res.status(403).json({ error: 'Download token does not match key' });
        }
      } catch (err) {
        if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
          return res.status(401).json({ error: 'Download link expired or invalid' });
        }
        log.error('[dump-bin download] token path', err);
        return res.status(500).json({ error: err.message || 'Download failed' });
      }
    } else {
      const user = await authenticateRequest(req, res);
      if (!user) return;
    }

    let bodyStream;
    try {
      const out = await r2.getObjectStream(key);
      bodyStream = out.body;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', out.contentType || 'application/octet-stream');
      if (out.contentLength != null) res.setHeader('Content-Length', String(out.contentLength));
      if (out.etag) res.setHeader('ETag', out.etag);
      res.setHeader('Content-Disposition', contentDispositionForFilename(out.filename));
      pipeObjectStreamToResponse(bodyStream, res, log);
    } catch (err) {
      if (bodyStream && typeof bodyStream.destroy === 'function') {
        bodyStream.destroy();
      }
      if (err.code === 'DUMP_BIN_NOT_CONFIGURED') {
        return res.status(503).json({ ok: false, error: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'not found' });
      }
      log.error('[dump-bin download]', err);
      const status =
        err.status && Number(err.status) >= 400 && Number(err.status) < 600
          ? Number(err.status)
          : 500;
      return res.status(status).json({ error: err.message || 'Download failed' });
    }
  });

  router.post('/print-at-store', requireAuth, async (req, res) => {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    if (!r2.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Dump bin R2 is not configured' });
    }
    const printRecipient = (process.env.PRINT_RECIPIENT || '').trim();
    const sendDomain = (process.env.SEND_DOMAIN || '').trim();
    if (!printRecipient || !sendDomain) {
      return res.status(500).json({ error: 'Print at store is not configured (PRINT_RECIPIENT / SEND_DOMAIN)' });
    }
    if (!resend) {
      return res.status(500).json({ error: 'Email service not available' });
    }

    const { keys, storeNumber, storeCity } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'no files selected' });
    }
    if (!storeNumber) {
      return res.status(400).json({ error: 'no store selected' });
    }

    const attachments = [];
    let totalBytes = 0;
    const MAX_BYTES = 35 * 1024 * 1024;

    for (const rawKey of keys) {
      const fileKey = String(rawKey || '').trim();
      if (!fileKey) continue;
      let buf;
      try {
        buf = await r2.getObjectBuffer(fileKey);
      } catch (e) {
        if (e.code === 'NOT_FOUND') continue;
        if (e.code === 'DUMP_BIN_NOT_CONFIGURED') {
          return res.status(503).json({ ok: false, error: e.message });
        }
        log.error('[dump-bin print-at-store] getObjectBuffer', e);
        return res.status(500).json({ error: e.message || 'Failed to read files' });
      }
      totalBytes += buf.length;
      if (totalBytes > MAX_BYTES) {
        return res.status(413).json({
          error: `Selection too large (${(totalBytes / 1048576).toFixed(1)}MB). Resend caps at ~40MB. Please split into smaller requests.`,
        });
      }
      const filename = fileKey.split('/').pop();
      attachments.push({ filename, content: buf.toString('base64') });
    }

    const fromLocal = senderLocalPart(userEmail);
    const from = `${fromLocal}@${sendDomain}`;
    const subject = `#${storeNumber}`;
    const fileListHtml = keys.map((k) => `<li>${escapeHtml(String(k).split('/').pop())}</li>`).join('');
    const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;color:#222;"><h2 style="color:#4a7fb5;margin:0 0 8px;">Print at Store — #${storeNumber}${storeCity ? ` (${escapeHtml(storeCity)})` : ''}</h2><p>Requested by: <strong>${escapeHtml(userEmail)}</strong></p><p><strong>${attachments.length}</strong> file(s) attached:</p><ul>${fileListHtml}</ul><p style="color:#888;font-size:.85em;margin-top:20px;">Sent via the Dump Bin print-at-store workflow.</p></div>`;

    try {
      const printPayload = {
        from: `Dump Bin <${from}>`,
        to: [printRecipient],
        cc: [userEmail],
        subject,
        html,
        attachments,
      };
      addReplyTo(printPayload, { userEmail });
      const { data, error } = await dispatchTrackedEmail(resend, {
        sourceType: 'dump-bin-print-at-store',
        sourceRef: storeNumber,
        sentByEmail: userEmail,
        metadata: { storeNumber, fileCount: attachments.length, subject },
      }, printPayload);
      if (error) {
        log.error('[dump-bin print-at-store] Resend rejected', {
          error,
          from,
          to: printRecipient,
          fileCount: attachments.length,
          totalBytes,
        });
        const msg = error.message ?? String(error);
        return res.status(502).json({ error: `Resend error: ${msg}` });
      }
      return res.json({
        ok: true,
        emailId: data?.id,
        from,
        to: printRecipient,
        cc: userEmail,
        subject,
        fileCount: attachments.length,
        totalSize: totalBytes,
      });
    } catch (err) {
      log.error('[dump-bin print-at-store] Resend', err);
      return res.status(502).json({ error: `Resend error: ${err.message || err}` });
    }
  });

  return router;
}

module.exports = createDumpBinRouter;
