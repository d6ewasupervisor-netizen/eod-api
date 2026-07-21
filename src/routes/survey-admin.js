// Survey admin routes — mount BEFORE the general survey router:
//   app.use('/api/survey/admin', require('./routes/survey-admin'));
//   app.use('/api/survey', require('./routes/survey'));
// Gated by existing Kompass role stack: requireAuth + requireRole('admin').
// Read-only over survey data except survey_admin_views (per-admin saved layouts).
const express = require('express');
const { requireAuth, requireRole } = require('../auth-middleware');
const { pool } = require('../lib/db');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

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
    const filters = {
      districts: parseListParam(req.query.districts),
      stores: parseListParam(req.query.stores),
      respondents: parseListParam(req.query.respondents),
      status: req.query.status,
    };
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
    const filters = {
      districts: parseListParam(req.query.districts),
      stores: parseListParam(req.query.stores),
      respondents: parseListParam(req.query.respondents),
      status: req.query.status,
    };
    const responses = await fetchResponses(filters);
    res.json({ ok: true, responses });
  } catch (e) { next(e); }
});

// ---- Filter option lists
router.get('/filters', async (req, res, next) => {
  try {
    const districts = await pool.query(`SELECT DISTINCT district FROM survey_store_districts ORDER BY 1`);
    const stores = await pool.query(
      `SELECT a.store_num,
              COALESCE(d.district,'Unassigned') AS district,
              d.store_name
         FROM (SELECT DISTINCT store_num FROM survey_store_access) a
         LEFT JOIN survey_store_districts d ON d.store_num = a.store_num ORDER BY a.store_num`);
    const respondents = await pool.query(
      `SELECT email, name, role, team, district FROM survey_roster WHERE active = TRUE ORDER BY name`);
    res.json({ ok: true, districts: districts.rows.map(r => r.district), stores: stores.rows, respondents: respondents.rows });
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
    const filters = {
      districts: parseListParam(req.query.districts),
      stores: parseListParam(req.query.stores),
      respondents: parseListParam(req.query.respondents),
      status: req.query.status,
    };
    const responses = await fetchResponses(filters);
    const esc = v => {
      const s = v == null ? '' : (Array.isArray(v) ? v.join('; ') : String(v));
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // include a comment column for any question that has at least one comment in the data
    const hasComment = new Set();
    for (const r of responses) for (const c of cols) if (r.answers[c.id + '_c']) hasComment.add(c.id);
    const header = ['store', 'district', 'respondent', 'respondent_name', 'team', 'status', 'submitted_at'];
    for (const c of cols) {
      header.push(`${c.id} ${c.text}`);
      if (hasComment.has(c.id)) header.push(`${c.id} comment`);
    }
    const lines = [header.map(esc).join(',')];
    for (const r of responses) {
      const row = [
        r.store_num, r.district, r.respondent, r.respondent_name, r.team || '', r.status,
        r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
      ];
      for (const c of cols) {
        row.push(r.answers[c.id]);
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

module.exports = router;
