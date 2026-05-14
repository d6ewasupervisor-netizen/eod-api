const express = require('express');
const { requireAuth, authenticateRequest } = require('../auth-middleware');
const { issueDownloadLinkToken, verifyDownloadLinkToken } = require('../lib/download-link-jwt');
const graph = require('../lib/dump-bin-graph');

const router = express.Router();

function withDownloadTokens(files) {
  return (files || []).map((f) => ({
    ...f,
    t: issueDownloadLinkToken(f.key),
  }));
}

router.get('/list', requireAuth, async (req, res) => {
  const prefix = String(req.query.prefix || '');
  try {
    const { folders, files } = await graph.listByPrefix(prefix);
    return res.json({
      folders,
      files: withDownloadTokens(files),
    });
  } catch (err) {
    if (err.code === 'DUMP_BIN_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: err.message });
    }
    console.error('[dump-bin list]', err);
    return res.status(500).json({ ok: false, error: err.message || 'List failed' });
  }
});

// Mint or refresh a download token (e.g. ZIP / bulk download) when the client
// no longer has `t` from a list payload.
router.get('/download-token', requireAuth, async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
  try {
    const t = issueDownloadLinkToken(key);
    return res.json({ ok: true, t });
  } catch (err) {
    console.error('[dump-bin download-token]', err);
    return res.status(500).json({ ok: false, error: 'Could not issue token' });
  }
});

router.get('/download', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) return res.status(400).send('Missing key');

  const t = String(req.query.t || '').trim();
  if (t) {
    try {
      const payload = verifyDownloadLinkToken(t);
      if (payload.key !== key) {
        return res.status(403).send('Download token does not match key');
      }
      return await pipeDumpFile(res, key);
    } catch (err) {
      if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
        return res.status(401).send('Download link expired or invalid');
      }
      console.error('[dump-bin download] token path', err);
      return res.status(500).send('Download failed');
    }
  }

  const user = await authenticateRequest(req, res);
  if (!user) return;
  try {
    return await pipeDumpFile(res, key);
  } catch (err) {
    console.error('[dump-bin download] auth path', err);
    const status = err.status && Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
    return res.status(status).send(err.message || 'Download failed');
  }
});

async function pipeDumpFile(res, key) {
  if (!graph.isConfigured()) {
    return res.status(503).send('Dump bin storage not configured');
  }
  try {
    const { buffer, contentType, contentDisposition } = await graph.fetchFileContent(key);
    res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    const status =
      err.status && Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
    if (!res.headersSent) {
      return res.status(status).send(err.message || 'Download failed');
    }
    throw err;
  }
}

module.exports = router;
