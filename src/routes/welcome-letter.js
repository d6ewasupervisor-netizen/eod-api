'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const {
  dispatchTrackedEmail,
  listEmails,
  getEmailById,
  resendStoredEmail,
} = require('../lib/resend-outbox');
const {
  buildWelcomeLetter,
  buildResendPayload,
  validateWelcomeLetterInput,
} = require('../lib/welcome-letter-email');

const SOURCE_TYPE = 'welcome-letter';

function createWelcomeLetterRouter({ resend, logger, pool }) {
  const router = express.Router();
  const log = logger || console;

  router.post('/preview', requireAuth, (req, res) => {
    try {
      const letter = buildWelcomeLetter({ ...(req.body || {}), forPreview: true });
      return res.json({
        ok: true,
        to: letter.to,
        cc: letter.cc,
        from: letter.from,
        replyTo: letter.replyTo,
        subject: letter.subject,
        html: letter.html,
        text: letter.text,
        firstName: letter.firstName,
      });
    } catch (err) {
      const status = err.statusCode || 400;
      return res.status(status).json({
        ok: false,
        error: err.message || 'Invalid welcome letter input',
        errors: err.errors || undefined,
      });
    }
  });

  router.post('/send', requireAuth, async (req, res) => {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ ok: false, error: 'not authenticated' });
    }
    if (!resend) {
      return res.status(500).json({ ok: false, error: 'Email service not available' });
    }

    const validation = validateWelcomeLetterInput(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        error: validation.errors.join('; '),
        errors: validation.errors,
      });
    }

    let letter;
    try {
      letter = buildWelcomeLetter(validation);
    } catch (err) {
      return res.status(err.statusCode || 400).json({
        ok: false,
        error: err.message || 'Invalid welcome letter input',
        errors: err.errors || undefined,
      });
    }

    const payload = buildResendPayload(letter);

    try {
      const { data, error, recordId } = await dispatchTrackedEmail(
        resend,
        {
          sourceType: 'welcome-letter',
          sourceRef: letter.email,
          sentByEmail: userEmail,
          metadata: {
            firstName: letter.firstName,
            hireEmail: letter.email,
          },
        },
        payload,
      );

      if (error) {
        log.error('[welcome-letter] Resend rejected', {
          error,
          to: letter.email,
          sentByEmail: userEmail,
          recordId,
        });
        const msg = error.message ?? String(error);
        return res.status(502).json({
          ok: false,
          error: `Resend error: ${msg}`,
          recordId: recordId || undefined,
        });
      }

      log.info('[welcome-letter] sent', {
        to: letter.email,
        firstName: letter.firstName,
        emailId: data?.id,
        recordId,
        sentByEmail: userEmail,
      });

      return res.json({
        ok: true,
        emailId: data?.id || null,
        recordId: recordId || null,
        to: letter.to,
        cc: letter.cc,
        from: letter.from,
        replyTo: letter.replyTo,
        subject: letter.subject,
        firstName: letter.firstName,
      });
    } catch (err) {
      log.error('[welcome-letter] send failed', err);
      return res.status(502).json({
        ok: false,
        error: `Resend error: ${err.message || err}`,
        recordId: err.recordId || undefined,
      });
    }
  });

  // ─── Welcome Letter Board ────────────────────────────────────────────────
  // Thin wrappers around the shared email-outbox tables/helpers, scoped to
  // sourceType='welcome-letter' so this is a dedicated board without a
  // separate storage layer or duplicated resend logic.

  router.get('/board', requireAuth, async (req, res) => {
    try {
      const data = await listEmails(pool, {
        page: req.query.page,
        pageSize: req.query.pageSize,
        status: req.query.status,
        deliveryStatus: req.query.deliveryStatus,
        search: req.query.search,
        since: req.query.since,
        until: req.query.until,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
        sourceType: SOURCE_TYPE,
      });
      return res.json({ ok: true, ...data });
    } catch (err) {
      log.error('[welcome-letter] board list failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/board/:id', requireAuth, async (req, res) => {
    try {
      const item = await getEmailById(pool, Number(req.params.id));
      if (!item || item.sourceType !== SOURCE_TYPE) {
        return res.status(404).json({ ok: false, error: 'Not found' });
      }
      return res.json({ ok: true, item });
    } catch (err) {
      log.error('[welcome-letter] board detail failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/board/:id/resend', requireAuth, async (req, res) => {
    try {
      const existing = await getEmailById(pool, Number(req.params.id));
      if (!existing || existing.sourceType !== SOURCE_TYPE) {
        return res.status(404).json({ ok: false, error: 'Not found' });
      }
      const result = await resendStoredEmail(resend, pool, Number(req.params.id), {
        sentByEmail: req.user?.email,
      });
      if (result.error) {
        return res.status(502).json({
          ok: false,
          error: result.error.message || String(result.error),
          recordId: result.recordId,
        });
      }
      return res.json({
        ok: true,
        resendId: result.data?.id,
        recordId: result.recordId,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createWelcomeLetterRouter };
