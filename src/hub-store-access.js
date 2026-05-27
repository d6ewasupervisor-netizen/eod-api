// Checklane Hub — store-scoped access, assignments, and supervisor purview.

const { query } = require('./lib/db');
const { resolveHubUser } = require('./hub-auth');
const { resolveStoreForVisit } = require('./lib/hub-fixture-catalog');

function parseVisitId(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }
  return visitIdNum;
}

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS = parseEmailList(process.env.KOMPASS_ADMIN_EMAILS);
const SUPERVISOR_EMAILS = parseEmailList(process.env.KOMPASS_SUPERVISOR_EMAILS);
const HUB_ADMIN_EMAILS = parseEmailList(process.env.CHECKLANES_HUB_ADMIN_EMAILS);

const BUILTIN_HUB_ADMINS = new Set([
  'tyson.gauthier@retailodyssey.com',
  'd6ewa.supervisor@gmail.com',
]);

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function normalizeStoreNumber(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? String(n) : digits.replace(/^0+/, '') || '0';
}

function storeRoleToRank(role) {
  return role === 'lead' ? 2 : 1;
}

function isEnvSupervisor(email) {
  const e = normalizeEmail(email);
  return ADMIN_EMAILS.includes(e) || SUPERVISOR_EMAILS.includes(e);
}

async function isHubAdmin(user, hubUserRow) {
  const email = normalizeEmail(user?.email);
  if (BUILTIN_HUB_ADMINS.has(email)) return true;
  if (HUB_ADMIN_EMAILS.includes(email)) return true;
  if (ADMIN_EMAILS.includes(email)) return true;
  if (hubUserRow?.is_hub_admin) return true;
  return false;
}

async function getSupervisorStoreNumbers(email) {
  const e = normalizeEmail(email);
  if (!e) return [];

  const { rows } = await query(
    `SELECT DISTINCT store_number::text AS store_number
     FROM schedules
     WHERE store_number IS NOT NULL
       AND (
         lower(coalesce(supervisor, '')) LIKE '%' || $1 || '%'
         OR lower(coalesce(visit_lead, '')) LIKE '%' || $1 || '%'
       )
     ORDER BY store_number`,
    [e],
  );

  return rows
    .map((row) => normalizeStoreNumber(row.store_number))
    .filter(Boolean);
}

async function getDirectAssignment(userId) {
  const { rows } = await query(
    `SELECT a.store_number, a.store_role, s.name, s.default_visit_id, s.is_test
     FROM hub_store_assignments a
     JOIN hub_stores s ON s.store_number = a.store_number
     WHERE a.user_id = $1
     ORDER BY s.name NULLS LAST, a.store_number`,
    [userId],
  );
  return rows;
}

async function listAccessibleStores(user) {
  const hubUser = await resolveHubUser(user);
  const admin = await isHubAdmin(user, hubUser);
  const assignments = await getDirectAssignment(hubUser.id);
  const assignmentByStore = new Map(
    assignments.map((row) => [normalizeStoreNumber(row.store_number), row]),
  );

  let storeRows;
  if (admin) {
    const { rows } = await query(
      `SELECT store_number, name, default_visit_id, is_test
       FROM hub_stores
       ORDER BY is_test DESC, name NULLS LAST, store_number`,
    );
    storeRows = rows;
  } else if (isEnvSupervisor(user.email)) {
    const supervisorStores = await getSupervisorStoreNumbers(user.email);
    const assignedStores = assignments.map((a) => normalizeStoreNumber(a.store_number));
    const storeSet = new Set([...supervisorStores, ...assignedStores]);

    if (!storeSet.size) {
      return {
        isAdmin: false,
        isSupervisor: true,
        stores: [],
        hubUserId: hubUser.id,
      };
    }

    const { rows } = await query(
      `SELECT store_number, name, default_visit_id, is_test
       FROM hub_stores
       WHERE store_number = ANY($1::text[])
       ORDER BY name NULLS LAST, store_number`,
      [[...storeSet]],
    );
    storeRows = rows;

    for (const sn of storeSet) {
      if (!storeRows.some((r) => normalizeStoreNumber(r.store_number) === sn)) {
        storeRows.push({
          store_number: sn,
          name: `Store ${String(sn).padStart(5, '0')}`,
          default_visit_id: null,
          is_test: false,
        });
      }
    }
  } else {
    if (!assignments.length) {
      return {
        isAdmin: false,
        isSupervisor: false,
        stores: [],
        hubUserId: hubUser.id,
      };
    }
    storeRows = assignments.map((a) => ({
      store_number: a.store_number,
      name: a.name,
      default_visit_id: a.default_visit_id,
      is_test: a.is_test,
    }));
  }

  const stores = storeRows.map((row) => {
    const sn = normalizeStoreNumber(row.store_number);
    const assignment = assignmentByStore.get(sn);
    const canManage = admin || isEnvSupervisor(user.email);
    return {
      storeNumber: sn,
      name: row.name || `Store ${String(sn).padStart(5, '0')}`,
      defaultVisitId: row.default_visit_id != null ? String(row.default_visit_id) : null,
      isTest: !!row.is_test,
      myRole: assignment?.store_role || (canManage && !admin ? 'supervisor' : null),
      isAssigned: !!assignment,
      canManage: admin || (isEnvSupervisor(user.email) && (
        admin || assignment?.store_role === 'lead' || !assignment
      )),
      myRank: assignment ? storeRoleToRank(assignment.store_role) : (canManage ? 3 : 1),
    };
  });

  for (const store of stores) {
    if (admin || isEnvSupervisor(user.email)) {
      store.canManage = true;
      if (!store.myRole) store.myRole = 'supervisor';
      store.myRank = Math.max(store.myRank || 1, 3);
    }
  }

  return {
    isAdmin: admin,
    isSupervisor: isEnvSupervisor(user.email),
    stores,
    hubUserId: hubUser.id,
  };
}

async function userHasVisitAccess(user, visitId) {
  const visitIdNum = parseVisitId(visitId);
  const hubUser = await resolveHubUser(user);
  const admin = await isHubAdmin(user, hubUser);
  if (admin) return { allowed: true, reason: 'admin' };

  const storeNumber = await resolveStoreForVisit(visitIdNum);
  if (!storeNumber) {
    return { allowed: false, reason: 'unknown_store' };
  }

  if (isEnvSupervisor(user.email)) {
    const supervisorStores = await getSupervisorStoreNumbers(user.email);
    if (supervisorStores.includes(storeNumber)) {
      return { allowed: true, reason: 'supervisor', storeNumber };
    }
  }

  const { rows } = await query(
    `SELECT store_role FROM hub_store_assignments
     WHERE user_id = $1 AND store_number = $2`,
    [hubUser.id, storeNumber],
  );
  if (rows.length) {
    return {
      allowed: true,
      reason: 'assignment',
      storeNumber,
      storeRole: rows[0].store_role,
    };
  }

  return { allowed: false, reason: 'not_assigned', storeNumber };
}

async function storeRankForUser(user, storeNumber) {
  const hubUser = await resolveHubUser(user);
  const admin = await isHubAdmin(user, hubUser);
  if (admin || isEnvSupervisor(user.email)) return 3;

  const sn = normalizeStoreNumber(storeNumber);
  const { rows } = await query(
    `SELECT store_role FROM hub_store_assignments
     WHERE user_id = $1 AND store_number = $2`,
    [hubUser.id, sn],
  );
  if (rows.length) return storeRoleToRank(rows[0].store_role);
  return 1;
}

async function canManageStore(user, storeNumber) {
  const hubUser = await resolveHubUser(user);
  if (await isHubAdmin(user, hubUser)) return true;
  if (isEnvSupervisor(user.email)) return true;

  const sn = normalizeStoreNumber(storeNumber);
  const { rows } = await query(
    `SELECT store_role FROM hub_store_assignments
     WHERE user_id = $1 AND store_number = $2`,
    [hubUser.id, sn],
  );
  return rows.length && rows[0].store_role === 'lead';
}

async function listStoreAssignments(storeNumber) {
  const sn = normalizeStoreNumber(storeNumber);
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, a.store_role, a.assigned_at
     FROM hub_store_assignments a
     JOIN hub_users u ON u.id = a.user_id
     WHERE a.store_number = $1 AND u.is_active = true
     ORDER BY
       CASE a.store_role WHEN 'lead' THEN 0 ELSE 1 END,
       u.name`,
    [sn],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.store_role,
    assignedAt: row.assigned_at,
  }));
}

async function upsertStoreAssignment({
  storeNumber,
  email,
  role,
  assignedById,
}) {
  const sn = normalizeStoreNumber(storeNumber);
  const normalizedEmail = normalizeEmail(email);
  const storeRole = role === 'lead' ? 'lead' : 'rep';

  const storeCheck = await query(
    'SELECT store_number FROM hub_stores WHERE store_number = $1',
    [sn],
  );
  if (!storeCheck.rows.length) {
    await query(
      `INSERT INTO hub_stores (store_number, name)
       VALUES ($1, $2)
       ON CONFLICT (store_number) DO NOTHING`,
      [sn, `Store ${String(sn).padStart(5, '0')}`],
    );
  }

  const name = normalizedEmail.split('@')[0] || 'User';
  const userResult = await query(
    `INSERT INTO hub_users (email, name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET is_active = true
     RETURNING id`,
    [normalizedEmail, name],
  );
  const userId = userResult.rows[0].id;

  if (storeRole === 'lead') {
    await query(
      `UPDATE hub_store_assignments
       SET store_role = 'rep'
       WHERE store_number = $1 AND store_role = 'lead' AND user_id <> $2`,
      [sn, userId],
    );
  }

  await query(
    `INSERT INTO hub_store_assignments (store_number, user_id, store_role, assigned_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_number, user_id) DO UPDATE
       SET store_role = EXCLUDED.store_role,
           assigned_by = EXCLUDED.assigned_by,
           assigned_at = now()`,
    [sn, userId, storeRole, assignedById || null],
  );

  return { userId, email: normalizedEmail, role: storeRole };
}

async function removeStoreAssignment(storeNumber, userId) {
  const sn = normalizeStoreNumber(storeNumber);
  const { rowCount } = await query(
    `DELETE FROM hub_store_assignments
     WHERE store_number = $1 AND user_id = $2`,
    [sn, userId],
  );
  return rowCount > 0;
}

function requireVisitAccess() {
  return async (req, res, next) => {
    try {
      const access = await userHasVisitAccess(req.user, req.params.visitId);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'You do not have access to this store visit',
          storeNumber: access.storeNumber || null,
        });
      }
      req.hubStoreAccess = access;
      next();
    } catch (err) {
      if (err.message === 'Invalid visitId') {
        return res.status(400).json({ error: err.message });
      }
      console.error('[hub-store-access] visit access check failed:', err.message);
      return res.status(500).json({ error: 'Failed to verify store access' });
    }
  };
}

module.exports = {
  normalizeStoreNumber,
  isHubAdmin,
  listAccessibleStores,
  userHasVisitAccess,
  storeRankForUser,
  canManageStore,
  listStoreAssignments,
  upsertStoreAssignment,
  removeStoreAssignment,
  requireVisitAccess,
  storeRoleToRank,
};
