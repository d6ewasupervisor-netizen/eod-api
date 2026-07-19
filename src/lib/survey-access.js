// Survey feature ACL — roster membership required; store selection is open
// (schedule-based suggestions only, not a hard lock).
const { pool } = require('./db');

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
    su.isMasterAdmin = isMasterAdminEmail(su.email);
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

/** Stores suggested from schedule/roster assignment (prefill only). */
async function listSuggestedStores(surveyUser) {
  if (surveyUser?.isMasterAdmin || isMasterAdminEmail(surveyUser?.email)) {
    // Master: no forced prefills — empty suggestion list is fine
    return listCatalogStores();
  }
  if (surveyUser.role === 'supervisor') {
    const { rows } = await pool.query(
      `SELECT DISTINCT s.store_num AS store_num,
              COALESCE(d.district, 'Unassigned') AS district
         FROM (
           SELECT store_num FROM survey_store_supervisors WHERE supervisor_email = $1
           UNION
           SELECT store_num FROM survey_store_access WHERE email = $1
         ) s
         LEFT JOIN survey_store_districts d ON d.store_num = s.store_num
        ORDER BY s.store_num`,
      [surveyUser.email]
    );
    return rows.map((r) => ({
      storeNum: Number(r.store_num),
      district: r.district,
      suggested: true,
    }));
  }
  const { rows } = await pool.query(
    `SELECT a.store_num,
            COALESCE(d.district, 'Unassigned') AS district
       FROM survey_store_access a
       LEFT JOIN survey_store_districts d ON d.store_num = a.store_num
      WHERE a.email = $1
      ORDER BY a.store_num`,
    [surveyUser.email]
  );
  return rows.map((r) => ({
    storeNum: Number(r.store_num),
    district: r.district,
    suggested: true,
  }));
}

/** Full division catalog for dropdowns (any roster user may pick any store). */
async function listCatalogStores() {
  const { rows } = await pool.query(
    `SELECT d.store_num,
            d.district
       FROM survey_store_districts d
      ORDER BY d.district, d.store_num`
  );
  return rows.map((r) => ({
    storeNum: Number(r.store_num),
    district: r.district,
  }));
}

async function listCatalogDistricts() {
  const { rows } = await pool.query(
    `SELECT DISTINCT district FROM survey_store_districts ORDER BY 1`
  );
  return rows.map((r) => r.district).filter(Boolean);
}

async function listCatalogTeams() {
  const { rows } = await pool.query(
    `SELECT DISTINCT team FROM survey_roster
      WHERE active AND team IS NOT NULL AND trim(team) <> ''
      ORDER BY 1`
  );
  return rows.map((r) => r.team);
}

/**
 * Any authenticated roster member may survey any catalog store
 * (assignments change week to week — suggestions only, not locks).
 */
async function userHasStoreAccess(_surveyUser, _kompassRoles, storeNum) {
  const n = Number(storeNum);
  if (!Number.isFinite(n)) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM survey_store_districts WHERE store_num = $1 LIMIT 1`,
    [n]
  );
  // Also allow stores that only appear in store_access (edge cases)
  if (rows.length) return true;
  const { rows: a } = await pool.query(
    `SELECT 1 FROM survey_store_access WHERE store_num = $1 LIMIT 1`,
    [n]
  );
  return a.length > 0;
}

/** Legacy name used by supervisor reports — scoped suggestions for their purview. */
async function listAccessibleStores(surveyUser, kompassRoles = []) {
  if (surveyUser?.isMasterAdmin || isMasterAdminEmail(surveyUser?.email) || (kompassRoles || []).includes('admin')) {
    const all = await listCatalogStores();
    return all.map((s) => s.storeNum);
  }
  const sug = await listSuggestedStores(surveyUser);
  return sug.map((s) => s.storeNum);
}

async function listAccessibleStoresDetailed(surveyUser, kompassRoles = []) {
  const storeNums = await listAccessibleStores(surveyUser, kompassRoles);
  if (!storeNums.length) return [];
  const { rows } = await pool.query(
    `SELECT store_num, COALESCE(district, 'Unassigned') AS district
       FROM survey_store_districts
      WHERE store_num = ANY($1::int[])
      ORDER BY store_num`,
    [storeNums]
  );
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

/**
 * Typeahead: operational hints + THIS user's answers from other stores
 * (reuse "same answer across stores") — never RO teammate names.
 */
async function buildSuggestions(surveyUser, { storeNum = null, kompassRoles = [] } = {}) {
  const stores = storeNum != null
    ? [Number(storeNum)]
    : (await listCatalogStores()).map((s) => s.storeNum);

  const prior = {
    cartLocations: [],
    vestcomLocations: [],
    tagLocations: [],
    entryMethods: [],
    storeSideNames: [],
  };

  const pushUnique = (arr, v) => {
    const s = String(v || '').trim();
    if (!s || s.length > 200) return;
    if (!arr.some((x) => x.toLowerCase() === s.toLowerCase())) arr.push(s);
  };

  // This respondent's answers across all their stores (cross-store reuse)
  const { rows: mineAll } = await pool.query(
    `SELECT r.answers, r.store_num
       FROM survey_responses r
       JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
      WHERE r.respondent = $1
      ORDER BY r.updated_at DESC NULLS LAST
      LIMIT 40`,
    [surveyUser.email]
  );
  for (const row of mineAll) {
    if (storeNum != null && Number(row.store_num) === Number(storeNum)) continue;
    const a = row.answers || {};
    pushUnique(prior.cartLocations, a.Q6);
    pushUnique(prior.vestcomLocations, a.Q20);
    pushUnique(prior.tagLocations, a.Q21);
    pushUnique(prior.entryMethods, a.Q30);
    pushUnique(prior.entryMethods, a.Q31a);
    pushUnique(prior.storeSideNames, a.Q7a);
    for (const k of ['Q34_d', 'Q35_d', 'Q36_d', 'Q37_d']) pushUnique(prior.storeSideNames, a[k]);
  }

  // Same-store priors from any respondent (locations / entry / store-side names only)
  if (storeNum != null) {
    const { rows } = await pool.query(
      `SELECT r.answers
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
        WHERE r.store_num = $1
        ORDER BY r.updated_at DESC NULLS LAST
        LIMIT 40`,
      [Number(storeNum)]
    );
    for (const row of rows) {
      const a = row.answers || {};
      pushUnique(prior.cartLocations, a.Q6);
      pushUnique(prior.vestcomLocations, a.Q20);
      pushUnique(prior.tagLocations, a.Q21);
      pushUnique(prior.entryMethods, a.Q30);
      pushUnique(prior.entryMethods, a.Q31a);
      pushUnique(prior.storeSideNames, a.Q7a);
      for (const k of ['Q34_d', 'Q35_d', 'Q36_d', 'Q37_d']) pushUnique(prior.storeSideNames, a[k]);
    }
  }

  const byQuestion = {
    Q6: prior.cartLocations,
    Q7a: prior.storeSideNames,
    Q20: prior.vestcomLocations,
    Q21: prior.tagLocations,
    Q30: prior.entryMethods.length
      ? prior.entryMethods
      : ['Front doors when open', 'Receiving / back door', 'Vendor entrance', 'Side employee entrance'],
    Q31a: prior.entryMethods,
    Q34_d: prior.storeSideNames,
    Q35_d: prior.storeSideNames,
    Q36_d: prior.storeSideNames,
    Q37_d: prior.storeSideNames,
  };
  for (const k of Object.keys(byQuestion)) {
    const seen = new Set();
    byQuestion[k] = (byQuestion[k] || []).filter((v) => {
      const key = String(v).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 40);
  }

  // Flat map of this user's answers on other stores for "use same as store X"
  const crossStore = {};
  for (const row of mineAll) {
    if (storeNum != null && Number(row.store_num) === Number(storeNum)) continue;
    const sn = Number(row.store_num);
    crossStore[sn] = row.answers || {};
  }

  return {
    profile: {
      name: surveyUser.name,
      email: surveyUser.email,
      team: surveyUser.team || null,
      district: surveyUser.district || null,
      role: surveyUser.role,
      title: surveyUser.title || null,
    },
    people: [],
    byQuestion,
    crossStoreAnswers: crossStore,
    districts: await listCatalogDistricts(),
  };
}

/** Archive current live row into history before overwriting. */
async function archiveResponseSnapshot(client, responseRow, source) {
  if (!responseRow) return;
  await client.query(
    `INSERT INTO survey_response_history
       (response_id, question_set_id, store_num, respondent, answers, photos, status, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [
      responseRow.id,
      responseRow.question_set_id,
      responseRow.store_num,
      responseRow.respondent,
      JSON.stringify(responseRow.answers || {}),
      JSON.stringify(responseRow.photos || []),
      responseRow.status,
      source || 'save',
    ]
  );
}

module.exports = {
  requireSurveyAccess,
  requireSurveyRole,
  listAccessibleStores,
  listAccessibleStoresDetailed,
  listSuggestedStores,
  listCatalogStores,
  listCatalogDistricts,
  listCatalogTeams,
  userHasStoreAccess,
  getSurveyUser,
  buildSuggestions,
  archiveResponseSnapshot,
  isMasterAdminEmail,
  MASTER_ADMIN_EMAILS,
};
