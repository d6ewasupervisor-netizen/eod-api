'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { Webhook } = require('svix');
const { requireAuth, requireRole } = require('../auth-middleware');
const {
  listEmails,
  getEmailById,
  getEmailAttachment,
  buildEmailEml,
  contentDispositionHeader,
  resendStoredEmail,
  ingestEmailRecord,
  applyResendWebhookEvent,
  syncFromResendAccounts,
  editEmailRecord,
  deleteEmailRecord,
  purgeEmailsOlderThan,
  retentionDays,
} = require('../lib/resend-outbox');

function bearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function safeTokenEquals(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireIngestKey(req, res, next) {
  const expected = String(process.env.EMAIL_OUTBOX_INGEST_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'Email outbox ingest is not configured' });
  }
  const token = bearerToken(req);
  if (!token || !safeTokenEquals(token, expected)) {
    return res.status(401).json({ ok: false, error: 'Invalid ingest key' });
  }
  return next();
}

function createEmailOutboxRouter({ pool, resend, resendSyncAccounts, logger = console }) {
  const router = express.Router();
  // Fall back to a single-account sync (using the primary `resend` client)
  // when no explicit multi-account list was wired up by the caller.
  const syncAccounts = Array.isArray(resendSyncAccounts) && resendSyncAccounts.length
    ? resendSyncAccounts
    : [{ client: resend, label: null }];

  router.post('/ingest', requireIngestKey, async (req, res) => {
    try {
      const result = await ingestEmailRecord(pool, req.body || {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.error?.('[email-outbox] ingest failed:', err.message);
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  router.post(
    '/webhook',
    // Body is already parsed by the app-level express.json() in index.js,
    // which also captures req.rawBody (needed for svix signature
    // verification below) — no route-level parser needed here.
    async (req, res) => {
      // We send from more than one Resend account (retail-odyssey.com on the
      // primary key, the-dump-bin.com signoffs on RESEND_SIGNOFF_API_KEY — see
      // index.js), and each account has its own webhook endpoint + signing
      // secret in the Resend dashboard even though both point at this same
      // URL. Accept the payload if it verifies against ANY configured secret.
      const secrets = [
        String(process.env.RESEND_WEBHOOK_SECRET || '').trim(),
        String(process.env.RESEND_SIGNOFF_WEBHOOK_SECRET || '').trim(),
      ].filter(Boolean);

      if (secrets.length) {
        const verified = secrets.some((secret) => {
          try {
            const wh = new Webhook(secret);
            wh.verify(req.rawBody, {
              'svix-id': req.headers['svix-id'],
              'svix-timestamp': req.headers['svix-timestamp'],
              'svix-signature': req.headers['svix-signature'],
            });
            return true;
          } catch (_err) {
            return false;
          }
        });
        if (!verified) {
          logger.error?.('[email-outbox] webhook signature verification failed against all configured secrets');
          return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
        }
      } else {
        logger.warn?.(
          '[email-outbox] No RESEND_WEBHOOK_SECRET(S) set — accepting unverified webhook payloads. '
          + 'Set RESEND_WEBHOOK_SECRET (retail-odyssey) / RESEND_SIGNOFF_WEBHOOK_SECRET (the-dump-bin) '
          + 'from the Resend dashboard webhook endpoints to enable signature verification.',
        );
      }
      try {
        const result = await applyResendWebhookEvent(pool, req.body || {});
        return res.json({ ok: true, ...result });
      } catch (err) {
        logger.error?.('[email-outbox] webhook failed:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
    },
  );

  router.use(requireAuth);
  router.use(requireRole('admin', 'supervisor'));

  router.get('/', async (req, res) => {
    try {
      const data = await listEmails(pool, {
        page: req.query.page,
        pageSize: req.query.pageSize,
        status: req.query.status,
        deliveryStatus: req.query.deliveryStatus,
        sourceSystem: req.query.sourceSystem,
        sourceType: req.query.sourceType,
        search: req.query.search,
        since: req.query.since,
        until: req.query.until,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
      });
      return res.json({ ok: true, ...data });
    } catch (err) {
      logger.error?.('[email-outbox] list failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/sources', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT source_system, source_type, COUNT(*)::int AS count
         FROM sent_emails
         GROUP BY source_system, source_type
         ORDER BY source_system, source_type`,
      );
      return res.json({ ok: true, sources: rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/sync/resend', async (req, res) => {
    try {
      const result = await syncFromResendAccounts(syncAccounts, pool, {
        limit: req.body?.limit,
        maxPages: req.body?.maxPages,
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/purge', async (req, res) => {
    try {
      const days = req.body?.olderThanDays ?? retentionDays();
      const result = await purgeEmailsOlderThan(pool, days);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const item = await getEmailById(pool, Number(req.params.id));
      if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.json({ ok: true, item });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Download the full stored email as a .eml (RFC 822) file. */
  router.get('/:id/download', async (req, res) => {
    try {
      const eml = await buildEmailEml(pool, Number(req.params.id));
      res.setHeader('Content-Type', eml.contentType);
      res.setHeader('Content-Disposition', contentDispositionHeader(eml.filename, { inline: false }));
      res.setHeader('Content-Length', String(eml.content.length));
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).send(eml.content);
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  /**
   * Download or view a single attachment.
   * Query: disposition=inline|attachment (default attachment).
   * Also accepts ?inline=1 as a shorthand for disposition=inline.
   */
  router.get('/:id/attachments/:index', async (req, res) => {
    try {
      const att = await getEmailAttachment(pool, Number(req.params.id), Number(req.params.index));
      const wantInline = String(req.query.disposition || '').toLowerCase() === 'inline'
        || req.query.inline === '1'
        || req.query.inline === 'true';
      const inline = wantInline && att.viewable;
      res.setHeader('Content-Type', att.contentType);
      res.setHeader('Content-Disposition', contentDispositionHeader(att.filename, { inline }));
      res.setHeader('Content-Length', String(att.content.length));
      res.setHeader('Cache-Control', 'private, no-store');
      // Allow same-origin iframe/img viewing when opened as a blob URL from the UI.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(att.content);
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  router.post('/:id/resend', async (req, res) => {
    try {
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

  router.patch('/:id', async (req, res) => {
    try {
      const body = req.body || {};
      const item = await editEmailRecord(pool, Number(req.params.id), {
        subject: body.subject,
        to: body.to,
        cc: body.cc,
        htmlBody: body.htmlBody,
        textBody: body.textBody,
        deliveryStatus: body.deliveryStatus,
        resendAllowed: body.resendAllowed,
        compact: body.compact === true,
      }, { editedByEmail: req.user?.email });
      return res.json({ ok: true, item });
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const result = await deleteEmailRecord(pool, Number(req.params.id));
      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createEmailOutboxRouter };
