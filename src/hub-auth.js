// Checklane Hub — rank resolution (env-first, DB raises, never lowers).

const { query } = require('./lib/db');

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS = parseEmailList(process.env.KOMPASS_ADMIN_EMAILS);
const SUPERVISOR_EMAILS = parseEmailList(process.env.KOMPASS_SUPERVISOR_EMAILS);
const LEAD_EMAILS = parseEmailList(process.env.KOMPASS_LEAD_EMAILS);

function envRankFromEmail(email) {
  const e = (email || '').trim().toLowerCase();
  if (ADMIN_EMAILS.includes(e) || SUPERVISOR_EMAILS.includes(e)) return 3;
  if (LEAD_EMAILS.includes(e)) return 2;
  return 1;
}

function parseVisitId(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }
  return visitIdNum;
}

/**
 * Resolve or create hub_users row for the authenticated JWT user.
 * @param {{ email: string }} user
 */
async function resolveHubUser(user) {
  const email = (user.email || '').trim().toLowerCase();
  const fallbackName = email.split('@')[0] || 'User';

  const existing = await query(
    `SELECT id, email, name, standing_rank, is_active
     FROM hub_users
     WHERE email = $1`,
    [email],
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    if (!row.is_active) {
      throw new Error('Hub user inactive');
    }
    return row;
  }

  const inserted = await query(
    `INSERT INTO hub_users (email, name)
     VALUES ($1, $2)
     RETURNING id, email, name, standing_rank, is_active`,
    [email, fallbackName],
  );
  return inserted.rows[0];
}

/**
 * Effective hub rank: max(env baseline, standing_rank, active role_grants).
 * DB can only raise rank, never lower env baseline.
 */
async function resolveRank(user, visitId) {
  const visitIdNum = parseVisitId(visitId);
  const envRank = envRankFromEmail(user.email);

  const hubUser = await resolveHubUser(user);
  const standingRank = hubUser.is_active ? Number(hubUser.standing_rank) || 1 : 1;

  const { rows: grants } = await query(
    `SELECT granted_rank
     FROM role_grants
     WHERE visit_id = $1
       AND grantee_id = $2
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [visitIdNum, hubUser.id],
  );

  let grantRank = 0;
  for (const row of grants) {
    grantRank = Math.max(grantRank, Number(row.granted_rank) || 0);
  }

  return Math.max(envRank, standingRank, grantRank);
}

function requireHubRank(minRank) {
  return async (req, res, next) => {
    try {
      const rank = await resolveRank(req.user, req.params.visitId);
      req.hubRank = rank;
      req.hubUser = await resolveHubUser(req.user);
      if (rank < minRank) {
        return res.status(403).json({ error: 'lead or supervisor required' });
      }
      next();
    } catch (err) {
      if (err.message === 'Invalid visitId') {
        return res.status(400).json({ error: err.message });
      }
      console.error('[hub-auth] rank check failed:', err.message);
      return res.status(500).json({ error: 'Failed to resolve hub rank' });
    }
  };
}

async function writeAuditLog(visitIdNum, actorId, action, target, detail) {
  await query(
    `INSERT INTO audit_log (visit_id, actor_id, action, target, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [visitIdNum, actorId, action, target || null, JSON.stringify(detail || {})],
  );
}

module.exports = {
  envRankFromEmail,
  resolveHubUser,
  resolveRank,
  requireHubRank,
  writeAuditLog,
  parseVisitId,
};
