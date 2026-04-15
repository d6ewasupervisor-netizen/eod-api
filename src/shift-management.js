/**
 * Shift Management Endpoints
 * - GET  /api/shifts              — find visits for a store/date via operations/field-data
 * - GET  /api/lead-info           — look up visit lead contact details by name
 * - GET  /api/shifts/:visitId/members — people assigned to a shift
 * - GET  /api/employees           — supervisor's direct reports (cached 1hr)
 * - POST /api/shifts/:visitId/add — add employees to a shift (immediate)
 * - POST /api/shift-request       — request removal (pending approval)
 * - GET  /api/shift-request/:id/approve — approve removal
 * - GET  /api/shift-request/:id/deny   — deny removal
 */

const crypto = require('crypto');
const axios = require('axios');
const { getHeaders, sasGet, sasPatch, isSessionAlive } = require('./sas-bridge');

const BASE_URL = 'https://prod.sasretail.com';
const SUPERVISOR_WORKDAY_ID = '800175315';
const SUPERVISOR_EMAIL = 'tyson.gauthier@retailodyssey.com';
const APP_BASE = 'https://eod-api-production.up.railway.app';
const CUSTOMER_ID = 2;
const PROGRAM_ID = 1;
const REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const logger = {
  info: (...a) => console.log('[shift-mgmt]', ...a),
  error: (...a) => console.error('[shift-mgmt]', ...a),
};

// ─── CACHES ────────────────────────────────────────────────────────────────

// Direct reports cache
let directReportsCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── HELPERS ────────────────────────────────────────────────────────────────

function checkSession(res) {
  if (!isSessionAlive()) {
    res.status(401).json({ error: 'SAS session not active — run morning auth first' });
    return false;
  }
  return true;
}

async function sasPost(urlPath, data) {
  const headers = getHeaders();
  if (!headers) throw new Error('SAS session not active');
  return axios.post(`${BASE_URL}${urlPath}`, data, { headers, maxBodyLength: Infinity });
}

function isSasAuthError(err) {
  const status = err?.response?.status;
  return status === 401 || status === 403;
}

function handleSasError(res, err, context) {
  if (isSasAuthError(err)) {
    return res.status(401).json({ error: 'SAS session not active — run morning auth first' });
  }
  logger.error(`${context}: ${err.message}`);
  return res.status(500).json({ error: err.message });
}

async function getDirectReports() {
  const now = Date.now();
  if (directReportsCache.data && (now - directReportsCache.fetchedAt) < CACHE_TTL_MS) {
    return directReportsCache.data;
  }

  const resp = await sasGet('/api/v1/human-resources/workday-employees/', {
    page: 1,
    page_size: 50,
    sort: 'person__person_name',
    supervisor_id: SUPERVISOR_WORKDAY_ID,
  });

  const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
  const employees = raw.map(e => ({
    employeeId: e.id || e.employee_id,
    workdayId: e.workday_given_id || e.workday_id,
    name: e.person?.person_name || e.person_name || '',
    preferredName: e.person?.preferred_name || e.preferred_name || null,
    title: e.person?.person_title || e.person_title || '',
    phone: e.person?.phone_number || e.phone_number || '',
  }));

  directReportsCache = { data: employees, fetchedAt: now };
  return employees;
}

// ─── EMAIL ──────────────────────────────────────────────────────────────────

async function sendEmail(resend, { to, subject, html }) {
  const { data, error } = await resend.emails.send({
    from: 'shifts@retail-odyssey.com',
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  });
  if (error) {
    logger.error('Email send failed:', error);
    throw new Error(error.message || String(error));
  }
  logger.info(`Email sent: ${data?.id} to ${to}`);
  return data;
}

function buildApprovalEmail(request) {
  const { requestId, storeNumber, teamName, date, remove, requestedBy } = request;
  const removeList = remove.map(r => `<li style="color:red;font-weight:bold;">${r.name} (ID: ${r.employeeId})</li>`).join('');
  const approveUrl = `${APP_BASE}/api/shift-request/${requestId}/approve`;
  const denyUrl = `${APP_BASE}/api/shift-request/${requestId}/deny`;

  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px;">
<h2>Shift Removal Request — Store #${storeNumber} ${date}</h2>
<p><strong>Store:</strong> #${storeNumber}</p>
<p><strong>Team:</strong> ${teamName}</p>
<p><strong>Date:</strong> ${date}</p>
<p><strong>Requested by:</strong> ${requestedBy}</p>
<h3>Employees to REMOVE:</h3>
<ul>${removeList}</ul>
<div style="margin-top:30px;">
  <a href="${approveUrl}" style="display:inline-block;padding:14px 28px;background:#22c55e;color:white;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;margin-right:16px;">✅ APPROVE</a>
  <a href="${denyUrl}" style="display:inline-block;padding:14px 28px;background:#ef4444;color:white;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;">❌ DENY</a>
</div>
</body></html>`;
}

function buildConfirmationEmail(request, results) {
  const { storeNumber, date, requestedBy } = request;
  const resultList = results.map(r =>
    `<li>${r.name}: ${r.success ? '<span style="color:green;">Removed</span>' : `<span style="color:red;">Failed — ${r.error}</span>`}</li>`
  ).join('');

  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px;">
<h2>Shift Removal Completed — Store #${storeNumber} ${date}</h2>
<p><strong>Requested by:</strong> ${requestedBy}</p>
<h3>Results:</h3>
<ul>${resultList}</ul>
</body></html>`;
}

// ─── DB INIT ────────────────────────────────────────────────────────────────

async function initShiftRequestsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shift_requests (
      id TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL,
      cycle_id TEXT,
      store_number TEXT NOT NULL,
      team_name TEXT,
      date TEXT NOT NULL,
      remove JSONB NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      results JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `);
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

function registerRoutes(app, resend, pool) {

  // 1. GET /api/shifts — find visits for a store on a date (operations-based)
  app.get('/api/shifts', async (req, res) => {
    const { store, date } = req.query;
    if (!store || !date) {
      return res.status(400).json({ error: 'Missing required query params: store, date' });
    }
    if (!checkSession(res)) return;

    try {
      // Step A: Resolve store number to account_store_id
      const storeResp = await sasGet('/api/v1/projects/store-numbers/', {
        customer: CUSTOMER_ID,
        program: PROGRAM_ID,
        search: store,
        page: 1,
        page_size: 8,
      });

      const storeResults = Array.isArray(storeResp.data) ? storeResp.data : (storeResp.data?.results || []);
      const exactMatch = storeResults.find(s => String(s.store__number) === String(store));
      if (!exactMatch) {
        return res.status(404).json({ error: `Store number ${store} not found` });
      }

      const accountStoreId = exactMatch.store__id;

      // Step B: Get shifts via operations/field-data
      const fieldResp = await sasGet('/api/v1/operations/field-data/', {
        account_store_id: accountStoreId,
        customer_id: CUSTOMER_ID,
        program_id: PROGRAM_ID,
        scheduled_dt_from: date,
        scheduled_dt_to: date,
        page: 1,
        page_size: 20,
        merchandiser: '',
        supervisor_id: '',
      });

      const visits = Array.isArray(fieldResp.data) ? fieldResp.data : (fieldResp.data?.results || []);

      const mapped = visits.map(v => {
        const projectName = v.project?.name || v.project_name || '';
        let kompassType;
        if (projectName.includes('Cut In')) {
          kompassType = 'Cut In Kompass ISE';
        } else if (projectName.includes('Kompass ISE')) {
          kompassType = 'Kompass ISE';
        } else {
          kompassType = projectName;
        }

        return {
          visitId: v.id,
          cycleId: v.cycle_id || null,
          projectName,
          projectId: v.project?.project_id || null,
          storeNumber: Number(store),
          storeName: v.store_name?.name || '',
          scheduledDate: v.scheduled_date || date,
          totalHours: v.total_hours || 0,
          currentStatus: v.current_status || 'active',
          visitLead: v.visit_lead || '',
          empCount: v.emp_count || 0,
          noShowCount: v.no_show_count || 0,
          dueBy: v.due_by || v.scheduled_date || date,
          kompassType,
        };
      });

      return res.json(mapped);
    } catch (err) {
      return handleSasError(res, err, 'GET /api/shifts');
    }
  });

  // GET /api/lead-info — look up visit lead contact details
  app.get('/api/lead-info', async (req, res) => {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Missing required query param: name' });
    }
    if (!checkSession(res)) return;

    try {
      const resp = await sasGet('/api/v1/human-resources/workday-employees/', {
        page: 1,
        page_size: 5,
        person_name: name,
        sort: 'person__person_name',
      });

      const results = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
      if (results.length === 0) {
        return res.status(404).json({ error: `No employee found matching "${name}"` });
      }

      const e = results[0];
      return res.json({
        employeeId: e.id,
        legalName: e.person?.person_name || '',
        preferredName: e.person?.preferred_name || '',
        email: e.person?.email || '',
        phone: e.person?.phone_number || '',
        title: e.person?.person_title || '',
      });
    } catch (err) {
      return handleSasError(res, err, 'GET /api/lead-info');
    }
  });

  // 2. GET /api/shifts/:visitId/members — people on a shift
  app.get('/api/shifts/:visitId/members', async (req, res) => {
    const { visitId } = req.params;
    if (!checkSession(res)) return;

    try {
      const resp = await sasGet('/api/v1/team-scheduling/shifts/', {
        visit: visitId,
        page: 1,
        page_size: 50,
      });

      const shifts = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
      const members = shifts
        .filter(s => s.current_status === 'active')
        .map(s => ({
          shiftId: s.id,
          employeeId: s.employee?.id || s.employee_id,
          workdayId: s.employee?.workday_given_id || '',
          name: s.employee?.person?.person_name || s.employee?.person_name || '',
          title: s.employee?.person?.person_title || '',
          phone: s.employee?.person?.phone_number || s.employee?.phone_number || '',
          isLead: s.is_lead || false,
          shiftStartTime: s.shift_start_time || '',
          shiftEndTime: s.shift_end_time || '',
          status: s.current_status,
        }));

      return res.json(members);
    } catch (err) {
      return handleSasError(res, err, 'GET /api/shifts/:visitId/members');
    }
  });

  // 3. GET /api/employees — supervisor's direct reports (cached 1hr)
  app.get('/api/employees', async (req, res) => {
    if (!checkSession(res)) return;

    try {
      const employees = await getDirectReports();
      return res.json(employees);
    } catch (err) {
      return handleSasError(res, err, 'GET /api/employees');
    }
  });

  // 4. POST /api/shifts/:visitId/add — add employees (immediate, no approval)
  app.post('/api/shifts/:visitId/add', async (req, res) => {
    const { visitId } = req.params;
    const { employees, requestedBy } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: 'Missing required field: employees' });
    }
    if (!checkSession(res)) return;

    try {
      // Fetch visit detail to get cycleId, shiftStartTime, shiftEndTime
      const visitResp = await sasGet(`/api/v1/team-scheduling/visits/${visitId}/`);
      const visitDetail = visitResp.data;

      if (!visitDetail) {
        return res.status(404).json({ error: 'Visit not found' });
      }

      if (visitDetail.current_status === 'completed') {
        return res.status(400).json({ error: 'Cannot modify a completed shift' });
      }

      const cycleId = visitDetail.cycle;
      const shiftStartTime = visitDetail.shift_start_time;
      const shiftEndTime = visitDetail.shift_end_time;

      if (!cycleId || !shiftStartTime || !shiftEndTime) {
        return res.status(400).json({ error: 'Visit is missing cycle or shift time data' });
      }

      // Validate all employees are direct reports
      const directReports = await getDirectReports();
      const directReportIds = new Set(directReports.map(d => d.employeeId));

      for (const emp of employees) {
        if (!directReportIds.has(emp.employeeId)) {
          return res.status(403).json({ error: `Employee ${emp.employeeId} is not a direct report` });
        }
      }

      // Add each employee
      const results = [];
      for (const emp of employees) {
        try {
          const body = {
            home_to_store: true,
            store_to_store: true,
            store_to_home: true,
            calculate_mileage: true,
            visit: String(visitId),
            employee: Number(emp.employeeId),
            cycle: Number(cycleId),
            shift_start_time: shiftStartTime,
            shift_end_time: shiftEndTime,
            current_status: 'active',
            rate_type: {},
            device_reimbursement: false,
            is_lead: String(emp.isLead === true),
          };

          const resp = await sasPost('/api/v1/team-scheduling/shifts/', body);
          results.push({
            employeeId: emp.employeeId,
            name: emp.name,
            success: true,
            shiftId: resp.data?.id,
          });
        } catch (err) {
          const errMsg = err.response?.data?.message || err.response?.data?.error || err.message;
          results.push({
            employeeId: emp.employeeId,
            name: emp.name,
            success: false,
            error: typeof errMsg === 'string' ? errMsg : 'Already assigned',
          });
        }
      }

      return res.json({ success: true, results });
    } catch (err) {
      return handleSasError(res, err, 'POST /api/shifts/:visitId/add');
    }
  });

  // 5. POST /api/shift-request — removal request (requires approval)
  app.post('/api/shift-request', async (req, res) => {
    const { visitId, cycleId, storeNumber, teamName, date, remove, requestedBy } = req.body;

    if (!visitId || !storeNumber || !date || !Array.isArray(remove) || remove.length === 0 || !requestedBy) {
      return res.status(400).json({ error: 'Missing required fields: visitId, storeNumber, date, remove, requestedBy' });
    }

    const requestId = crypto.randomUUID();

    try {
      await pool.query(
        `INSERT INTO shift_requests (id, visit_id, cycle_id, store_number, team_name, date, remove, requested_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [requestId, String(visitId), cycleId || null, String(storeNumber), teamName || null, date, JSON.stringify(remove), requestedBy]
      );
    } catch (err) {
      logger.error(`Failed to persist shift request: ${err.message}`);
      return res.status(500).json({ error: 'Failed to create shift request' });
    }

    const request = { requestId, storeNumber, teamName, date, remove, requestedBy };

    // Send approval email
    try {
      await sendEmail(resend, {
        to: SUPERVISOR_EMAIL,
        subject: `Shift Removal Request — Store #${storeNumber} ${date}`,
        html: buildApprovalEmail(request),
      });
    } catch (err) {
      logger.error(`Failed to send approval email: ${err.message}`);
    }

    return res.json({ requestId, status: 'pending' });
  });

  // 6. GET /api/shift-request/:requestId/approve — execute removals
  app.get('/api/shift-request/:requestId/approve', async (req, res) => {
    const { requestId } = req.params;

    let request;
    try {
      const { rows } = await pool.query('SELECT * FROM shift_requests WHERE id = $1', [requestId]);
      if (!rows.length) {
        return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;"><h1>Not Found</h1><p>Request not found.</p></body></html>');
      }
      request = rows[0];
    } catch (err) {
      return res.status(500).send('<html><body style="font-family:sans-serif;padding:40px;"><h1>Error</h1><p>Database error.</p></body></html>');
    }

    // Expire if older than 24h
    if (request.status === 'pending' && (Date.now() - new Date(request.created_at).getTime()) > REQUEST_EXPIRY_MS) {
      await pool.query("UPDATE shift_requests SET status = 'expired', processed_at = NOW() WHERE id = $1", [requestId]);
      request.status = 'expired';
    }

    if (request.status !== 'pending') {
      return res.send(`<html><body style="font-family:sans-serif;padding:40px;"><h1>Already Processed</h1><p>This request has already been ${request.status}. No further action needed.</p></body></html>`);
    }

    if (!isSessionAlive()) {
      return res.status(503).send('<html><body style="font-family:sans-serif;padding:40px;"><h1>SAS Session Inactive</h1><p>Cannot process removals — SAS session is not active. Please try again later or contact the team.</p></body></html>');
    }

    const removeList = request.remove;
    const results = [];
    for (const person of removeList) {
      try {
        await sasPatch(`/api/v1/team-scheduling/shifts/${person.shiftId}/`, {
          current_status: 'deleted',
        });
        results.push({ name: person.name, employeeId: person.employeeId, success: true });
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({ name: person.name, employeeId: person.employeeId, success: false, error: errMsg });
      }
    }

    await pool.query(
      "UPDATE shift_requests SET status = 'approved', results = $1, processed_at = NOW() WHERE id = $2",
      [JSON.stringify(results), requestId]
    );

    // Send confirmation email
    try {
      await sendEmail(resend, {
        to: SUPERVISOR_EMAIL,
        subject: `Shift Removal Completed — Store #${request.store_number} ${request.date}`,
        html: buildConfirmationEmail({
          storeNumber: request.store_number,
          date: request.date,
          requestedBy: request.requested_by,
        }, results),
      });
    } catch (err) {
      logger.error(`Failed to send confirmation email: ${err.message}`);
    }

    const names = results.filter(r => r.success).map(r => r.name).join(', ');
    res.send(`<html><body style="font-family:sans-serif;padding:40px;">
<h1>✅ Approved</h1>
<p>Shift removals for Store #${request.store_number} on ${request.date} have been applied.</p>
<p>Removed: ${names || 'None (all failed)'}</p>
<p>Requested by: ${request.requested_by}</p>
</body></html>`);
  });

  // 7. GET /api/shift-request/:requestId/deny — deny removal
  app.get('/api/shift-request/:requestId/deny', async (req, res) => {
    const { requestId } = req.params;

    let request;
    try {
      const { rows } = await pool.query('SELECT * FROM shift_requests WHERE id = $1', [requestId]);
      if (!rows.length) {
        return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;"><h1>Not Found</h1><p>Request not found.</p></body></html>');
      }
      request = rows[0];
    } catch (err) {
      return res.status(500).send('<html><body style="font-family:sans-serif;padding:40px;"><h1>Error</h1><p>Database error.</p></body></html>');
    }

    // Expire if older than 24h
    if (request.status === 'pending' && (Date.now() - new Date(request.created_at).getTime()) > REQUEST_EXPIRY_MS) {
      await pool.query("UPDATE shift_requests SET status = 'expired', processed_at = NOW() WHERE id = $1", [requestId]);
      request.status = 'expired';
    }

    if (request.status !== 'pending') {
      return res.send(`<html><body style="font-family:sans-serif;padding:40px;"><h1>Already Processed</h1><p>This request has already been ${request.status}. No further action needed.</p></body></html>`);
    }

    await pool.query(
      "UPDATE shift_requests SET status = 'denied', processed_at = NOW() WHERE id = $1",
      [requestId]
    );

    res.send(`<html><body style="font-family:sans-serif;padding:40px;">
<h1>❌ Denied</h1>
<p>Removal request for Store #${request.store_number} on ${request.date} has been denied. No changes were made.</p>
</body></html>`);
  });

  // 8. GET /api/shift-request/:requestId/status — poll for resolution
  app.get('/api/shift-request/:requestId/status', async (req, res) => {
    const { requestId } = req.params;

    try {
      const { rows } = await pool.query('SELECT id, status, results FROM shift_requests WHERE id = $1', [requestId]);
      if (!rows.length) {
        return res.status(404).json({ error: 'Request not found' });
      }

      const row = rows[0];

      // Expire if older than 24h
      if (row.status === 'pending') {
        const { rows: fullRows } = await pool.query('SELECT created_at FROM shift_requests WHERE id = $1', [requestId]);
        if ((Date.now() - new Date(fullRows[0].created_at).getTime()) > REQUEST_EXPIRY_MS) {
          await pool.query("UPDATE shift_requests SET status = 'expired', processed_at = NOW() WHERE id = $1", [requestId]);
          row.status = 'expired';
        }
      }

      return res.json({
        requestId: row.id,
        status: row.status,
        results: row.results || [],
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes, initShiftRequestsTable };
