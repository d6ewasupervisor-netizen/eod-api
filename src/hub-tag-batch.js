/**
 * Checklane Hub Step 6 — verified tag batch email (PDF + Resend).
 *
 * tag_flags.status lifecycle:
 *   flagged → verified (Step 5 verify gate) → sent (this module) | rejected
 *
 * Only status='verified' rows are gathered for preview/send. On successful Resend
 * delivery they become status='sent' with sent_by / sent_at. Resend failure leaves
 * them verified so a retry resends the same batch.
 */

const { query } = require('./lib/db');
const { generateBarcode, validateUpc } = require('./lib/barcode');
const { buildTagBatchPdf } = require('./lib/tag-batch-pdf');
const { writeAuditLog, parseVisitId } = require('./hub-auth');
const { applyTransition } = require('./hub-state');
const { broadcastVisit } = require('./hub-broadcast');
const { buildSetRelatedEmailPayload, CHECKLANES_OPS_EMAIL } = require('./lib/checklanes-email');
const { sortTagsByAisle, groupTagsByAisle, formatTagLocationLabel } = require('./lib/tag-location');
const { lookupFixture, resolveStoreForVisit } = require('./lib/hub-fixture-catalog');

const TZ = 'America/Los_Angeles';

let _resend = null;

function initHubTagBatch({ resend }) {
  _resend = resend;
}

function resolveTagBatchRecipient() {
  if (process.env.HUB_TAG_BATCH_EMAIL) {
    return process.env.HUB_TAG_BATCH_EMAIL.trim();
  }
  return CHECKLANES_OPS_EMAIL;
}

/**
 * Barcode print batch subject — store token only, e.g. #31 or #163.
 * Hardcoded #999 during hub testing; flip to tagBatchEmailSubjectLive when live.
 */
function tagBatchEmailSubject(_storeNumber) {
  return '#999';
}

function tagBatchEmailSubjectLive(storeNumber) {
  const n = Number(storeNumber);
  if (!Number.isFinite(n)) return '#999';
  return `#${n}`;
}

function formatStoreNumber(storeNumber) {
  if (storeNumber == null || storeNumber === '') return null;
  const n = Number(storeNumber);
  if (!Number.isFinite(n)) return String(storeNumber);
  return String(n).padStart(5, '0');
}

async function resolveStore(visitIdNum) {
  const storeNumber = await resolveStoreForVisit(visitIdNum);
  return storeNumber ? formatStoreNumber(storeNumber) : null;
}

function resolvePlanogramName(storeNumber, dbkey) {
  const fixture = storeNumber ? lookupFixture({ storeNumber, dbkey }) : null;
  return fixture?.name || null;
}

function enrichTagLocationFields(row, storeNumber) {
  return {
    locationLabel: formatTagLocationLabel(row.location) || row.location || null,
    planogramName: resolvePlanogramName(storeNumber, row.dbkey),
  };
}

function formatLocalDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatFilenameDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}`;
}

async function loadVerifiedUnsentTags(visitIdNum) {
  const { rows } = await query(
    `SELECT tf.id, tf.visit_id, tf.dbkey, tf.upc, tf.description, tf.location,
            tf.flagged_by, tf.flagged_at, tf.verified_by, tf.verified_at, tf.status
     FROM tag_flags tf
     WHERE tf.visit_id = $1 AND tf.status = 'verified'
     ORDER BY tf.id ASC`,
    [visitIdNum],
  );
  return rows;
}

async function enrichTagForPreview(row, storeNumber) {
  const validation = validateUpc(row.upc);
  const { locationLabel, planogramName } = enrichTagLocationFields(row, storeNumber);
  return {
    id: row.id,
    dbkey: row.dbkey,
    upc: row.upc,
    description: row.description,
    location: row.location,
    locationLabel,
    planogramName,
    valid: validation.valid,
    reason: validation.reason || null,
    displayDigits: validation.displayDigits || null,
    symbology: validation.symbology || null,
    verified_at: row.verified_at ? row.verified_at.toISOString() : null,
  };
}

async function getTagBatchPreview(visitId) {
  const visitIdNum = parseVisitId(visitId);
  const rows = await loadVerifiedUnsentTags(visitIdNum);
  const store = await resolveStore(visitIdNum);
  const storeNumber = store ? String(Number(store)) : null;
  const tags = await Promise.all(rows.map((row) => enrichTagForPreview(row, storeNumber)));
  const sorted = sortTagsByAisle(tags);

  return {
    visitId: visitIdNum,
    store,
    count: sorted.length,
    tags: sorted,
    byAisle: groupTagsByAisle(sorted),
  };
}

async function enrichTagForPdf(row, storeNumber) {
  const barcode = await generateBarcode(row.upc);
  const { locationLabel, planogramName } = enrichTagLocationFields(row, storeNumber);
  return {
    id: row.id,
    dbkey: row.dbkey,
    upc: row.upc,
    rawUpc: row.upc,
    description: row.description,
    location: row.location,
    locationLabel,
    planogramName,
    valid: barcode.valid,
    reason: barcode.reason,
    displayDigits: barcode.displayDigits,
    primary: barcode.primary,
  };
}

async function logTagBatchEmail({
  visitIdNum,
  recipients,
  subject,
  bodySummary,
  resendId,
  sentBy,
}) {
  await query(
    `INSERT INTO email_log (visit_id, email_type, recipients, subject, body_summary, sent_by, resend_id)
     VALUES ($1, 'tag_batch', $2, $3, $4, $5, $6)`,
    [visitIdNum, recipients, subject, bodySummary, sentBy, resendId || null],
  );
}

async function sendTagBatch(visitId, actor) {
  if (!_resend) {
    return { ok: false, status: 500, error: 'Tag batch email not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  const rows = await loadVerifiedUnsentTags(visitIdNum);

  if (!rows.length) {
    return { ok: false, status: 400, error: 'no verified tags to send' };
  }

  const store = await resolveStore(visitIdNum);
  const storeNumber = store ? String(Number(store)) : null;
  const pdfItems = await Promise.all(rows.map((row) => enrichTagForPdf(row, storeNumber)));

  const sortedPdfItems = sortTagsByAisle(pdfItems);

  const dateLabel = formatLocalDate();
  const pdfBuffer = await buildTagBatchPdf({
    store,
    visitId: visitIdNum,
    dateLabel,
    items: sortedPdfItems,
  });

  const storeLabel = store || 'unknown';
  const count = rows.length;
  const subject = tagBatchEmailSubject(store);
  const to = resolveTagBatchRecipient();
  const recipients = [to];
  if (actor.email && actor.email.toLowerCase() !== to.toLowerCase()) {
    recipients.push(actor.email);
  }

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:420px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Checklane tag print batch</h2>
  <p style="margin:0 0 8px;">${count} verified missing-tag item${count === 1 ? '' : 's'} for store ${storeLabel}, visit ${visitIdNum}.</p>
  <p style="margin:0 0 8px;">Sent by ${actor.name || actor.email}.</p>
  <p style="margin:0;color:#6b7280;font-size:13px;">The attached PDF is formatted for fax — scan barcodes with the spa gun to print shelf tags.</p>
</body></html>`;

  const bodySummary = `store=${storeLabel} visit=${visitIdNum} count=${count} sender=${actor.email}`;
  const stamp = formatFilenameDate();
  const filename = `tag-batch_${storeLabel}_${visitIdNum}_${stamp}.pdf`;

  const { data, error } = await _resend.emails.send(
    buildSetRelatedEmailPayload({
      to,
      subject,
      html,
      actorEmail: actor.email,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    }),
  );

  if (error) {
    console.error('[hub-tag-batch] Resend error:', error.message || String(error));
    return {
      ok: false,
      status: 502,
      error: error.message || String(error),
    };
  }

  const tagIds = rows.map((row) => row.id);

  await applyTransition(visitIdNum, async () => {
    await query(
      `UPDATE tag_flags
       SET status = 'sent', sent_by = $1, sent_at = now()
       WHERE visit_id = $2 AND id = ANY($3::int[]) AND status = 'verified'`,
      [actor.id, visitIdNum, tagIds],
    );

    await writeAuditLog(visitIdNum, actor.id, 'tag_batch_sent', null, {
      tag_count: count,
      tag_ids: tagIds,
      recipients,
      resend_id: data?.id,
    });
  });

  try {
    await logTagBatchEmail({
      visitIdNum,
      recipients,
      subject,
      bodySummary,
      resendId: data?.id,
      sentBy: actor.id,
    });
  } catch (logErr) {
    console.error('[hub-tag-batch] email_log insert failed:', logErr.message);
  }

  await broadcastVisit(visitIdNum);

  return {
    ok: true,
    count,
    resendId: data?.id,
    recipients,
  };
}

module.exports = {
  initHubTagBatch,
  getTagBatchPreview,
  sendTagBatch,
  resolveTagBatchRecipient,
  tagBatchEmailSubject,
  tagBatchEmailSubjectLive,
};
