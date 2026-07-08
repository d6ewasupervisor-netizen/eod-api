'use strict';

const express = require('express');
const board = require('../lib/dc-scan-board');
const notify = require('../lib/dc-scan-notify');
const { buildFinalizedPledges } = require('../lib/dc-scan-sas-build');
const {
  isVolunteerEmail,
  isSupervisorEmail,
  normalizeEmail,
  volunteerEmails,
  supervisorEmails,
} = require('../lib/dc-scan-inventory');

function createDcScanBoardRouter({ resend }) {
  const router = express.Router();

  router.get('/approved-users', (req, res) => {
    res.json({
      ok: true,
      approvedEmails: [...volunteerEmails()].sort(),
      supervisorEmails: [...supervisorEmails()].sort(),
      me: normalizeEmail(req.user?.email),
      isVolunteer: isVolunteerEmail(req.user?.email),
      isSupervisor: isSupervisorEmail(req.user?.email),
    });
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
};
