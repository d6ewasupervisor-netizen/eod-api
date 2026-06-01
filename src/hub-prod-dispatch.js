'use strict';

/**
 * Checklanes hub → PROD photo dispatch (manual approval gate).
 *
 * When a lead signs off a set, create a pending request for the sole approver,
 * email + in-app notification with review link. On approve, upload bay photos to
 * the matching category reset on prod.sasretail.com (by dbkey).
 *
 * Enable with HUB_PROD_DISPATCH_ENABLED=1. Approver defaults to Tyson.
 * Future: HUB_PROD_DISPATCH_AUTO_UPLOAD=1 skips the approval gate.
 */

const { query } = require('./lib/db');
const { issueReviewToken, normalizeApproverEmail } = require('./lib/decision-review-jwt');
const { lookupFixture, resolveStoreForVisit } = require('./lib/hub-fixture-catalog');
const { listBayPhotos, loadBayPhotoRow } = require('./hub-bay-photos');
const { extractPlanogramMeta } = require('./lib/helpdesk-email');
const { sendProdDispatchReviewEmail } = require('./hub-notify');
const { broadcastProdDispatch } = require('./hub-broadcast');

const DUMP_BIN_SITE = (process.env.DUMP_BIN_SITE || 'https://the-dump-bin.com').replace(/\/$/, '');

function normalizeEmail(email) {
  return normalizeApproverEmail(email);
}

function isTruthyEnv(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isProdDispatchEnabled() {
  return isTruthyEnv('HUB_PROD_DISPATCH_ENABLED');
}

function isAutoUploadEnabled() {
  return isTruthyEnv('HUB_PROD_DISPATCH_AUTO_UPLOAD');
}

function getApproverEmail() {
  return normalizeEmail(
    process.env.HUB_PROD_DISPATCH_APPROVER || 'tyson.gauthier@retailodyssey.com',
  );
}

function isProdDispatchApprover(email) {
  if (!isProdDispatchEnabled()) return false;
  return normalizeEmail(email) === getApproverEmail();
}

function buildReviewPageUrl(requestId, token) {
  const params = new URLSearchParams({
    type: 'prod',
    id: String(requestId),
    token,
  });
  return `${DUMP_BIN_SITE}/prod-dispatch.html?${params.toString()}`;
}

async function loadBayPhotoPayload(visitIdNum, lane, dbkey) {
  const meta = await listBayPhotos(visitIdNum, dbkey, lane);
  const photos = [];
  for (const row of meta) {
    const full = await loadBayPhotoRow(visitIdNum, dbkey, lane, row.bay_num);
    if (!full) continue;
    photos.push({
      bay_num: row.bay_num,
      content_type: full.content_type || row.content_type || 'image/jpeg',
      base64: full.photo_base64,
    });
  }
  photos.sort((a, b) => a.bay_num - b.bay_num);
  return photos;
}

async function createProdDispatchRequest({
  visitIdNum,
  lane,
  dbkey,
  actor,
}) {
  if (!isProdDispatchEnabled()) return null;

  const approverEmail = getApproverEmail();
  const storeNumber = await resolveStoreForVisit(visitIdNum);
  const fixture = storeNumber
    ? lookupFixture({ storeNumber, lane, dbkey })
    : null;

  const { rows } = await query(
    `INSERT INTO hub_prod_dispatch_requests (
       visit_id, lane, dbkey, store_number, set_name, manifest_pog_id, action_code,
       signed_off_by, signed_off_by_name, signed_off_by_email, approver_email, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     RETURNING id, visit_id, lane, dbkey, store_number, set_name, manifest_pog_id,
               action_code, signed_off_at, approver_email, status`,
    [
      visitIdNum,
      lane || '',
      dbkey,
      storeNumber,
      fixture?.name || null,
      fixture?.manifest_pog_id || null,
      fixture?.action || null,
      actor.id,
      actor.name || null,
      actor.email || null,
      approverEmail,
    ],
  );

  const request = rows[0];
  const token = issueReviewToken({
    requestId: String(request.id),
    decisionType: 'prod',
    approverEmail,
  });
  const reviewUrl = buildReviewPageUrl(request.id, token);
  const photos = await loadBayPhotoPayload(visitIdNum, lane, dbkey);

  if (isAutoUploadEnabled()) {
    const uploadResult = await executeProdUpload(request.id);
    return { request, reviewUrl, autoUpload: true, uploadResult };
  }

  const emailResult = await sendProdDispatchReviewEmail({
    request,
    photos,
    reviewUrl,
    signedOffBy: actor,
  });

  await broadcastProdDispatch({
    id: request.id,
    visitId: visitIdNum,
    lane: lane || '',
    dbkey,
    storeNumber,
    setName: request.set_name,
    reviewUrl,
    bayCount: photos.length,
    status: 'pending',
  });

  return { request, reviewUrl, emailResult, bayCount: photos.length };
}

async function listPendingForApprover(approverEmail) {
  const email = normalizeEmail(approverEmail);
  const { rows } = await query(
    `SELECT id, visit_id, lane, dbkey, store_number, set_name, manifest_pog_id,
            action_code, signed_off_by_name, signed_off_at, status, created_at
     FROM hub_prod_dispatch_requests
     WHERE approver_email = $1 AND status = 'pending'
     ORDER BY signed_off_at ASC
     LIMIT 50`,
    [email],
  );
  return rows.map((row) => {
    const token = issueReviewToken({
      requestId: String(row.id),
      decisionType: 'prod',
      approverEmail: email,
    });
    return {
      id: row.id,
      visitId: Number(row.visit_id),
      lane: row.lane || '',
      dbkey: row.dbkey,
      storeNumber: row.store_number,
      setName: row.set_name,
      manifestPogId: row.manifest_pog_id,
      actionCode: row.action_code,
      signedOffByName: row.signed_off_by_name,
      signedOffAt: row.signed_off_at ? row.signed_off_at.toISOString() : null,
      status: row.status,
      reviewUrl: buildReviewPageUrl(row.id, token),
    };
  });
}

async function getRequestById(id) {
  const { rows } = await query(
    `SELECT *
     FROM hub_prod_dispatch_requests
     WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function findCategoryResetByDbkey(visitId, dbkey) {
  const sasBridge = require('./sas-bridge');
  if (!sasBridge.isSessionAlive()) {
    const err = new Error('SAS session not active');
    err.code = 'sas_inactive';
    throw err;
  }

  const resp = await sasBridge.sasGet(
    `/api/v1/field-app/visits/${visitId}/category-resets/`,
  );
  const categoryResets = resp.data?.category_resets || [];
  const target = String(dbkey || '').trim();

  for (const r of categoryResets) {
    const meta = extractPlanogramMeta(r.planogram_id);
    if (meta.dbkey === target) {
      return {
        id: r.id,
        name: r.name,
        planogramId: r.planogram_id,
        resetType: r.reset_type,
      };
    }
  }

  for (const r of categoryResets) {
    if (String(r.planogram_id || '').includes(target)) {
      return {
        id: r.id,
        name: r.name,
        planogramId: r.planogram_id,
        resetType: r.reset_type,
      };
    }
  }

  return null;
}

async function uploadBayPhotosToReset(visitId, resetId, photos) {
  const sasBridge = require('./sas-bridge');
  const results = [];

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const dataUrl = `data:${photo.content_type || 'image/jpeg'};base64,${photo.base64}`;
    const slot = 'after';
    const filename = `bay${photo.bay_num || i + 1}_visit${visitId}.jpg`;
    const result = await sasBridge.uploadCategoryResetPhoto(
      visitId,
      resetId,
      dataUrl,
      slot,
      filename,
    );
    results.push({
      bay_num: photo.bay_num,
      slot,
      success: result.success,
      imageId: result.imageId,
    });
  }

  return results;
}

async function executeProdUpload(requestId) {
  const request = await getRequestById(requestId);
  if (!request) {
    return { ok: false, error: 'not_found' };
  }

  const visitId = String(request.visit_id);
  const photos = await loadBayPhotoPayload(
    Number(request.visit_id),
    request.lane,
    request.dbkey,
  );

  if (!photos.length) {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'upload_failed', upload_result = $2, decision_at = now()
       WHERE id = $1`,
      [requestId, JSON.stringify({ error: 'no_photos' })],
    );
    return { ok: false, error: 'no_photos' };
  }

  let matched;
  try {
    matched = await findCategoryResetByDbkey(visitId, request.dbkey);
  } catch (err) {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'upload_failed', upload_result = $2, decision_at = now()
       WHERE id = $1`,
      [requestId, JSON.stringify({ error: err.code || err.message })],
    );
    return { ok: false, error: err.code || err.message };
  }

  if (!matched) {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'upload_failed', upload_result = $2, decision_at = now()
       WHERE id = $1`,
      [
        requestId,
        JSON.stringify({ error: 'reset_not_found', dbkey: request.dbkey }),
      ],
    );
    return { ok: false, error: 'reset_not_found' };
  }

  let uploadResults;
  try {
    uploadResults = await uploadBayPhotosToReset(visitId, matched.id, photos);
  } catch (err) {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'upload_failed',
           matched_reset_id = $2,
           matched_reset_name = $3,
           matched_reset_planogram_id = $4,
           upload_result = $5,
           decision_at = now()
       WHERE id = $1`,
      [
        requestId,
        matched.id,
        matched.name,
        matched.planogramId,
        JSON.stringify({ error: err.message }),
      ],
    );
    return { ok: false, error: err.message };
  }

  await query(
    `UPDATE hub_prod_dispatch_requests
     SET status = 'uploaded',
         matched_reset_id = $2,
         matched_reset_name = $3,
         matched_reset_planogram_id = $4,
         upload_result = $5,
         decision_at = now()
     WHERE id = $1`,
    [
      requestId,
      matched.id,
      matched.name,
      matched.planogramId,
      JSON.stringify({ uploads: uploadResults }),
    ],
  );

  return {
    ok: true,
    status: 'uploaded',
    matchedReset: matched,
    uploads: uploadResults,
  };
}

async function applyProdDispatchDecision(requestId, decision) {
  const request = await getRequestById(requestId);
  if (!request) return { ok: false, error: 'not_found' };
  if (request.status !== 'pending') {
    return { ok: true, status: request.status, alreadyDecided: true };
  }

  if (decision === 'denied') {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'denied', decision_at = now()
       WHERE id = $1`,
      [requestId],
    );
    await broadcastProdDispatch({
      id: request.id,
      visitId: Number(request.visit_id),
      lane: request.lane || '',
      dbkey: request.dbkey,
      storeNumber: request.store_number,
      setName: request.set_name,
      status: 'denied',
    });
    return { ok: true, status: 'denied' };
  }

  if (decision === 'approved') {
    await query(
      `UPDATE hub_prod_dispatch_requests
       SET status = 'approved', decision_at = now()
       WHERE id = $1`,
      [requestId],
    );
    const uploadResult = await executeProdUpload(requestId);
    await broadcastProdDispatch({
      id: request.id,
      visitId: Number(request.visit_id),
      lane: request.lane || '',
      dbkey: request.dbkey,
      storeNumber: request.store_number,
      setName: request.set_name,
      status: uploadResult.ok ? 'uploaded' : 'upload_failed',
    });
    return {
      ok: uploadResult.ok,
      status: uploadResult.ok ? 'uploaded' : 'upload_failed',
      uploadResult,
    };
  }

  return { ok: false, error: 'invalid_decision' };
}

function formatRequestForReview(row, token) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    visitId: Number(row.visit_id),
    lane: row.lane || '',
    dbkey: row.dbkey,
    storeNumber: row.store_number,
    setName: row.set_name,
    manifestPogId: row.manifest_pog_id,
    actionCode: row.action_code,
    signedOffByName: row.signed_off_by_name,
    signedOffByEmail: row.signed_off_by_email,
    signedOffAt: row.signed_off_at ? row.signed_off_at.toISOString() : null,
    matchedResetName: row.matched_reset_name,
    matchedResetPlanogramId: row.matched_reset_planogram_id,
    uploadResult: row.upload_result,
    reviewUrl: token ? buildReviewPageUrl(row.id, token) : null,
  };
}

module.exports = {
  isProdDispatchEnabled,
  isAutoUploadEnabled,
  isProdDispatchApprover,
  getApproverEmail,
  createProdDispatchRequest,
  listPendingForApprover,
  getRequestById,
  loadBayPhotoPayload,
  applyProdDispatchDecision,
  executeProdUpload,
  formatRequestForReview,
  buildReviewPageUrl,
};
