// Microsoft Graph helpers for Dump Bin list/download. Uses the same app-only
// credentials as InstaWork SharePoint uploads (INSTAWORK_AAD_* / MICROSOFT_*).

function graphEnv() {
  return {
    tenant:
      process.env.INSTAWORK_AAD_TENANT_ID ||
      process.env.MICROSOFT_TENANT_ID ||
      process.env.AZURE_TENANT_ID,
    clientId:
      process.env.INSTAWORK_AAD_CLIENT_ID ||
      process.env.MICROSOFT_CLIENT_ID ||
      process.env.AZURE_CLIENT_ID,
    clientSecret:
      process.env.INSTAWORK_AAD_CLIENT_SECRET ||
      process.env.MICROSOFT_CLIENT_SECRET ||
      process.env.AZURE_CLIENT_SECRET,
    driveId: process.env.DUMP_BIN_SP_DRIVE_ID,
  };
}

function isConfigured() {
  const e = graphEnv();
  return !!(e.tenant && e.clientId && e.clientSecret && e.driveId);
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

/** Encode each path segment for Graph "path under root" URLs. */
function encodeGraphPath(pathStr) {
  const raw = String(pathStr || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) return '';
  return raw
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function childrenUrlForPath(driveId, folderPath) {
  const enc = encodeGraphPath(folderPath);
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`;
  if (!enc) return `${base}/root/children`;
  return `${base}/root:/${enc}:/children`;
}

function contentUrlForKey(driveId, fileKey) {
  const enc = encodeGraphPath(fileKey);
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`;
  return `${base}/root:/${enc}:/content`;
}

/**
 * @param {string} prefix - POSIX folder prefix with trailing slash (may be "")
 * @returns {{ folders: Array<{ name, prefix }>, files: Array<{ name, size, key }> }}
 */
async function listByPrefix(prefix) {
  if (!isConfigured()) {
    const err = new Error('Dump bin SharePoint is not configured (set DUMP_BIN_SP_DRIVE_ID + Microsoft app credentials)');
    err.code = 'DUMP_BIN_NOT_CONFIGURED';
    throw err;
  }
  const { driveId } = graphEnv();
  const token = await getGraphAccessToken();
  const folderPath = String(prefix || '').replace(/^\/+/, '');
  const url = childrenUrlForPath(driveId, folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  const normPrefix = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
  const folders = [];
  const files = [];
  for (const item of data.value || []) {
    if (item.folder) {
      const name = item.name || '';
      folders.push({
        name,
        prefix: `${normPrefix}${name}/`,
      });
    } else if (item.file) {
      const name = item.name || '';
      files.push({
        name,
        size: Number(item.size) || 0,
        key: `${normPrefix}${name}`,
      });
    }
  }
  return { folders, files };
}

/** Fetch file bytes from Graph (follows redirect to SAS URL when applicable). */
async function fetchFileContent(key) {
  if (!isConfigured()) {
    const err = new Error('Dump bin SharePoint is not configured');
    err.code = 'DUMP_BIN_NOT_CONFIGURED';
    throw err;
  }
  const { driveId } = graphEnv();
  const token = await getGraphAccessToken();
  const url = contentUrlForKey(driveId, key);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = j.error?.message || msg;
    } catch (_) { /* ignore */ }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const buffer = Buffer.from(await r.arrayBuffer());
  return {
    buffer,
    contentType: r.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: r.headers.get('content-disposition'),
  };
}

module.exports = {
  isConfigured,
  listByPrefix,
  fetchFileContent,
};
