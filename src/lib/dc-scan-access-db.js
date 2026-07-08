'use strict';

const crypto = require('node:crypto');
const { query } = require('./db');
const { normalizeEmail } = require('./dc-scan-inventory');

function newRequestId() {
  return crypto.randomUUID();
}

async function loadGrantedVolunteerEmails() {
  const { rows } = await query('SELECT lower(email) AS email FROM dc_scan_volunteer_grants');
  return rows.map((r) => normalizeEmail(r.email)).filter(Boolean);
}

async function grantVolunteerEmail({ email, name, grantedBy }) {
  const em = normalizeEmail(email);
  const { rows } = await query(
    `INSERT INTO dc_scan_volunteer_grants (email, name, granted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, dc_scan_volunteer_grants.name),
           granted_by = EXCLUDED.granted_by,
           granted_at = NOW()
     RETURNING *`,
    [em, name || null, grantedBy || null],
  );
  return rows[0];
}

async function createDcScanAccessRequest({ id, name, email, reason }) {
  const { rows } = await query(
    `INSERT INTO dc_scan_access_requests (id, name, email, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, name, normalizeEmail(email), reason || null],
  );
  return rows[0];
}

async function getDcScanAccessRequest(id) {
  const { rows } = await query('SELECT * FROM dc_scan_access_requests WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getPendingDcScanAccessRequestForEmail(email) {
  const em = normalizeEmail(email);
  const { rows } = await query(
    `SELECT * FROM dc_scan_access_requests
     WHERE lower(email) = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [em],
  );
  return rows[0] || null;
}

async function markDcScanAccessRequestDecided(id, action, decidedBy) {
  const status = action === 'approve' ? 'approved' : 'denied';
  const { rows } = await query(
    `UPDATE dc_scan_access_requests
     SET status = $2, decided_at = NOW(), decided_by = $3, decided_action = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, decidedBy, action],
  );
  return rows[0] || null;
}

module.exports = {
  newRequestId,
  loadGrantedVolunteerEmails,
  grantVolunteerEmail,
  createDcScanAccessRequest,
  getDcScanAccessRequest,
  getPendingDcScanAccessRequestForEmail,
  markDcScanAccessRequestDecided,
};
