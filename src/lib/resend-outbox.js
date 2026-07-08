'use strict';

const { query } = require('./db');

/** @type {((meta: object, payload: object) => Promise<{ data?: object, error?: object, recordId?: number|null }>)|null} */
let _sendEmail = null;

const AUTH_SOURCE_TYPES = new Set([
  'auth-magic-link',
  'auth-password-reset',
  'auth-alert',
  'auth-invite',
  'auth-otp',
]);

function setEmailSender(fn) {
  _sendEmail = fn;
}

function getEmailSender() {
  return _sendEmail;
}

async function dispatchTrackedEmail(fallbackResend, meta, payload) {
  const send = getEmailSender();
  if (send) {
    return send(meta, payload);
  }
  if (!fallbackResend?.emails?.send) {
    return { data: null, error: { message: 'Email sender not configured' } };
  }
  return fallbackResend.emails.send(payload);
}

function normalizeAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function attachmentToStored(att) {
  if (!att || !att.filename) return null;
  let contentBase64 = '';
  if (Buffer.isBuffer(att.content)) {
    contentBase64 = att.content.toString('base64');
  } else if (typeof att.content === 'string') {
    contentBase64 = att.content;
  }
  const stored = {
    filename: String(att.filename),
    content_type: att.content_type || att.contentType || undefined,
    content_base64: contentBase64,
  };
  const contentId = att.contentId || att.content_id;
  if (contentId) stored.content_id = String(contentId);
  return stored;
}

function attachmentsToStored(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map(attachmentToStored).filter(Boolean);
}

function attachmentsFromStored(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a && a.filename && a.content_base64)
    .map((a) => {
      const restored = {
        filename: a.filename,
        content: a.content_base64,
        content_type: a.content_type,
      };
      const contentId = a.content_id || a.contentId;
      if (contentId) restored.contentId = String(contentId);
      return restored;
    });
}

function buildStoredPayload(payload) {
  const copy = { ...payload };
  if (Array.isArray(copy.attachments)) {
    copy.attachments = attachmentsToStored(copy.attachments);
  }
  return copy;
}

function payloadForResend(storedPayload) {
  const payload = { ...storedPayload };
  if (Array.isArray(payload.attachments)) {
    payload.attachments = attachmentsFromStored(payload.attachments);
  }
  return payload;
}

function mapResendEventToDelivery(lastEvent) {
  const ev = String(lastEvent || '').trim().toLowerCase();
  if (!ev) return null;
  if (ev === 'delivered') return 'delivered';
  if (ev === 'bounced' || ev === 'failed') return 'failed';
  if (ev === 'complained') return 'complained';
  if (ev === 'sent' || ev === 'queued' || ev === 'delivery_delayed') return 'sent';
  return ev;
}

function rowToListItem(row) {
  const compacted = Boolean(row.metadata?.compactedAt);
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    resendId: row.resend_id,
    parentId: row.parent_id,
    status: row.status,
    deliveryStatus: row.delivery_status,
    lastEvent: row.last_event,
    lastEventAt: row.last_event_at,
    from: row.from_address,
    to: row.to_addresses || [],
    cc: row.cc_addresses || [],
    subject: row.subject,
    attachmentCount: Array.isArray(row.attachments) ? row.attachments.length : 0,
    resendAllowed: row.resend_allowed,
    compacted,
    errorMessage: row.error_message,
    sentByEmail: row.sent_by_email,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canResend: Boolean(
      row.resend_allowed
      && !compacted
      && row.stored_payload
      && Object.keys(row.stored_payload).length,
    ),
  };
}

function rowToDetail(row) {
  const item = rowToListItem(row);
  return {
    ...item,
    bcc: row.bcc_addresses || [],
    replyTo: row.reply_to,
    htmlBody: row.html_body,
    textBody: row.text_body,
    attachments: row.attachments || [],
    storedPayload: row.stored_payload || {},
  };
}

async function insertEmailRecord(pool, {
  sourceSystem = 'eod-api',
  sourceType,
  sourceRef = null,
  resendId = null,
  parentId = null,
  status = 'pending',
  deliveryStatus = null,
  lastEvent = null,
  lastEventAt = null,
  fromAddress = null,
  toAddresses = [],
  ccAddresses = [],
  bccAddresses = [],
  replyTo = null,
  subject = null,
  htmlBody = null,
  textBody = null,
  attachments = [],
  storedPayload = {},
  resendAllowed = true,
  errorMessage = null,
  sentByEmail = null,
  metadata = {},
}) {
  const client = pool || { query };
  const allowed = resendAllowed && !AUTH_SOURCE_TYPES.has(sourceType);
  const { rows } = await client.query(
    `INSERT INTO sent_emails (
      source_system, source_type, source_ref, resend_id, parent_id,
      status, delivery_status, last_event, last_event_at,
      from_address, to_addresses, cc_addresses, bcc_addresses, reply_to,
      subject, html_body, text_body, attachments, stored_payload,
      resend_allowed, error_message, sent_by_email, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, $17, $18::jsonb, $19::jsonb,
      $20, $21, $22, $23::jsonb
    )
    RETURNING id`,
    [
      sourceSystem,
      sourceType,
      sourceRef,
      resendId,
      parentId,
      status,
      deliveryStatus,
      lastEvent,
      lastEventAt,
      fromAddress,
      toAddresses,
      ccAddresses,
      bccAddresses,
      replyTo,
      subject,
      htmlBody,
      textBody,
      JSON.stringify(attachments),
      JSON.stringify(storedPayload),
      allowed,
      errorMessage,
      sentByEmail,
      JSON.stringify(metadata),
    ],
  );
  return rows[0].id;
}

async function updateEmailRecord(pool, id, patch) {
  const client = pool || { query };
  const fields = [];
  const values = [];
  let idx = 1;

  const setters = {
    resend_id: patch.resendId,
    status: patch.status,
    delivery_status: patch.deliveryStatus,
    last_event: patch.lastEvent,
    last_event_at: patch.lastEventAt,
    error_message: patch.errorMessage,
    updated_at: patch.updatedAt || new Date().toISOString(),
  };

  for (const [col, val] of Object.entries(setters)) {
    if (val !== undefined) {
      fields.push(`${col} = $${idx++}`);
      values.push(val);
    }
  }

  if (!fields.length) return;
  values.push(id);
  await client.query(
    `UPDATE sent_emails SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

async function sendViaOutbox(resend, pool, meta, payload) {
  const sourceType = meta.sourceType || 'unknown';
  const storedPayload = buildStoredPayload(payload);
  const toAddresses = normalizeAddressList(payload.to);
  const ccAddresses = normalizeAddressList(payload.cc);
  const bccAddresses = normalizeAddressList(payload.bcc);
  const recordId = await insertEmailRecord(pool, {
    sourceSystem: meta.sourceSystem || 'eod-api',
    sourceType,
    sourceRef: meta.sourceRef != null ? String(meta.sourceRef) : null,
    status: 'pending',
    fromAddress: payload.from || null,
    toAddresses,
    ccAddresses,
    bccAddresses,
    replyTo: payload.reply_to || payload.replyTo || null,
    subject: payload.subject || null,
    htmlBody: payload.html || null,
    textBody: payload.text || null,
    attachments: storedPayload.attachments || [],
    storedPayload,
    resendAllowed: meta.resendAllowed !== false,
    sentByEmail: meta.sentByEmail || null,
    metadata: meta.metadata || {},
  });

  try {
    const resendPayload = payloadForResend(storedPayload);
    const { data, error } = await resend.emails.send(resendPayload);
    if (error) {
      await updateEmailRecord(pool, recordId, {
        status: 'failed',
        deliveryStatus: 'failed',
        errorMessage: error.message || String(error),
      });
      return { data: null, error, recordId };
    }

    const lastEvent = 'sent';
    await updateEmailRecord(pool, recordId, {
      resendId: data?.id || null,
      status: 'sent',
      deliveryStatus: mapResendEventToDelivery(lastEvent),
      lastEvent,
      lastEventAt: new Date().toISOString(),
    });
    return { data, error: null, recordId };
  } catch (err) {
    await updateEmailRecord(pool, recordId, {
      status: 'failed',
      deliveryStatus: 'failed',
      errorMessage: err.message || String(err),
    });
    throw err;
  }
}

function createEmailSender({ resend, pool }) {
  if (!resend) {
    throw new Error('Resend client is required for email sender');
  }
  return async (meta, payload) => {
    if (!pool || !process.env.DATABASE_URL) {
      const { data, error } = await resend.emails.send(payload);
      return { data, error, recordId: null };
    }
    return sendViaOutbox(resend, pool, meta, payload);
  };
}

const LIST_SORT_COLUMNS = {
  createdAt: 'created_at',
  subject: 'subject',
  status: 'status',
  deliveryStatus: 'delivery_status',
  sourceSystem: 'source_system',
  sourceType: 'source_type',
  to: "array_to_string(to_addresses, ',')",
};

function resolveListSort(sortBy, sortDir) {
  const col = LIST_SORT_COLUMNS[sortBy] || LIST_SORT_COLUMNS.createdAt;
  const dir = String(sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return { col, dir, sortBy: LIST_SORT_COLUMNS[sortBy] ? sortBy : 'createdAt' };
}

async function listEmails(pool, {
  page = 1,
  pageSize = 50,
  status,
  deliveryStatus,
  sourceSystem,
  sourceType,
  search,
  since,
  until,
  sortBy,
  sortDir,
}) {
  const client = pool || { query };
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = Math.max((Number(page) || 1) - 1, 0) * limit;
  const where = [];
  const values = [];
  let idx = 1;

  if (status) {
    where.push(`status = $${idx++}`);
    values.push(status);
  }
  if (deliveryStatus) {
    where.push(`delivery_status = $${idx++}`);
    values.push(deliveryStatus);
  }
  if (sourceSystem) {
    where.push(`source_system = $${idx++}`);
    values.push(sourceSystem);
  }
  if (sourceType) {
    where.push(`source_type = $${idx++}`);
    values.push(sourceType);
  }
  if (search) {
    where.push(`(
      subject ILIKE $${idx}
      OR array_to_string(to_addresses, ',') ILIKE $${idx}
      OR from_address ILIKE $${idx}
      OR source_ref ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }
  if (since) {
    where.push(`created_at >= $${idx++}`);
    values.push(since);
  }
  if (until) {
    where.push(`created_at <= $${idx++}`);
    values.push(until);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM sent_emails ${whereSql}`,
    values,
  );
  const total = countRes.rows[0]?.total || 0;
  const { col: sortCol, dir: sortOrder, sortBy: resolvedSortBy } = resolveListSort(sortBy, sortDir);
  values.push(limit, offset);
  const { rows } = await client.query(
    `SELECT *
     FROM sent_emails
     ${whereSql}
     ORDER BY ${sortCol} ${sortOrder} NULLS LAST, id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  return {
    total,
    page: Number(page) || 1,
    pageSize: limit,
    sortBy: resolvedSortBy,
    sortDir: sortOrder.toLowerCase(),
    items: rows.map(rowToListItem),
  };
}

async function getEmailById(pool, id) {
  const client = pool || { query };
  const { rows } = await client.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) return null;
  return rowToDetail(rows[0]);
}

async function resendStoredEmail(resend, pool, id, { sentByEmail } = {}) {
  const client = pool || { query };
  const { rows } = await client.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = rows[0];
  if (!row.resend_allowed) {
    const err = new Error('Resend is not allowed for this email type');
    err.statusCode = 403;
    throw err;
  }
  const stored = row.stored_payload || {};
  if (!stored || !Object.keys(stored).length) {
    const err = new Error('No stored payload — cannot resend exactly. Try syncing from Resend or re-send from the source app.');
    err.statusCode = 409;
    throw err;
  }

  const payload = payloadForResend(stored);
  const result = await sendViaOutbox(resend, pool, {
    sourceSystem: row.source_system,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sentByEmail,
    metadata: {
      ...(row.metadata || {}),
      resentFromId: row.id,
      resentAt: new Date().toISOString(),
    },
  }, payload);

  if (result.recordId && row.id) {
    await client.query('UPDATE sent_emails SET parent_id = $1 WHERE id = $2', [row.id, result.recordId]);
  }
  return result;
}

async function ingestEmailRecord(pool, body) {
  const {
    sourceSystem = 'external',
    sourceType,
    sourceRef,
    resendId,
    status = 'sent',
    deliveryStatus,
    lastEvent,
    from,
    to = [],
    cc = [],
    bcc = [],
    replyTo,
    subject,
    html,
    text,
    attachments,
    storedPayload,
    resendAllowed = true,
    errorMessage,
    sentByEmail,
    metadata = {},
  } = body;

  if (!sourceType) {
    const err = new Error('sourceType is required');
    err.statusCode = 400;
    throw err;
  }

  const payload = storedPayload || {
    from,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    reply_to: replyTo,
    subject,
    html,
    text,
    attachments: attachmentsFromStored(attachments || []),
  };
  const built = buildStoredPayload(payload);

  if (resendId) {
    const existing = await (pool || { query }).query(
      'SELECT id FROM sent_emails WHERE resend_id = $1',
      [resendId],
    );
    if (existing.rows.length) {
      await updateEmailRecord(pool, existing.rows[0].id, {
        status,
        deliveryStatus: deliveryStatus || mapResendEventToDelivery(lastEvent),
        lastEvent,
        lastEventAt: lastEvent ? new Date().toISOString() : undefined,
        errorMessage,
      });
      return { id: existing.rows[0].id, updated: true };
    }
  }

  const id = await insertEmailRecord(pool, {
    sourceSystem,
    sourceType,
    sourceRef,
    resendId,
    status,
    deliveryStatus: deliveryStatus || mapResendEventToDelivery(lastEvent),
    lastEvent,
    lastEventAt: lastEvent ? new Date().toISOString() : null,
    fromAddress: from || payload.from || null,
    toAddresses: normalizeAddressList(to.length ? to : payload.to),
    ccAddresses: normalizeAddressList(cc.length ? cc : payload.cc),
    bccAddresses: normalizeAddressList(bcc.length ? bcc : payload.bcc),
    replyTo: replyTo || payload.reply_to || null,
    subject: subject || payload.subject || null,
    htmlBody: html || payload.html || null,
    textBody: text || payload.text || null,
    attachments: built.attachments || [],
    storedPayload: built,
    resendAllowed,
    errorMessage,
    sentByEmail,
    metadata,
  });
  return { id, updated: false };
}

async function applyResendWebhookEvent(pool, event) {
  const type = String(event?.type || '').trim();
  const data = event?.data || {};
  const resendId = data.email_id || data.id;
  if (!resendId) return { ok: false, reason: 'missing email id' };

  const lastEvent = type.replace(/^email\./, '') || data.last_event;
  const deliveryStatus = mapResendEventToDelivery(lastEvent);
  const client = pool || { query };
  const { rows } = await client.query('SELECT id FROM sent_emails WHERE resend_id = $1', [resendId]);
  if (!rows.length) return { ok: true, matched: false };

  await updateEmailRecord(pool, rows[0].id, {
    lastEvent,
    lastEventAt: new Date().toISOString(),
    deliveryStatus,
    status: deliveryStatus === 'failed' ? 'failed' : undefined,
    errorMessage: data.error?.message || data.bounce?.message || undefined,
  });
  return { ok: true, matched: true, id: rows[0].id };
}

async function syncFromResendApi(resend, pool, { limit = 100, maxPages = 20 } = {}) {
  const client = pool || { query };
  let after;
  let imported = 0;
  let updated = 0;
  let pages = 0;

  while (pages < maxPages) {
    const opts = { limit: Math.min(limit, 100) };
    if (after) opts.after = after;
    const { data, error } = await resend.emails.list(opts);
    if (error) throw new Error(error.message || String(error));
    const page = data?.data || [];
    if (!page.length) break;

    for (const item of page) {
      const resendId = item.id;
      const lastEvent = item.last_event || 'sent';
      const deliveryStatus = mapResendEventToDelivery(lastEvent);
      const existing = await client.query('SELECT id, stored_payload FROM sent_emails WHERE resend_id = $1', [resendId]);
      if (existing.rows.length) {
        await updateEmailRecord(pool, existing.rows[0].id, {
          lastEvent,
          lastEventAt: item.created_at || new Date().toISOString(),
          deliveryStatus,
        });
        updated += 1;
        continue;
      }

      await insertEmailRecord(pool, {
        sourceSystem: 'resend-sync',
        sourceType: 'unknown',
        resendId,
        status: deliveryStatus === 'failed' ? 'failed' : 'sent',
        deliveryStatus,
        lastEvent,
        lastEventAt: item.created_at || null,
        fromAddress: item.from || null,
        toAddresses: normalizeAddressList(item.to),
        ccAddresses: normalizeAddressList(item.cc),
        subject: item.subject || null,
        storedPayload: {},
        resendAllowed: false,
        metadata: { syncedFromResend: true },
      });
      imported += 1;
    }

    if (!data?.has_more) break;
    after = page[page.length - 1].id;
    pages += 1;
  }

  return { imported, updated, pages };
}

function retentionDays() {
  const n = Number(process.env.EMAIL_OUTBOX_RETENTION_DAYS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

async function compactEmailRecord(pool, id, { editedByEmail } = {}) {
  const client = pool || { query };
  const { rows } = await client.query('SELECT metadata FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const metadata = {
    ...(rows[0].metadata || {}),
    compactedAt: new Date().toISOString(),
    compactedBy: editedByEmail || null,
  };
  await client.query(
    `UPDATE sent_emails SET
      html_body = NULL,
      text_body = NULL,
      attachments = '[]'::jsonb,
      stored_payload = '{}'::jsonb,
      resend_allowed = FALSE,
      metadata = $1::jsonb,
      updated_at = now()
    WHERE id = $2`,
    [JSON.stringify(metadata), id],
  );
  return getEmailById(pool, id);
}

async function editEmailRecord(pool, id, patch, { editedByEmail } = {}) {
  if (patch.compact) {
    return compactEmailRecord(pool, id, { editedByEmail });
  }

  const client = pool || { query };
  const { rows } = await client.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = rows[0];
  const updates = [];
  const values = [];
  let idx = 1;
  const stored = { ...(row.stored_payload || {}) };
  let storedChanged = false;

  if (patch.subject !== undefined) {
    updates.push(`subject = $${idx++}`);
    values.push(patch.subject);
    stored.subject = patch.subject;
    storedChanged = true;
  }
  if (patch.to !== undefined) {
    const toAddresses = normalizeAddressList(patch.to);
    updates.push(`to_addresses = $${idx++}`);
    values.push(toAddresses);
    stored.to = toAddresses;
    storedChanged = true;
  }
  if (patch.cc !== undefined) {
    const ccAddresses = normalizeAddressList(patch.cc);
    updates.push(`cc_addresses = $${idx++}`);
    values.push(ccAddresses);
    stored.cc = ccAddresses.length ? ccAddresses : undefined;
    if (!ccAddresses.length) delete stored.cc;
    storedChanged = true;
  }
  if (patch.htmlBody !== undefined) {
    updates.push(`html_body = $${idx++}`);
    values.push(patch.htmlBody);
    stored.html = patch.htmlBody;
    storedChanged = true;
  }
  if (patch.textBody !== undefined) {
    updates.push(`text_body = $${idx++}`);
    values.push(patch.textBody);
    stored.text = patch.textBody;
    storedChanged = true;
  }
  if (patch.deliveryStatus !== undefined) {
    updates.push(`delivery_status = $${idx++}`);
    values.push(patch.deliveryStatus);
  }
  if (patch.resendAllowed !== undefined) {
    updates.push(`resend_allowed = $${idx++}`);
    values.push(Boolean(patch.resendAllowed));
  }
  if (storedChanged) {
    updates.push(`stored_payload = $${idx++}::jsonb`);
    values.push(JSON.stringify(stored));
  }

  const metadata = {
    ...(row.metadata || {}),
    editedAt: new Date().toISOString(),
    editedBy: editedByEmail || null,
  };
  updates.push(`metadata = $${idx++}::jsonb`);
  values.push(JSON.stringify(metadata));
  updates.push('updated_at = now()');
  values.push(id);

  await client.query(
    `UPDATE sent_emails SET ${updates.join(', ')} WHERE id = $${idx}`,
    values,
  );
  return getEmailById(pool, id);
}

async function deleteEmailRecord(pool, id) {
  const client = pool || { query };
  const { rowCount } = await client.query('DELETE FROM sent_emails WHERE id = $1', [id]);
  if (!rowCount) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  return { deleted: true, id };
}

async function purgeEmailsOlderThan(pool, days = retentionDays()) {
  const client = pool || { query };
  const { rowCount } = await client.query(
    `DELETE FROM sent_emails WHERE created_at < now() - ($1::text || ' days')::interval`,
    [String(days)],
  );
  return { deleted: rowCount, olderThanDays: days };
}

module.exports = {
  AUTH_SOURCE_TYPES,
  setEmailSender,
  getEmailSender,
  dispatchTrackedEmail,
  normalizeAddressList,
  buildStoredPayload,
  payloadForResend,
  attachmentsToStored,
  attachmentsFromStored,
  mapResendEventToDelivery,
  resolveListSort,
  LIST_SORT_COLUMNS,
  sendViaOutbox,
  createEmailSender,
  listEmails,
  getEmailById,
  resendStoredEmail,
  ingestEmailRecord,
  applyResendWebhookEvent,
  syncFromResendApi,
  editEmailRecord,
  compactEmailRecord,
  deleteEmailRecord,
  purgeEmailsOlderThan,
  retentionDays,
  rowToListItem,
  rowToDetail,
};
