'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const board = require('../lib/dc-scan-board');
const notify = require('../lib/dc-scan-notify');
const { buildFinalizedPledges } = require('../lib/dc-scan-sas-build');
const {
  rescheduleVisitDates,
  reassignVisitLead,
} = require('../lib/dc-scan-sas-mutate');
const {
  newRequestId,
  createDcScanAccessRequest,
  getPendingDcScanAccessRequestForEmail,
} = require('../lib/dc-scan-access-db');
const {
  isVolunteerEmail,
  isSupervisorEmail,
  isAdminEmail,
  canParticipateInDcScan,
  normalizeEmail,
  volunteerEmails,
  supervisorEmails,
  adminEmails,
  findVolunteerByEmail,
  VOLUNTEERS,
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
      adminEmails: [...adminEmails()].sort(),
      volunteers: VOLUNTEERS.map((v) => ({
        name: v.preferredName || v.name,
        email: v.email,
        displayName: v.displayName,
      })),
      me: email,
      isVolunteer: isVolunteerEmail(email),
      isSupervisor: isSupervisorEmail(email),
      isAdmin: isAdminEmail(email),
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
      const { scope, storeId, scheduledDate, assignToEmail, force, note } = req.body || {};
      const { snapshot, pledge, previous } = await board.addPledge({
        email,
        scope,
        storeId,
        scheduledDate,
        assignToEmail,
        force,
        note,
      });
      notify.notifyClaim(resend, { pledge }).catch(() => {});
      const assignedOther = assignToEmail && normalizeEmail(assignToEmail) !== normalizeEmail(email);
      return res.json({
        success: true,
        message: assignedOther
          ? `Assigned FM ${pledge.storeId} to ${pledge.name} for ${pledge.scheduledDate}.`
          : `Claimed FM ${pledge.storeId} for ${pledge.scheduledDate}.`,
        snapshot,
        pledge,
        previous: previous
          ? { id: previous.id, name: previous.name, email: previous.email }
          : null,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Claim failed' });
    }
  });

  router.post('/admin-assign', async (req, res) => {
    try {
      const email = req.user?.email;
      if (!isAdminEmail(email) && !isSupervisorEmail(email)) {
        return res.status(403).json({ error: 'Admin access required.' });
      }
      const {
        scope,
        storeId,
        scheduledDate,
        assignToEmail,
        pledgeId,
        release,
        note,
      } = req.body || {};

      if (pledgeId) {
        const out = await board.adminReassignPledge({
          email,
          pledgeId,
          assignToEmail,
          scheduledDate,
          release: Boolean(release),
          note,
        });
        return res.json({
          success: true,
          message: out.released
            ? `Released FM ${out.pledge.storeId}.`
            : `Reassigned FM ${out.pledge.storeId} to ${out.pledge.name}.`,
          snapshot: out.snapshot,
          pledge: out.pledge,
        });
      }

      const { snapshot, pledge, previous } = await board.addPledge({
        email,
        scope,
        storeId,
        scheduledDate,
        assignToEmail,
        force: true,
        note,
      });
      notify.notifyClaim(resend, { pledge }).catch(() => {});
      return res.json({
        success: true,
        message: previous
          ? `Reassigned FM ${pledge.storeId} from ${previous.name} to ${pledge.name}.`
          : `Assigned FM ${pledge.storeId} to ${pledge.name} for ${pledge.scheduledDate}.`,
        snapshot,
        pledge,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Admin assign failed' });
    }
  });

  router.post('/reschedule', async (req, res) => {
    try {
      const email = req.user?.email;
      const { pledgeId, scheduledDate, note } = req.body || {};
      const out = await board.reschedulePledge({
        email,
        pledgeId,
        scheduledDate,
        note,
      });

      let sasError = null;
      if (out.pledge.sasVisitId) {
        try {
          await rescheduleVisitDates({
            visitId: out.pledge.sasVisitId,
            storeId: out.pledge.storeId,
            newDate: out.scheduledDate,
          });
        } catch (err) {
          sasError = err.message || 'SAS date update failed';
          console.error('[dc-scan] reschedule SAS', err);
        }
      }

      notify
        .notifyReschedule(resend, {
          pledge: out.pledge,
          previousDate: out.previousDate,
          scheduledDate: out.scheduledDate,
          actorEmail: normalizeEmail(email),
        })
        .catch(() => {});

      return res.json({
        success: !sasError,
        message: sasError
          ? `Board date updated to ${out.scheduledDate}, but SAS PROD update failed: ${sasError}`
          : `Rescheduled FM ${out.pledge.storeId} to ${out.scheduledDate}. Tyson was copied.`,
        snapshot: board.buildSnapshot(),
        pledge: out.pledge,
        sasError,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Reschedule failed' });
    }
  });

  router.post('/change-request', async (req, res) => {
    try {
      const email = req.user?.email;
      const { pledgeId, type, note, swapToStoreId, swapToDate } = req.body || {};
      const changeType = type === 'dropout' ? 'dropout' : type;
      const { snapshot, request, pledge } = await board.requestChange({
        email,
        pledgeId,
        type: changeType,
        note,
        swapToStoreId,
        swapToDate,
      });

      if (request.type === 'dropout') {
        await notify.notifyDropoutOffer(resend, { request, pledge });
        return res.json({
          success: true,
          message:
            'Teammates were emailed. Your shift is on hold until someone takes it — nothing was removed from SAS yet.',
          snapshot,
          request,
        });
      }

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

  router.post('/take-offer', async (req, res) => {
    try {
      const email = req.user?.email;
      const { requestId } = req.body || {};
      const out = await board.acceptOpenOffer({ email, requestId });

      let sasError = null;
      if (out.previous.sasVisitId && out.previous.employeeId && out.taker?.employeeId) {
        try {
          const sas = await reassignVisitLead({
            visitId: out.previous.sasVisitId,
            storeId: out.pledge.storeId,
            fromEmployeeId: out.previous.employeeId,
            toEmployeeId: out.taker.employeeId,
            shiftId: out.previous.sasShiftId,
            scheduledDate: out.pledge.scheduledDate,
          });
          if (sas.newShiftId) {
            await board.markPledgeBuildResult(out.pledge.id, {
              ok: true,
              visitId: out.previous.sasVisitId,
              shiftId: sas.newShiftId,
            });
          }
        } catch (err) {
          sasError = err.message || 'SAS lead reassignment failed';
          console.error('[dc-scan] take-offer SAS', err);
        }
      }

      notify
        .notifyOfferTaken(resend, {
          request: out.request,
          pledge: out.pledge,
          previous: out.previous,
        })
        .catch(() => {});

      return res.json({
        success: !sasError,
        message: sasError
          ? `You are assigned on the board, but SAS PROD reassignment failed: ${sasError}`
          : `You are now lead for FM ${out.pledge.storeId} on ${out.pledge.scheduledDate}.`,
        snapshot: board.buildSnapshot(),
        pledge: out.pledge,
        sasError,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Could not take open shift' });
    }
  });

  router.post('/cancel-offer', async (req, res) => {
    try {
      const email = req.user?.email;
      const { requestId } = req.body || {};
      const { snapshot, request } = await board.cancelOpenOffer({ email, requestId });
      return res.json({
        success: true,
        message: 'Open shift offer cancelled. You remain assigned.',
        snapshot,
        request,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Could not cancel offer' });
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
