/**
 * InstaWork routes for eod-api — same JSON contract as flow-automation
 * /instawork/save-image. Delivery defaults: Resend email
 * (instawork@retail-odyssey.com → Gmail poller → OneDrive). Optional: Graph, local disk.
 */

const express = require('express');
const fs = require('fs').promises;
const { getPeriodWeekForDate, formatPeriodWeekUnpadded } = require('./lib/fiscal-calendar');
const { deliverInstaworkImage, graphConfigured, parseEmailRecipients } = require('./lib/instawork-delivery');

function parseWorkDate(input) {
  if (!input) return new Date();
  if (input instanceof Date) return input;

  const s = String(input);

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
  }

  const usMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (usMatch) {
    const [, m2, d2, y2] = usMatch;
    const year = y2.length === 2 ? 2000 + parseInt(y2, 10) : parseInt(y2, 10);
    return new Date(year, parseInt(m2, 10) - 1, parseInt(d2, 10));
  }

  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

function formatMmDdYyyyUnderscored(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${mm}_${dd}_${yyyy}`;
}

function paddedStoreNumber(storeNumber) {
  return String(storeNumber || '').replace(/\D/g, '').padStart(3, '0');
}

function createInstaworkRouter({ resend, logger, saveImageGate }) {
  const router = express.Router();
  const rootDir =
    process.env.INSTAWORK_SIGNOUT_ROOT ||
    String.raw`C:\Users\tgaut\OneDrive - Advantage Solutions\Auston Nix's files - InstaWork\InstaWork Sign Out Sheets`;

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      graph: graphConfigured(),
      localRootConfigured: !!process.env.INSTAWORK_SIGNOUT_ROOT,
      emailFallbackConfigured: parseEmailRecipients().length > 0,
    });
  });

  // Optional gate (e.g. requireDayConfirm) — applied only to the mutating
  // save route so /health stays trivially reachable.
  const gates = typeof saveImageGate === 'function' ? [saveImageGate] : [];

  router.post('/save-image', ...gates, async (req, res) => {
    try {
      const { storeNumber, workDate, imageBase64 } = req.body || {};

      if (!storeNumber) {
        return res.status(400).json({ success: false, error: 'storeNumber is required' });
      }
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ success: false, error: 'imageBase64 is required' });
      }

      const date = parseWorkDate(workDate);
      const pw = getPeriodWeekForDate(date);
      if (!pw) {
        return res.status(400).json({
          success: false,
          error: `No fiscal period/week defined for date ${date.toISOString().slice(0, 10)}`,
        });
      }

      const cleaned = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
      const buffer = Buffer.from(cleaned, 'base64');
      if (!buffer.length) {
        return res.status(400).json({ success: false, error: 'imageBase64 decoded to empty buffer' });
      }

      const periodWeekLabel = `P${pw.periodStr}W${pw.weekStr}`;
      const fileName = `FM${paddedStoreNumber(storeNumber)} ${formatMmDdYyyyUnderscored(date)}.jpg`;

      const result = await deliverInstaworkImage({
        rootDir,
        period: pw.period,
        week: pw.week,
        periodWeekLabel,
        fileName,
        storeNumber,
        workDate: date.toISOString().slice(0, 10),
        buffer,
        resend,
        log: logger,
      });

      const folderName =
        result.resolvedFolderBasename || formatPeriodWeekUnpadded(pw.period, pw.week);

      logger.info(
        {
          delivery: result.delivery,
          folder: folderName,
          periodWeek: periodWeekLabel,
          fiscalYear: pw.fiscalYear,
        },
        'InstaWork sign-out sheet image saved (eod-api)',
      );

      return res.json({
        success: true,
        filePath: result.filePath,
        folder: folderName,
        periodWeek: periodWeekLabel,
        fiscalYear: pw.fiscalYear,
        delivery: result.delivery,
      });
    } catch (err) {
      logger.error({ err }, 'InstaWork sign-out sheet image save failed (eod-api)');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createInstaworkRouter };
