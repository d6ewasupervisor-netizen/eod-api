/**
 * InstaWork sign-out image delivery for cloud EOD API (mobile-safe).
 *
 * Priority (production uses email → Gmail poller → OneDrive):
 *   1. Email via Resend (defaults: instawork@retail-odyssey.com → d6ewa.supervisor@gmail.com)
 *   2. SharePoint via Microsoft Graph when INSTAWORK_SP_* + AAD are configured
 *   3. Local disk INSTAWORK_SIGNOUT_ROOT when the path exists (dev only)
 */

const fs = require('fs').promises;

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

async function getOrCreateChildFolder(token, driveId, parentItemId, folderName) {
  const listUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}/children`;
  const listR = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  const data = await listR.json();
  if (!listR.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  const existing = (data.value || []).find((c) => c.name === folderName && c.folder);
  if (existing) return existing.id;

  const createR = await fetch(listUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
  const created = await createR.json();
  if (!createR.ok) {
    throw new Error(created.error?.message || JSON.stringify(created));
  }
  return created.id;
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

async function deliverViaGraph({ periodWeekFolder, fileName, buffer, log }) {
  const token = await getGraphAccessToken();
  const { driveId, baseFolderId } = graphEnv();
  const weekFolderId = await getOrCreateChildFolder(token, driveId, baseFolderId, periodWeekFolder);
  const item = await uploadJpegToFolder(token, driveId, weekFolderId, fileName, buffer);
  const webUrl = item.webUrl || null;
  const logical = webUrl || `SharePoint:${periodWeekFolder}/${fileName}`;
  log.info({ webUrl, periodWeekFolder, fileName }, 'InstaWork image uploaded via SharePoint');
  return {
    delivery: 'sharepoint',
    filePath: logical,
  };
}

async function deliverViaLocalDisk({ targetDir, desiredPath, buffer, logger }) {
  const { writeFileVersioned } = require('./file-utils');
  await fs.mkdir(targetDir, { recursive: true });
  const writtenPath = await writeFileVersioned(desiredPath, buffer, logger);
  return { delivery: 'local', filePath: writtenPath };
}

function parseEmailRecipients() {
  const list = (process.env.INSTAWORK_EMAIL_RECIPIENTS || 'd6ewa.supervisor@gmail.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['d6ewa.supervisor@gmail.com'];
}

async function deliverViaEmail({ resend, fileName, periodWeekLabel, storeNumber, workDate, buffer, log }) {
  const to = parseEmailRecipients();
  const from = process.env.INSTAWORK_EMAIL_FROM || 'InstaWork <instawork@retail-odyssey.com>';
  const subject = `[InstaWork sign-out] ${periodWeekLabel} FM${String(storeNumber).replace(/\D/g, '').padStart(3, '0')} ${workDate} ${fileName}`;
  const html = `<p>InstaWork sign-out sheet image attached.</p>
<p><strong>Period / week:</strong> ${periodWeekLabel}<br/>
<strong>Store:</strong> ${storeNumber}<br/>
<strong>Work date:</strong> ${workDate}<br/>
<strong>File:</strong> ${fileName}</p>
<p>Subject line carries routing metadata for the flow-automation Gmail watcher.</p>`;

  const { data, error } = await resend.emails.send({
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
  });

  if (error) {
    throw new Error(error.message || String(error));
  }
  log.info({ id: data?.id, to }, 'InstaWork image emailed (mobile / fallback path)');
  return {
    delivery: 'email',
    filePath: `email:${fileName}`,
    resendId: data?.id,
  };
}

async function deliverInstaworkImage(opts) {
  const {
    rootDir,
    targetDir,
    desiredPath,
    periodWeekFolder,
    periodWeekLabel,
    fileName,
    storeNumber,
    workDate,
    buffer,
    resend,
    log,
  } = opts;

  if (resend && parseEmailRecipients().length) {
    return deliverViaEmail({
      resend,
      fileName,
      periodWeekLabel,
      storeNumber,
      workDate,
      buffer,
      log,
    });
  }

  if (graphConfigured()) {
    return deliverViaGraph({ periodWeekFolder, fileName, buffer, log });
  }

  if (rootDir) {
    try {
      await fs.access(rootDir);
      return deliverViaLocalDisk({ targetDir, desiredPath, buffer, logger: log });
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
