// Bay completion photos — one row per (visit, lane, dbkey, bay_num).

const { query } = require('./lib/db');

function normalizeLane(lane) {
  if (lane == null) return '';
  return String(lane).trim();
}

function parseBayNum(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw Object.assign(new Error('dataUrl is required'), { status: 400 });
  }
  const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
  if (!match) {
    throw Object.assign(new Error('dataUrl must be a base64 image data URL'), { status: 400 });
  }
  const contentType = match[1];
  const base64 = match[2];
  if (!base64 || base64.length < 32) {
    throw Object.assign(new Error('Image data is empty or too small'), { status: 400 });
  }
  const approxBytes = Math.ceil((base64.length * 3) / 4);
  if (approxBytes > 8 * 1024 * 1024) {
    throw Object.assign(new Error('Image exceeds 8 MB limit'), { status: 413 });
  }
  return { contentType, base64 };
}

async function listBayPhotos(visitIdNum, dbkey, lane) {
  const laneNorm = normalizeLane(lane);
  const { rows } = await query(
    `SELECT bay_num, content_type, updated_at, uploaded_by
     FROM section_bay_photos
     WHERE visit_id = $1 AND dbkey = $2 AND lane = $3
     ORDER BY bay_num ASC`,
    [visitIdNum, dbkey, laneNorm],
  );
  return rows.map((row) => ({
    bay_num: row.bay_num,
    content_type: row.content_type,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    uploaded_by: row.uploaded_by,
  }));
}

async function loadBayPhotoRow(visitIdNum, dbkey, lane, bayNum) {
  const laneNorm = normalizeLane(lane);
  const { rows } = await query(
    `SELECT id, content_type, photo_base64
     FROM section_bay_photos
     WHERE visit_id = $1 AND dbkey = $2 AND lane = $3 AND bay_num = $4`,
    [visitIdNum, dbkey, laneNorm, bayNum],
  );
  return rows[0] || null;
}

async function upsertBayPhoto(visitIdNum, dbkey, lane, bayNum, dataUrl, uploadedBy) {
  const laneNorm = normalizeLane(lane);
  const { contentType, base64 } = parseDataUrl(dataUrl);
  await query(
    `INSERT INTO section_bay_photos (
       visit_id, lane, dbkey, bay_num, content_type, photo_base64, uploaded_by, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (visit_id, lane, dbkey, bay_num) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           photo_base64 = EXCLUDED.photo_base64,
           uploaded_by = EXCLUDED.uploaded_by,
           updated_at = now()`,
    [visitIdNum, laneNorm, dbkey, bayNum, contentType, base64, uploadedBy],
  );
}

async function assertAllBayPhotosPresent(visitIdNum, dbkey, lane, bayNums) {
  if (!Array.isArray(bayNums) || !bayNums.length) return;
  const photos = await listBayPhotos(visitIdNum, dbkey, lane);
  const saved = new Set(photos.map((p) => p.bay_num));
  const missing = bayNums.filter((bn) => !saved.has(bn));
  if (missing.length) {
    throw Object.assign(
      new Error('Bay photos required before marking done — missing bay(s): ' + missing.join(', ')),
      { status: 409, missingBays: missing },
    );
  }
}

async function clearBayPhotos(visitIdNum, dbkey, lane) {
  const laneNorm = normalizeLane(lane);
  await query(
    `DELETE FROM section_bay_photos WHERE visit_id = $1 AND dbkey = $2 AND lane = $3`,
    [visitIdNum, dbkey, laneNorm],
  );
}

module.exports = {
  normalizeLane,
  parseBayNum,
  listBayPhotos,
  loadBayPhotoRow,
  upsertBayPhoto,
  assertAllBayPhotosPresent,
  clearBayPhotos,
};
