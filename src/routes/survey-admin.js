// Survey admin routes — mount BEFORE the general survey router:
//   app.use('/api/survey/admin', require('./routes/survey-admin'));
//   app.use('/api/survey', require('./routes/survey'));
// Gated by survey ops ACL: supervisors (district), managers/directors/master (division).
const express = require('express');
const archiver = require('archiver');
const { requireAuth } = require('../auth-middleware');
const { pool } = require('../lib/db');
const {
  requireSurveyAdmin,
  applyScopeToFilters,
  buildCoverage,
  searchRoster,
  listTeams,
  createAssignments,
  getAlertPrefs,
  upsertAlertPrefs,
  photoFileName,
} = require('../lib/survey-ops');
const { sortDistricts } = require('../lib/survey-access');

const router = express.Router();
router.use(requireAuth, requireSurveyAdmin);

/** Distinct districts, numeric order (1…9, 10 — not 1, 10, 2). */
async function queryDistrictsOrdered(extraWhere = '', params = []) {
  const sql = `
    SELECT district FROM (
      SELECT DISTINCT district FROM survey_store_districts
      ${extraWhere}
    ) t
    ORDER BY
      CASE WHEN district ~ '^[0-9]+$' THEN district::int ELSE 2147483647 END,
      district`;
  const { rows } = await pool.query(sql, params);
  return sortDistricts(rows.map((r) => r.district));
}

function scopedFilters(req) {
  return applyScopeToFilters(req.surveyAdminScope, {
    districts: parseListParam(req.query.districts),
    stores: parseListParam(req.query.stores),
    respondents: parseListParam(req.query.respondents),
    status: req.query.status,
  });
}

async function activeQuestionSet() {
  const { rows } = await pool.query(
    'SELECT id, version, spec FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1'
  );
  return rows[0] || null;
}

function flattenQuestions(spec) {
  const out = [];
  for (const sec of spec.sections || []) {
    for (const q of sec.questions || []) {
      out.push({ ...q, section: sec.id, sectionTitle: sec.title });
      for (const b of q.branches || []) out.push({ ...b, section: sec.id, sectionTitle: sec.title, parent: q.id });
    }
  }
  return out;
}

function isProblem(q, val) {
  if (!q.good || val == null || val === '') return null; // untracked
  if (q.type === 'multiselect') {
    const arr = Array.isArray(val) ? val : String(val).split(',').map(s => s.trim());
    return !(arr.length === 1 && arr[0] === q.good);
  }
  return String(val).trim() !== q.good;
}

// Shared filtered fetch. Filters: districts, stores, respondents, status (default submitted).
async function fetchResponses(filters) {
  const params = [];
  const where = ['q.active = TRUE'];
  const status = filters.status || 'submitted';
  if (status !== 'all') { params.push(status); where.push(`r.status = $${params.length}`); }
  if (filters.stores && filters.stores.length) {
    params.push(filters.stores.map(Number)); where.push(`r.store_num = ANY($${params.length}::int[])`);
  }
  if (filters.districts && filters.districts.length) {
    params.push(filters.districts); where.push(`COALESCE(d.district,'Unassigned') = ANY($${params.length}::text[])`);
  }
  if (filters.respondents && filters.respondents.length) {
    params.push(filters.respondents.map(e => String(e).toLowerCase())); where.push(`r.respondent = ANY($${params.length}::text[])`);
  }
  const { rows } = await pool.query(
    `SELECT r.id, r.store_num, d.store_name, COALESCE(d.district,'Unassigned') AS district, r.respondent,
            ro.name AS respondent_name, ro.team, r.answers, r.status, r.submitted_at, r.updated_at
       FROM survey_responses r
       JOIN survey_question_sets q ON q.id = r.question_set_id
       JOIN survey_roster ro ON ro.email = r.respondent
       LEFT JOIN survey_store_districts d ON d.store_num = r.store_num
      WHERE ${where.join(' AND ')}
      ORDER BY r.store_num, r.submitted_at DESC NULLS LAST`,
    params
  );
  return rows;
}

function parseListParam(v) {
  if (!v) return null;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ---- Dashboard summary: per-question aggregates, top-3 trending, baseline deltas
router.get('/summary', async (req, res, next) => {
  try {
    const qs = await activeQuestionSet();
    if (!qs) return res.status(404).json({ ok: false, error: 'No active question set' });
    const questions = flattenQuestions(qs.spec);
    const filters = scopedFilters(req);
    const responses = await fetchResponses(filters);

    const agg = {};
    for (const q of questions) agg[q.id] = { id: q.id, text: q.text, section: q.section, sectionTitle: q.sectionTitle, good: q.good || null, counts: {}, n: 0, problems: 0, tracked: !!q.good };
    for (const r of responses) {
      for (const q of questions) {
        const val = r.answers[q.id];
        if (val == null || val === '') continue;
        const key = Array.isArray(val) ? val.join(', ') : String(val);
        const a = agg[q.id];
        a.counts[key] = (a.counts[key] || 0) + 1;
        a.n++;
        const p = isProblem(q, val);
        if (p === true) a.problems++;
      }
    }
    const MIN_N = 3;
    const trending = Object.values(agg)
      .filter(a => a.tracked && a.n >= MIN_N)
      .map(a => ({ ...a, problemRate: a.problems / a.n }))
      .sort((x, y) => y.problemRate - x.problemRate || y.n - x.n)
      .slice(0, 3);

    // Baseline comparison (2025) for mapped questions
    const { rows: baseRows } = await pool.query('SELECT store_num, answers FROM survey_baseline');
    const base = {};
    for (const q of questions) base[q.id] = { n: 0, problems: 0 };
    for (const b of baseRows) {
      for (const q of questions) {
        const val = b.answers[q.id];
        if (val == null || val === '') continue;
        base[q.id].n++;
        if (isProblem(q, val) === true) base[q.id].problems++;
      }
    }
    const baseline = {};
    for (const [id, v] of Object.entries(base)) {
      if (v.n > 0) baseline[id] = { n: v.n, problemRate: v.problems / v.n };
    }

    res.json({
      ok: true,
      totals: {
        responses: responses.length,
        stores: new Set(responses.map(r => r.store_num)).size,
        respondents: new Set(responses.map(r => r.respondent)).size,
      },
      questions: Object.values(agg),
      trending,
      baseline,
    });
  } catch (e) { next(e); }
});

// ---- Filterable flat data for the client-side pivot/rearrange UI
router.get('/responses', async (req, res, next) => {
  try {
    const filters = scopedFilters(req);
    const responses = await fetchResponses(filters);
    res.json({ ok: true, responses });
  } catch (e) { next(e); }
});

// ---- Filter option lists
router.get('/filters', async (req, res, next) => {
  try {
    const scope = req.surveyAdminScope;
    let districtPromise = queryDistrictsOrdered();
    let storeSql = `SELECT d.store_num, COALESCE(d.district,'Unassigned') AS district, d.store_name
                      FROM survey_store_districts d
                     ORDER BY
                       CASE WHEN d.district ~ '^[0-9]+$' THEN d.district::int ELSE 2147483647 END,
                       d.district,
                       d.store_num`;
    let storeParams = [];
    if (scope?.level === 'district' && scope.storeNums?.length) {
      storeSql = `SELECT d.store_num, COALESCE(d.district,'Unassigned') AS district, d.store_name
                    FROM survey_store_districts d
                   WHERE d.store_num = ANY($1::int[])
                   ORDER BY
                     CASE WHEN d.district ~ '^[0-9]+$' THEN d.district::int ELSE 2147483647 END,
                     d.district,
                     d.store_num`;
      storeParams = [scope.storeNums];
      districtPromise = queryDistrictsOrdered('WHERE store_num = ANY($1::int[])', [scope.storeNums]);
    } else if (scope?.level === 'district' && scope.districts?.length) {
      districtPromise = queryDistrictsOrdered('WHERE district = ANY($1::text[])', [scope.districts]);
      storeSql = `SELECT d.store_num, COALESCE(d.district,'Unassigned') AS district, d.store_name
                    FROM survey_store_districts d
                   WHERE d.district = ANY($1::text[])
                   ORDER BY
                     CASE WHEN d.district ~ '^[0-9]+$' THEN d.district::int ELSE 2147483647 END,
                     d.district,
                     d.store_num`;
      storeParams = [scope.districts];
    }
    const [districts, stores, teams] = await Promise.all([
      districtPromise,
      pool.query(storeSql, storeParams),
      listTeams(),
    ]);
    res.json({
      ok: true,
      scope,
      districts,
      stores: stores.rows,
      teams,
      user: {
        email: req.surveyUser.email,
        name: req.surveyUser.name,
        role: req.surveyUser.role,
        title: req.surveyUser.title,
        district: req.surveyUser.district,
      },
    });
  } catch (e) { next(e); }
});

// ---- CSV export (server-side). XLSX is produced client-side from /responses.
router.get('/export.csv', async (req, res, next) => {
  try {
    const qs = await activeQuestionSet();
    if (!qs) return res.status(404).json({ ok: false, error: 'No active question set' });
    const questions = flattenQuestions(qs.spec);
    const qids = parseListParam(req.query.questions);
    const cols = qids ? questions.filter(q => qids.includes(q.id)) : questions.filter(q => q.type !== undefined);
    const filters = scopedFilters(req);
    const responses = await fetchResponses(filters);
    const esc = v => {
      const s = v == null ? '' : (Array.isArray(v) ? v.join('; ') : String(v));
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // Comment / detail columns when any row has them (matches taker Yes → name fields)
    const hasComment = new Set();
    const hasDetail = new Set();
    for (const r of responses) {
      for (const c of cols) {
        if (r.answers[c.id + '_c']) hasComment.add(c.id);
        if (r.answers[c.id + '_d']) hasDetail.add(c.id);
      }
    }
    const header = [
      'id', 'store', 'store_name', 'district',
      'respondent', 'respondent_name', 'team',
      'status', 'submitted_at',
    ];
    for (const c of cols) {
      header.push(`${c.id} ${String(c.text || '').split('{{storeName}}').join('store')}`);
      if (hasDetail.has(c.id)) header.push(`${c.id} detail`);
      if (hasComment.has(c.id)) header.push(`${c.id} comment`);
    }
    const lines = [header.map(esc).join(',')];
    for (const r of responses) {
      const row = [
        r.id,
        r.store_num,
        r.store_name || '',
        r.district,
        r.respondent,
        r.respondent_name,
        r.team || '',
        r.status,
        r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
      ];
      for (const c of cols) {
        row.push(r.answers[c.id]);
        if (hasDetail.has(c.id)) row.push(r.answers[c.id + '_d']);
        if (hasComment.has(c.id)) row.push(r.answers[c.id + '_c']);
      }
      lines.push(row.map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="survey-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (e) { next(e); }
});

// ---- Per-admin saved views (layouts/filters; never touches survey data)
router.get('/views', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, config, updated_at FROM survey_admin_views WHERE email = $1 ORDER BY name',
      [req.user.email.toLowerCase()]
    );
    res.json({ ok: true, views: rows });
  } catch (e) { next(e); }
});

router.put('/views/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name).slice(0, 100);
    const config = req.body && req.body.config;
    if (!config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'config object required' });
    const { rows } = await pool.query(
      `INSERT INTO survey_admin_views (email, name, config)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (email, name) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
       RETURNING id, name, config, updated_at`,
      [req.user.email.toLowerCase(), name, JSON.stringify(config)]
    );
    res.json({ ok: true, view: rows[0] });
  } catch (e) { next(e); }
});

router.delete('/views/:name', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM survey_admin_views WHERE email = $1 AND name = $2',
      [req.user.email.toLowerCase(), String(req.params.name)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Access / coverage / assignments / alerts / photo zip

router.get('/access', async (req, res) => {
  res.json({
    ok: true,
    scope: req.surveyAdminScope,
    user: {
      email: req.surveyUser.email,
      name: req.surveyUser.name,
      role: req.surveyUser.role,
      title: req.surveyUser.title,
      district: req.surveyUser.district,
    },
  });
});

router.get('/coverage', async (req, res, next) => {
  try {
    const coverage = await buildCoverage(req.surveyAdminScope);
    res.json({ ok: true, scope: req.surveyAdminScope, ...coverage });
  } catch (e) { next(e); }
});

router.get('/roster-search', async (req, res, next) => {
  try {
    const people = await searchRoster({
      q: req.query.q || '',
      team: req.query.team || null,
      role: req.query.role || null,
      limit: req.query.limit || 25,
    });
    res.json({ ok: true, people });
  } catch (e) { next(e); }
});

router.post('/assignments', async (req, res, next) => {
  try {
    const body = req.body || {};
    let storeNums = Array.isArray(body.storeNums) ? body.storeNums.map(Number) : [];
    const assigneeEmails = Array.isArray(body.assigneeEmails) ? body.assigneeEmails : [];
    const team = body.team || null;
    const role = body.role || null;

    // Resolve team/role bulk → emails
    let emails = [...assigneeEmails];
    if (team || (role && !emails.length)) {
      const people = await searchRoster({ team, role, limit: 200, q: '' });
      emails = [...new Set([...emails, ...people.map((p) => p.email)])];
    }

    // Scope guard stores
    const scope = req.surveyAdminScope;
    if (scope?.level === 'district' && scope.storeNums?.length) {
      const allowed = new Set(scope.storeNums.map(Number));
      storeNums = storeNums.filter((n) => allowed.has(Number(n)));
    }

    const result = await createAssignments({
      assigneeEmails: emails,
      storeNums,
      assignedBy: req.surveyUser.email,
      dueAt: body.dueAt || null,
      notes: body.notes || null,
      scopeLabel: body.scopeLabel || (team ? `Team ${team}` : null),
      remindDaysBefore: body.remindDaysBefore == null ? 1 : Number(body.remindDaysBefore),
      sendInvites: body.sendInvites !== false,
    });
    res.json({
      ok: true,
      created: result.created.length,
      inviteResults: result.inviteResults,
      assignments: result.created,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
    next(e);
  }
});

router.post('/assignments/bulk-from-access', async (req, res, next) => {
  try {
    const body = req.body || {};
    const storeNumsIn = Array.isArray(body.storeNums) ? body.storeNums.map(Number) : [];
    let storeNums = storeNumsIn;
    const scope = req.surveyAdminScope;
    if (scope?.level === 'district' && scope.storeNums?.length) {
      const allowed = new Set(scope.storeNums.map(Number));
      storeNums = storeNums.length
        ? storeNums.filter((n) => allowed.has(n))
        : [...allowed];
    } else if (!storeNums.length) {
      const cov = await buildCoverage(scope);
      storeNums = cov.stores.filter((s) => s.state === 'needs_assign').map((s) => s.storeNum);
    }

    const { rows } = await pool.query(
      `SELECT sa.email, sa.store_num, ro.name, ro.role, ro.team
         FROM survey_store_access sa
         JOIN survey_roster ro ON ro.email = sa.email AND ro.active = TRUE
        WHERE sa.store_num = ANY($1::int[])
          AND ro.role IN ('lead', 'member', 'supervisor')
        ORDER BY sa.store_num, CASE ro.role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END`,
      [storeNums]
    );

    // Prefer one lead per store when available; else first member
    const pick = new Map();
    for (const r of rows) {
      const sn = Number(r.store_num);
      if (!pick.has(sn)) pick.set(sn, r);
      else if (pick.get(sn).role !== 'lead' && r.role === 'lead') pick.set(sn, r);
    }

    const createdAll = [];
    const inviteAll = [];
    for (const [storeNum, person] of pick) {
      const result = await createAssignments({
        assigneeEmails: [person.email],
        storeNums: [storeNum],
        assignedBy: req.surveyUser.email,
        dueAt: body.dueAt || null,
        notes: body.notes || 'Bulk from store access',
        scopeLabel: 'Bulk store access',
        remindDaysBefore: body.remindDaysBefore == null ? 1 : Number(body.remindDaysBefore),
        sendInvites: body.sendInvites !== false,
      });
      createdAll.push(...result.created);
      inviteAll.push(...result.inviteResults);
    }
    res.json({
      ok: true,
      created: createdAll.length,
      storesCovered: pick.size,
      inviteResults: inviteAll,
    });
  } catch (e) { next(e); }
});

router.patch('/assignments/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (!['open', 'done', 'cancelled'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be open|done|cancelled' });
    }
    const { rows } = await pool.query(
      `UPDATE survey_assignments SET status = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, assignment: rows[0] });
  } catch (e) { next(e); }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const prefs = await getAlertPrefs(req.surveyUser.email);
    res.json({ ok: true, prefs });
  } catch (e) { next(e); }
});

router.put('/alerts', async (req, res, next) => {
  try {
    const prefs = await upsertAlertPrefs(req.surveyUser.email, req.body || {});
    res.json({ ok: true, prefs });
  } catch (e) { next(e); }
});

router.get('/photos.zip', async (req, res, next) => {
  try {
    const filters = scopedFilters(req);
    const responses = await fetchResponses(filters);
    const storeNums = [...new Set(responses.map((r) => Number(r.store_num)))];
    if (!storeNums.length) {
      return res.status(404).json({ ok: false, error: 'No matching responses / stores for photo export' });
    }

    const respondentFilter = filters.respondents && filters.respondents.length
      ? filters.respondents.map((e) => String(e).toLowerCase())
      : null;

    const params = [storeNums];
    let sql = `SELECT p.id, p.store_num, p.respondent, p.question_id, p.mime, p.bytes, d.store_name
                 FROM survey_photos p
                 LEFT JOIN survey_store_districts d ON d.store_num = p.store_num
                WHERE p.store_num = ANY($1::int[])`;
    if (respondentFilter) {
      params.push(respondentFilter);
      sql += ` AND lower(p.respondent) = ANY($${params.length}::text[])`;
    }
    sql += ' ORDER BY p.store_num, p.question_id, p.id';

    const { rows: photos } = await pool.query(sql, params);
    if (!photos.length) {
      return res.status(404).json({ ok: false, error: 'No photos found for the current filters' });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="survey-photos-${stamp}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);

    const used = new Set();
    for (const p of photos) {
      let name = photoFileName({
        storeNum: p.store_num,
        storeName: p.store_name,
        questionId: p.question_id,
        respondent: p.respondent,
        photoId: p.id,
        mime: p.mime,
      });
      if (used.has(name)) name = name.replace(/(\.\w+)$/, `_${p.id}$1`);
      used.add(name);
      archive.append(p.bytes, { name: `FM${p.store_num}/${name}` });
    }
    await archive.finalize();
  } catch (e) { next(e); }
});

module.exports = router;
