const fs = require('fs').promises;
const path = require('path');

const LOCK_OR_EXISTS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EEXIST']);

function isLockedOrExistsError(err) {
  return !!err && LOCK_OR_EXISTS_CODES.has(err.code);
}

function buildVersionedCandidate(filePath, version) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(dir, `${baseName} version ${version}${ext}`);
}

async function getWritablePath(filePath, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 50;

  async function exists(candidate) {
    try { await fs.access(candidate); return true; } catch { return false; }
  }

  if (!(await exists(filePath))) return filePath;

  for (let version = 2; version < 2 + maxAttempts; version++) {
    const candidate = buildVersionedCandidate(filePath, version);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free versioned path for ${filePath} after ${maxAttempts} attempts`);
}

async function writeFileVersioned(filePath, content, log = null) {
  let targetPath = await getWritablePath(filePath);
  if (targetPath !== filePath && log) {
    log.info({ original: filePath, versioned: targetPath }, 'Target exists or is locked; writing to versioned path');
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.writeFile(targetPath, content);
      return targetPath;
    } catch (err) {
      if (!isLockedOrExistsError(err)) throw err;
      const nextPath = await getWritablePath(targetPath);
      if (log) log.warn({ err: err.code, from: targetPath, to: nextPath }, 'Write raced with a lock; bumping version');
      targetPath = nextPath;
    }
  }
  throw new Error(`Could not write to ${filePath} or any versioned variant (file kept getting locked)`);
}

module.exports = { writeFileVersioned, getWritablePath };
