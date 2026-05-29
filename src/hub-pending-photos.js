// Photos attached to a pending action (help / not-in-store flags).

const { query } = require('./lib/db');

const MAX_PHOTOS_PER_FLAG = 6;

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw Object.assign(new Error('Photo must be a base64 image data URL'), { status: 400 });
  }
  const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
  if (!match) {
    throw Object.assign(new Error('Photo must be a base64 image data URL'), { status: 400 });
  }
  const contentType = match[1];
  const base64 = match[2];
  if (!base64 || base64.length < 32) {
    throw Object.assign(new Error('Photo data is empty or too small'), { status: 400 });
  }
  const approxBytes = Math.ceil((base64.length * 3) / 4);
  if (approxBytes > 8 * 1024 * 1024) {
    throw Object.assign(new Error('Photo exceeds 8 MB limit'), { status: 413 });
  }
  return { contentType, base64 };
}

/**
 * Validate an array of base64 image data URLs up front (before any DB write),
 * so a bad photo never leaves a flag half-saved.
 * @returns {{ contentType: string, base64: string }[]}
 */
function parsePhotoDataUrls(photos) {
  if (photos == null) return [];
  if (!Array.isArray(photos)) {
    throw Object.assign(new Error('photos must be an array of data URLs'), { status: 400 });
  }
  const list = photos.filter((p) => typeof p === 'string' && p.trim());
  if (list.length > MAX_PHOTOS_PER_FLAG) {
    throw Object.assign(
      new Error(`Too many photos — max ${MAX_PHOTOS_PER_FLAG} per flag`),
      { status: 400 },
    );
  }
  return list.map(parseDataUrl);
}

async function insertPendingPhotos(visitIdNum, pendingId, parsedPhotos, uploadedBy) {
  if (!parsedPhotos || !parsedPhotos.length) return 0;
  let idx = 0;
  for (const photo of parsedPhotos) {
    await query(
      `INSERT INTO pending_action_photos
         (visit_id, pending_id, idx, content_type, photo_base64, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [visitIdNum, pendingId, idx, photo.contentType, photo.base64, uploadedBy],
    );
    idx += 1;
  }
  return parsedPhotos.length;
}

async function listPendingPhotos(visitIdNum, pendingId) {
  const { rows } = await query(
    `SELECT id, idx, content_type
     FROM pending_action_photos
     WHERE visit_id = $1 AND pending_id = $2
     ORDER BY idx ASC, id ASC`,
    [visitIdNum, pendingId],
  );
  return rows.map((row) => ({
    id: row.id,
    idx: row.idx,
    content_type: row.content_type,
  }));
}

async function loadPendingPhotoRow(visitIdNum, pendingId, photoId) {
  const { rows } = await query(
    `SELECT id, content_type, photo_base64
     FROM pending_action_photos
     WHERE visit_id = $1 AND pending_id = $2 AND id = $3`,
    [visitIdNum, pendingId, photoId],
  );
  return rows[0] || null;
}

/**
 * Photos as Resend-ready attachments (base64 content + filename).
 * @returns {{ filename: string, content: string, content_type: string }[]}
 */
async function loadPendingPhotosForEmail(visitIdNum, pendingId) {
  const { rows } = await query(
    `SELECT id, idx, content_type, photo_base64
     FROM pending_action_photos
     WHERE visit_id = $1 AND pending_id = $2
     ORDER BY idx ASC, id ASC`,
    [visitIdNum, pendingId],
  );
  return rows.map((row, i) => {
    const ext = (row.content_type || 'image/jpeg').split('/')[1] || 'jpg';
    return {
      filename: `flag-photo-${i + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
      content: row.photo_base64,
      content_type: row.content_type || 'image/jpeg',
    };
  });
}

module.exports = {
  MAX_PHOTOS_PER_FLAG,
  parsePhotoDataUrls,
  insertPendingPhotos,
  listPendingPhotos,
  loadPendingPhotoRow,
  loadPendingPhotosForEmail,
};
