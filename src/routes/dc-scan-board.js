'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const board = require('../lib/dc-scan-board');
const notify = require('../lib/dc-scan-notify');
const { buildFinalizedPledges } = require('../lib/dc-scan-sas-build');
const {
  newRequestId,
  createDcScanAccessRequest,
  getPendingDcScanAccessRequestForEmail,
} = require('../lib/dc-scan-access-db');
const {
  isVolunteerEmail,
  isSupervisorEmail,
  canParticipateInDcScan,
  normalizeEmail,
  volunteerEmails,
  supervisorEmails,
  findVolunteerByEmail,
} = require('../lib/dc-scan-inventory');

const accessRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many access requests. Try again later.' },
});

function createDcScanBoardRouter({ resend }) {
  const router = express.Router();

  router.get('/approved-users', async (req, res) => {
    const email = normalizeEmail(req.user?.email);
    let pendingAccessRequest = false;
    try {
      pendingAccessRequest = Boolean(await getPendingDcScanAccessRequestForEmail(email));
    } catch (_) {}
    res.json({
      ok: true,
      approvedEmails: [...volunteerEmails()].sort(),
      supervisorEmails: [...supervisorEmails()].sort(),
      me: email,
      isVolunteer: isVolunteerEmail(email),
      isSupervisor: isSupervisorEmail(email),
      canParticipate: canParticipateInDcScan(email),
      pendingAccessRequest,
    });
  });

  router.post('/access-request', accessRequestLimiter, async (req, res) => {
    try {
      const email = normalizeEmail(req.user?.email);
      if (!email) {
        return res.status(401).json({ error: 'Signed-in email is required.' });
      }
      if (canParticipateInDcScan(email)) {
        return res.status(400).json({ error: 'Your account already has DC Scan access.' });
      }

      const pending = await getPendingDcScanAccessRequestForEmail(email);
      if (pending) {
        return res.json({
          success: true,
          message: 'Your access request is already pending supervisor approval.',
          pending: true,
        });
      }

      const volunteer = findVolunteerByEmail(email);
      const rawName = req.body?.name ? String(req.body.name) : '';
      const name = (rawName.trim() || volunteer?.name || email.split('@')[0]).slice(0, 200);
      const reason = String(req.body?.reason || '').trim().slice(0, 1000) || null;

      const id = newRequestId();
      const record = await createDcScanAccessRequest({ id, name, email, reason });
      await notify.notifyDcScanAccessRequest(resend, { record });

      return res.json({
        success: true,
        message: 'Access request sent. Your supervisor will review it shortly.',
        pending: true,
      });
    } catch (err) {
      console.error('[dc-scan] access-request', err);
      return res.status(500).json({ error: err.message || 'Could not submit access request.' });
    }
  });

  router.get('/', (req, res) => {
    res.json({ success: true, snapshot: board.buildSnapshot() });
  });

  router.get('/events', (req, res) => {
    board.subscribe(res);
  });

  router.post('/claim', async (req, res) => {
    try {
      const email = req.user?.email;
      const { scope, storeId, scheduledDate } = req.body || {};
      const { snapshot, pledge } = await board.addPledge({
        email,
        scope,
        storeId,
        scheduledDate,
      });
      notify.notifyClaim(resend, { pledge }).catch(() => {});
      return res.json({
        success: true,
        message: `Claimed FM ${pledge.storeId} for ${pledge.scheduledDate}.`,
        snapshot,
        pledge,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Claim failed' });
    }
  });

  router.post('/change-request', async (req, res) => {
    try {
      const email = req.user?.email;
      const { pledgeId, type, note, swapToStoreId, swapToDate } = req.body || {};
      const { snapshot, request, pledge } = await board.requestChange({
        email,
        pledgeId,
        type,
        note,
        swapToStoreId,
        swapToDate,
      });
      await notify.notifyChangeRequest(resend, { request, pledge });
      return res.json({
        success: true,
        message: 'Change request sent for supervisor approval.',
        snapshot,
        request,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Change request failed' });
    }
  });

  router.post('/send-invite', async (req, res) => {
    try {
      if (!isSupervisorEmail(req.user?.email)) {
        return res.status(403).json({ error: 'Supervisor access required.' });
      }
      const result = await notify.notifyVolunteerInvite(resend);
      if (result?.error) {
        return res.status(500).json({
          error: result.error.message || 'Failed to send volunteer invite email.',
        });
      }
      return res.json({
        success: true,
        message: 'Volunteer invite email sent.',
        emailId: result?.data?.id || result?.recordId || null,
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message || 'Failed to send volunteer invite email.',
      });
    }
  });

  router.post('/resync', async (req, res) => {
    try {
      const out = await board.resyncProd({ forceSas: true });
      if (out.busy) {
        return res.status(409).json({
          error: 'A PROD sync is already running. Try again in a few seconds.',
        });
      }
      const prod = out.prod || {};
      const sas = out.sas || {};
      let message = 'SAS PROD schedule refreshed.';
      if (!sas.sessionAlive) {
        message = sas.error || 'SAS session is still not active after refresh attempt.';
      } else if (!prod.ok) {
        message = prod.error || 'SAS session is up but PROD fetch failed.';
      } else {
        message = `SAS connected · ${prod.visitCount || 0} visit(s) loaded from project 8081.`;
      }
      return res.json({
        success: Boolean(sas.sessionAlive && prod.ok),
        message,
        snapshot: out.snapshot,
        prod: {
          ok: prod.ok,
          sessionAlive: prod.sessionAlive,
          syncedAt: prod.syncedAt,
          visitCount: (prod.visits || []).length,
          error: prod.error || null,
          sas,
        },
      });
    } catch (err) {
      return res.status(500).json({
        error: err.message || 'PROD resync failed',
      });
    }
  });

  router.post('/finalize', async (req, res) => {
    try {
      const email = req.user?.email;
      const { snapshot, pledges, finalization } = await board.finalizeSelections({ email });

      let buildResults = [];
      let buildError = null;
      try {
        const built = await buildFinalizedPledges(pledges);
        buildResults = built.results || [];
      } catch (err) {
        buildError = err.message || 'SAS build failed';
        console.error('[dc-scan] finalize build', err);
      }

      await notify.notifyFinalize(resend, {
        email: normalizeEmail(email),
        name: finalization.name,
        pledges,
        buildResults,
      });

      return res.json({
        success: true,
        message: buildError
          ? `Selections locked, but SAS build hit an error: ${buildError}`
          : 'Selections locked. SAS visits/shifts queued and built where possible.',
        snapshot: board.buildSnapshot(),
        buildResults,
        buildError,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Finalize failed' });
    }
  });

  return router;
}

async function applyDcScanDecision(requestId, decision, resolvedBy) {
  const out = await board.applyChangeDecision(requestId, decision, resolvedBy);
  return out;
}

module.exports = {
  createDcScanBoardRouter,
  applyDcScanDecision,
  initDcScanBoard: board.init,
  startDcScanProdSync: board.startProdSync,
};
