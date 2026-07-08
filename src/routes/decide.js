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
const {
  getRequestById,
  loadBayPhotoPayload,
  applyProdDispatchDecision,
} = require('../hub-prod-dispatch');
const board = require('../lib/dc-scan-board');
const { notifyChangeResolved } = require('../lib/dc-scan-notify');

const DC_SCAN_REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function mapType(param) {
  if (param === 'store') return 'store';
  if (param === 'shift') return 'shift';
  if (param === 'prod') return 'prod';
  if (param === 'dcscan') return 'dcscan';
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

  router.get('/prod/:id/bay/:bayNum/image', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const bayNum = Number(req.params.bayNum);
    const token = req.query.token;
    if (!id || !Number.isFinite(bayNum) || !token) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }
    try {
      verifyReviewToken(String(token), { expectedRequestId: id, expectedType: 'prod' });
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    try {
      const row = await getRequestById(Number(id));
      if (!row) return res.status(404).end();
      const { loadBayPhotoRow } = require('../hub-bay-photos');
      const photo = await loadBayPhotoRow(Number(row.visit_id), row.dbkey, row.lane, bayNum);
      if (!photo) return res.status(404).end();
      const buf = Buffer.from(photo.photo_base64, 'base64');
      res.setHeader('Content-Type', photo.content_type || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buf);
    } catch (err) {
      console.error('[decide prod image]', err);
      return res.status(500).end();
    }
  });

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
      if (t === 'prod') {
        const { rows } = await pool.query(
          'SELECT * FROM hub_prod_dispatch_requests WHERE id = $1',
          [id],
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        const r = rows[0];
        const created = new Date(r.created_at).getTime();
        const requestCutoff = created + 24 * 60 * 60 * 1000;
        let status = r.status;
        if (status === 'pending' && Date.now() > requestCutoff) {
          status = 'expired';
        }
        const expiresMs = Math.min(jwtExpMs(verified), requestCutoff);
        const photos = await loadBayPhotoPayload(
          Number(r.visit_id),
          r.lane,
          r.dbkey,
        );
        const photoUrls = photos.map((p) => ({
          bay_num: p.bay_num,
          url: `/api/decide/prod/${id}/bay/${p.bay_num}/image?token=${encodeURIComponent(String(token))}`,
        }));
        return res.json({
          ok: true,
          status,
          requestedBy: r.signed_off_by_email,
          signedOffByName: r.signed_off_by_name,
          storeNumber: r.store_number,
          visitId: Number(r.visit_id),
          lane: r.lane || '',
          dbkey: r.dbkey,
          setName: r.set_name,
          manifestPogId: r.manifest_pog_id,
          actionCode: r.action_code,
          matchedResetName: r.matched_reset_name,
          uploadResult: r.upload_result,
          bayCount: photos.length,
          photos: photoUrls,
          requestedAt: r.signed_off_at || r.created_at,
          expiresAt: iso(expiresMs),
        });
      }

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

      if (t === 'dcscan') {
        const r = board.getChangeRequest(id);
        if (!r) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        const created = new Date(r.requestedAt).getTime();
        const requestCutoff = created + DC_SCAN_REQUEST_EXPIRY_MS;
        let status = r.status;
        if (status === 'pending' && Date.now() > requestCutoff) {
          status = 'expired';
        }
        const expiresMs = Math.min(jwtExpMs(verified), requestCutoff);
        const reasonParts = [
          `Type: ${r.type}`,
          r.note ? `Note: ${r.note}` : null,
          r.type === 'swap'
            ? `Swap to FM ${r.swapToStoreId} on ${r.swapToDate}`
            : null,
        ].filter(Boolean);
        return res.json({
          ok: true,
          status,
          requestedBy: r.requestedByEmail,
          storeNumber: r.storeId,
          date: r.scheduledDate,
          reason: reasonParts.join(' · '),
          memberName: r.requestedByName || null,
          requestedAt: r.requestedAt,
          expiresAt: iso(expiresMs),
          changeType: r.type,
          swapToStoreId: r.swapToStoreId || null,
          swapToDate: r.swapToDate || null,
        });
      }

      if (t !== 'shift') {
        return res.status(400).json({ ok: false, error: 'invalid_type' });
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
      if (t === 'prod') {
        const out = await applyProdDispatchDecision(Number(id), decision);
        if (!out.ok && out.error === 'not_found') {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        if (!out.ok && out.error === 'sas_inactive') {
          return res.status(503).json({ ok: false, error: 'sas_inactive' });
        }
        if (!out.ok) {
          return res.status(500).json({ ok: false, error: out.error || 'server' });
        }
        return res.json({ ok: true, status: out.status, uploadResult: out.uploadResult || null });
      }

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

      if (t === 'dcscan') {
        const out = await board.applyChangeDecision(id, decision, verified.approverEmail);
        if (!out.ok && out.error === 'not_found') {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        if (!out.ok) {
          return res.status(500).json({ ok: false, error: out.error || 'server' });
        }
        if (out.request) {
          notifyChangeResolved(resend, {
            request: out.request,
            status: out.status,
          }).catch((err) => console.error('[decide dcscan notify]', err.message));
        }
        return res.json({ ok: true, status: out.status });
      }

      if (t !== 'shift') {
        return res.status(400).json({ ok: false, error: 'invalid_type' });
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
