'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const {
  dispatchTrackedEmail,
  listEmails,
  getEmailById,
  resendStoredEmail,
  syncOpenTrackingForSourceType,
  markEmailCancelled,
  sendViaOutbox,
} = require('../lib/resend-outbox');
const {
  buildWelcomeLetter,
  buildResendPayload,
  buildDisregardLetter,
  buildDisregardResendPayload,
  validateWelcomeLetterInput,
} = require('../lib/welcome-letter-email');

const SOURCE_TYPE = 'welcome-letter';

// Welcome Letter send UI + dashboard are restricted to authorized admins only.
// Keep in sync with the-dump-bin hub cards and welcome page gates.
const WELCOME_LETTER_ALLOWED_EMAILS = new Set([
  'tyson.gauthier@retailodyssey.com',
  'tyson.gauthier@retail-odyssey.com',
  'tgauthier2011@gmail.com',
  'aiyana.natarisalazar@retailodyssey.com', // Wolf
  'd6ewa.supervisor@gmail.com', // admin
]);

function requireWelcomeLetterAccess(req, res, next) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email || !WELCOME_LETTER_ALLOWED_EMAILS.has(email)) {
    return res.status(403).json({
      ok: false,
      error: 'Welcome Letter access is limited to authorized supervisors only.',
    });
  }
  return next();
}

function createWelcomeLetterRouter({ resend, logger, pool }) {
  const router = express.Router();
  const log = logger || console;

  // Every welcome-letter route requires auth + the Tyson/Wolf allowlist.
  router.use(requireAuth, requireWelcomeLetterAccess);

  router.post('/preview', (req, res) => {
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

  router.post('/send', async (req, res) => {
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

  router.get('/board', async (req, res) => {
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

  // Refresh board rows from Resend (delivery + open/click last_event).
  // Registered before /board/:id so "refresh" is never parsed as an id.
  router.post('/board/refresh', async (req, res) => {
    if (!resend) {
      return res.status(500).json({ ok: false, error: 'Email service not available' });
    }
    try {
      const result = await syncOpenTrackingForSourceType(resend, pool, SOURCE_TYPE, {
        limit: Number(req.body?.limit) || 150,
      });
      log.info('[welcome-letter] board refresh', result);
      return res.json({ ok: true, ...result });
    } catch (err) {
      log.error('[welcome-letter] board refresh failed:', err.message);
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get('/board/:id', async (req, res) => {
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

  router.post('/board/:id/resend', async (req, res) => {
    try {
      const existing = await getEmailById(pool, Number(req.params.id));
      if (!existing || existing.sourceType !== SOURCE_TYPE) {
        return res.status(404).json({ ok: false, error: 'Not found' });
      }
      if (existing.status === 'cancelled' || !existing.canResend) {
        return res.status(403).json({
          ok: false,
          error: existing.status === 'cancelled'
            ? 'This welcome letter was cancelled — resend of this variant is not allowed. Send a new letter instead.'
            : 'This welcome letter cannot be resent.',
        });
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

  // Soft-cancel: mark original cancelled (no exact resend), send polite disregard notice.
  router.post('/board/:id/cancel', async (req, res) => {
    if (!resend) {
      return res.status(500).json({ ok: false, error: 'Email service not available' });
    }
    const id = Number(req.params.id);
    try {
      const existing = await getEmailById(pool, id);
      if (!existing || existing.sourceType !== SOURCE_TYPE) {
        return res.status(404).json({ ok: false, error: 'Not found' });
      }
      if (existing.metadata?.kind === 'disregard') {
        return res.status(400).json({
          ok: false,
          error: 'Disregard notices cannot be cancelled this way.',
        });
      }
      if (existing.status === 'cancelled') {
        return res.status(409).json({
          ok: false,
          error: 'This welcome letter is already cancelled.',
          item: existing,
        });
      }

      const toAddr = (existing.to && existing.to[0]) || existing.metadata?.hireEmail || null;
      if (!toAddr) {
        return res.status(400).json({
          ok: false,
          error: 'Cannot send disregard notice — original recipient is missing.',
        });
      }

      const firstName = existing.metadata?.firstName || 'there';
      const disregard = buildDisregardLetter({ firstName, email: toAddr });
      const payload = buildDisregardResendPayload(disregard);

      const cancelResult = await markEmailCancelled(pool, id, {
        cancelledByEmail: req.user?.email,
        reason: 'Soft recall — tools and contacts being updated; disregard notice sent',
        extraMetadata: {
          softRecalled: true,
          openedBeforeCancel: Number(existing.openCount || 0) > 0,
          openCountAtCancel: Number(existing.openCount || 0) || 0,
        },
      });

      const sendResult = await sendViaOutbox(resend, pool, {
        sourceType: SOURCE_TYPE,
        sourceRef: disregard.email,
        sentByEmail: req.user?.email,
        resendAllowed: false,
        metadata: {
          kind: 'disregard',
          firstName: disregard.firstName,
          hireEmail: disregard.email,
          cancelledParentId: id,
        },
      }, payload);

      if (sendResult.recordId && id) {
        // Link disregard notice as a child of the cancelled original.
        await pool.query('UPDATE sent_emails SET parent_id = $1 WHERE id = $2', [
          id,
          sendResult.recordId,
        ]);
      }

      if (sendResult.error) {
        log.error('[welcome-letter] disregard send failed after cancel', {
          error: sendResult.error,
          parentId: id,
          recordId: sendResult.recordId,
        });
        return res.status(502).json({
          ok: true,
          cancelled: true,
          disregardSent: false,
          error: `Letter cancelled, but disregard notice failed: ${sendResult.error.message || sendResult.error}`,
          item: cancelResult.item,
          disregardRecordId: sendResult.recordId || null,
        });
      }

      log.info('[welcome-letter] cancelled with disregard', {
        parentId: id,
        disregardRecordId: sendResult.recordId,
        to: disregard.email,
        sentByEmail: req.user?.email,
        openedBeforeCancel: Number(existing.openCount || 0) > 0,
      });

      return res.json({
        ok: true,
        cancelled: true,
        disregardSent: true,
        item: cancelResult.item,
        disregardRecordId: sendResult.recordId || null,
        disregardResendId: sendResult.data?.id || null,
        openedBeforeCancel: Number(existing.openCount || 0) > 0,
      });
    } catch (err) {
      log.error('[welcome-letter] cancel failed', err);
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = {
  createWelcomeLetterRouter,
  WELCOME_LETTER_ALLOWED_EMAILS,
  requireWelcomeLetterAccess,
};
