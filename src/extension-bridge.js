// extension-bridge.js
//
// Hosts versioned releases of the sas-automator-portable Chrome
// extension so the office USB stick can pull the latest code without
// the user having to remember to copy a fresh zip onto it.
//
// Storage model: each upload becomes a row in extension_releases with
// the zip blob in bytea. Latest = ORDER BY uploaded_at DESC LIMIT 1.
// 80KB-per-version × small N versions stays well under any sane
// Postgres size budget; we don't bother with retention pruning.
//
// Auth model:
//   POST /extension/publish        — Bearer SAS_AUTH_SECRET (write-protect)
//   GET  /extension/manifest       — public (read-only metadata)
//   GET  /extension/download[/v]   — public (zip body)
//
// Read endpoints are public on purpose: the bundle contains no secrets
// (creds live in chrome.storage on the user's own machine, encrypted
// behind a passphrase). The "Anyone with my Railway URL can download
// my Chrome extension" exposure is acceptable; Cloudflare Access in
// front of eod-api narrows the audience further in practice.

const crypto = require('crypto');

const AUTH_SECRET = process.env.SAS_AUTH_SECRET || '';
const MAX_ZIP_BYTES = 5 * 1024 * 1024; // 5 MB ceiling — a healthy 50× the current bundle size

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extension_releases (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      zip_bytes BYTEA NOT NULL,
      description TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uploaded_by TEXT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_extension_releases_uploaded_at
      ON extension_releases (uploaded_at DESC)
  `);
}

function authedAsPublisher(req) {
  if (!AUTH_SECRET) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${AUTH_SECRET}`;
}

async function init(app, pool) {
  await ensureTable(pool);

  // ── GET /extension/manifest ──────────────────────────────────────
  // Lightweight metadata so update.ps1 can short-circuit when the
  // local manifest version already matches the published one.
  app.get('/extension/manifest', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT version, sha256, size_bytes, description, uploaded_at, uploaded_by
           FROM extension_releases
          ORDER BY uploaded_at DESC
          LIMIT 1`
      );
      if (!rows.length) {
        return res.status(404).json({ ok: false, error: 'No extension releases published yet' });
      }
      const r = rows[0];
      return res.json({
        ok: true,
        version: r.version,
        sha256: r.sha256,
        sizeBytes: r.size_bytes,
        description: r.description,
        uploadedAt: r.uploaded_at,
        uploadedBy: r.uploaded_by,
      });
    } catch (err) {
      console.error('[extension-bridge] manifest query failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /extension/download[/v] ──────────────────────────────────
  // Streams the zip. With no version param, returns the latest.
  app.get(['/extension/download', '/extension/download/:version'], async (req, res) => {
    try {
      const wanted = req.params.version;
      const sql = wanted
        ? `SELECT version, sha256, zip_bytes
             FROM extension_releases
            WHERE version = $1
            ORDER BY uploaded_at DESC
            LIMIT 1`
        : `SELECT version, sha256, zip_bytes
             FROM extension_releases
            ORDER BY uploaded_at DESC
            LIMIT 1`;
      const args = wanted ? [wanted] : [];
      const { rows } = await pool.query(sql, args);
      if (!rows.length) {
        return res.status(404).json({ ok: false, error: 'No matching release' });
      }
      const r = rows[0];
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', r.zip_bytes.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sas-automator-portable-${r.version}.zip"`
      );
      // Surface SHA-256 so update.ps1 can verify without a second
      // round-trip to /extension/manifest.
      res.setHeader('X-Extension-Version', r.version);
      res.setHeader('X-Extension-Sha256', r.sha256);
      return res.end(r.zip_bytes);
    } catch (err) {
      console.error('[extension-bridge] download failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /extension/publish ──────────────────────────────────────
  // Body: { version, description?, sha256, zipBase64 }
  // Server re-computes sha256 from the bytes it received and rejects
  // the upload if it doesn't match the client's claim — covers the
  // accidental-corruption case but is NOT a substitute for the Bearer
  // secret as a write gate.
  app.post('/extension/publish', async (req, res) => {
    if (!AUTH_SECRET) {
      return res.status(500).json({ ok: false, error: 'SAS_AUTH_SECRET not set on the server' });
    }
    if (!authedAsPublisher(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const body = req.body || {};
    const { version, description, sha256, zipBase64, uploadedBy } = body;

    if (!version || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ ok: false, error: 'version must be a semver string like 1.2.3' });
    }
    if (!sha256 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      return res.status(400).json({ ok: false, error: 'sha256 must be a 64-char hex string' });
    }
    if (!zipBase64 || typeof zipBase64 !== 'string') {
      return res.status(400).json({ ok: false, error: 'zipBase64 missing' });
    }

    let zipBytes;
    try {
      zipBytes = Buffer.from(zipBase64, 'base64');
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'zipBase64 is not valid base64' });
    }
    if (zipBytes.length === 0) {
      return res.status(400).json({ ok: false, error: 'zipBase64 decoded to zero bytes' });
    }
    if (zipBytes.length > MAX_ZIP_BYTES) {
      return res.status(413).json({
        ok: false,
        error: `zip exceeds ${MAX_ZIP_BYTES} byte cap (got ${zipBytes.length})`,
      });
    }

    const computed = crypto.createHash('sha256').update(zipBytes).digest('hex');
    if (computed.toLowerCase() !== sha256.toLowerCase()) {
      return res.status(400).json({
        ok: false,
        error: 'sha256 mismatch — upload corrupted or attacker tampered',
        expected: sha256,
        computed,
      });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO extension_releases (version, sha256, size_bytes, zip_bytes, description, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, uploaded_at`,
        [
          version,
          computed,
          zipBytes.length,
          zipBytes,
          description || null,
          (uploadedBy && String(uploadedBy).slice(0, 200)) || null,
        ]
      );
      const row = rows[0];
      console.log(
        `[extension-bridge] Published ${version} (${zipBytes.length}B, sha256=${computed.slice(0, 12)}…) ` +
        `as release id=${row.id}`
      );
      return res.json({
        ok: true,
        id: row.id,
        version,
        sha256: computed,
        sizeBytes: zipBytes.length,
        uploadedAt: row.uploaded_at,
      });
    } catch (err) {
      console.error('[extension-bridge] publish insert failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { init };
