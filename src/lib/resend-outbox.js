'use strict';

const MailComposer = require('nodemailer/lib/mail-composer');
const { query } = require('./db');

/** @type {((meta: object, payload: object) => Promise<{ data?: object, error?: object, recordId?: number|null }>)|null} */
let _sendEmail = null;

const VIEWABLE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/html',
  'text/csv',
]);

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
  // Opens/clicks are engagement signals, not delivery outcomes — never map them
  // into delivery_status (that used to overwrite "delivered" with "opened" and
  // left open_count at 0 because only webhooks incremented opens).
  if (ev === 'opened' || ev === 'clicked') return null;
  if (ev === 'delivered') return 'delivered';
  if (ev === 'bounced' || ev === 'failed' || ev === 'suppressed') return 'failed';
  if (ev === 'complained') return 'complained';
  if (ev === 'sent' || ev === 'queued' || ev === 'delivery_delayed' || ev === 'scheduled') return 'sent';
  if (ev === 'cancelled' || ev === 'canceled') return 'cancelled';
  return ev;
}

/**
 * Normalize a Resend last_event / webhook type into a bare event name
 * (e.g. "email.opened" → "opened", "opened" → "opened").
 */
function normalizeResendEventName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^email\./, '');
}

/**
 * Apply a Resend last_event onto an existing sent_emails row.
 * - Engagement events (opened/clicked) update open/click counters without
 *   clobbering delivery_status.
 * - Delivery events update delivery_status when mappable.
 * - Sync path uses floor counts (at least 1); webhook path can pass { increment: true }.
 *
 * @param {object} row - DB row (needs id, open_count, opened_at, click_count, clicked_at, delivery_status)
 * @param {string} lastEventRaw
 * @param {object} [opts]
 * @param {string|null} [opts.eventAt]
 * @param {boolean} [opts.increment] - when true, increment open/click counts (webhook); otherwise set floor ≥ 1 (sync)
 */
async function applyResendLastEvent(pool, row, lastEventRaw, { eventAt = null, increment = false } = {}) {
  if (!row?.id) return { ok: false, reason: 'missing row' };
  const lastEvent = normalizeResendEventName(lastEventRaw);
  if (!lastEvent) return { ok: false, reason: 'missing event' };

  const nowIso = eventAt || new Date().toISOString();
  const patch = {
    lastEvent,
    lastEventAt: nowIso,
  };

  if (lastEvent === 'opened') {
    const prev = Number(row.open_count || 0);
    patch.openCount = increment ? prev + 1 : Math.max(prev, 1);
    if (!row.opened_at) patch.openedAt = nowIso;
    // Opened implies the message reached the inbox.
    const ds = String(row.delivery_status || '').toLowerCase();
    if (!ds || ds === 'sent' || ds === 'opened' || ds === 'queued') {
      patch.deliveryStatus = 'delivered';
    }
  } else if (lastEvent === 'clicked') {
    const prevClicks = Number(row.click_count || 0);
    patch.clickCount = increment ? prevClicks + 1 : Math.max(prevClicks, 1);
    if (!row.clicked_at) patch.clickedAt = nowIso;
    // A click also counts as engagement/open for board display.
    const prevOpens = Number(row.open_count || 0);
    if (increment || prevOpens < 1) {
      patch.openCount = increment && prevOpens > 0 ? prevOpens : Math.max(prevOpens, 1);
    }
    if (!row.opened_at) patch.openedAt = nowIso;
    const ds = String(row.delivery_status || '').toLowerCase();
    if (!ds || ds === 'sent' || ds === 'opened' || ds === 'queued') {
      patch.deliveryStatus = 'delivered';
    }
  } else {
    const deliveryStatus = mapResendEventToDelivery(lastEvent);
    if (deliveryStatus) {
      patch.deliveryStatus = deliveryStatus;
      if (deliveryStatus === 'failed') {
        patch.status = 'failed';
      }
    }
  }

  await updateEmailRecord(pool, row.id, patch);
  return { ok: true, id: row.id, lastEvent };
}

function base64ByteLength(contentBase64) {
  if (!contentBase64 || typeof contentBase64 !== 'string') return 0;
  // Strip data-URL prefix / whitespace if present; length math is approximate for padding.
  const b64 = contentBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function attachmentMeta(att, index) {
  if (!att || !att.filename) return null;
  const contentType = att.content_type || att.contentType || null;
  const contentId = att.content_id || att.contentId || null;
  const hasContent = Boolean(att.content_base64);
  const sizeBytes = hasContent ? base64ByteLength(att.content_base64) : 0;
  return {
    index,
    filename: String(att.filename),
    contentType,
    contentId: contentId ? String(contentId) : null,
    sizeBytes,
    hasContent,
    viewable: hasContent && isViewableContentType(contentType, att.filename),
  };
}

function attachmentsMetaList(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((att, index) => attachmentMeta(att, index)).filter(Boolean);
}

function isViewableContentType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct && VIEWABLE_CONTENT_TYPES.has(ct)) return true;
  const name = String(filename || '').toLowerCase();
  return /\.(pdf|png|jpe?g|gif|webp|svg|txt|html?|csv)$/.test(name);
}

function decodeStoredAttachmentContent(att) {
  if (!att?.content_base64) return null;
  const raw = String(att.content_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  try {
    return Buffer.from(raw, 'base64');
  } catch (_err) {
    return null;
  }
}

function sanitizeDownloadFilename(name, fallback = 'download') {
  const base = String(name || fallback)
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return base || fallback;
}

function contentDispositionHeader(filename, { inline = false } = {}) {
  const safe = sanitizeDownloadFilename(filename);
  // ASCII fallback + RFC 5987 filename* for non-ASCII.
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'download';
  const disposition = inline ? 'inline' : 'attachment';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function guessContentType(filename, contentType) {
  const ct = String(contentType || '').trim();
  if (ct) return ct;
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
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
    openedAt: row.opened_at || null,
    openCount: row.open_count || 0,
    clickedAt: row.clicked_at || null,
    clickCount: row.click_count || 0,
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
      && row.status !== 'cancelled'
      && !compacted
      && row.stored_payload
      && Object.keys(row.stored_payload).length,
    ),
    canCancel: Boolean(
      row.status !== 'cancelled'
      && row.status !== 'failed'
      && row.metadata?.kind !== 'disregard'
    ),
    canDownload: Boolean(
      !compacted
      && (
        row.html_body
        || row.text_body
        || (Array.isArray(row.attachments) && row.attachments.some((a) => a?.content_base64))
        || (row.stored_payload && Object.keys(row.stored_payload).length)
      ),
    ),
  };
}

function rowToDetail(row) {
  const item = rowToListItem(row);
  // Never ship base64 payloads in the JSON detail response — use download routes.
  return {
    ...item,
    bcc: row.bcc_addresses || [],
    replyTo: row.reply_to,
    htmlBody: row.html_body,
    textBody: row.text_body,
    attachments: attachmentsMetaList(row.attachments || []),
    // Flag only — avoids transferring multi-MB attachment bodies on every detail open.
    hasStoredPayload: Boolean(row.stored_payload && Object.keys(row.stored_payload).length),
  };
}

/**
 * Load a single stored attachment by index. Returns binary content for download/view.
 * @returns {Promise<{ filename: string, contentType: string, content: Buffer, viewable: boolean }|null>}
 */
async function getEmailAttachment(pool, id, index) {
  const client = pool || { query };
  const { rows } = await client.query(
    'SELECT id, attachments, metadata FROM sent_emails WHERE id = $1',
    [id],
  );
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = rows[0];
  if (row.metadata?.compactedAt) {
    const err = new Error('Email was compacted — attachments are no longer stored');
    err.statusCode = 409;
    throw err;
  }
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) {
    const err = new Error('Attachment not found');
    err.statusCode = 404;
    throw err;
  }
  const att = attachments[idx];
  if (!att?.filename || !att.content_base64) {
    const err = new Error('Attachment content is not available');
    err.statusCode = 404;
    throw err;
  }
  const content = decodeStoredAttachmentContent(att);
  if (!content) {
    const err = new Error('Attachment content could not be decoded');
    err.statusCode = 500;
    throw err;
  }
  const contentType = guessContentType(att.filename, att.content_type || att.contentType);
  return {
    filename: String(att.filename),
    contentType,
    content,
    viewable: isViewableContentType(contentType, att.filename),
  };
}

/**
 * Build an RFC 822 (.eml) message from a stored outbox row, including body + attachments.
 * @returns {Promise<{ filename: string, contentType: string, content: Buffer }>}
 */
async function buildEmailEml(pool, id) {
  const client = pool || { query };
  const { rows } = await client.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = rows[0];
  if (row.metadata?.compactedAt) {
    const err = new Error('Email was compacted — body and attachments are no longer stored');
    err.statusCode = 409;
    throw err;
  }

  const stored = row.stored_payload || {};
  const html = row.html_body || stored.html || null;
  const text = row.text_body || stored.text || null;
  const from = row.from_address || stored.from || undefined;
  const to = (row.to_addresses?.length ? row.to_addresses : normalizeAddressList(stored.to)).join(', ') || undefined;
  const cc = (row.cc_addresses?.length ? row.cc_addresses : normalizeAddressList(stored.cc)).join(', ') || undefined;
  const bcc = (row.bcc_addresses?.length ? row.bcc_addresses : normalizeAddressList(stored.bcc)).join(', ') || undefined;
  const replyTo = row.reply_to || stored.reply_to || stored.replyTo || undefined;
  const subject = row.subject || stored.subject || '(no subject)';
  const date = row.created_at ? new Date(row.created_at) : new Date();

  const rawAttachments = Array.isArray(row.attachments) && row.attachments.length
    ? row.attachments
    : (Array.isArray(stored.attachments) ? stored.attachments : []);

  const attachments = rawAttachments
    .map((att) => {
      const content = decodeStoredAttachmentContent(att);
      if (!content || !att.filename) return null;
      const part = {
        filename: String(att.filename),
        content,
        contentType: guessContentType(att.filename, att.content_type || att.contentType),
      };
      const contentId = att.content_id || att.contentId;
      if (contentId) {
        part.cid = String(contentId);
        part.contentDisposition = 'inline';
      }
      return part;
    })
    .filter(Boolean);

  if (!html && !text && !attachments.length) {
    const err = new Error('No email body or attachments stored for download');
    err.statusCode = 409;
    throw err;
  }

  const mail = new MailComposer({
    from,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    replyTo: replyTo || undefined,
    subject,
    date,
    html: html || undefined,
    text: text || (html ? undefined : '(no body)'),
    attachments: attachments.length ? attachments : undefined,
    headers: {
      'X-Email-Outbox-Id': String(row.id),
      'X-Resend-Id': row.resend_id || '',
      'X-Source-System': row.source_system || '',
      'X-Source-Type': row.source_type || '',
    },
  });

  const content = await mail.compile().build();
  const safeSubject = sanitizeDownloadFilename(subject, `email-${row.id}`).slice(0, 80);
  return {
    filename: `${safeSubject || `email-${row.id}`}.eml`,
    contentType: 'message/rfc822',
    content,
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
    opened_at: patch.openedAt,
    open_count: patch.openCount,
    clicked_at: patch.clickedAt,
    click_count: patch.clickCount,
    error_message: patch.errorMessage,
    resend_allowed: patch.resendAllowed,
    updated_at: patch.updatedAt || new Date().toISOString(),
  };

  for (const [col, val] of Object.entries(setters)) {
    if (val !== undefined) {
      fields.push(`${col} = $${idx++}`);
      values.push(val);
    }
  }

  if (patch.metadata !== undefined) {
    fields.push(`metadata = $${idx++}::jsonb`);
    values.push(JSON.stringify(patch.metadata || {}));
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
    err.recordId = recordId;
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
  from: 'from_address',
  openedAt: 'opened_at',
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
  if (row.status === 'cancelled') {
    const err = new Error('This email was cancelled — resend of this variant is not allowed. Send a new welcome letter instead.');
    err.statusCode = 403;
    throw err;
  }
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

  const lastEvent = normalizeResendEventName(type) || normalizeResendEventName(data.last_event);
  const client = pool || { query };
  const { rows } = await client.query(
    `SELECT id, open_count, click_count, opened_at, clicked_at, delivery_status, status
     FROM sent_emails WHERE resend_id = $1`,
    [resendId],
  );
  if (!rows.length) return { ok: true, matched: false };
  const row = rows[0];
  const nowIso = new Date().toISOString();

  // Opens/clicks are tracked in their own columns so they never clobber
  // delivery_status — a message can be both "delivered" and "opened".
  if (lastEvent === 'opened' || lastEvent === 'clicked') {
    await applyResendLastEvent(pool, row, lastEvent, { eventAt: nowIso, increment: true });
    return { ok: true, matched: true, id: row.id, lastEvent };
  }

  const deliveryStatus = mapResendEventToDelivery(lastEvent);
  await updateEmailRecord(pool, row.id, {
    lastEvent,
    lastEventAt: nowIso,
    deliveryStatus: deliveryStatus || undefined,
    status: deliveryStatus === 'failed' ? 'failed' : undefined,
    errorMessage: data.error?.message || data.bounce?.message || undefined,
  });
  return { ok: true, matched: true, id: row.id, lastEvent };
}

async function syncFromResendApi(resend, pool, { limit = 100, maxPages = 20, accountLabel = null } = {}) {
  const client = pool || { query };
  let after;
  let imported = 0;
  let updated = 0;
  let pages = 0;
  const sourceSystem = accountLabel ? `resend-sync:${accountLabel}` : 'resend-sync';

  while (pages < maxPages) {
    const opts = { limit: Math.min(limit, 100) };
    if (after) opts.after = after;
    const { data, error } = await resend.emails.list(opts);
    if (error) throw new Error(error.message || String(error));
    const page = data?.data || [];
    if (!page.length) break;

    for (const item of page) {
      const resendId = item.id;
      const lastEvent = normalizeResendEventName(item.last_event) || 'sent';
      const deliveryStatus = mapResendEventToDelivery(lastEvent);
      // Opened/clicked imply delivery for brand-new import rows.
      const effectiveDelivery = deliveryStatus
        || (lastEvent === 'opened' || lastEvent === 'clicked' ? 'delivered' : 'sent');
      const existing = await client.query(
        `SELECT id, stored_payload, open_count, opened_at, click_count, clicked_at, delivery_status, status
         FROM sent_emails WHERE resend_id = $1`,
        [resendId],
      );
      if (existing.rows.length) {
        await applyResendLastEvent(pool, existing.rows[0], lastEvent, {
          eventAt: item.created_at || new Date().toISOString(),
          increment: false,
        });
        updated += 1;
        continue;
      }

      const openPatch = lastEvent === 'opened' || lastEvent === 'clicked'
        ? {
          open_count: 1,
          opened_at: item.created_at || new Date().toISOString(),
          click_count: lastEvent === 'clicked' ? 1 : 0,
          clicked_at: lastEvent === 'clicked' ? (item.created_at || new Date().toISOString()) : null,
        }
        : null;

      const id = await insertEmailRecord(pool, {
        sourceSystem,
        sourceType: 'unknown',
        resendId,
        status: effectiveDelivery === 'failed' ? 'failed' : 'sent',
        deliveryStatus: effectiveDelivery,
        lastEvent,
        lastEventAt: item.created_at || null,
        fromAddress: item.from || null,
        toAddresses: normalizeAddressList(item.to),
        ccAddresses: normalizeAddressList(item.cc),
        subject: item.subject || null,
        storedPayload: {},
        resendAllowed: false,
        metadata: { syncedFromResend: true, resendAccount: accountLabel || null },
      });
      if (openPatch) {
        await updateEmailRecord(pool, id, {
          openCount: openPatch.open_count,
          openedAt: openPatch.opened_at,
          clickCount: openPatch.click_count || undefined,
          clickedAt: openPatch.clicked_at || undefined,
        });
      }
      imported += 1;
    }

    if (!data?.has_more) break;
    after = page[page.length - 1].id;
    pages += 1;
  }

  return { imported, updated, pages };
}

/**
 * Pull latest delivery/open state from Resend for stored emails of a source type.
 * Used by the Welcome Letter board Refresh button so open tracking updates even
 * when webhooks were delayed or not subscribed to email.opened.
 */
async function syncOpenTrackingForSourceType(resend, pool, sourceType, { limit = 150 } = {}) {
  if (!resend?.emails?.get) {
    const err = new Error('Resend client is not available');
    err.statusCode = 500;
    throw err;
  }
  const client = pool || { query };
  const cap = Math.min(Math.max(Number(limit) || 150, 1), 300);
  const { rows } = await client.query(
    `SELECT id, resend_id, open_count, opened_at, click_count, clicked_at, delivery_status, status
     FROM sent_emails
     WHERE source_type = $1
       AND resend_id IS NOT NULL
       AND status <> 'cancelled'
     ORDER BY created_at DESC
     LIMIT $2`,
    [sourceType, cap],
  );

  let checked = 0;
  let updated = 0;
  let opensFound = 0;
  const errors = [];

  for (const row of rows) {
    checked += 1;
    try {
      const { data, error } = await resend.emails.get(row.resend_id);
      if (error) {
        errors.push({ id: row.id, resendId: row.resend_id, error: error.message || String(error) });
        continue;
      }
      if (!data) continue;
      const lastEvent = normalizeResendEventName(data.last_event) || 'sent';
      const beforeOpens = Number(row.open_count || 0);
      await applyResendLastEvent(pool, row, lastEvent, {
        eventAt: data.created_at || new Date().toISOString(),
        increment: false,
      });
      updated += 1;
      if (lastEvent === 'opened' || lastEvent === 'clicked' || beforeOpens === 0) {
        // Re-read not needed for count; last_event open/click means at least one open.
        if (lastEvent === 'opened' || lastEvent === 'clicked') opensFound += 1;
      }
    } catch (err) {
      errors.push({ id: row.id, resendId: row.resend_id, error: err.message || String(err) });
    }
  }

  return { checked, updated, opensFound, errors: errors.slice(0, 10) };
}

/**
 * Soft-cancel a tracked email: mark status cancelled, block exact resend of this
 * variant. Does not remove the message from the recipient's mailbox (Resend cannot).
 */
async function markEmailCancelled(pool, id, {
  cancelledByEmail = null,
  reason = null,
  extraMetadata = {},
} = {}) {
  const client = pool || { query };
  const { rows } = await client.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
  if (!rows.length) {
    const err = new Error('Email record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = rows[0];
  if (row.status === 'cancelled') {
    return { alreadyCancelled: true, item: await getEmailById(pool, id) };
  }

  const metadata = {
    ...(row.metadata || {}),
    ...extraMetadata,
    cancelledAt: new Date().toISOString(),
    cancelledBy: cancelledByEmail || null,
    cancelReason: reason || null,
  };

  await updateEmailRecord(pool, id, {
    status: 'cancelled',
    resendAllowed: false,
    metadata,
  });

  return { alreadyCancelled: false, item: await getEmailById(pool, id) };
}

/**
 * Resend's `emails.list()` API is scoped to the account tied to the API key
 * used to call it — it will NOT return emails sent from a different Resend
 * account, even if both accounts belong to the same org. We send email from
 * more than one Resend account (e.g. retail-odyssey.com from one account,
 * the-dump-bin.com signoffs from another), so the Outbox has to sync each
 * account separately and merge the results here.
 */
async function syncFromResendAccounts(accounts, pool, { limit = 100, maxPages = 20 } = {}) {
  const list = (accounts || []).filter((a) => a && a.client);
  const byAccount = [];
  let imported = 0;
  let updated = 0;
  let pages = 0;

  for (const { client: resendClient, label } of list) {
    try {
      const result = await syncFromResendApi(resendClient, pool, { limit, maxPages, accountLabel: label });
      byAccount.push({ label: label || 'default', ...result });
      imported += result.imported;
      updated += result.updated;
      pages += result.pages;
    } catch (err) {
      byAccount.push({ label: label || 'default', error: err.message || String(err) });
    }
  }

  return { imported, updated, pages, byAccount };
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
  attachmentsMetaList,
  attachmentMeta,
  mapResendEventToDelivery,
  resolveListSort,
  LIST_SORT_COLUMNS,
  sendViaOutbox,
  createEmailSender,
  listEmails,
  getEmailById,
  getEmailAttachment,
  buildEmailEml,
  contentDispositionHeader,
  sanitizeDownloadFilename,
  guessContentType,
  isViewableContentType,
  decodeStoredAttachmentContent,
  resendStoredEmail,
  ingestEmailRecord,
  applyResendWebhookEvent,
  applyResendLastEvent,
  normalizeResendEventName,
  syncFromResendApi,
  syncFromResendAccounts,
  syncOpenTrackingForSourceType,
  markEmailCancelled,
  editEmailRecord,
  compactEmailRecord,
  deleteEmailRecord,
  purgeEmailsOlderThan,
  retentionDays,
  rowToListItem,
  rowToDetail,
  updateEmailRecord,
};
