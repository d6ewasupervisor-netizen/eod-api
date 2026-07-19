// Survey feature ACL — mirrors trackers/welcome-letter pattern.
// Mount after requireAuth. Attaches req.surveyUser = roster row.
const { pool } = require('./db');

/** Master admins see every store and every district (division-wide). */
const MASTER_ADMIN_EMAILS = new Set([
  'tyson.gauthier@retailodyssey.com',
]);

function isMasterAdminEmail(email) {
  return MASTER_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

async function getSurveyUser(email) {
  const em = String(email || '').trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT email, name, role, team, supervisor_email, district, phone, title, active
       FROM survey_roster
      WHERE email = $1 AND active = TRUE`,
    [em]
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    isMasterAdmin: isMasterAdminEmail(row.email),
  };
}

async function requireSurveyAccess(req, res, next) {
  try {
    const su = await getSurveyUser(req.user && req.user.email);
    if (!su) return res.status(403).json({ ok: false, error: 'Not on the survey roster' });
    // Kompass env admin elevates to master for scoping
    if ((req.user?.roles || []).includes('admin') || isMasterAdminEmail(su.email)) {
      su.isMasterAdmin = true;
    }
    req.surveyUser = su;
    next();
  } catch (err) {
    next(err);
  }
}

function requireSurveyRole(...allowed) {
  return (req, res, next) => {
    const role = req.surveyUser && req.surveyUser.role;
    const isKompassAdmin = (req.user && req.user.roles || []).includes('admin');
    const isMaster = req.surveyUser && req.surveyUser.isMasterAdmin;
    if (isKompassAdmin || isMaster || allowed.includes(role)) return next();
    return res.status(403).json({ ok: false, error: 'Insufficient survey role' });
  };
}

// Data scoping — mirrors hub-store-access listAccessibleStores
async function listAccessibleStores(surveyUser, kompassRoles = []) {
  if (surveyUser?.isMasterAdmin || (kompassRoles || []).includes('admin')) {
    const { rows } = await pool.query('SELECT DISTINCT store_num FROM survey_store_access ORDER BY store_num');
    return rows.map((r) => r.store_num);
  }
  if (surveyUser.role === 'supervisor') {
    const { rows } = await pool.query(
      `SELECT DISTINCT s.store_num
         FROM survey_store_supervisors s
        WHERE s.supervisor_email = $1
        UNION
       SELECT store_num FROM survey_store_access WHERE email = $1
        ORDER BY 1`,
      [surveyUser.email]
    );
    return rows.map((r) => r.store_num);
  }
  const { rows } = await pool.query(
    'SELECT store_num FROM survey_store_access WHERE email = $1 ORDER BY store_num',
    [surveyUser.email]
  );
  return rows.map((r) => r.store_num);
}

async function listAccessibleStoresDetailed(surveyUser, kompassRoles = []) {
  const storeNums = await listAccessibleStores(surveyUser, kompassRoles);
  if (!storeNums.length) return [];

  const { rows } = await pool.query(
    `SELECT a.store_num,
            COALESCE(d.district, 'Unassigned') AS district
       FROM (SELECT DISTINCT store_num FROM survey_store_access WHERE store_num = ANY($1::int[])) a
       LEFT JOIN survey_store_districts d ON d.store_num = a.store_num
      ORDER BY a.store_num`,
    [storeNums]
  );

  // Status for this respondent
  const { rows: mine } = await pool.query(
    `SELECT r.store_num, r.status, r.updated_at, r.submitted_at
       FROM survey_responses r
       JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
      WHERE r.respondent = $1 AND r.store_num = ANY($2::int[])`,
    [surveyUser.email, storeNums]
  );
  const byStore = new Map(mine.map((m) => [Number(m.store_num), m]));

  return rows.map((r) => {
    const st = byStore.get(Number(r.store_num));
    return {
      storeNum: Number(r.store_num),
      district: r.district,
      status: st?.status || null,
      updatedAt: st?.updated_at || null,
      submittedAt: st?.submitted_at || null,
    };
  });
}

async function userHasStoreAccess(surveyUser, kompassRoles, storeNum) {
  const stores = await listAccessibleStores(surveyUser, kompassRoles);
  return stores.includes(Number(storeNum));
}

/**
 * Build typeahead suggestions for the signed-in user (and optional store).
 * Includes identity fields, teammates on shared stores, and prior text answers.
 */
async function buildSuggestions(surveyUser, { storeNum = null, kompassRoles = [] } = {}) {
  const stores = storeNum != null
    ? [Number(storeNum)]
    : await listAccessibleStores(surveyUser, kompassRoles);

  const people = [];
  if (stores.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ro.email, ro.name, ro.role, ro.team, ro.phone, ro.district
         FROM survey_roster ro
         JOIN survey_store_access a ON a.email = ro.email
        WHERE ro.active = TRUE
          AND a.store_num = ANY($1::int[])
        ORDER BY ro.name
        LIMIT 200`,
      [stores]
    );
    for (const p of rows) {
      people.push({
        name: p.name,
        email: p.email,
        role: p.role,
        team: p.team,
        phone: p.phone,
        district: p.district,
      });
    }
  }

  // Prior free-text answers at these stores (any respondent) for location/entry hints
  const prior = {
    cartLocations: [],
    vestcomLocations: [],
    tagLocations: [],
    entryMethods: [],
    championNames: [],
    contactNames: [],
  };
  if (stores.length) {
    const { rows } = await pool.query(
      `SELECT r.answers
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
        WHERE r.store_num = ANY($1::int[])
          AND r.status IN ('draft','submitted')
        ORDER BY r.updated_at DESC NULLS LAST
        LIMIT 80`,
      [stores]
    );
    const pushUnique = (arr, v) => {
      const s = String(v || '').trim();
      if (!s || s.length > 200) return;
      if (!arr.some((x) => x.toLowerCase() === s.toLowerCase())) arr.push(s);
    };
    for (const row of rows) {
      const a = row.answers || {};
      pushUnique(prior.cartLocations, a.Q6);
      pushUnique(prior.vestcomLocations, a.Q20);
      pushUnique(prior.tagLocations, a.Q21);
      pushUnique(prior.entryMethods, a.Q30);
      pushUnique(prior.entryMethods, a.Q31a);
      pushUnique(prior.championNames, a.Q7a);
      for (const k of ['Q34_d', 'Q35_d', 'Q36_d', 'Q37_d']) pushUnique(prior.contactNames, a[k]);
    }
  }

  // Baseline text-ish answers for the store
  if (storeNum != null) {
    const { rows: base } = await pool.query(
      `SELECT answers FROM survey_baseline WHERE store_num = $1 ORDER BY submitted DESC LIMIT 5`,
      [Number(storeNum)]
    );
    const pushUnique = (arr, v) => {
      const s = String(v || '').trim();
      if (!s || s.length > 200) return;
      if (!arr.some((x) => x.toLowerCase() === s.toLowerCase())) arr.push(s);
    };
    for (const b of base) {
      const a = b.answers || {};
      // mapped baseline is mostly yes/no; still harvest any strings
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string' && v.length > 2 && !['Yes', 'No', 'N/A', 'Other'].includes(v)) {
          if (k === 'Q6') pushUnique(prior.cartLocations, v);
          else pushUnique(prior.contactNames, v);
        }
      }
    }
  }

  const profile = {
    name: surveyUser.name,
    email: surveyUser.email,
    phone: surveyUser.phone || null,
    team: surveyUser.team || null,
    district: surveyUser.district || null,
    role: surveyUser.role,
    title: surveyUser.title || null,
  };

  // Question-keyed suggestion lists for the UI typeahead
  const byQuestion = {
    Q6: prior.cartLocations,
    Q7a: [
      ...prior.championNames,
      ...people.filter((p) => p.role === 'lead' || /captain|champion/i.test(p.title || '')).map((p) => p.name),
    ],
    Q20: prior.vestcomLocations,
    Q21: prior.tagLocations,
    Q30: prior.entryMethods.length
      ? prior.entryMethods
      : ['Front doors when open', 'Receiving / back door', 'Vendor entrance', 'Side employee entrance'],
    Q31a: prior.entryMethods,
    Q34_d: prior.contactNames,
    Q35_d: prior.contactNames,
    Q36_d: prior.contactNames,
    Q37_d: prior.contactNames,
  };
  // Dedupe byQuestion
  for (const k of Object.keys(byQuestion)) {
    const seen = new Set();
    byQuestion[k] = (byQuestion[k] || []).filter((v) => {
      const key = String(v).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 40);
  }

  return {
    profile,
    people,
    byQuestion,
    districts: [...new Set(
      (await pool.query(
        `SELECT DISTINCT COALESCE(d.district,'Unassigned') AS district
           FROM survey_store_access a
           LEFT JOIN survey_store_districts d ON d.store_num = a.store_num
          WHERE a.store_num = ANY($1::int[])`,
        [stores.length ? stores : [-1]]
      )).rows.map((r) => r.district)
    )].filter(Boolean).sort(),
  };
}

module.exports = {
  requireSurveyAccess,
  requireSurveyRole,
  listAccessibleStores,
  listAccessibleStoresDetailed,
  userHasStoreAccess,
  getSurveyUser,
  buildSuggestions,
  isMasterAdminEmail,
  MASTER_ADMIN_EMAILS,
};
