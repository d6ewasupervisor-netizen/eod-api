// Survey routes — mount AFTER global gate; NOT on PUBLIC_PATHS.
const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { pool } = require('../lib/db');
const {
  requireSurveyAccess,
  requireSurveyRole,
  listAccessibleStores,
  listSuggestedStores,
  listScheduleToday,
  todayPacificDate,
  listCatalogStores,
  listCatalogDistricts,
  listCatalogTeams,
  userHasStoreAccess,
  buildSuggestions,
  archiveResponseSnapshot,
} = require('../lib/survey-access');

const router = express.Router();
router.use(requireAuth, requireSurveyAccess);

/** Bootstrap: identity, today's schedule prefill, full catalog for overrides. */
router.get('/me', async (req, res, next) => {
  try {
    const roles = req.user?.roles || [];
    const scheduleToday = listScheduleToday(req.surveyUser);
    const [suggested, catalog, districts, teams, suggestions, myStatuses] = await Promise.all([
      listSuggestedStores(req.surveyUser),
      listCatalogStores(),
      listCatalogDistricts(),
      listCatalogTeams(),
      buildSuggestions(req.surveyUser, { kompassRoles: roles }),
      pool.query(
        `SELECT r.store_num, r.status, r.updated_at, r.submitted_at
           FROM survey_responses r
           JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
          WHERE r.respondent = $1`,
        [req.surveyUser.email]
      ),
    ]);
    const statusByStore = new Map(
      myStatuses.rows.map((r) => [Number(r.store_num), r])
    );
    const suggestedNums = new Set(suggested.map((s) => s.storeNum));
    // Primary preselect: first schedule store for today (single-store flow)
    const primaryStore = suggested.length ? suggested[0].storeNum : null;
    const storeDetails = catalog.map((s) => {
      const st = statusByStore.get(s.storeNum);
      return {
        storeNum: s.storeNum,
        district: s.district,
        suggested: suggestedNums.has(s.storeNum),
        status: st?.status || null,
        updatedAt: st?.updated_at || null,
        submittedAt: st?.submitted_at || null,
      };
    });
    res.json({
      ok: true,
      user: {
        email: req.surveyUser.email,
        name: req.surveyUser.name,
        role: req.surveyUser.role,
        team: req.surveyUser.team,
        district: req.surveyUser.district,
        title: req.surveyUser.title || null,
        workdayId: req.surveyUser.workdayId || req.surveyUser.workday_id || null,
        isMasterAdmin: !!req.surveyUser.isMasterAdmin,
      },
      scheduleDate: scheduleToday.date || todayPacificDate(),
      scheduleTimezone: scheduleToday.timezone || 'America/Los_Angeles',
      scheduleToday: scheduleToday.assignments.map((a) => ({
        storeNum: a.storeNum,
        team: a.team,
        role: a.role,
        date: a.date,
      })),
      primaryStore,
      suggestedStores: primaryStore != null ? [primaryStore] : [],
      storeDetails,
      catalog: { districts, teams, stores: catalog },
      // back-compat
      stores: storeDetails.map((s) => s.storeNum),
      suggestions,
    });
  } catch (e) { next(e); }
});

router.get('/questions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, version, title, spec FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1'
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No active question set' });
    res.json({ ok: true, questionSet: rows[0] });
  } catch (e) { next(e); }
});

router.get('/stores/:storeNum/context', async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'Unknown store' });
    }
    const baseline = await pool.query(
      'SELECT respondent, submitted, answers, source FROM survey_baseline WHERE store_num = $1 ORDER BY submitted DESC',
      [storeNum]
    );
    const mine = await pool.query(
      `SELECT r.id, r.answers, r.photos, r.status, r.submitted_at, r.updated_at, r.question_set_id
         FROM survey_responses r
         JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
        WHERE r.store_num = $1 AND r.respondent = $2`,
      [storeNum, req.surveyUser.email]
    );
    const history = await pool.query(
      `SELECT id, answers, status, snapshot_at, source
         FROM survey_response_history
        WHERE store_num = $1 AND respondent = $2
        ORDER BY snapshot_at DESC
        LIMIT 20`,
      [storeNum, req.surveyUser.email]
    );
    const suggestions = await buildSuggestions(req.surveyUser, {
      storeNum,
      kompassRoles: req.user?.roles || [],
    });
    const { rows: districtRows } = await pool.query(
      `SELECT district FROM survey_store_districts WHERE store_num = $1`,
      [storeNum]
    );
    res.json({
      ok: true,
      baseline: baseline.rows,
      myResponse: mine.rows[0] || null,
      history: history.rows,
      store: {
        storeNum,
        district: districtRows[0]?.district || null,
      },
      suggestions,
    });
  } catch (e) { next(e); }
});

/** Live upsert with history archive when answers change. */
router.put('/stores/:storeNum/response', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'Unknown store' });
    }
    const { answers = {}, photos = [], submit = false } = req.body || {};
    if (typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ ok: false, error: 'answers must be an object' });
    }
    const qs = await client.query(
      'SELECT id FROM survey_question_sets WHERE active = TRUE ORDER BY version DESC LIMIT 1'
    );
    if (!qs.rows.length) return res.status(409).json({ ok: false, error: 'No active question set' });
    const qid = qs.rows[0].id;
    const status = submit ? 'submitted' : 'draft';

    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, question_set_id, store_num, respondent, answers, photos, status
         FROM survey_responses
        WHERE question_set_id = $1 AND store_num = $2 AND respondent = $3
        FOR UPDATE`,
      [qid, storeNum, req.surveyUser.email]
    );
    const prev = existing.rows[0];
    if (prev) {
      const prevJson = JSON.stringify(prev.answers || {});
      const nextJson = JSON.stringify(answers);
      if (prevJson !== nextJson || prev.status !== status) {
        await archiveResponseSnapshot(client, prev, submit ? 'submit' : 'save');
      }
    }

    const { rows } = await client.query(
      `INSERT INTO survey_responses (question_set_id, store_num, respondent, answers, photos, status, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, CASE WHEN $6 = 'submitted' THEN now() END, now())
       ON CONFLICT (question_set_id, store_num, respondent) DO UPDATE
         SET answers = EXCLUDED.answers,
             photos = EXCLUDED.photos,
             status = EXCLUDED.status,
             submitted_at = CASE
               WHEN EXCLUDED.status = 'submitted' THEN now()
               ELSE survey_responses.submitted_at
             END,
             updated_at = now()
       RETURNING id, status, submitted_at, updated_at`,
      [qid, storeNum, req.surveyUser.email, JSON.stringify(answers), JSON.stringify(photos), status]
    );
    await client.query('COMMIT');
    res.json({ ok: true, response: rows[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(e);
  } finally {
    client.release();
  }
});

router.get('/stores/:storeNum/history', async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'Unknown store' });
    }
    const { rows } = await pool.query(
      `SELECT id, answers, status, snapshot_at, source
         FROM survey_response_history
        WHERE store_num = $1 AND respondent = $2
        ORDER BY snapshot_at DESC
        LIMIT 50`,
      [storeNum, req.surveyUser.email]
    );
    res.json({ ok: true, history: rows });
  } catch (e) { next(e); }
});

router.get('/responses', requireSurveyRole('supervisor'), async (req, res, next) => {
  try {
    // Supervisors: suggested stores; master/admin: all catalog
    let stores = await listAccessibleStores(req.surveyUser, req.user.roles);
    if (req.surveyUser.isMasterAdmin || (req.user?.roles || []).includes('admin')) {
      stores = (await listCatalogStores()).map((s) => s.storeNum);
    }
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

const photoJson = express.json({ limit: '8mb' });

router.post('/stores/:storeNum/photos', photoJson, async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'Unknown store' });
    }
    const { questionId, mime, data, caption } = req.body || {};
    if (!questionId || !mime || !data) return res.status(400).json({ ok: false, error: 'questionId, mime, data required' });
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return res.status(400).json({ ok: false, error: 'Unsupported image type' });
    const buf = Buffer.from(String(data), 'base64');
    if (!buf.length || buf.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'Image empty or over 5MB' });
    const { rows } = await pool.query(
      `INSERT INTO survey_photos (store_num, respondent, question_id, mime, bytes, caption)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, question_id, caption, created_at`,
      [storeNum, req.surveyUser.email, String(questionId).slice(0, 10), mime, buf, caption ? String(caption).slice(0, 300) : null]
    );
    res.json({ ok: true, photo: rows[0] });
  } catch (e) { next(e); }
});

router.get('/stores/:storeNum/photos', async (req, res, next) => {
  try {
    const storeNum = Number(req.params.storeNum);
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, storeNum))) {
      return res.status(403).json({ ok: false, error: 'Unknown store' });
    }
    const { rows } = await pool.query(
      `SELECT id, respondent, question_id, caption, created_at FROM survey_photos
        WHERE store_num = $1 ORDER BY created_at`,
      [storeNum]
    );
    res.json({ ok: true, photos: rows });
  } catch (e) { next(e); }
});

router.get('/photos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT store_num, mime, bytes FROM survey_photos WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Photo not found' });
    if (!(await userHasStoreAccess(req.surveyUser, req.user.roles, rows[0].store_num))) {
      return res.status(403).json({ ok: false, error: 'No access to this photo' });
    }
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(rows[0].bytes);
  } catch (e) { next(e); }
});

router.delete('/photos/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM survey_photos WHERE id = $1 AND respondent = $2',
      [Number(req.params.id), req.surveyUser.email]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Photo not found or not yours' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
