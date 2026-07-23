'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../auth-middleware');
const { addReplyTo } = require('../lib/resend-reply-to');
const { dispatchTrackedEmail } = require('../lib/resend-outbox');

const SHEETS = {
  instawork: {
    filename: 'Instawork_Time_Sheet.pdf',
    label: 'InstaWork Time Sheet',
  },
  kompass: {
    filename: 'Kompass_Daily_Time_Tracker.pdf',
    label: 'Kompass Daily Time Tracker',
  },
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeStoreNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

function createEodPrintTimesheetRouter({ resend, logger }) {
  const router = express.Router();
  const log = logger || {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };

  /**
   * POST /api/eod/print-timesheet
   * Body: { storeNumber, sheet: 'instawork'|'kompass' }
   *
   * Same email-to-fax pipeline as Dump Bin print-at-store:
   * Resend → PRINT_RECIPIENT with subject `#storeNumber` → flow-automation
   * Metrofax → store customer service desk fax.
   */
  router.post('/print-timesheet', requireAuth, async (req, res) => {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'not authenticated' });
    }

    const printRecipient = (process.env.PRINT_RECIPIENT || '').trim();
    const sendDomain = (process.env.SEND_DOMAIN || '').trim();
    if (!printRecipient || !sendDomain) {
      return res.status(500).json({
        error: 'Print at store is not configured (PRINT_RECIPIENT / SEND_DOMAIN)',
      });
    }
    if (!resend) {
      return res.status(500).json({ error: 'Email service not available' });
    }

    const sheetKey = String(req.body?.sheet || '').trim().toLowerCase();
    const sheet = SHEETS[sheetKey];
    if (!sheet) {
      return res.status(400).json({
        error: 'sheet must be "instawork" or "kompass"',
      });
    }

    const storeNumber = normalizeStoreNumber(req.body?.storeNumber);
    if (!storeNumber) {
      return res.status(400).json({ error: 'store number is required' });
    }

    const pdfPath = path.join(__dirname, '..', 'assets', 'timesheets', sheet.filename);
    let buf;
    try {
      buf = fs.readFileSync(pdfPath);
    } catch (err) {
      log.error('[eod print-timesheet] missing asset', { pdfPath, err: err.message });
      return res.status(500).json({ error: `Timesheet PDF not available: ${sheet.filename}` });
    }

    const from = `fax@${sendDomain}`;
    const subject = `#${storeNumber}`;
    const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;color:#222;">
      <h2 style="color:#4a7fb5;margin:0 0 8px;">EOD Timesheet Print — #${escapeHtml(storeNumber)}</h2>
      <p>Requested by: <strong>${escapeHtml(userEmail)}</strong></p>
      <p>Document: <strong>${escapeHtml(sheet.label)}</strong></p>
      <p style="color:#888;font-size:.85em;margin-top:20px;">Sent via the EOD print-timesheet workflow (email-to-fax).</p>
    </div>`;

    try {
      const printPayload = {
        from: `Dump Bin <${from}>`,
        to: [printRecipient],
        cc: [userEmail],
        subject,
        html,
        attachments: [
          {
            filename: sheet.filename,
            content: buf.toString('base64'),
          },
        ],
      };
      addReplyTo(printPayload, { userEmail });
      const { data, error } = await dispatchTrackedEmail(resend, {
        sourceType: 'eod-print-timesheet',
        sourceRef: `${sheetKey}:${storeNumber}`,
        sentByEmail: userEmail,
        metadata: {
          storeNumber,
          sheet: sheetKey,
          filename: sheet.filename,
          subject,
        },
      }, printPayload);

      if (error) {
        log.error('[eod print-timesheet] Resend rejected', {
          error,
          from,
          to: printRecipient,
          storeNumber,
          sheet: sheetKey,
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
        sheet: sheetKey,
        label: sheet.label,
        storeNumber,
        fileCount: 1,
      });
    } catch (err) {
      log.error('[eod print-timesheet] Resend', err);
      return res.status(502).json({ error: `Resend error: ${err.message || err}` });
    }
  });

  return router;
}

module.exports = createEodPrintTimesheetRouter;
