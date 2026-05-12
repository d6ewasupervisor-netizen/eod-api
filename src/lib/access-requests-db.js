// DB helpers for the self-serve access-request flow. The UPDATE … WHERE
// status='pending' RETURNING * pattern gives atomic first-click-wins between
// the two emailed decision links without any application-level locking.

const crypto = require('node:crypto');
const { query } = require('./db');

function newRequestId() {
  return crypto.randomUUID();
}

async function createAccessRequest({ id, name, email, reason }) {
  const { rows } = await query(
    `INSERT INTO access_requests (id, name, email, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, name, email, reason || null],
  );
  return rows[0];
}

async function getAccessRequest(id) {
  const { rows } = await query(
    'SELECT * FROM access_requests WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}

async function markAccessRequestDecided(id, action, decidedBy) {
  const status = action === 'approve' ? 'approved' : 'denied';
  const { rows } = await query(
    `UPDATE access_requests
     SET status = $2, decided_at = NOW(), decided_by = $3, decided_action = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, decidedBy, action],
  );
  return rows[0] || null;
}

module.exports = {
  newRequestId,
  createAccessRequest,
  getAccessRequest,
  markAccessRequestDecided,
};
