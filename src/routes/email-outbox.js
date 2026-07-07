'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { requireAuth, requireRole } = require('../auth-middleware');
const {
  listEmails,
  getEmailById,
  resendStoredEmail,
  ingestEmailRecord,
  applyResendWebhookEvent,
  syncFromResendApi,
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

function createEmailOutboxRouter({ pool, resend, logger = console }) {
  const router = express.Router();

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

  router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
    try {
      const result = await applyResendWebhookEvent(pool, req.body || {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      logger.error?.('[email-outbox] webhook failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

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
      const result = await syncFromResendApi(resend, pool, {
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
