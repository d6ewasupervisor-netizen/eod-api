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
const { dispatchTrackedEmail } = require('./lib/resend-outbox');
const {
  sortTagsByAisle,
  groupTagsByAisle,
  formatTagLocationLabel,
  enrichLocationWithStoreAisle,
  parseAisleFromLocation,
} = require('./lib/tag-location');
const { lookupFixture, resolveStoreForVisit } = require('./lib/hub-fixture-catalog');
const { getSectionDesignationsMap, lookupStoreAisleLabel } = require('./hub-aisle-designation');
const { getAisleAssignments } = require('./hub-tag-sweep');

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
 */
function tagBatchEmailSubject(storeNumber) {
  return tagBatchEmailSubjectLive(storeNumber);
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

function enrichTagLocationFields(row, storeNumber, designations) {
  const registerLane = parseAisleFromLocation(row.location);
  // Sweep-added tags freeze their store aisle on the row; rep tags resolve it
  // dynamically from the section's aisle designation.
  const storeAisleLabel = (row.aisle_label && String(row.aisle_label).trim())
    || lookupStoreAisleLabel(
      { dbkey: row.dbkey, lane: row.lane || registerLane, location: row.location },
      designations,
    );
  const locationLabel = enrichLocationWithStoreAisle(row.location, storeAisleLabel)
    || formatTagLocationLabel(row.location)
    || row.location
    || null;
  return {
    locationLabel,
    storeAisleLabel: storeAisleLabel || null,
    aisleKeyExplicit: (row.aisle_key && String(row.aisle_key).trim()) || null,
    registerLane: registerLane != null ? String(registerLane) : null,
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

/**
 * Tags pending in the aisle tag batch. The aisle sweep replaced the verify gate,
 * so both freshly flagged tags and any legacy 'verified' rows are sendable.
 */
async function loadPendingBatchTags(visitIdNum) {
  const { rows } = await query(
    `SELECT tf.id, tf.visit_id, tf.dbkey, tf.lane, tf.upc, tf.description, tf.location,
            tf.aisle_key, tf.aisle_label, tf.source, tf.flagged_by, tf.flagged_at,
            tf.verified_by, tf.verified_at, tf.status
     FROM tag_flags tf
     WHERE tf.visit_id = $1 AND tf.status IN ('flagged', 'verified')
     ORDER BY tf.id ASC`,
    [visitIdNum],
  );
  return rows;
}

async function enrichTagForPreview(row, storeNumber, designations) {
  const validation = validateUpc(row.upc);
  const { locationLabel, planogramName, storeAisleLabel, aisleKeyExplicit, registerLane } = enrichTagLocationFields(
    row,
    storeNumber,
    designations,
  );
  return {
    id: row.id,
    dbkey: row.dbkey,
    lane: row.lane || '',
    source: row.source || 'rep',
    upc: row.upc,
    description: row.description,
    location: row.location,
    locationLabel,
    storeAisleLabel,
    aisleKeyExplicit,
    registerLane,
    planogramName,
    valid: validation.valid,
    reason: validation.reason || null,
    displayDigits: validation.displayDigits || null,
    symbology: validation.symbology || null,
    verified_at: row.verified_at ? row.verified_at.toISOString() : null,
  };
}

async function getTagBatchPreview(visitId, { restrictToAisleKeys } = {}) {
  const visitIdNum = parseVisitId(visitId);
  const [rows, designations, assignments] = await Promise.all([
    loadPendingBatchTags(visitIdNum),
    getSectionDesignationsMap(visitIdNum),
    getAisleAssignments(visitIdNum),
  ]);
  const store = await resolveStore(visitIdNum);
  const storeNumber = store ? String(Number(store)) : null;
  const tags = await Promise.all(rows.map((row) => enrichTagForPreview(row, storeNumber, designations)));
  const sorted = sortTagsByAisle(tags);

  const assignmentByKey = {};
  for (const a of assignments) assignmentByKey[a.aisleKey] = a;

  let groups = groupTagsByAisle(sorted).map((group) => {
    const assignment = assignmentByKey[group.aisleKey] || null;
    return {
      ...group,
      assigneeId: assignment ? assignment.assigneeId : null,
      assigneeName: assignment ? assignment.assigneeName : null,
      invalidCount: group.tags.filter((t) => !t.valid).length,
    };
  });

  // Reps only see aisles assigned to them.
  const allow = Array.isArray(restrictToAisleKeys) ? new Set(restrictToAisleKeys) : null;
  if (allow) {
    groups = groups.filter((g) => allow.has(g.aisleKey));
  }

  const visibleTags = allow ? groups.flatMap((g) => g.tags) : sorted;

  return {
    visitId: visitIdNum,
    store,
    count: visibleTags.length,
    tags: visibleTags,
    byAisle: groups,
    assignments,
  };
}

async function enrichTagForPdf(row, storeNumber, designations) {
  const barcode = await generateBarcode(row.upc);
  const { locationLabel, planogramName, storeAisleLabel, aisleKeyExplicit, registerLane } = enrichTagLocationFields(
    row,
    storeNumber,
    designations,
  );
  return {
    id: row.id,
    dbkey: row.dbkey,
    upc: row.upc,
    rawUpc: row.upc,
    description: row.description,
    location: row.location,
    locationLabel,
    storeAisleLabel,
    aisleKeyExplicit,
    registerLane,
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

/**
 * Build + email a tag print batch for the given rows, then mark them sent.
 * @param {number} visitIdNum
 * @param {object} actor
 * @param {Array<object>} rows  raw tag_flags rows (already filtered to the batch)
 * @param {object} designations section aisle designations map
 * @param {{ aisleLabel?: string|null }} [opts]
 */
async function deliverTagBatch(visitIdNum, actor, rows, designations, opts = {}) {
  if (!rows.length) {
    return { ok: false, status: 400, error: 'no pending tags to send' };
  }

  const store = await resolveStore(visitIdNum);
  const storeNumber = store ? String(Number(store)) : null;
  const pdfItems = await Promise.all(rows.map((row) => enrichTagForPdf(row, storeNumber, designations)));
  const sortedPdfItems = sortTagsByAisle(pdfItems);

  const aisleLabel = opts.aisleLabel || null;
  const dateLabel = formatLocalDate();
  const pdfBuffer = await buildTagBatchPdf({
    store,
    visitId: visitIdNum,
    dateLabel,
    aisleLabel,
    items: sortedPdfItems,
  });

  const storeLabel = store || 'unknown';
  const count = rows.length;
  const subject = aisleLabel
    ? `${tagBatchEmailSubject(store)} — ${aisleLabel}`
    : tagBatchEmailSubject(store);
  const to = resolveTagBatchRecipient();
  const recipients = [to];
  if (actor.email && actor.email.toLowerCase() !== to.toLowerCase()) {
    recipients.push(actor.email);
  }

  const scopeLine = aisleLabel
    ? `${count} missing-tag item${count === 1 ? '' : 's'} for ${aisleLabel}, store ${storeLabel}, visit ${visitIdNum}.`
    : `${count} missing-tag item${count === 1 ? '' : 's'} for store ${storeLabel}, visit ${visitIdNum}.`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:420px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Checklane tag print batch</h2>
  <p style="margin:0 0 8px;">${scopeLine}</p>
  <p style="margin:0 0 8px;">Sent by ${actor.name || actor.email}.</p>
  <p style="margin:0;color:#6b7280;font-size:13px;">The attached PDF is formatted for fax — scan barcodes with the spa gun to print shelf tags.</p>
</body></html>`;

  const bodySummary = `store=${storeLabel} visit=${visitIdNum} count=${count} aisle=${aisleLabel || 'all'} sender=${actor.email}`;
  const stamp = formatFilenameDate();
  const aisleSlug = aisleLabel ? `_${aisleLabel.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}` : '';
  const filename = `tag-batch_${storeLabel}_${visitIdNum}${aisleSlug}_${stamp}.pdf`;

  const emailPayload = buildSetRelatedEmailPayload({
      to,
      subject,
      html,
      actorEmail: actor.email,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    });
  const { data, error } = await dispatchTrackedEmail(_resend, {
    sourceType: 'hub-tag-batch',
    sourceRef: visitIdNum,
    sentByEmail: actor.email,
    metadata: { visitId: visitIdNum, store: storeLabel, count, subject },
  }, emailPayload);

  if (error) {
    console.error('[hub-tag-batch] Resend error:', error.message || String(error));
    return { ok: false, status: 502, error: error.message || String(error) };
  }

  const tagIds = rows.map((row) => row.id);

  await applyTransition(visitIdNum, async () => {
    await query(
      `UPDATE tag_flags
       SET status = 'sent', sent_by = $1, sent_at = now()
       WHERE visit_id = $2 AND id = ANY($3::int[]) AND status IN ('flagged', 'verified')`,
      [actor.id, visitIdNum, tagIds],
    );

    await writeAuditLog(visitIdNum, actor.id, 'tag_batch_sent', null, {
      tag_count: count,
      tag_ids: tagIds,
      aisle_label: aisleLabel,
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

  return { ok: true, count, aisleLabel, resendId: data?.id, recipients };
}

async function sendTagBatch(visitId, actor) {
  if (!_resend) {
    return { ok: false, status: 500, error: 'Tag batch email not initialized' };
  }
  const visitIdNum = parseVisitId(visitId);
  const [rows, designations] = await Promise.all([
    loadPendingBatchTags(visitIdNum),
    getSectionDesignationsMap(visitIdNum),
  ]);
  return deliverTagBatch(visitIdNum, actor, rows, designations);
}

/**
 * Send/print one store aisle's pending tags. Rows are grouped exactly like the
 * preview so the chosen aisleKey matches what the lead/assignee sees.
 */
async function sendTagBatchForAisle(visitId, actor, aisleKey) {
  if (!_resend) {
    return { ok: false, status: 500, error: 'Tag batch email not initialized' };
  }
  const key = String(aisleKey ?? '').trim();
  if (!key) return { ok: false, status: 400, error: 'aisleKey is required' };

  const visitIdNum = parseVisitId(visitId);
  const [rows, designations] = await Promise.all([
    loadPendingBatchTags(visitIdNum),
    getSectionDesignationsMap(visitIdNum),
  ]);

  const store = await resolveStore(visitIdNum);
  const storeNumber = store ? String(Number(store)) : null;

  // Enrich + group to find the rows that belong to this aisle, then map back to raw rows.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const enriched = await Promise.all(rows.map((row) => enrichTagForPreview(row, storeNumber, designations)));
  const group = groupTagsByAisle(enriched).find((g) => g.aisleKey === key);
  if (!group || !group.tags.length) {
    return { ok: false, status: 400, error: 'no pending tags for that aisle' };
  }

  const aisleRows = group.tags.map((t) => byId.get(t.id)).filter(Boolean);
  return deliverTagBatch(visitIdNum, actor, aisleRows, designations, { aisleLabel: group.aisleLabel });
}

async function sendTagBatchForTagIds(visitId, actor, tagIds) {
  if (!_resend) {
    return { ok: false, status: 500, error: 'Tag batch email not initialized' };
  }
  const ids = Array.isArray(tagIds)
    ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  if (!ids.length) {
    return { ok: false, status: 400, error: 'No tags to print' };
  }

  const visitIdNum = parseVisitId(visitId);
  const [rows, designations] = await Promise.all([
    loadPendingBatchTags(visitIdNum),
    getSectionDesignationsMap(visitIdNum),
  ]);
  const wanted = new Set(ids);
  const selectedRows = rows.filter((row) => wanted.has(Number(row.id)));
  if (!selectedRows.length) {
    return { ok: false, status: 400, error: 'No pending tags matched that draft list' };
  }
  return deliverTagBatch(visitIdNum, actor, selectedRows, designations);
}

module.exports = {
  initHubTagBatch,
  getTagBatchPreview,
  sendTagBatch,
  sendTagBatchForAisle,
  sendTagBatchForTagIds,
  resolveTagBatchRecipient,
  tagBatchEmailSubject,
  tagBatchEmailSubjectLive,
};
