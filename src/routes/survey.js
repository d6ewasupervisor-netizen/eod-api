// Survey routes — mount in src/index.js AFTER the global gate:
//   const surveyRouter = require('./routes/survey');
//   app.use('/api/survey', surveyRouter);
// Do NOT add /api/survey to PUBLIC_PATHS/PREFIXES.
const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { pool } = require('../lib/db');
const {
  requireSurveyAccess,
  requireSurveyRole,
  listAccessibleStores,
  userHasStoreAccess,
} = require('../lib/survey-access');

const router = express.Router();
router.use(requireAuth, requireSurveyAccess);

// Identity + scope bootstrap for the frontend
router.get('/me', async (req, res, next) => {
  try {
    const stores = await listAccessibleStores(req.surveyUser, req.user.roles);
    res.json({ ok: true, user: req.surveyUser, stores });
  } catch (e) { next(e); }
});

// Active question set
router.get('/questions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, version, title, spec FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1'
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No active question set' });
    res.json({ ok: true, questionSet: rows[0] });
  } catch (e) { next(e); }
});

// Baseline (2025) + any current responses for a store — read-only historical + prefill source
router.get('/stores/:storeNum/context', async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'No access to this store' });
    }
    const baseline = await pool.query(
      'SELECT respondent, submitted, answers, source FROM survey_baseline WHERE store_num = $1 ORDER BY submitted DESC',
      [storeNum]
    );
    const mine = await pool.query(
      `SELECT r.id, r.answers, r.photos, r.status, r.submitted_at
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
        WHERE r.store_num = $1 AND r.respondent = $2`,
      [storeNum, req.surveyUser.email]
    );
    res.json({ ok: true, baseline: baseline.rows, myResponse: mine.rows[0] || null });
  } catch (e) { next(e); }
});

// Upsert draft / submit
router.put('/stores/:storeNum/response', async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'No access to this store' });
    }
    const { answers = {}, photos = [], submit = false } = req.body || {};
    if (typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ ok: false, error: 'answers must be an object' });
    }
    const qs = await pool.query('SELECT id FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1');
    if (!qs.rows.length) return res.status(409).json({ ok: false, error: 'No active question set' });
    const status = submit ? 'submitted' : 'draft';
    const { rows } = await pool.query(
      `INSERT INTO survey_responses (question_set_id, store_num, respondent, answers, photos, status, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, CASE WHEN $6 = 'submitted' THEN now() END, now())
       ON CONFLICT (question_set_id, store_num, respondent) DO UPDATE
         SET answers = EXCLUDED.answers,
             photos = EXCLUDED.photos,
             status = EXCLUDED.status,
             submitted_at = CASE WHEN EXCLUDED.status = 'submitted' THEN now() ELSE survey_responses.submitted_at END,
             updated_at = now()
       RETURNING id, status, submitted_at`,
      [qs.rows[0].id, storeNum, req.surveyUser.email, JSON.stringify(answers), JSON.stringify(photos), status]
    );
    res.json({ ok: true, response: rows[0] });
  } catch (e) { next(e); }
});

// Supervisor/admin reporting — scoped list of responses
router.get('/responses', requireSurveyRole('supervisor'), async (req, res, next) => {
  try {
    const stores = await listAccessibleStores(req.surveyUser, req.user.roles);
    if (!stores.length) return res.json({ ok: true, responses: [] });
    const { rows } = await pool.query(
      `SELECT r.store_num, r.respondent, ro.name AS respondent_name, r.answers, r.photos, r.status, r.submitted_at
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
         JOIN survey_roster ro ON ro.email = r.respondent
        WHERE r.store_num = ANY($1::int[])
        ORDER BY r.store_num, r.submitted_at DESC NULLS LAST`,
      [stores]
    );
    res.json({ ok: true, responses: rows });
  } catch (e) { next(e); }
});

module.exports = router;
