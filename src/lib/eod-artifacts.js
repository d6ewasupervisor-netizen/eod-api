'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool } = require('./db');
const { publicArtifactUrl, artifactUrlTtlDays } = require('./eod-artifact-jwt');

function artifactsRoot() {
  const fromEnv = String(process.env.EOD_ARTIFACTS_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve('/app/data/eod-artifacts');
}

function retentionDays() {
  const v = process.env.EOD_ARTIFACT_RETENTION_DAYS;
  if (v == null || v === '') return 180;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 180;
}

function ensureRoot() {
  const root = artifactsRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function absolutePathFor(relPath) {
  const root = artifactsRoot();
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error('Invalid artifact path');
  }
  return abs;
}

/**
 * Persist PDF + signoff buffers for one EOD send. Returns package metadata + public URLs.
 * @param {{ storeNumber: string|number, pdf?: { buffer: Buffer, filename: string, mime?: string }, signoffs?: Array<{ buffer: Buffer, filename: string, mime: string }> }} opts
 */
async function storeEodPackage({ storeNumber, pdf, signoffs = [] }) {
  const root = ensureRoot();
  const packageId = crypto.randomUUID();
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dirRel = path.join(yyyy, mm, packageId);
  const dirAbs = path.join(root, dirRel);
  await fsp.mkdir(dirAbs, { recursive: true });

  const items = [];
  let sortIndex = 0;

  async function insertOne({ kind, filename, mime, buffer }) {
    const safeName = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 180);
    const relPath = path.join(dirRel, `${sortIndex}_${safeName}`).replace(/\\/g, '/');
    const abs = absolutePathFor(relPath);
    await fsp.writeFile(abs, buffer);
    const sizeBytes = buffer.length;
    const { rows } = await pool.query(
      `INSERT INTO eod_artifacts
         (package_id, kind, filename, mime, size_bytes, rel_path, store_number, sort_index)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, kind, filename, mime, size_bytes, sort_index`,
      [
        packageId,
        kind,
        safeName,
        mime || 'application/octet-stream',
        sizeBytes,
        relPath,
        storeNumber != null ? String(storeNumber) : null,
        sortIndex,
      ]
    );
    const row = rows[0];
    const url = publicArtifactUrl(row.id);
    items.push({
      id: Number(row.id),
      kind: row.kind,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes),
      sortIndex: Number(row.sort_index),
      url,
    });
    sortIndex += 1;
  }

  if (pdf?.buffer?.length) {
    await insertOne({
      kind: 'pdf',
      filename: pdf.filename || `EOD_Store${storeNumber}.pdf`,
      mime: pdf.mime || 'application/pdf',
      buffer: pdf.buffer,
    });
  }

  for (const s of signoffs) {
    if (!s?.buffer?.length) continue;
    await insertOne({
      kind: 'signoff',
      filename: s.filename || `signoff_${sortIndex}.jpg`,
      mime: s.mime || 'image/jpeg',
      buffer: s.buffer,
    });
  }

  return {
    packageId,
    linkTtlDays: artifactUrlTtlDays(),
    items,
    pdf: items.find((i) => i.kind === 'pdf') || null,
    signoffs: items.filter((i) => i.kind === 'signoff'),
  };
}

async function getArtifactRow(id) {
  const { rows } = await pool.query(
    `SELECT id, package_id, kind, filename, mime, size_bytes, rel_path, store_number, created_at
     FROM eod_artifacts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function readArtifactFile(row) {
  const abs = absolutePathFor(row.rel_path);
  return fsp.readFile(abs);
}

/**
 * Delete artifacts older than retention. Removes DB rows and files.
 */
async function purgeArtifactsOlderThan(days = retentionDays()) {
  const olderThanDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 180;
  const { rows } = await pool.query(
    `SELECT id, rel_path FROM eod_artifacts
     WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY id ASC
     LIMIT 5000`,
    [olderThanDays]
  );

  let deleted = 0;
  let filesRemoved = 0;
  for (const row of rows) {
    try {
      const abs = absolutePathFor(row.rel_path);
      await fsp.unlink(abs).catch((err) => {
        if (err && err.code !== 'ENOENT') throw err;
      });
      filesRemoved += 1;
    } catch {
      // continue — still drop the row
    }
    await pool.query('DELETE FROM eod_artifacts WHERE id = $1', [row.id]);
    deleted += 1;
  }

  // Best-effort: remove empty package dirs under root (ignore errors)
  try {
    await pruneEmptyDirs(artifactsRoot(), 3);
  } catch {
    // ignore
  }

  return { deleted, filesRemoved, olderThanDays };
}

async function pruneEmptyDirs(dir, maxDepth) {
  if (maxDepth < 0) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    await pruneEmptyDirs(path.join(dir, ent.name), maxDepth - 1);
  }
  try {
    const left = await fsp.readdir(dir);
    if (left.length === 0 && path.resolve(dir) !== path.resolve(artifactsRoot())) {
      await fsp.rmdir(dir);
    }
  } catch {
    // ignore
  }
}

module.exports = {
  artifactsRoot,
  retentionDays,
  ensureRoot,
  storeEodPackage,
  getArtifactRow,
  readArtifactFile,
  purgeArtifactsOlderThan,
  absolutePathFor,
};
