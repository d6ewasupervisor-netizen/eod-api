// Survey feature ACL — mirrors trackers/welcome-letter pattern.
// Mount after requireAuth. Attaches req.surveyUser = roster row.
const { pool } = require('./db');

async function getSurveyUser(email) {
  const { rows } = await pool.query(
    'SELECT email, name, role, team, supervisor_email, active FROM survey_roster WHERE email = $1 AND active = TRUE',
    [String(email || '').trim().toLowerCase()]
  );
  return rows[0] || null;
}

async function requireSurveyAccess(req, res, next) {
  try {
    const su = await getSurveyUser(req.user && req.user.email);
    if (!su) return res.status(403).json({ ok: false, error: 'Not on the survey roster' });
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
    if (isKompassAdmin || allowed.includes(role)) return next();
    return res.status(403).json({ ok: false, error: 'Insufficient survey role' });
  };
}

// Data scoping — mirrors hub-store-access listAccessibleStores
async function listAccessibleStores(surveyUser, kompassRoles = []) {
  if (kompassRoles.includes('admin')) {
    const { rows } = await pool.query('SELECT DISTINCT store_num FROM survey_store_access ORDER BY store_num');
    return rows.map(r => r.store_num);
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
    return rows.map(r => r.store_num);
  }
  const { rows } = await pool.query(
    'SELECT store_num FROM survey_store_access WHERE email = $1 ORDER BY store_num',
    [surveyUser.email]
  );
  return rows.map(r => r.store_num);
}

async function userHasStoreAccess(surveyUser, kompassRoles, storeNum) {
  const stores = await listAccessibleStores(surveyUser, kompassRoles);
  return stores.includes(Number(storeNum));
}

module.exports = { requireSurveyAccess, requireSurveyRole, listAccessibleStores, userHasStoreAccess, getSurveyUser };
