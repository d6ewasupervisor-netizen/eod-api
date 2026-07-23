'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const r2 = require('../lib/dump-bin-r2');
const { addReplyTo } = require('../lib/resend-reply-to');
const { dispatchTrackedEmail } = require('../lib/resend-outbox');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BYTES = 35 * 1024 * 1024;
const MAX_RECIPIENTS = 20;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeRecipients(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const email = String(item || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

function createEodEmailMaterialsRouter({ resend, logger }) {
  const router = express.Router();
  const log = logger || {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };

  /**
   * POST /api/eod/email-materials
   * Body: {
   *   to: string[],
   *   keys?: string[],
   *   attachments?: [{ filename, content }], // base64 (page extracts)
   *   subject?: string,
   *   note?: string,
   *   storeNumber?: string
   * }
   */
  router.post('/email-materials', requireAuth, async (req, res) => {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    if (!resend) {
      return res.status(500).json({ error: 'Email service not available' });
    }

    const sendDomain = (process.env.SEND_DOMAIN || 'the-dump-bin.com').trim();
    const to = normalizeRecipients(req.body?.to);
    if (to.length === 0) {
      return res.status(400).json({ error: 'at least one valid recipient email is required' });
    }

    const keys = Array.isArray(req.body?.keys)
      ? [...new Set(req.body.keys.map((k) => String(k || '').trim()).filter(Boolean))]
      : [];
    const inlineAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (keys.length === 0 && inlineAttachments.length === 0) {
      return res.status(400).json({ error: 'no files selected' });
    }
    if (keys.length > 0 && !r2.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Dump bin R2 is not configured' });
    }

    const attachments = [];
    const fileListRows = [];
    let totalBytes = 0;

    for (const fileKey of keys) {
      let buf;
      try {
        buf = await r2.getObjectBuffer(fileKey);
      } catch (e) {
        if (e.code === 'NOT_FOUND') continue;
        if (e.code === 'DUMP_BIN_NOT_CONFIGURED') {
          return res.status(503).json({ ok: false, error: e.message });
        }
        log.error('[eod email-materials] getObjectBuffer', e);
        return res.status(500).json({ error: e.message || 'Failed to read files' });
      }
      totalBytes += buf.length;
      if (totalBytes > MAX_BYTES) {
        return res.status(413).json({
          error: `Selection too large (${(totalBytes / 1048576).toFixed(1)}MB). Please split into smaller requests.`,
        });
      }
      const baseName = fileKey.split('/').pop() || 'file';
      attachments.push({ filename: baseName, content: buf.toString('base64') });
      fileListRows.push(`<li>${escapeHtml(baseName)}</li>`);
    }

    for (const item of inlineAttachments) {
      const filename = String(item?.filename || 'attachment.pdf').trim() || 'attachment.pdf';
      const content = String(item?.content || '').replace(/\s+/g, '');
      if (!content) continue;
      const approxBytes = Math.floor((content.length * 3) / 4);
      totalBytes += approxBytes;
      if (totalBytes > MAX_BYTES) {
        return res.status(413).json({
          error: `Selection too large (${(totalBytes / 1048576).toFixed(1)}MB). Please split into smaller requests.`,
        });
      }
      attachments.push({ filename, content });
      fileListRows.push(`<li>${escapeHtml(filename)}</li>`);
    }

    if (attachments.length === 0) {
      return res.status(400).json({ error: 'no readable files selected' });
    }

    const storeNumber = String(req.body?.storeNumber || '').replace(/\D/g, '');
    const note = String(req.body?.note || '').trim();
    const subject = String(req.body?.subject || '').trim()
      || (storeNumber
        ? `Dump Bin materials — store #${Number(storeNumber)}`
        : 'Dump Bin materials for your shift');

    const from = `materials@${sendDomain}`;
    const noteHtml = note
      ? `<p style="margin:12px 0;">${escapeHtml(note).replace(/\n/g, '<br>')}</p>`
      : '';
    const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;color:#222;max-width:560px;">
      <h2 style="color:#4a7fb5;margin:0 0 8px;">Dump Bin materials</h2>
      <p>Your lead (<strong>${escapeHtml(userEmail)}</strong>) sent the attached documents for review before the shift.</p>
      ${storeNumber ? `<p>Store: <strong>#${escapeHtml(String(Number(storeNumber)))}</strong></p>` : ''}
      ${noteHtml}
      <p><strong>${attachments.length}</strong> attachment(s):</p>
      <ul>${fileListRows.join('')}</ul>
      <p style="color:#888;font-size:.85em;margin-top:20px;">Sent via the EOD materials browser.</p>
    </div>`;

    try {
      const payload = {
        from: `Dump Bin Materials <${from}>`,
        to,
        cc: [userEmail],
        subject,
        html,
        attachments,
      };
      addReplyTo(payload, { userEmail });
      const { data, error } = await dispatchTrackedEmail(resend, {
        sourceType: 'eod-email-materials',
        sourceRef: storeNumber || 'materials',
        sentByEmail: userEmail,
        metadata: {
          storeNumber: storeNumber || null,
          recipientCount: to.length,
          fileCount: attachments.length,
          subject,
        },
      }, payload);

      if (error) {
        log.error('[eod email-materials] Resend rejected', { error, to, fileCount: attachments.length });
        return res.status(502).json({ error: `Resend error: ${error.message ?? String(error)}` });
      }

      return res.json({
        ok: true,
        emailId: data?.id,
        to,
        cc: userEmail,
        subject,
        fileCount: attachments.length,
        totalSize: totalBytes,
      });
    } catch (err) {
      log.error('[eod email-materials] Resend', err);
      return res.status(502).json({ error: `Resend error: ${err.message || err}` });
    }
  });

  return router;
}

module.exports = createEodEmailMaterialsRouter;
