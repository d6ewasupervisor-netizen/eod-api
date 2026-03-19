/**
 * SAS Bridge for Railway EOD API
 * - Receives + stores authenticated session from morning-auth.js
 * - Queues photo upload jobs from the frontend
 * - Processes queue in background using stored session
 * - Heartbeat keeps session alive all day
 */

const axios = require('axios');

const BASE_URL = 'https://prod.sasretail.com';
const CUSTOMER_ID = 2;
const DEFAULT_PROGRAM_ID = 1;
const DEFAULT_PROJECT_IDS = [1, 1668, 1715, 3568];
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;       // 4 minutes
const QUEUE_POLL_INTERVAL_MS = 10 * 1000;           // 10 seconds
const AUTH_SECRET = process.env.SAS_AUTH_SECRET || '';

const logger = {
  info: (...a) => console.log('[sas-bridge]', ...a),
  error: (...a) => console.error('[sas-bridge]', ...a),
};

// ─── IN-MEMORY SESSION ────────────────────────────────────────────────────────

let sasSession = {
  cookieHeader: null,
  csrfToken: null,
  receivedAt: null,
  lastHeartbeat: null,
  alive: false,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getHeaders() {
  if (!sasSession.alive) return null;
  return {
    'Cookie': sasSession.cookieHeader,
    'X-CSRFToken': sasSession.csrfToken,
    'Referer': `${BASE_URL}/en/sasretail/dashboard/`,
    'Content-Type': 'application/json',
  };
}

async function sasGet(urlPath, params = {}) {
  const headers = getHeaders();
  if (!headers) throw new Error('SAS session not active');
  return axios.get(`${BASE_URL}${urlPath}`, { headers, params });
}

async function sasPatch(urlPath, data) {
  const headers = getHeaders();
  if (!headers) throw new Error('SAS session not active');
  return axios.patch(`${BASE_URL}${urlPath}`, data, { headers, maxBodyLength: Infinity });
}

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────

let heartbeatTimer = null;

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(async () => {
    try {
      const resp = await axios.get(`${BASE_URL}/api/v1/notifications/api/unread_list/?max=1`, {
        headers: getHeaders(),
        validateStatus: () => true,
      });

      if (resp.status === 200) {
        sasSession.lastHeartbeat = new Date().toISOString();
        logger.info(`Heartbeat OK at ${sasSession.lastHeartbeat}`);
      } else {
        logger.error(`Heartbeat returned ${resp.status} — session may be expired`);
        sasSession.alive = false;
      }
    } catch (err) {
      logger.error(`Heartbeat failed: ${err.message}`);
      sasSession.alive = false;
    }
  }, HEARTBEAT_INTERVAL_MS);

  logger.info(`Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

// ─── SAS API NAVIGATION ──────────────────────────────────────────────────────

async function findEmployee(nameQuery) {
  const resp = await sasGet('/api/v1/team-employees/', {
    customer_id: CUSTOMER_ID,
    q: nameQuery,
  });

  const employees = resp.data;
  if (!employees || employees.length === 0) return null;

  const exact = employees.find(
    e => e.person_name.toLowerCase().includes(nameQuery.toLowerCase())
  );
  return exact || employees[0];
}

async function findVisit(employeeId, date, projectIds) {
  projectIds = projectIds || DEFAULT_PROJECT_IDS;

  for (const projectId of projectIds) {
    try {
      const resp = await sasGet('/api/v1/operations/field-data/', {
        customer_id: CUSTOMER_ID,
        merchandiser: employeeId,
        program_id: DEFAULT_PROGRAM_ID,
        project_id: projectId,
        scheduled_dt_from: date,
        scheduled_dt_to: date,
        page: 1,
        page_size: 10,
      });

      const visits = resp.data;
      if (Array.isArray(visits) && visits.length > 0) {
        return {
          visitId: visits[0].id,
          storeNumber: visits[0].store_name?.number,
          projectId,
          projectName: visits[0].project?.name,
          status: visits[0].current_status,
        };
      }
    } catch (err) {
      // try next project
    }
  }
  return null;
}

async function findVisitByStore(storeNumber, date, projectIds) {
  projectIds = projectIds || DEFAULT_PROJECT_IDS;

  for (const projectId of projectIds) {
    try {
      const resp = await sasGet('/api/v1/operations/field-data/', {
        customer_id: CUSTOMER_ID,
        program_id: DEFAULT_PROGRAM_ID,
        project_id: projectId,
        scheduled_dt_from: date,
        scheduled_dt_to: date,
        page: 1,
        page_size: 50,
      });

      const visits = resp.data;
      if (!Array.isArray(visits)) continue;

      const match = visits.find(v => String(v.store_name?.number) === String(storeNumber));
      if (match) {
        return {
          visitId: match.id,
          storeNumber: match.store_name?.number,
          projectId,
          projectName: match.project?.name,
          status: match.current_status,
        };
      }
    } catch (err) {
      // try next project
    }
  }
  return null;
}

async function getCategoryResets(visitId) {
  const resp = await sasGet(`/api/v1/field-app/visits/${visitId}/category-resets/`);
  if (!resp.data?.category_resets) return [];

  return resp.data.category_resets.map(r => ({
    id: r.id,
    name: r.name,
    planogramId: r.planogram_id,
    resetType: r.reset_type,
    beforeCount: r.state?.before?.count || 0,
    afterCount: r.state?.after?.count || 0,
    isPhotoRequired: r.is_photo_required,
  }));
}

async function uploadPhoto(visitId, resetId, photoBase64, slot, filename, filetype) {
  let base64Data = photoBase64;
  if (base64Data.startsWith('data:')) {
    const parts = base64Data.split(',');
    base64Data = parts[1];
    const match = parts[0].match(/data:(.*?);/);
    if (match) filetype = match[1];
  }

  filetype = filetype || 'image/jpeg';
  filename = filename || 'photo.jpg';
  const filesize = Math.round((base64Data.length * 3) / 4);

  const body = {
    [slot]: {
      image: { filetype, filename, filesize, base64: base64Data },
    },
    compress_image: true,
  };

  const resp = await sasPatch(
    `/api/v1/field-app/visits/${visitId}/category-resets/${resetId}/`,
    body
  );

  return {
    success: resp.data?.success || resp.status === 200,
    imageId: resp.data?.image_id,
    imageUrl: resp.data?.image_url,
  };
}

// ─── JOB PROCESSOR ────────────────────────────────────────────────────────────

async function processUploadJob(job) {
  const { storeNumber, date, leadName, photoBase64, slot, targetReset, filename } = job;

  logger.info(`Processing upload: store=${storeNumber} date=${date} lead=${leadName} slot=${slot}`);

  // Step 1: Find employee
  const employee = await findEmployee(leadName);
  if (!employee) {
    return { success: false, error: `Employee not found: ${leadName}` };
  }

  // Step 2: Find visit
  let visit = await findVisit(employee.id, date);
  if (!visit) {
    visit = await findVisitByStore(storeNumber, date);
  }
  if (!visit) {
    return { success: false, error: `No visit found for store ${storeNumber} on ${date}` };
  }

  // Step 3: Find target reset
  const resets = await getCategoryResets(visit.visitId);
  let target;

  if (!targetReset || targetReset === 'MAINTENANCE') {
    target = resets.find(r => r.resetType === 'MAINTENANCE' || r.name === 'KOMPASS MAINTENANCE');
  } else {
    target = resets.find(r =>
      r.name.toLowerCase().includes(targetReset.toLowerCase())
    );
  }

  if (!target) {
    return {
      success: false,
      error: `Reset "${targetReset || 'MAINTENANCE'}" not found`,
      availableResets: resets.map(r => r.name),
    };
  }

  // Step 4: Upload
  const autoFilename = filename || `${slot}_store${storeNumber}_${date}.jpg`;
  const result = await uploadPhoto(visit.visitId, target.id, photoBase64, slot, autoFilename);

  return {
    ...result,
    visitId: visit.visitId,
    resetId: target.id,
    resetName: target.name,
    storeNumber: visit.storeNumber,
  };
}

// ─── QUEUE (PostgreSQL-backed) ────────────────────────────────────────────────

let queueTimer = null;

async function initQueue(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sas_upload_queue (
      id SERIAL PRIMARY KEY,
      store_number TEXT NOT NULL,
      date TEXT NOT NULL,
      lead_name TEXT NOT NULL,
      photo_base64 TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT 'before',
      target_reset TEXT DEFAULT 'MAINTENANCE',
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `);
  logger.info('Upload queue table ready');
}

async function enqueueUpload(pool, job) {
  const { rows } = await pool.query(
    `INSERT INTO sas_upload_queue (store_number, date, lead_name, photo_base64, slot, target_reset, filename)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [job.storeNumber, job.date, job.leadName, job.photoBase64, job.slot || 'before', job.targetReset || 'MAINTENANCE', job.filename || null]
  );
  const jobId = rows[0].id;
  logger.info(`Enqueued upload job #${jobId} for store ${job.storeNumber}`);
  return jobId;
}

async function processQueue(pool) {
  if (!sasSession.alive) return;

  const { rows: jobs } = await pool.query(
    `SELECT * FROM sas_upload_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 5`
  );

  if (jobs.length === 0) return;

  logger.info(`Processing ${jobs.length} queued upload(s)...`);

  for (const job of jobs) {
    try {
      // Mark as processing
      await pool.query(
        `UPDATE sas_upload_queue SET status = 'processing' WHERE id = $1`,
        [job.id]
      );

      const result = await processUploadJob({
        storeNumber: job.store_number,
        date: job.date,
        leadName: job.lead_name,
        photoBase64: job.photo_base64,
        slot: job.slot,
        targetReset: job.target_reset,
        filename: job.filename,
      });

      const status = result.success ? 'completed' : 'failed';
      await pool.query(
        `UPDATE sas_upload_queue
         SET status = $1, result = $2, error = $3, processed_at = NOW()
         WHERE id = $4`,
        [status, JSON.stringify(result), result.error || null, job.id]
      );

      logger.info(`Job #${job.id}: ${status}${result.imageUrl ? ' → ' + result.imageUrl : ''}`);
    } catch (err) {
      await pool.query(
        `UPDATE sas_upload_queue
         SET status = 'failed', error = $1, processed_at = NOW()
         WHERE id = $2`,
        [err.message, job.id]
      );
      logger.error(`Job #${job.id} failed: ${err.message}`);
    }
  }
}

function startQueueWorker(pool) {
  if (queueTimer) clearInterval(queueTimer);

  queueTimer = setInterval(() => {
    processQueue(pool).catch(err => {
      logger.error(`Queue worker error: ${err.message}`);
    });
  }, QUEUE_POLL_INTERVAL_MS);

  logger.info(`Queue worker started (polling every ${QUEUE_POLL_INTERVAL_MS / 1000}s)`);
}

// ─── EXPRESS ROUTES ───────────────────────────────────────────────────────────

function registerRoutes(app, pool) {

  // Receive session from morning-auth.js
  app.post('/sas-session', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!AUTH_SECRET || token !== AUTH_SECRET) {
      return res.status(401).json({ success: false, error: 'Invalid auth secret' });
    }

    const { cookieHeader, csrfToken } = req.body;

    if (!cookieHeader || !csrfToken) {
      return res.status(400).json({ success: false, error: 'Missing cookieHeader or csrfToken' });
    }

    // Validate the session with a quick API call
    try {
      const testResp = await axios.get(`${BASE_URL}/api/v1/notifications/api/unread_list/?max=1`, {
        headers: {
          'Cookie': cookieHeader,
          'X-CSRFToken': csrfToken,
          'Referer': `${BASE_URL}/en/sasretail/dashboard/`,
        },
        validateStatus: () => true,
      });

      if (testResp.status !== 200) {
        return res.status(400).json({
          success: false,
          error: `Session validation failed (HTTP ${testResp.status})`,
        });
      }
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: `Session validation error: ${err.message}`,
      });
    }

    // Store session
    sasSession = {
      cookieHeader,
      csrfToken,
      receivedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      alive: true,
    };

    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

    // Start heartbeat + queue worker
    startHeartbeat();
    startQueueWorker(pool);

    logger.info('Session received and validated. Heartbeat + queue worker started.');

    return res.json({
      success: true,
      receivedAt: sasSession.receivedAt,
      expiresAt,
    });
  });

  // Accept upload jobs from the EOD frontend
  app.post('/sas-upload', async (req, res) => {
    const { storeNumber, date, leadName, photoBase64, slot, targetReset, filename } = req.body;

    if (!storeNumber || !date || !leadName || !photoBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: storeNumber, date, leadName, photoBase64',
      });
    }

    if (!sasSession.alive) {
      // Queue it anyway — it'll be processed when session is restored
      try {
        const jobId = await enqueueUpload(pool, { storeNumber, date, leadName, photoBase64, slot, targetReset, filename });
        return res.json({
          success: true,
          queued: true,
          jobId,
          message: 'SAS session not active — job queued for processing when session is restored',
        });
      } catch (err) {
        return res.status(500).json({ success: false, error: `Queue error: ${err.message}` });
      }
    }

    // Session is active — enqueue and it'll process within 10 seconds
    try {
      const jobId = await enqueueUpload(pool, { storeNumber, date, leadName, photoBase64, slot, targetReset, filename });
      return res.json({ success: true, queued: true, jobId });
    } catch (err) {
      return res.status(500).json({ success: false, error: `Queue error: ${err.message}` });
    }
  });

  // Check upload job status
  app.get('/sas-upload/:jobId', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, store_number, date, lead_name, slot, target_reset, status, result, error, created_at, processed_at
         FROM sas_upload_queue WHERE id = $1`,
        [req.params.jobId]
      );

      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      return res.json({ success: true, job: rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Session status check
  app.get('/sas-session/status', (req, res) => {
    res.json({
      alive: sasSession.alive,
      receivedAt: sasSession.receivedAt,
      lastHeartbeat: sasSession.lastHeartbeat,
    });
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init(app, pool) {
  await initQueue(pool);
  registerRoutes(app, pool);
  logger.info('SAS bridge initialized. Waiting for session from morning-auth.');
}

module.exports = { init };
