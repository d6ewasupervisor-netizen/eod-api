/**
 * Checklane Hub — off-Railway backup snapshots via Resend.
 *
 * To restore: take the JSON attachment, replay data.section_state /
 * tag_flags / pending_actions into Postgres for that visit_id; schemaVersion
 * gates the format.
 *
 * Triggers:
 *   - Every 15 minutes for visits marked dirty (see hub-state.js)
 *   - Immediately on sign-off via markVisitDirtyAndBackupNow()
 */

const { query } = require('./lib/db');
const { buildSetRelatedEmailPayload } = require('./lib/checklanes-email');
const { dispatchTrackedEmail } = require('./lib/resend-outbox');
const {
  markVisitDirty,
  clearVisitDirty,
  getDirtyVisitIds,
} = require('./hub-state');

const SCHEMA_VERSION = 1;
const INTERVAL_MS = 15 * 60 * 1000;
const TZ = 'America/Los_Angeles';

const logger = {
  info: (...a) => console.log('[hub-backup]', ...a),
  warn: (...a) => console.warn('[hub-backup]', ...a),
  error: (...a) => console.error('[hub-backup]', ...a),
};

let _resend = null;
let intervalHandle = null;
let inFlight = null;

function initHubBackup({ resend }) {
  _resend = resend;
}

function resolveBackupRecipient() {
  if (process.env.HUB_BACKUP_EMAIL) {
    return process.env.HUB_BACKUP_EMAIL.trim();
  }
  if (process.env.OVERRIDE_APPROVER_EMAIL) {
    return process.env.OVERRIDE_APPROVER_EMAIL.trim();
  }
  const supervisors = (process.env.KOMPASS_SUPERVISOR_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (supervisors.length) return supervisors[0];
  return 'tyson.gauthier@retailodyssey.com';
}

function parseVisitId(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }
  return visitIdNum;
}

function serializeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (value !== null && typeof value === 'object' && typeof value.toISOString === 'function') {
      out[key] = value.toISOString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function formatStoreNumber(storeNumber) {
  if (storeNumber == null || storeNumber === '') return null;
  const n = Number(storeNumber);
  if (!Number.isFinite(n)) return String(storeNumber);
  return String(n).padStart(5, '0');
}

async function resolveStore(visitIdNum) {
  const { BLITZ_PROJECT_ID } = require('./lib/hub-blitz-config');
  const { rows } = await query(
    `SELECT store_number
     FROM schedules
     WHERE visit_id = $1
     ORDER BY (project_id = $2) DESC, scheduled_date DESC
     LIMIT 1`,
    [visitIdNum, BLITZ_PROJECT_ID],
  );
  if (rows.length && rows[0].store_number != null) {
    return formatStoreNumber(rows[0].store_number);
  }
  return null;
}

async function nextSequence(visitIdNum) {
  const { rows } = await query(
    `INSERT INTO hub_backup_seq (visit_id, last_seq)
     VALUES ($1, 1)
     ON CONFLICT (visit_id) DO UPDATE
       SET last_seq = hub_backup_seq.last_seq + 1
     RETURNING last_seq`,
    [visitIdNum],
  );
  return rows[0].last_seq;
}

function buildSummary(sectionState, tagFlags, pendingActions) {
  const byState = {
    not_started: 0,
    assigned: 0,
    in_progress: 0,
    needs_attention: 0,
    done_pending_signoff: 0,
    signed_off: 0,
    not_in_store: 0,
  };

  let lastSignoffAt = null;

  for (const row of sectionState) {
    if (Object.prototype.hasOwnProperty.call(byState, row.state)) {
      byState[row.state] += 1;
    }
    if (row.signed_off_at) {
      const ts = row.signed_off_at instanceof Date
        ? row.signed_off_at.toISOString()
        : String(row.signed_off_at);
      if (!lastSignoffAt || ts > lastSignoffAt) {
        lastSignoffAt = ts;
      }
    }
  }

  const openTagFlags = tagFlags.filter((row) => row.status === 'flagged').length;
  const pendingActionCount = pendingActions.filter((row) => row.status === 'pending').length;

  return {
    total: sectionState.length,
    byState,
    openTagFlags,
    pendingActions: pendingActionCount,
    lastSignoffAt,
  };
}

async function buildBackup(visitId) {
  const visitIdNum = parseVisitId(visitId);

  const [sectionResult, tagResult, pendingResult, store, sequence] = await Promise.all([
    query('SELECT * FROM section_state WHERE visit_id = $1 ORDER BY dbkey', [visitIdNum]),
    query('SELECT * FROM tag_flags WHERE visit_id = $1 ORDER BY id', [visitIdNum]),
    query('SELECT * FROM pending_actions WHERE visit_id = $1 ORDER BY id', [visitIdNum]),
    resolveStore(visitIdNum),
    nextSequence(visitIdNum),
  ]);

  const sectionState = sectionResult.rows.map(serializeRow);
  const tagFlags = tagResult.rows.map(serializeRow);
  const pendingActions = pendingResult.rows.map(serializeRow);

  return {
    schemaVersion: SCHEMA_VERSION,
    visitId: visitIdNum,
    store,
    generatedAt: new Date().toISOString(),
    sequence,
    data: {
      section_state: sectionState,
      tag_flags: tagFlags,
      pending_actions: pendingActions,
    },
    summary: buildSummary(sectionResult.rows, tagResult.rows, pendingResult.rows),
  };
}

function formatLocalTimestamp(date = new Date()) {
  return date.toLocaleString('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatFilenameTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
}

function reasonLabel(reason) {
  return reason === 'signoff' ? 'sign-off' : '15-min interval';
}

function buildHtmlBody(backup, reason) {
  const storeLabel = backup.store || 'unknown';
  const localTime = formatLocalTimestamp(new Date(backup.generatedAt));
  const s = backup.summary;

  const stateLines = Object.entries(s.byState)
    .map(([state, count]) => `<tr><td style="padding:4px 8px;color:#6b7280;">${state.replace(/_/g, ' ')}</td><td style="padding:4px 8px;font-weight:600;">${count}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:420px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Hub backup</h2>
  <table style="width:100%;border-collapse:collapse;font-size:15px;">
    <tr><td style="padding:4px 0;color:#6b7280;">Store</td><td style="padding:4px 0;font-weight:600;">${storeLabel}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Visit</td><td style="padding:4px 0;font-weight:600;">${backup.visitId}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Time (${TZ})</td><td style="padding:4px 0;font-weight:600;">${localTime}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Sequence</td><td style="padding:4px 0;font-weight:600;">${backup.sequence}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Reason</td><td style="padding:4px 0;font-weight:600;">${reasonLabel(reason)}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Sections</td><td style="padding:4px 0;font-weight:600;">${s.total}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Open tag flags</td><td style="padding:4px 0;font-weight:600;">${s.openTagFlags}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Pending actions</td><td style="padding:4px 0;font-weight:600;">${s.pendingActions}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Last sign-off</td><td style="padding:4px 0;font-weight:600;">${s.lastSignoffAt || '—'}</td></tr>
  </table>
  <h3 style="margin:20px 0 8px;font-size:14px;color:#374151;">By state</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">${stateLines}</table>
  <p style="margin:20px 0 0;color:#6b7280;font-size:13px;">Full restore JSON attached.</p>
</body></html>`;
}

function buildBodySummary(backup, reason) {
  const s = backup.summary;
  return [
    `store=${backup.store || 'unknown'}`,
    `visit=${backup.visitId}`,
    `seq=${backup.sequence}`,
    `reason=${reasonLabel(reason)}`,
    `sections=${s.total}`,
    `openTags=${s.openTagFlags}`,
    `pending=${s.pendingActions}`,
  ].join(' · ');
}

async function logEmailSend({
  visitIdNum,
  recipients,
  subject,
  bodySummary,
  resendId,
  sentBy = 0,
}) {
  await query(
    `INSERT INTO email_log (visit_id, email_type, recipients, subject, body_summary, sent_by, resend_id)
     VALUES ($1, 'hub_backup', $2, $3, $4, $5, $6)`,
    [visitIdNum, recipients, subject, bodySummary, sentBy, resendId || null],
  );
}

async function sendBackup(visitId, reason, { sentBy = 0 } = {}) {
  if (!_resend) {
    logger.error('sendBackup called before initHubBackup');
    return { sent: false, error: 'Hub backup not initialized' };
  }

  const visitIdNum = parseVisitId(visitId);
  let backup;

  try {
    backup = await buildBackup(visitIdNum);
  } catch (err) {
    logger.error(`buildBackup failed for visit ${visitIdNum}:`, err.message);
    return { sent: false, error: err.message };
  }

  const storeLabel = backup.store || 'unknown';
  const localTime = formatLocalTimestamp(new Date(backup.generatedAt));
  const stamp = formatFilenameTimestamp(new Date(backup.generatedAt));
  const filename = `hub-backup_${storeLabel}_${backup.visitId}_seq${backup.sequence}_${stamp}.json`;
  const subject = `[Hub backup] Store ${storeLabel} · visit ${backup.visitId} · ${localTime} · seq${backup.sequence}`;
  const to = resolveBackupRecipient();
  const html = buildHtmlBody(backup, reason);
  const bodySummary = buildBodySummary(backup, reason);
  const jsonContent = Buffer.from(JSON.stringify(backup, null, 2)).toString('base64');

  try {
    const emailPayload = buildSetRelatedEmailPayload({
        to,
        subject,
        html,
        attachments: [{ filename, content: jsonContent }],
      });
    const { data, error } = await dispatchTrackedEmail(_resend, {
      sourceType: 'hub-backup',
      sourceRef: visitIdNum,
      metadata: { visitId: visitIdNum, store: storeLabel, sequence: backup.sequence, subject },
    }, emailPayload);

    if (error) {
      logger.error(`Resend error for visit ${visitIdNum}:`, error.message || String(error));
      return { sent: false, error: error.message || String(error), sequence: backup.sequence };
    }

    try {
      await logEmailSend({
        visitIdNum,
        recipients: [to],
        subject,
        bodySummary,
        resendId: data?.id,
        sentBy,
      });
    } catch (logErr) {
      logger.error(`email_log insert failed for visit ${visitIdNum}:`, logErr.message);
    }

    logger.info(`Backup sent visit=${visitIdNum} seq=${backup.sequence} reason=${reason} id=${data?.id}`);
    return { sent: true, sequence: backup.sequence, resendId: data?.id };
  } catch (err) {
    logger.error(`sendBackup failed for visit ${visitIdNum}:`, err.message);
    return { sent: false, error: err.message, sequence: backup.sequence };
  }
}

async function markVisitDirtyAndBackupNow(visitId) {
  const visitIdNum = parseVisitId(visitId);
  markVisitDirty(visitIdNum);
  const result = await sendBackup(visitIdNum, 'signoff');
  if (result.sent) {
    clearVisitDirty(visitIdNum);
  }
  return result;
}

async function runIntervalBackups() {
  const dirtyIds = getDirtyVisitIds();
  if (!dirtyIds.length) return { ok: true, skipped: true, reason: 'empty' };

  for (const visitId of dirtyIds) {
    const result = await sendBackup(visitId, 'interval');
    if (result.sent) {
      clearVisitDirty(visitId);
    }
  }

  return { ok: true, processed: dirtyIds.length };
}

function startBackupIntervalJob() {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    if (inFlight) {
      logger.info('Skipping interval run — previous backup job still in flight');
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const result = await runIntervalBackups();
        if (!result.skipped) {
          logger.info('Interval backup run finished:', JSON.stringify(result));
        }
      } catch (err) {
        logger.error('Interval backup job threw:', err.message);
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }, INTERVAL_MS);

  logger.info(`Hub backup interval scheduled every ${INTERVAL_MS / 60000} minutes`);
}

module.exports = {
  initHubBackup,
  buildBackup,
  sendBackup,
  markVisitDirtyAndBackupNow,
  startBackupIntervalJob,
  resolveBackupRecipient,
};
