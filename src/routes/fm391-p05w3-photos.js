'use strict';

const express = require('express');
const { addReplyTo } = require('../lib/resend-reply-to');

const { retailOdysseyFrom } = require('../lib/email-from');

const SUBJECT_PREFIX = '[FM391 P05W3 photos]';
const DEFAULT_RECIPIENT = 'd6ewa.supervisor@gmail.com';
const DEFAULT_FROM = retailOdysseyFrom('FM391 Photos');
const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_PHOTOS_PER_BATCH = 60;
const STORE = 'FM391';
const PERIOD_WEEK = 'P05W3';

function parseRecipients() {
  const raw = process.env.FM391_PHOTO_EMAIL_RECIPIENTS || DEFAULT_RECIPIENT;
  const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return recipients.length ? recipients : [DEFAULT_RECIPIENT];
}

function cleanBase64(input) {
  return String(input || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}

function safeAttachmentName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  return cleaned && /\.jpe?g$/i.test(cleaned) ? cleaned : `${cleaned || 'photo'}.jpg`;
}

function decodePhoto(photo) {
  const fileName = safeAttachmentName(photo.fileName);
  const buffer = Buffer.from(cleanBase64(photo.imageBase64), 'base64');
  if (!buffer.length) {
    throw new Error(`${fileName} decoded to an empty image`);
  }
  return { fileName, buffer };
}

function photoSummary(photo) {
  const meta = photo.manifest || {};
  const bay = String(photo.bayNumber || '').padStart(2, '0');
  return {
    fileName: safeAttachmentName(photo.fileName),
    category: meta.categoryName || 'Unknown category',
    pog: meta.pogShort || meta.pogId || 'Unknown POG',
    bay: bay || 'n/a',
  };
}

function buildHtml({ batchIndex, totalBatches, decodedPhotos, photos }) {
  const rows = photos.map((photo) => {
    const s = photoSummary(photo);
    return `<tr>
      <td>${escapeHtml(s.category)}</td>
      <td>${escapeHtml(s.pog)}</td>
      <td>${escapeHtml(s.bay)}</td>
      <td>${escapeHtml(s.fileName)}</td>
    </tr>`;
  }).join('');

  const totalBytes = decodedPhotos.reduce((sum, photo) => sum + photo.buffer.length, 0);
  return `<!doctype html>
<html>
<body>
  <p>FM391 P05W3 bay photos attached.</p>
  <p><strong>Batch:</strong> ${batchIndex} of ${totalBatches}<br>
  <strong>Photos:</strong> ${photos.length}<br>
  <strong>Attachment bytes:</strong> ${totalBytes.toLocaleString()}</p>
  <table border="1" cellpadding="6" cellspacing="0">
    <thead><tr><th>Category</th><th>POG</th><th>Bay</th><th>Attachment</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p>Subject and attachment names carry routing metadata for flow-automation.</p>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createFm391P05W3PhotosRouter({ resend, logger }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      store: STORE,
      periodWeek: PERIOD_WEEK,
      recipients: parseRecipients(),
      maxAttachmentBytes: MAX_EMAIL_ATTACHMENT_BYTES,
    });
  });

  router.post('/photos', async (req, res) => {
    try {
      const {
        store,
        periodWeek,
        workDate,
        batchIndex = 1,
        totalBatches = 1,
        photos,
      } = req.body || {};

      if (store !== STORE || periodWeek !== PERIOD_WEEK) {
        return res.status(400).json({ success: false, error: 'Invalid store or periodWeek for this photo app.' });
      }
      if (!Array.isArray(photos) || photos.length === 0) {
        return res.status(400).json({ success: false, error: 'photos array is required.' });
      }
      if (photos.length > MAX_PHOTOS_PER_BATCH) {
        return res.status(400).json({ success: false, error: `Too many photos in one batch; max is ${MAX_PHOTOS_PER_BATCH}.` });
      }

      const decodedPhotos = photos.map(decodePhoto);
      const totalBytes = decodedPhotos.reduce((sum, photo) => sum + photo.buffer.length, 0);
      if (totalBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
        return res.status(413).json({
          success: false,
          error: `Batch is too large after compression (${totalBytes} bytes). Send fewer photos in this batch.`,
        });
      }

      const subject = `${SUBJECT_PREFIX} batch ${batchIndex} of ${totalBatches} ${photos.length} photos`;
      const payload = {
        from: process.env.FM391_PHOTO_EMAIL_FROM || DEFAULT_FROM,
        to: parseRecipients(),
        subject,
        html: buildHtml({ batchIndex, totalBatches, decodedPhotos, photos }),
        headers: {
          'X-FM391-Photo-Store': STORE,
          'X-FM391-Photo-Period-Week': PERIOD_WEEK,
          'X-FM391-Photo-Work-Date': workDate || '',
          'X-FM391-Photo-Batch': `${batchIndex}/${totalBatches}`,
        },
        attachments: decodedPhotos.map((photo) => ({
          filename: photo.fileName,
          content: photo.buffer.toString('base64'),
        })),
      };
      addReplyTo(payload, {});

      const { data, error } = await resend.emails.send(payload);
      if (error) throw new Error(error.message || String(error));

      logger.info(
        { resendId: data?.id, count: photos.length, totalBytes, batchIndex, totalBatches },
        'FM391 P05W3 photo batch emailed'
      );
      return res.json({ success: true, resendId: data?.id, count: photos.length });
    } catch (err) {
      logger.error({ err }, 'FM391 P05W3 photo batch failed');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = {
  createFm391P05W3PhotosRouter,
  SUBJECT_PREFIX,
  MAX_EMAIL_ATTACHMENT_BYTES,
};
