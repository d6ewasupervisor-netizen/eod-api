// Survey ops: admin scope, coverage, assignments, invites, alerts.
'use strict';

const { pool } = require('./db');
const { issueLinkToken } = require('./tokens');
const { buildMagicLink } = require('./magic-link');
const { getEmailSender } = require('./resend-outbox');
const { retailOdysseyFrom } = require('./email-from');
const {
  getSurveyUser,
  isMasterAdminEmail,
  listCatalogStores,
  sortDistricts,
  compareDistricts,
} = require('./survey-access');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function isDivisionAdmin(surveyUser, kompassRoles = []) {
  if (!surveyUser) return false;
  if (surveyUser.isMasterAdmin || isMasterAdminEmail(surveyUser.email)) return true;
  if ((kompassRoles || []).includes('admin')) return true;
  const title = String(surveyUser.title || '').toLowerCase();
  return /manager retail operations|director/.test(title);
}

/**
 * Who can use survey admin:
 * - division: managers / directors / master / Kompass admin → all stores
 * - district: retail supervisors → stores they supervise (and/or home district)
 * - null: no access
 */
async function resolveSurveyAdminScope(surveyUser, kompassRoles = []) {
  if (!surveyUser) return null;
  if (isDivisionAdmin(surveyUser, kompassRoles)) {
    return { level: 'division', districts: null, storeNums: null };
  }
  if (surveyUser.role !== 'supervisor') return null;

  const { rows } = await pool.query(
    `SELECT s.store_num, COALESCE(d.district, 'Unassigned') AS district
       FROM survey_store_supervisors s
       LEFT JOIN survey_store_districts d ON d.store_num = s.store_num
      WHERE lower(s.supervisor_email) = lower($1)`,
    [surveyUser.email]
  );

  let storeNums = rows.map((r) => Number(r.store_num)).filter(Number.isFinite);
  let districts = sortDistricts([...new Set(rows.map((r) => r.district).filter(Boolean))]);

  if (surveyUser.district) {
    districts = sortDistricts([...new Set([String(surveyUser.district), ...districts])]);
  }

  if (!storeNums.length && surveyUser.district) {
    const all = await pool.query(
      `SELECT store_num FROM survey_store_districts WHERE district = $1`,
      [String(surveyUser.district)]
    );
    storeNums = all.rows.map((r) => Number(r.store_num));
  }

  if (!storeNums.length && !districts.length) return null;
  return { level: 'district', districts, storeNums };
}

function applyScopeToFilters(scope, filters = {}) {
  const out = { ...filters };
  if (!scope || scope.level === 'division') return out;
  if (scope.storeNums && scope.storeNums.length) {
    const allowed = new Set(scope.storeNums.map(Number));
    if (out.stores && out.stores.length) {
      out.stores = out.stores.map(Number).filter((n) => allowed.has(n));
    } else {
      out.stores = [...allowed];
    }
  } else if (scope.districts && scope.districts.length) {
    if (out.districts && out.districts.length) {
      const allowed = new Set(scope.districts.map(String));
      out.districts = out.districts.filter((d) => allowed.has(String(d)));
    } else {
      out.districts = [...scope.districts];
    }
  }
  return out;
}

async function requireSurveyAdmin(req, res, next) {
  try {
    const su = await getSurveyUser(req.user && req.user.email);
    if (!su) return res.status(403).json({ ok: false, error: 'Not on the survey roster' });
    su.isMasterAdmin = isMasterAdminEmail(su.email);
    const scope = await resolveSurveyAdminScope(su, req.user?.roles || []);
    if (!scope) {
      return res.status(403).json({
        ok: false,
        error: 'Survey admin is for supervisors, managers, and division admins.',
      });
    }
    req.surveyUser = su;
    req.surveyAdminScope = scope;
    next();
  } catch (e) {
    next(e);
  }
}

async function buildCoverage(scope) {
  const catalog = await listCatalogStores();
  let stores = catalog;
  if (scope?.level === 'district') {
    const allowed = new Set((scope.storeNums || []).map(Number));
    const dists = new Set((scope.districts || []).map(String));
    stores = catalog.filter((s) => {
      if (allowed.size && allowed.has(Number(s.storeNum))) return true;
      if (dists.size && dists.has(String(s.district))) return true;
      return false;
    });
  }

  const storeNums = stores.map((s) => s.storeNum);
  if (!storeNums.length) {
    return { stores: [], totals: { stores: 0, done: 0, assigned: 0, needsAssign: 0, open: 0 } };
  }

  const { rows: submitted } = await pool.query(
    `SELECT DISTINCT r.store_num
       FROM survey_responses r
       JOIN survey_question_sets q ON q.id = r.question_set_id AND q.active = TRUE
      WHERE r.status = 'submitted' AND r.store_num = ANY($1::int[])`,
    [storeNums]
  );
  const doneSet = new Set(submitted.map((r) => Number(r.store_num)));

  const { rows: assigns } = await pool.query(
    `SELECT a.id, a.store_num, a.assignee_email, a.due_at, a.status, a.notes, a.scope_label,
            a.invite_sent_at, a.assigned_by, a.created_at,
            ro.name AS assignee_name, ro.team AS assignee_team, ro.role AS assignee_role,
            ab.name AS assigned_by_name
       FROM survey_assignments a
       LEFT JOIN survey_roster ro ON ro.email = a.assignee_email
       LEFT JOIN survey_roster ab ON ab.email = a.assigned_by
      WHERE a.status = 'open' AND a.store_num = ANY($1::int[])
      ORDER BY a.due_at NULLS LAST, a.store_num`,
    [storeNums]
  );

  const byStore = new Map();
  for (const a of assigns) {
    const sn = Number(a.store_num);
    if (!byStore.has(sn)) byStore.set(sn, []);
    byStore.get(sn).push({
      id: a.id,
      assigneeEmail: a.assignee_email,
      assigneeName: a.assignee_name,
      assigneeTeam: a.assignee_team,
      assigneeRole: a.assignee_role,
      dueAt: a.due_at,
      notes: a.notes,
      scopeLabel: a.scope_label,
      inviteSentAt: a.invite_sent_at,
      assignedBy: a.assigned_by,
      assignedByName: a.assigned_by_name,
      createdAt: a.created_at,
    });
  }

  const rows = stores.map((s) => {
    const sn = Number(s.storeNum);
    const assignees = byStore.get(sn) || [];
    const done = doneSet.has(sn);
    let state = 'needs_assign';
    if (done) state = 'done';
    else if (assignees.length) state = 'assigned';
    return {
      storeNum: sn,
      storeName: s.storeName || null,
      district: s.district,
      done,
      state,
      assignees,
    };
  });

  rows.sort((a, b) => {
    const order = { needs_assign: 0, assigned: 1, done: 2 };
    return (order[a.state] - order[b.state])
      || compareDistricts(a.district, b.district)
      || a.storeNum - b.storeNum;
  });

  const totals = {
    stores: rows.length,
    done: rows.filter((r) => r.state === 'done').length,
    assigned: rows.filter((r) => r.state === 'assigned').length,
    needsAssign: rows.filter((r) => r.state === 'needs_assign').length,
    open: rows.filter((r) => r.state !== 'done').length,
  };

  return { stores: rows, totals };
}

async function searchRoster({ q = '', team = null, role = null, limit = 25 } = {}) {
  const params = [];
  const where = ['active = TRUE'];
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length} OR lower(COALESCE(team,'')) LIKE $${params.length})`);
  }
  if (team) {
    params.push(String(team));
    where.push(`team = $${params.length}`);
  }
  if (role) {
    params.push(String(role));
    where.push(`role = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 25, 1), 80));
  const { rows } = await pool.query(
    `SELECT email, name, role, team, district, title
       FROM survey_roster
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE role WHEN 'supervisor' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END,
        name
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function listTeams() {
  const { rows } = await pool.query(
    `SELECT DISTINCT team FROM survey_roster
      WHERE active AND team IS NOT NULL AND trim(team) <> ''
      ORDER BY 1`
  );
  return rows.map((r) => r.team);
}

function remindAtFromDue(dueAt, daysBefore = 1) {
  if (!dueAt) return null;
  const d = new Date(`${String(dueAt).slice(0, 10)}T16:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - Number(daysBefore || 1));
  return d;
}

/**
 * Ensure assignee emails exist on survey_roster (FK). Creates lightweight
 * roster rows for manual / alternate emails that are not already in the system.
 * @param {Array<string|{email:string,name?:string,role?:string}>} assignees
 */
async function ensureRosterEmails(assignees, client = pool) {
  const list = [];
  for (const raw of assignees || []) {
    if (typeof raw === 'string') {
      const email = String(raw).trim().toLowerCase();
      if (email) list.push({ email, name: null, role: 'lead' });
      continue;
    }
    const email = String(raw?.email || '').trim().toLowerCase();
    if (!email) continue;
    list.push({
      email,
      name: raw.name ? String(raw.name).trim() : null,
      role: ['supervisor', 'lead', 'member'].includes(String(raw.role || '').toLowerCase())
        ? String(raw.role).toLowerCase()
        : 'lead',
    });
  }
  const unique = new Map();
  for (const a of list) {
    if (!unique.has(a.email)) unique.set(a.email, a);
  }
  for (const a of unique.values()) {
    const displayName = a.name || a.email.split('@')[0] || a.email;
    await client.query(
      `INSERT INTO survey_roster (email, name, role, team, active)
       VALUES ($1, $2, $3, NULL, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         active = TRUE,
         updated_at = now()`,
      [a.email, displayName, a.role]
    );
  }
  return [...unique.keys()];
}

async function createAssignments({
  assigneeEmails,
  assignees = null,
  storeNums,
  assignedBy,
  dueAt = null,
  notes = null,
  scopeLabel = null,
  remindDaysBefore = 1,
  sendInvites = true,
}) {
  const fromAssignees = Array.isArray(assignees)
    ? assignees.map((a) => (typeof a === 'string' ? { email: a } : a))
    : [];
  const fromEmails = (assigneeEmails || []).map((e) => ({ email: e }));
  const people = [...fromAssignees, ...fromEmails];
  const emails = await ensureRosterEmails(people);
  const stores = [...new Set((storeNums || []).map(Number).filter(Number.isFinite))];
  if (!emails.length) {
    const err = new Error('At least one assignee required');
    err.status = 400;
    throw err;
  }
  if (!stores.length) {
    const err = new Error('At least one store required');
    err.status = 400;
    throw err;
  }

  const created = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureRosterEmails(people, client);
    for (const email of emails) {
      for (const store of stores) {
        const { rows } = await client.query(
          `INSERT INTO survey_assignments
             (store_num, assignee_email, assigned_by, due_at, notes, scope_label, status)
           VALUES ($1,$2,$3,$4,$5,$6,'open')
           ON CONFLICT (store_num, assignee_email) WHERE status = 'open'
           DO UPDATE SET
             due_at = COALESCE(EXCLUDED.due_at, survey_assignments.due_at),
             notes = COALESCE(EXCLUDED.notes, survey_assignments.notes),
             scope_label = COALESCE(EXCLUDED.scope_label, survey_assignments.scope_label),
             assigned_by = EXCLUDED.assigned_by,
             updated_at = now()
           RETURNING *`,
          [store, email, assignedBy, dueAt || null, notes || null, scopeLabel || null]
        );
        const row = rows[0];
        created.push(row);
        await client.query(
          `DELETE FROM survey_assignment_reminders WHERE assignment_id = $1 AND sent_at IS NULL`,
          [row.id]
        );
        const remindAt = remindAtFromDue(dueAt, remindDaysBefore);
        if (remindAt && remindAt.getTime() > Date.now()) {
          await client.query(
            `INSERT INTO survey_assignment_reminders (assignment_id, remind_at, kind)
             VALUES ($1,$2,'due')`,
            [row.id, remindAt.toISOString()]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  let inviteResults = [];
  if (sendInvites) {
    inviteResults = await sendAssignmentInvites(created);
  }
  return { created, inviteResults };
}

async function sendAssignmentInvites(assignmentRows) {
  const byEmail = new Map();
  for (const a of assignmentRows) {
    const em = a.assignee_email;
    if (!byEmail.has(em)) byEmail.set(em, []);
    byEmail.get(em).push(a);
  }

  const results = [];
  for (const [email, list] of byEmail) {
    try {
      const { rows: people } = await pool.query(
        `SELECT name FROM survey_roster WHERE email = $1`,
        [email]
      );
      const name = people[0]?.name || email;
      const storeNums = list.map((a) => a.store_num);
      const { rows: names } = await pool.query(
        `SELECT store_num, store_name FROM survey_store_districts WHERE store_num = ANY($1::int[])`,
        [storeNums]
      );
      const labelBy = new Map(names.map((r) => [Number(r.store_num), r.store_name || `Store ${r.store_num}`]));
      const storeLabels = storeNums.map((n) => {
        const nm = labelBy.get(Number(n));
        return nm ? `${n} · ${nm}` : String(n);
      });
      const due = list.map((a) => a.due_at).filter(Boolean).sort()[0] || null;

      const { token, jti } = issueLinkToken(email);
      await pool.query(
        `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [email, jti, null, 'survey-assignment-invite']
      );
      const primary = storeNums[0];
      const returnTo = primary
        ? `https://the-dump-bin.com/survey/?store=${encodeURIComponent(primary)}`
        : 'https://the-dump-bin.com/survey/';
      const link = buildMagicLink(token, returnTo);

      const first = String(name).split(/\s+/)[0] || 'there';
      const subject = storeNums.length === 1
        ? `Survey assigned — Store ${storeNums[0]}`
        : `Survey assigned — ${storeNums.length} stores`;
      const dueLine = due
        ? `Please complete by <strong>${escapeHtml(String(due).slice(0, 10))}</strong>.`
        : 'Please complete as soon as you can.';
      const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1c2733;line-height:1.5;max-width:560px">
          <p>Hi ${escapeHtml(first)},</p>
          <p>You've been assigned the Division 701 in-store best practices survey for:</p>
          <ul>${storeLabels.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
          <p>${dueLine}</p>
          <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0f5c8c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Open survey</a></p>
          <p style="font-size:13px;color:#5a6b7d">This link signs you in automatically. On a phone, press and hold the button and choose Open in browser.</p>
        </div>`;
      const text = [
        `Hi ${first},`,
        '',
        `You've been assigned the Division 701 survey for: ${storeLabels.join(', ')}.`,
        due ? `Due by ${String(due).slice(0, 10)}.` : '',
        '',
        `Open: ${link}`,
      ].filter(Boolean).join('\n');

      const send = getEmailSender();
      if (!send) throw new Error('Email sender not configured');
      await send(
        {
          sourceSystem: 'survey',
          sourceType: 'survey-assignment-invite',
          sourceRef: list.map((a) => a.id).join(','),
        },
        {
          to: email,
          subject,
          html,
          text,
          from: retailOdysseyFrom('Retail Odyssey Survey'),
        }
      );

      await pool.query(
        `UPDATE survey_assignments SET invite_sent_at = now(), updated_at = now()
          WHERE id = ANY($1::int[])`,
        [list.map((a) => a.id)]
      );
      results.push({ email, ok: true, stores: storeNums });
    } catch (err) {
      results.push({ email, ok: false, error: err.message });
    }
  }
  return results;
}

async function getAlertPrefs(email) {
  const { rows } = await pool.query(
    `SELECT email, notify_on_submit, notify_on_due_soon, notify_weekly_digest, districts, updated_at
       FROM survey_alert_prefs WHERE email = $1`,
    [String(email).toLowerCase()]
  );
  if (rows[0]) return rows[0];
  return {
    email: String(email).toLowerCase(),
    notify_on_submit: true,
    notify_on_due_soon: true,
    notify_weekly_digest: false,
    districts: [],
    updated_at: null,
  };
}

async function upsertAlertPrefs(email, body = {}) {
  const prefs = {
    notify_on_submit: body.notifyOnSubmit !== false && body.notify_on_submit !== false,
    notify_on_due_soon: body.notifyOnDueSoon !== false && body.notify_on_due_soon !== false,
    notify_weekly_digest: !!(body.notifyWeeklyDigest || body.notify_weekly_digest),
    districts: Array.isArray(body.districts) ? body.districts.map(String) : [],
  };
  const { rows } = await pool.query(
    `INSERT INTO survey_alert_prefs
       (email, notify_on_submit, notify_on_due_soon, notify_weekly_digest, districts, updated_at)
     VALUES ($1,$2,$3,$4,$5::text[], now())
     ON CONFLICT (email) DO UPDATE SET
       notify_on_submit = EXCLUDED.notify_on_submit,
       notify_on_due_soon = EXCLUDED.notify_on_due_soon,
       notify_weekly_digest = EXCLUDED.notify_weekly_digest,
       districts = EXCLUDED.districts,
       updated_at = now()
     RETURNING *`,
    [
      String(email).toLowerCase(),
      prefs.notify_on_submit,
      prefs.notify_on_due_soon,
      prefs.notify_weekly_digest,
      prefs.districts,
    ]
  );
  return rows[0];
}

async function processDueReminders() {
  const { rows } = await pool.query(
    `SELECT rem.id AS reminder_id, rem.remind_at, a.id AS assignment_id,
            a.store_num, a.assignee_email, a.due_at, ro.name AS assignee_name
       FROM survey_assignment_reminders rem
       JOIN survey_assignments a ON a.id = rem.assignment_id
       JOIN survey_roster ro ON ro.email = a.assignee_email
      WHERE rem.sent_at IS NULL
        AND rem.remind_at <= now()
        AND a.status = 'open'
      ORDER BY rem.remind_at
      LIMIT 40`
  );
  const results = [];
  for (const row of rows) {
    try {
      const { token, jti } = issueLinkToken(row.assignee_email);
      await pool.query(
        `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1,$2,$3,$4)`,
        [row.assignee_email, jti, null, 'survey-assignment-reminder']
      );
      const link = buildMagicLink(token, `https://the-dump-bin.com/survey/?store=${row.store_num}`);
      const first = String(row.assignee_name || '').split(/\s+/)[0] || 'there';
      const send = getEmailSender();
      if (send) {
        await send(
          {
            sourceSystem: 'survey',
            sourceType: 'survey-assignment-reminder',
            sourceRef: String(row.assignment_id),
          },
          {
            to: row.assignee_email,
            subject: `Reminder — survey due for store ${row.store_num}`,
            html: `<p>Hi ${escapeHtml(first)},</p><p>Friendly reminder: your Division 701 survey for store <strong>${row.store_num}</strong>${row.due_at ? ` is due <strong>${escapeHtml(String(row.due_at).slice(0, 10))}</strong>` : ''}.</p><p><a href="${escapeHtml(link)}">Open survey</a></p>`,
            text: `Reminder: complete the survey for store ${row.store_num}. ${link}`,
            from: retailOdysseyFrom('Retail Odyssey Survey'),
          }
        );
      }
      await pool.query(`UPDATE survey_assignment_reminders SET sent_at = now() WHERE id = $1`, [row.reminder_id]);
      results.push({ id: row.reminder_id, ok: true });
    } catch (err) {
      results.push({ id: row.reminder_id, ok: false, error: err.message });
    }
  }
  return results;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'store';
}

function photoFileName({ storeNum, storeName, questionId, respondent, photoId, mime }) {
  const ext = /png/i.test(mime || '') ? 'png' : (/webp/i.test(mime || '') ? 'webp' : 'jpg');
  const who = String(respondent || 'user').split('@')[0].replace(/[^a-z0-9._-]+/gi, '-').slice(0, 24);
  return `FM${storeNum}_${slugify(storeName)}_Q${questionId}_${who}_${photoId}.${ext}`;
}

module.exports = {
  resolveSurveyAdminScope,
  applyScopeToFilters,
  requireSurveyAdmin,
  isDivisionAdmin,
  buildCoverage,
  searchRoster,
  listTeams,
  ensureRosterEmails,
  createAssignments,
  sendAssignmentInvites,
  getAlertPrefs,
  upsertAlertPrefs,
  processDueReminders,
  photoFileName,
  slugify,
};
