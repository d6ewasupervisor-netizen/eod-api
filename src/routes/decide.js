// GET/POST /api/decide/:type/:id
//
// Supervisor review flow for store override + shift removal (JSON API for
// the-dump-bin.com/decide.html). GET is strictly read-only. Mounted like
// whoami.js / weeks.js via app.use('/api/decide', createDecideRouter(...)).

'use strict';

const express = require('express');
const { pool } = require('../lib/db');
const { verifyReviewToken } = require('../lib/decision-review-jwt');
const { applyStoreConfirmDecision, STORE_CONFIRM_REQUEST_EXPIRY_MS } = require('../store-confirmation');
const { applyShiftDecision, SHIFT_REQUEST_EXPIRY_MS } = require('../shift-management');

function iso(ms) {
  return new Date(ms).toISOString();
}

function mapType(param) {
  if (param === 'store') return 'store';
  if (param === 'shift') return 'shift';
  return null;
}

function jwtExpMs(verified) {
  if (verified.exp && Number.isFinite(verified.exp)) {
    return verified.exp * 1000;
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

function createDecideRouter({ resend }) {
  const router = express.Router();

  router.get('/:type/:id', async (req, res) => {
    const t = mapType(req.params.type);
    const id = String(req.params.id || '').trim();
    const token = req.query.token;
    if (!t || !id || !token) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    let verified;
    try {
      verified = verifyReviewToken(String(token), { expectedRequestId: id, expectedType: t });
    } catch (e) {
      const name = e && e.name;
      const err =
        name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token';
      return res.status(401).json({ ok: false, error: err });
    }

    try {
      if (t === 'store') {
        const { rows } = await pool.query(
          'SELECT * FROM store_confirm_requests WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        const r = rows[0];
        const created = new Date(r.created_at).getTime();
        const requestCutoff = created + STORE_CONFIRM_REQUEST_EXPIRY_MS;
        let status = r.status;
        if (status === 'pending' && Date.now() > requestCutoff) {
          status = 'expired';
        }
        const expiresMs = Math.min(jwtExpMs(verified), requestCutoff);
        return res.json({
          ok: true,
          status,
          requestedBy: r.requested_by_email,
          storeNumber: r.store_number,
          date: r.date,
          reason: r.reason || null,
          memberName: null,
          requestedAt: r.created_at,
          expiresAt: iso(expiresMs),
        });
      }

      const { rows } = await pool.query('SELECT * FROM shift_requests WHERE id = $1', [id]);
      if (!rows.length) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const r = rows[0];
      const remove = Array.isArray(r.remove) ? r.remove : [];
      const memberName =
        remove
          .map((x) => (x && x.name ? String(x.name) : ''))
          .filter(Boolean)
          .join(', ') || null;
      const created = new Date(r.created_at).getTime();
      const requestCutoff = created + SHIFT_REQUEST_EXPIRY_MS;
      let status = r.status;
      if (status === 'pending' && Date.now() > requestCutoff) {
        status = 'expired';
      }
      const expiresMs = Math.min(jwtExpMs(verified), requestCutoff);
      return res.json({
        ok: true,
        status,
        requestedBy: r.requested_by,
        storeNumber: r.store_number,
        date: r.date,
        reason: null,
        memberName,
        requestedAt: r.created_at,
        expiresAt: iso(expiresMs),
      });
    } catch (err) {
      console.error('[decide GET]', err);
      return res.status(500).json({ ok: false, error: 'server' });
    }
  });

  router.post('/:type/:id', async (req, res) => {
    const t = mapType(req.params.type);
    const id = String(req.params.id || '').trim();
    const token = req.body && req.body.token;
    const decision = req.body && req.body.decision;

    if (!t || !id || !token) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }
    if (decision !== 'approved' && decision !== 'denied') {
      return res.status(400).json({ ok: false, error: 'invalid_decision' });
    }

    let verified;
    try {
      verified = verifyReviewToken(String(token), { expectedRequestId: id, expectedType: t });
    } catch (e) {
      const err =
        e && e.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token';
      return res.status(401).json({ ok: false, error: err });
    }
    void verified;

    try {
      if (t === 'store') {
        const out = await applyStoreConfirmDecision(pool, id, decision);
        if (!out.ok && out.error === 'not_found') {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        if (!out.ok) {
          return res.status(500).json({ ok: false, error: out.error || 'server' });
        }
        return res.json({ ok: true, status: out.status });
      }

      const out = await applyShiftDecision(pool, resend, id, decision);
      if (!out.ok && out.error === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      if (!out.ok && out.error === 'sas_inactive') {
        return res.status(503).json({ ok: false, error: 'sas_inactive' });
      }
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || 'server' });
      }
      return res.json({ ok: true, status: out.status });
    } catch (err) {
      console.error('[decide POST]', err);
      return res.status(500).json({ ok: false, error: 'server' });
    }
  });

  return router;
}

module.exports = createDecideRouter;
