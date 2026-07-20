// Survey feature ACL — roster membership required; store selection is open
// (schedule-based suggestions only, not a hard lock).
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MASTER_ADMIN_EMAILS = new Set([
  'tyson.gauthier@retailodyssey.com',
]);

/** Kompass NW schedule seed (date + workdayId → store). Loaded once. */
let _scheduleCache = null;

function loadScheduleSeed() {
  if (_scheduleCache) return _scheduleCache;
  const candidates = [
    path.join(__dirname, '../../seed/seed_schedule.json'),
    path.join(process.cwd(), 'seed/seed_schedule.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const rows = Array.isArray(raw?.rows) ? raw.rows : [];
      const byDateWorkday = new Map(); // `${date}|${workdayId}` → rows
      const byDateName = new Map(); // `${date}|${normalizedName}` → rows
      for (const r of rows) {
        const date = String(r.date || '').slice(0, 10);
        const storeNum = Number(r.storeNum);
        if (!date || !Number.isFinite(storeNum)) continue;
        const entry = {
          date,
          storeNum,
          workdayId: r.workdayId ? String(r.workdayId).trim() : null,
          name: r.name || null,
          role: r.role || null,
          team: r.team || null,
        };
        if (entry.workdayId) {
          const k = `${date}|${entry.workdayId}`;
          if (!byDateWorkday.has(k)) byDateWorkday.set(k, []);
          byDateWorkday.get(k).push(entry);
        }
        if (entry.name) {
          const nk = `${date}|${normalizePersonName(entry.name)}`;
          if (!byDateName.has(nk)) byDateName.set(nk, []);
          byDateName.get(nk).push(entry);
        }
      }
      _scheduleCache = {
        source: raw.source || p,
        generatedAt: raw.generatedAt || null,
        rowCount: rows.length,
        byDateWorkday,
        byDateName,
      };
      return _scheduleCache;
    } catch (err) {
      console.warn('[survey-access] schedule seed load failed:', err.message);
    }
  }
  _scheduleCache = {
    source: null,
    generatedAt: null,
    rowCount: 0,
    byDateWorkday: new Map(),
    byDateName: new Map(),
  };
  return _scheduleCache;
}

/** Calendar date in America/Los_Angeles (YYYY-MM-DD). */
function todayPacificDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMasterAdminEmail(email) {
  return MASTER_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

async function getSurveyUser(email) {
  const em = String(email || '').trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT email, name, role, team, supervisor_email, district, phone, title, workday_id, active
       FROM survey_roster
      WHERE email = $1 AND active = TRUE`,
    [em]
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    workdayId: row.workday_id || null,
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

/**
 * Today's assignments for this person from the seeded Kompass schedule.
 * Match order: workday_id → normalized roster name.
 * Prefers Lead rows when multiple, then first by store number.
 */
function listScheduleToday(surveyUser, dateStr = null) {
  const date = dateStr || todayPacificDate();
  const sched = loadScheduleSeed();
  let hits = [];
  const wd = surveyUser?.workdayId || surveyUser?.workday_id;
  if (wd) {
    hits = sched.byDateWorkday.get(`${date}|${String(wd).trim()}`) || [];
  }
  if (!hits.length && surveyUser?.name) {
    hits = sched.byDateName.get(`${date}|${normalizePersonName(surveyUser.name)}`) || [];
  }
  // Prefer Lead role when multi-store edge cases
  const leads = hits.filter((h) => String(h.role || '').toLowerCase() === 'lead');
  const ordered = (leads.length ? leads : hits).slice().sort((a, b) => a.storeNum - b.storeNum);
  // Dedupe by store
  const seen = new Set();
  const unique = [];
  for (const h of ordered) {
    if (seen.has(h.storeNum)) continue;
    seen.add(h.storeNum);
    unique.push(h);
  }
  return {
    date,
    timezone: 'America/Los_Angeles',
    source: sched.source,
    assignments: unique,
  };
}

/**
 * Prefill store from today's schedule (single primary store).
 * Master admins: none. Manual override always available in the UI.
 */
async function listSuggestedStores(surveyUser) {
  if (surveyUser?.isMasterAdmin || isMasterAdminEmail(surveyUser?.email)) {
    return [];
  }
  const today = listScheduleToday(surveyUser);
  if (!today.assignments.length) return [];

  const storeNums = today.assignments.map((a) => a.storeNum);
  const { rows } = await pool.query(
    `SELECT store_num, COALESCE(district, 'Unassigned') AS district
       FROM survey_store_districts
      WHERE store_num = ANY($1::int[])`,
    [storeNums]
  );
  const dist = new Map(rows.map((r) => [Number(r.store_num), r.district]));
  // Primary = first assignment (lead-preferred, then lowest store #)
  return today.assignments.map((a) => ({
    storeNum: a.storeNum,
    district: dist.get(a.storeNum) || 'Unassigned',
    suggested: true,
    fromSchedule: true,
    scheduleDate: today.date,
    team: a.team || null,
    role: a.role || null,
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

function flattenSpecQuestions(spec) {
  const out = [];
  for (const sec of spec?.sections || []) {
    for (const q of sec.questions || []) {
      out.push(q);
      for (const b of q.branches || []) out.push(b);
    }
  }
  return out;
}

function answerKey(val) {
  if (val == null || val === '') return null;
  if (Array.isArray(val)) {
    if (!val.length) return null;
    return val.map((x) => String(x)).join(', ');
  }
  const s = String(val).trim();
  return s || null;
}

/**
 * Mode answer per question from live responses, falling back to question.good
 * then 2025 baseline mode. Used for "Common: Yes" chips in the taker UI.
 */
async function buildCommonAnswers() {
  const commonByQuestion = {};
  let qsSpec = null;
  try {
    const { rows: qsRows } = await pool.query(
      `SELECT spec FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1`
    );
    qsSpec = qsRows[0]?.spec || null;
  } catch (_) { /* ignore */ }

  const questions = flattenSpecQuestions(qsSpec);
  const counts = new Map(); // qid -> Map(answerKey -> count)

  const bump = (qid, val) => {
    const key = answerKey(val);
    if (!key || key.length > 120) return;
    if (!counts.has(qid)) counts.set(qid, new Map());
    const m = counts.get(qid);
    m.set(key, (m.get(key) || 0) + 1);
  };

  // Live responses (draft + submitted) for active question set
  try {
    const { rows } = await pool.query(
      `SELECT r.answers
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
        ORDER BY r.updated_at DESC NULLS LAST
        LIMIT 2500`
    );
    for (const row of rows) {
      const a = row.answers || {};
      for (const [k, v] of Object.entries(a)) {
        if (k.endsWith('_c') || k.endsWith('_d')) continue;
        bump(k, v);
      }
    }
  } catch (_) { /* ignore */ }

  const modeOf = (map) => {
    if (!map || !map.size) return null;
    let best = null, bestN = 0;
    for (const [k, n] of map.entries()) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return best != null ? { value: best, n: bestN } : null;
  };

  const MIN_N = 2; // need at least 2 people agreeing before we call it "common" from live data
  for (const [qid, map] of counts.entries()) {
    const mode = modeOf(map);
    if (mode && mode.n >= MIN_N) {
      commonByQuestion[qid] = { value: mode.value, n: mode.n, source: 'responses' };
    }
  }

  // Fallback: question.good from spec (best-practice answer)
  for (const q of questions) {
    if (commonByQuestion[q.id]) continue;
    if (q.good != null && q.good !== '') {
      commonByQuestion[q.id] = {
        value: Array.isArray(q.good) ? q.good.join(', ') : String(q.good),
        n: 0,
        source: 'good',
      };
    }
  }

  // Fallback: 2025 baseline mode for remaining gaps
  try {
    const { rows: baseRows } = await pool.query(
      `SELECT answers FROM survey_baseline ORDER BY submitted DESC NULLS LAST LIMIT 500`
    );
    const baseCounts = new Map();
    for (const row of baseRows) {
      const a = row.answers || {};
      for (const [k, v] of Object.entries(a)) {
        if (k.endsWith('_c') || k.endsWith('_d')) continue;
        const key = answerKey(v);
        if (!key || key.length > 120) continue;
        if (!baseCounts.has(k)) baseCounts.set(k, new Map());
        const m = baseCounts.get(k);
        m.set(key, (m.get(key) || 0) + 1);
      }
    }
    for (const [qid, map] of baseCounts.entries()) {
      if (commonByQuestion[qid]) continue;
      const mode = modeOf(map);
      if (mode && mode.n >= 2) {
        commonByQuestion[qid] = { value: mode.value, n: mode.n, source: 'baseline' };
      }
    }
  } catch (_) { /* ignore */ }

  return commonByQuestion;
}

/**
 * Typeahead: operational hints + THIS user's answers from other stores
 * (reuse "same answer across stores") — never RO teammate names.
 */
async function buildSuggestions(surveyUser, { storeNum = null, kompassRoles = [] } = {}) {
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

  // Cross-store reuse chips removed from UI — modes are rolled into commonByQuestion.
  const commonByQuestion = await buildCommonAnswers();

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
    commonByQuestion,
    crossStoreAnswers: {},
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
  listScheduleToday,
  todayPacificDate,
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
