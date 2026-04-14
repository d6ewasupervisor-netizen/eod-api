const { sasGet } = require('./sas-bridge');

const CUSTOMER_ID = 2;
const DIVISION_DEPT_CODE = '200250';
const SUPERVISOR_TITLE_ID = 60916;

const logger = {
  info: (...a) => console.log('[sas-sync]', ...a),
  error: (...a) => console.error('[sas-sync]', ...a),
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function paginateAll(urlPath, params, pageSize = 50) {
  const allResults = [];
  let page = 1;
  while (true) {
    const resp = await sasGet(urlPath, { ...params, page, page_size: pageSize });
    const data = resp.data;
    const results = Array.isArray(data) ? data : (data?.results || []);
    allResults.push(...results);
    if (results.length < pageSize) break;
    page++;
  }
  return allResults;
}

// ─── EMPLOYEE SYNC ────────────────────────────────────────────────────────────

async function syncEmployees(pool) {
  logger.info('Starting employee sync...');

  // Step 1: Get all "Supervisor Retail" employees, filter to our division
  const allSupervisors = await paginateAll('/api/v1/human-resources/workday-employees/', {
    person_title: SUPERVISOR_TITLE_ID,
    sort: 'person__person_name',
    supervisor_id: '',
  });

  const divisionSupervisors = allSupervisors.filter(
    s => s.department_code === DIVISION_DEPT_CODE
  );

  logger.info(`Found ${divisionSupervisors.length} supervisors in division ${DIVISION_DEPT_CODE}`);

  // Collect all employees (supervisors + their direct reports)
  const allEmployees = [];
  const seenIds = new Set();

  // Add the supervisors themselves
  for (const sup of divisionSupervisors) {
    if (!seenIds.has(sup.id)) {
      seenIds.add(sup.id);
      allEmployees.push(sup);
    }
  }

  // Step 2: For each supervisor, pull their direct reports
  for (const sup of divisionSupervisors) {
    const supWorkdayId = sup.workday_given_id;
    if (!supWorkdayId) continue;

    try {
      const reports = await paginateAll('/api/v1/human-resources/workday-employees/', {
        supervisor_id: supWorkdayId,
        sort: 'person__person_name',
      });

      for (const emp of reports) {
        if (!seenIds.has(emp.id)) {
          seenIds.add(emp.id);
          allEmployees.push(emp);
        }
      }

      logger.info(`  ${sup.person?.person_name || supWorkdayId}: ${reports.length} reports`);
    } catch (err) {
      logger.error(`  Failed to fetch reports for ${supWorkdayId}: ${err.message}`);
    }
  }

  logger.info(`Total unique employees: ${allEmployees.length}`);

  // Step 3: Upsert into Postgres
  let upserted = 0;
  for (const emp of allEmployees) {
    try {
      await pool.query(`
        INSERT INTO employees (
          sas_employee_id, workday_id, name, preferred_name, title,
          phone, email, supervisor_id, supervisor_name, department_code,
          employee_type, date_of_hire, termination_date, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
        ON CONFLICT (sas_employee_id) DO UPDATE SET
          workday_id = EXCLUDED.workday_id,
          name = EXCLUDED.name,
          preferred_name = EXCLUDED.preferred_name,
          title = EXCLUDED.title,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          supervisor_id = EXCLUDED.supervisor_id,
          supervisor_name = EXCLUDED.supervisor_name,
          department_code = EXCLUDED.department_code,
          employee_type = EXCLUDED.employee_type,
          date_of_hire = EXCLUDED.date_of_hire,
          termination_date = EXCLUDED.termination_date,
          synced_at = NOW()
      `, [
        emp.id,
        emp.workday_given_id || null,
        emp.person?.person_name || emp.person_name || '',
        emp.person?.preferred_name || null,
        emp.person?.person_title || '',
        emp.person?.phone_number || emp.person?.phone || '',
        emp.person?.email || '',
        emp.supervisor_id || emp.supervisor || null,
        emp.supervisor_person?.name || null,
        emp.department_code || null,
        emp.employee_type || null,
        emp.date_of_hire || null,
        emp.termination_date || null,
      ]);
      upserted++;
    } catch (err) {
      logger.error(`  Failed to upsert employee ${emp.id}: ${err.message}`);
    }
  }

  logger.info(`Employee sync complete: ${upserted} upserted`);
  return { total: allEmployees.length, upserted };
}

// ─── SCHEDULE SYNC ────────────────────────────────────────────────────────────

async function syncSchedules(pool) {
  logger.info('Starting schedule sync...');

  // Pull schedules for next 7 days
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 7);

  const fromDate = today.toISOString().split('T')[0];
  const toDate = endDate.toISOString().split('T')[0];

  logger.info(`Fetching schedules from ${fromDate} to ${toDate}`);

  const allVisits = await paginateAll('/api/v1/operations/field-data/', {
    customer_id: CUSTOMER_ID,
    scheduled_dt_from: fromDate,
    scheduled_dt_to: toDate,
    merchandiser: '',
    project_store_id: '',
    supervisor_id: '',
  });

  logger.info(`Fetched ${allVisits.length} visits`);

  // Upsert into Postgres
  let upserted = 0;
  for (const v of allVisits) {
    try {
      await pool.query(`
        INSERT INTO schedules (
          visit_id, visit_id_full, cycle_id, store_number, store_name,
          project_name, project_id, scheduled_date, shift_start_time,
          shift_end_time, total_hours, current_status, visit_lead,
          supervisor, emp_count, no_show_count, due_by, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
        ON CONFLICT (visit_id, scheduled_date) DO UPDATE SET
          visit_id_full = EXCLUDED.visit_id_full,
          cycle_id = EXCLUDED.cycle_id,
          store_number = EXCLUDED.store_number,
          store_name = EXCLUDED.store_name,
          project_name = EXCLUDED.project_name,
          project_id = EXCLUDED.project_id,
          shift_start_time = EXCLUDED.shift_start_time,
          shift_end_time = EXCLUDED.shift_end_time,
          total_hours = EXCLUDED.total_hours,
          current_status = EXCLUDED.current_status,
          visit_lead = EXCLUDED.visit_lead,
          supervisor = EXCLUDED.supervisor,
          emp_count = EXCLUDED.emp_count,
          no_show_count = EXCLUDED.no_show_count,
          due_by = EXCLUDED.due_by,
          synced_at = NOW()
      `, [
        v.id,
        v.visit_id || null,
        v.cycle_id || null,
        v.store_name?.number || null,
        v.store_name?.name || null,
        v.project?.name || null,
        v.project?.project_id || null,
        v.scheduled_date,
        null,
        null,
        v.total_hours || null,
        v.current_status || null,
        v.visit_lead || null,
        v.supervisor || null,
        v.emp_count || 0,
        v.no_show_count || 0,
        v.due_by || null,
      ]);
      upserted++;
    } catch (err) {
      logger.error(`  Failed to upsert visit ${v.id}: ${err.message}`);
    }
  }

  logger.info(`Schedule sync complete: ${upserted} upserted`);
  return { total: allVisits.length, upserted };
}

// ─── STORE SYNC ───────────────────────────────────────────────────────────────

async function syncStores(pool) {
  logger.info('Starting store sync (from schedule data)...');

  // Pull stores from existing schedule records
  const { rows } = await pool.query(`
    SELECT DISTINCT store_number, store_name
    FROM schedules
    WHERE store_number IS NOT NULL
  `);

  let upserted = 0;
  for (const row of rows) {
    try {
      await pool.query(`
        INSERT INTO stores (store_number, name, synced_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (store_number) DO UPDATE SET
          name = EXCLUDED.name,
          synced_at = NOW()
      `, [row.store_number, row.store_name]);
      upserted++;
    } catch (err) {
      logger.error(`  Failed to upsert store ${row.store_number}: ${err.message}`);
    }
  }

  logger.info(`Store sync complete: ${upserted} upserted`);
  return { total: rows.length, upserted };
}

// ─── FULL SYNC ────────────────────────────────────────────────────────────────

async function runFullSync(pool) {
  const start = Date.now();
  logger.info('=== FULL SYNC STARTED ===');

  try {
    const employees = await syncEmployees(pool);
    const schedules = await syncSchedules(pool);
    const stores = await syncStores(pool);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`=== FULL SYNC COMPLETE in ${elapsed}s ===`);

    return {
      success: true,
      elapsed: `${elapsed}s`,
      employees,
      schedules,
      stores,
    };
  } catch (err) {
    logger.error(`=== FULL SYNC FAILED: ${err.message} ===`);
    return { success: false, error: err.message };
  }
}

module.exports = { syncEmployees, syncSchedules, syncStores, runFullSync };