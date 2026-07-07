/**
 * InstaWork sign-out image delivery for cloud EOD API (mobile-safe).
 *
 * Priority (production uses email → Gmail poller → OneDrive):
 *   1. Email via Resend (defaults: info@retail-odyssey.com → d6ewa.supervisor@gmail.com)
 *   2. SharePoint via Microsoft Graph when INSTAWORK_SP_* + AAD are configured
 *   3. Local disk INSTAWORK_SIGNOUT_ROOT when the path exists (dev only)
 */

const fs = require('fs').promises;
const path = require('path');

const {
  formatPeriodWeekUnpadded,
  pickExistingPeriodWeekFolderName,
} = require('./fiscal-calendar');
const { addReplyTo } = require('./resend-reply-to');
const { dispatchTrackedEmail } = require('./resend-outbox');
const { retailOdysseyFrom } = require('./email-from');

function graphEnv() {
  const tenant =
    process.env.INSTAWORK_AAD_TENANT_ID ||
    process.env.MICROSOFT_TENANT_ID ||
    process.env.AZURE_TENANT_ID;
  const clientId =
    process.env.INSTAWORK_AAD_CLIENT_ID ||
    process.env.MICROSOFT_CLIENT_ID ||
    process.env.AZURE_CLIENT_ID;
  const clientSecret =
    process.env.INSTAWORK_AAD_CLIENT_SECRET ||
    process.env.MICROSOFT_CLIENT_SECRET ||
    process.env.AZURE_CLIENT_SECRET;
  const driveId = process.env.INSTAWORK_SP_DRIVE_ID;
  const baseFolderId = process.env.INSTAWORK_SP_SIGNOUT_FOLDER_ITEM_ID;
  return { tenant, clientId, clientSecret, driveId, baseFolderId };
}

function graphConfigured() {
  const e = graphEnv();
  return !!(e.tenant && e.clientId && e.clientSecret && e.driveId && e.baseFolderId);
}

async function getGraphAccessToken() {
  const { tenant, clientId, clientSecret } = graphEnv();
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const j = await r.json();
  if (!j.access_token) {
    throw new Error(j.error_description || j.error || 'Microsoft Graph token request failed');
  }
  return j.access_token;
}

/**
 * Finds `P4W2` vs `P04W2` siblings under the SharePoint Sign Out root, else creates unpadded basename.
 */
async function getOrCreatePeriodWeekSharePointFolder(token, driveId, parentItemId, period, week) {
  const listUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}/children`;
  const listR = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  const data = await listR.json();
  if (!listR.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  const childFolders = (data.value || []).filter((c) => c.folder);
  const siblingNames = childFolders.map((c) => c.name);
  const matchBasename = pickExistingPeriodWeekFolderName(siblingNames, period, week);
  if (matchBasename) {
    const hit = childFolders.find((c) => c.name.toLowerCase() === matchBasename.toLowerCase());
    if (hit) return { folderItemId: hit.id, basename: hit.name };
  }

  const newName = formatPeriodWeekUnpadded(period, week);
  const createR = await fetch(listUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: newName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
  const created = await createR.json();
  if (!createR.ok) {
    throw new Error(created.error?.message || JSON.stringify(created));
  }
  return { folderItemId: created.id, basename: created.name };
}

async function resolveInstaworkWeekFolderBasenameOnDisk(rootDir, period, week) {
  const dirents = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  return (
    pickExistingPeriodWeekFolderName(dirs, period, week) ?? formatPeriodWeekUnpadded(period, week)
  );
}

async function uploadJpegToFolder(token, driveId, folderItemId, fileName, buffer) {
  const enc = encodeURIComponent(fileName).replace(/'/g, '%27');
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderItemId}:/${enc}:/content`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: buffer,
  });
  const meta = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(meta.error?.message || r.statusText || 'Graph upload failed');
  }
  return meta;
}

async function deliverViaGraph({ period, week, fileName, buffer, log }) {
  const token = await getGraphAccessToken();
  const { driveId, baseFolderId } = graphEnv();
  const { folderItemId: weekFolderId, basename } = await getOrCreatePeriodWeekSharePointFolder(
    token,
    driveId,
    baseFolderId,
    period,
    week,
  );
  const item = await uploadJpegToFolder(token, driveId, weekFolderId, fileName, buffer);
  const webUrl = item.webUrl || null;
  const logical = webUrl || `SharePoint:${basename}/${fileName}`;
  log.info({ webUrl, folder: basename, fileName }, 'InstaWork image uploaded via SharePoint');
  return {
    delivery: 'sharepoint',
    filePath: logical,
    resolvedFolderBasename: basename,
  };
}

async function deliverViaLocalDisk({ rootDir, period, week, fileName, buffer, logger }) {
  const { writeFileVersioned } = require('./file-utils');
  const basename = await resolveInstaworkWeekFolderBasenameOnDisk(rootDir, period, week);
  const targetDir = path.join(rootDir, basename);
  await fs.mkdir(targetDir, { recursive: true });
  const desiredPath = path.join(targetDir, fileName);
  const writtenPath = await writeFileVersioned(desiredPath, buffer, logger);
  return { delivery: 'local', filePath: writtenPath, resolvedFolderBasename: basename };
}

function parseEmailRecipients() {
  const list = (process.env.INSTAWORK_EMAIL_RECIPIENTS || 'd6ewa.supervisor@gmail.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['d6ewa.supervisor@gmail.com'];
}

async function deliverViaEmail({ resend, fileName, periodWeekLabel, period, week, storeNumber, workDate, buffer, log, userEmail }) {
  const to = parseEmailRecipients();
  const from = process.env.INSTAWORK_EMAIL_FROM || retailOdysseyFrom('InstaWork');
  const subject = `[InstaWork sign-out] ${periodWeekLabel} FM${String(storeNumber).replace(/\D/g, '').padStart(3, '0')} ${workDate} ${fileName}`;
  const html = `<p>InstaWork sign-out sheet image attached.</p>
<p><strong>Period / week:</strong> ${periodWeekLabel}<br/>
<strong>Store:</strong> ${storeNumber}<br/>
<strong>Work date:</strong> ${workDate}<br/>
<strong>File:</strong> ${fileName}</p>
<p>Subject line carries routing metadata for the flow-automation Gmail watcher.</p>`;

  const payload = {
    from,
    to,
    subject,
    html,
    attachments: [
      {
        filename: fileName,
        content: buffer.toString('base64'),
      },
    ],
  };
  addReplyTo(payload, { userEmail });

  const { data, error } = await dispatchTrackedEmail(resend, {
    sourceType: 'instawork-signout',
    sourceRef: storeNumber,
    sentByEmail: userEmail,
    metadata: { storeNumber, workDate, periodWeekLabel, fileName },
  }, payload);

  if (error) {
    throw new Error(error.message || String(error));
  }
  log.info({ id: data?.id, to }, 'InstaWork image emailed (mobile / fallback path)');
  return {
    delivery: 'email',
    filePath: `email:${fileName}`,
    resendId: data?.id,
    resolvedFolderBasename: formatPeriodWeekUnpadded(period, week),
  };
}

async function deliverInstaworkImage(opts) {
  const {
    rootDir,
    period,
    week,
    periodWeekLabel,
    fileName,
    storeNumber,
    workDate,
    buffer,
    resend,
    log,
    userEmail,
  } = opts;

  if (resend && parseEmailRecipients().length) {
    return deliverViaEmail({
      resend,
      fileName,
      periodWeekLabel,
      period,
      week,
      storeNumber,
      workDate,
      buffer,
      userEmail,
      log,
    });
  }

  if (graphConfigured()) {
    return deliverViaGraph({ period, week, fileName, buffer, log });
  }

  if (rootDir) {
    try {
      await fs.access(rootDir);
      return deliverViaLocalDisk({ rootDir, period, week, fileName, buffer, logger: log });
    } catch {
      /* fall through */
    }
  }

  throw new Error(
    'InstaWork delivery is not configured. Set RESEND_API_KEY plus email recipients, ' +
      'or SharePoint Graph env (INSTAWORK_SP_* + INSTAWORK_AAD_*), or a writable INSTAWORK_SIGNOUT_ROOT.'
  );
}

module.exports = {
  deliverInstaworkImage,
  graphConfigured,
  parseEmailRecipients,
};
