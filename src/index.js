const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Resend } = require('resend');
const { requireAuth, requireRole, AUTH_MODE } = require('./auth-middleware');
const { pool, runMigrations } = require('./lib/db');
const sasBridge = require('./sas-bridge');
const sasAutoRefresh = require('./sas-auto-refresh');
const reboticsBridge = require('./rebotics-bridge');
const shiftManagement = require('./shift-management');
const storeConfirmation = require('./store-confirmation');
const extensionBridge = require('./extension-bridge');
const { createInstaworkRouter } = require('./instawork-router');
const { createAiRouter } = require('./ai-router');
const { runFullSync } = require('./sas-sync');
const { addReplyTo } = require('./lib/resend-reply-to');
const { CHECKLANES_FROM } = require('./lib/checklanes-email');
const {
  resolveHelpdeskRouting,
  buildHelpdeskFromAddress,
  buildHelpdeskSubject,
  buildHelpdeskHtml,
  buildHelpdeskAttachments,
  enforceAttachmentBudget,
  MAX_HELPDESK_PHOTOS,
  MAX_HELPDESK_DOCUMENTS,
} = require('./lib/helpdesk-email');

// New email-link + admin routes (Phase A of the Cloudflare Access removal).
// These are wired in unconditionally so they exist even while AUTH_MODE is
// still 'cf-access' -- the global gate below makes their paths public so they
// work without a CF Access JWT.
const requestLinkRouter = require('./routes/request-link');
const verifyTokenRouter = require('./routes/verify-token');
const adminSessionRouter = require('./routes/admin-session');
const adminAllowedEmailsRouter = require('./routes/admin-allowed-emails');
const adminAdminsRouter = require('./routes/admin-admins');
const accessRequestRouter = require('./routes/access-request');
const accessRequestDecisionRouter = require('./routes/access-request-decision');
const { identityHandler } = require('./routes/_identity');
const whoamiRouter = require('./routes/whoami');
const weeksRouter = require('./routes/weeks');
const createDecideRouter = require('./routes/decide');
const createDumpBinRouter = require('./routes/dump-bin');
const hubRoutes = require('./routes/hub-routes');
const hubStoreRoutes = require('./routes/hub-store-routes');
const { initHubBackup, startBackupIntervalJob } = require('./hub-backup');
const { initHubTagBatch } = require('./hub-tag-batch');
const { initHubNotify } = require('./hub-notify');

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

const resend = new Resend(process.env.RESEND_API_KEY);
const PORT = process.env.PORT || 3001;

// `pool` is the shared connection pool from ./lib/db. We re-export the same
// instance throughout the app so we never end up with two pools fighting over
// the same connection limit. New auth code (lib/db.js, lib/site-admin.js,
// routes/*) imports it directly; legacy code receives it via the sub-module
// init signatures below.

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_data (
      store_number TEXT PRIMARY KEY,
      manager_names JSONB DEFAULT '[]',
      recipient_emails JSONB DEFAULT '[]',
      fredmeyer_emails JSONB DEFAULT '[]'
    )
  `);

  // Non-destructive migration: add fredmeyer_emails if the table already exists
  await pool.query(`
    ALTER TABLE store_data ADD COLUMN IF NOT EXISTS fredmeyer_emails JSONB DEFAULT '[]'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      sas_employee_id INTEGER UNIQUE NOT NULL,
      workday_id TEXT,
      name TEXT NOT NULL,
      preferred_name TEXT,
      title TEXT,
      phone TEXT,
      email TEXT,
      supervisor_id TEXT,
      supervisor_name TEXT,
      department_code TEXT,
      employee_type TEXT,
      date_of_hire DATE,
      termination_date DATE,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      visit_id INTEGER NOT NULL,
      visit_id_full TEXT,
      cycle_id INTEGER,
      store_number INTEGER,
      store_name TEXT,
      project_name TEXT,
      project_id INTEGER,
      scheduled_date DATE NOT NULL,
      shift_start_time TEXT,
      shift_end_time TEXT,
      total_hours TEXT,
      current_status TEXT,
      visit_lead TEXT,
      supervisor TEXT,
      emp_count INTEGER DEFAULT 0,
      no_show_count INTEGER DEFAULT 0,
      due_by DATE,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(visit_id, scheduled_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      store_number INTEGER UNIQUE NOT NULL,
      name TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getStoreData(storeNumber) {
  const { rows } = await pool.query(
    'SELECT * FROM store_data WHERE store_number = $1',
    [storeNumber]
  );
  if (!rows.length) return { managerNames: [], recipientEmails: [], fredmeyerEmails: [] };
  return {
    managerNames: rows[0].manager_names ?? [],
    recipientEmails: rows[0].recipient_emails ?? [],
    fredmeyerEmails: rows[0].fredmeyer_emails ?? [],
  };
}

async function upsertStoreData(storeNumber, {
  managerNames = [],
  recipientEmails = [],
  fredmeyerEmails = [],
} = {}) {
  const existing = await getStoreData(storeNumber);
  const mergedManagers = [...new Set([...existing.managerNames, ...managerNames.filter(Boolean)])];
  const mergedEmails = [...new Set([...existing.recipientEmails, ...recipientEmails.filter(Boolean)])];
  const mergedFredmeyer = [...new Set([...existing.fredmeyerEmails, ...fredmeyerEmails.filter(Boolean)])];
  await pool.query(
    `INSERT INTO store_data (store_number, manager_names, recipient_emails, fredmeyer_emails)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_number) DO UPDATE
       SET manager_names   = $2,
           recipient_emails = $3,
           fredmeyer_emails = $4`,
    [storeNumber, JSON.stringify(mergedManagers), JSON.stringify(mergedEmails), JSON.stringify(mergedFredmeyer)]
  );
  return { managerNames: mergedManagers, recipientEmails: mergedEmails, fredmeyerEmails: mergedFredmeyer };
}

async function removeFromStoreData(storeNumber, { managerName, fredmeyerEmail } = {}) {
  const existing = await getStoreData(storeNumber);
  const managerNames = managerName
    ? existing.managerNames.filter((n) => n !== managerName)
    : existing.managerNames;
  const fredmeyerEmails = fredmeyerEmail
    ? existing.fredmeyerEmails.filter((e) => e !== fredmeyerEmail)
    : existing.fredmeyerEmails;
  await pool.query(
    `UPDATE store_data SET manager_names = $2, fredmeyer_emails = $3 WHERE store_number = $1`,
    [storeNumber, JSON.stringify(managerNames), JSON.stringify(fredmeyerEmails)]
  );
  return { managerNames, recipientEmails: existing.recipientEmails, fredmeyerEmails };
}

function buildFromAddress(storeNumber) {
  return `EOD_FM${String(storeNumber).padStart(3, '0')}@retail-odyssey.com`;
}

function buildHtml({ body, signoffPhotos, userName, userEmail }) {
  const hasPhotos = Array.isArray(signoffPhotos) && signoffPhotos.length > 0;

  const photoSection = hasPhotos
    ? `<h3 style="font-family:sans-serif;">Sign-Off Sheets</h3>
${signoffPhotos
  .map(
    (_, i) =>
      `<img src="cid:signoff_${i}" style="max-width:100%; margin-bottom:12px; display:block;">`
  )
  .join('\n')}`
    : '';

  const signature =
    userName || userEmail
      ? `<hr>
<p style="font-size:13px; color:#555; font-family:sans-serif;">
  ${userName ?? ''}<br>
  Retail Odyssey<br>
  ${userEmail ?? ''}
</p>`
      : '';

  return `<!DOCTYPE html>
<html>
<body>
${photoSection}
<pre style="font-family:sans-serif; white-space:pre-wrap; word-break:break-word;">${body}</pre>
${signature}
</body>
</html>`;
}

async function start() {
  await initDb();
  logger.info('Database initialized');

  // Idempotent schema migrations for the new email-link / admin auth stack.
  // Safe to run on every boot -- schema_migrations tracks which files have
  // already been applied.
  try {
    await runMigrations();
    logger.info('Auth migrations applied');
  } catch (err) {
    logger.error('Auth migrations failed:', err.message);
    throw err;
  }
  logger.info(`Auth mode: ${AUTH_MODE}`);

  initHubBackup({ resend });
  initHubTagBatch({ resend });
  initHubNotify({ resend });
  startBackupIntervalJob();

  const app = express();

  // Railway sits behind a proxy; trust the X-Forwarded-* headers so req.ip
  // and express-rate-limit keys reflect the real client IP. Required by the
  // /api/request-link + /api/access-request rate limiters.
  app.set('trust proxy', 1);

  // Approve/deny links in email open on the API host; the browser sends
  // Origin: https://eod-api.the-dump-bin.com, which is not in ALLOWED_ORIGINS.
  // These routes are direct GET/POST (not cross-origin XHR), so they must be
  // registered before the global cors() middleware.
  app.use('/api/access-requests', accessRequestDecisionRouter);

  // Cloudflare Access fronts both the-dump-bin.com (frontend) and
  // eod-api.the-dump-bin.com (this API). Cookies are scoped to the parent
  // zone, so we just need to echo the origin and allow credentials.
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://the-dump-bin.com,https://checklanes.the-dump-bin.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // server-to-server / curl
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} not allowed`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // ─── GLOBAL AUTH GATE ───────────────────────────────────────────────────────
  const PUBLIC_PATHS = [
    '/sas-session',
    '/sas-session/status',
    '/rebotics-auth-update',
    '/rebotics-token-internal',
    '/api/auth-status',
    // Extension distribution: /extension/publish gates itself on
    // SAS_AUTH_SECRET, /extension/manifest + /extension/download are
    // intentionally public (the bundle has no secrets).
    '/extension/manifest',
    '/extension/download',
    '/extension/publish',
    // Email-link / admin auth surface (Phase A migration off Cloudflare Access).
    // These endpoints ARE the sign-in flow, so they cannot themselves require
    // a session. They self-protect: /api/admin/* uses requireAdmin internally,
    // request-link/access-request are rate-limited + allowlist-checked, and
    // /api/verify-token only honors single-use JWTs signed by JWT_SECRET.
    '/api/request-link',
    '/api/verify-token',
    // Dump bin file GET: session Bearer OR short-lived ?t= JWT (typ dump_dl).
    '/api/download',
  ];
  const PUBLIC_PREFIXES = [
    '/api/shift-request/',
    '/extension/download/',
    // Whole /api/admin/* surface is public to the global gate (each subroute
    // applies requireAdmin from lib/admin-auth.js where needed).
    '/api/admin/',
    // Self-serve access request submission and approve/deny landing URLs.
    '/api/access-request',
    '/api/access-requests/',
    // Supervisor decide.html → read + POST decision (JWT in query/body).
    '/api/decide',
  ];
  const PUBLIC_REGEXES = [
    /^\/api\/signoff-photos\/[^\/]+\/image\/?$/,
    // /status for store-confirm still requires auth (not under shift prefix alone)
  ];
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.includes(req.path)) return next();
    if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();
    if (PUBLIC_REGEXES.some(r => r.test(req.path))) return next();
    return requireAuth(req, res, next);
  });

  // ─── NEW AUTH ROUTERS ──────────────────────────────────────────────────────
  // Mounted AFTER the global gate (which whitelisted them above), BEFORE any
  // gated business route, so they're reachable without a CF Access JWT or a
  // session token. The trailing slash on /api/access-requests vs the bare
  // /api/access-request matches district6 -- distinct subtrees.
  app.use('/api/request-link', requestLinkRouter);
  app.use('/api/verify-token', verifyTokenRouter);
  app.use('/api/admin/session', adminSessionRouter);
  app.use('/api/admin/allowed-emails', adminAllowedEmailsRouter);
  app.use('/api/admin/admins', adminAdminsRouter);
  app.use('/api/access-request', accessRequestRouter);
  app.use('/api/whoami', whoamiRouter);
  app.use('/api/weeks', weeksRouter);
  app.use('/api/hub', hubStoreRoutes);
  app.use('/api/hub', hubRoutes);
  app.use('/api/decide', createDecideRouter({ resend }));
  const dumpBinRouter = createDumpBinRouter({ resend, logger });
  app.use('/api', dumpBinRouter);

  // Initialize SAS bridge (session receiver, upload queue, worker)
  await sasBridge.init(app, pool);

  await reboticsBridge.init(app, pool, { resend });

  // Extension distribution endpoints (publish from personal computer,
  // download onto the office USB stick).
  await extensionBridge.init(app, pool);

  app.get('/api/me', requireAuth, identityHandler);

  // Initialize shift management endpoints
  await shiftManagement.initShiftRequestsTable(pool);
  shiftManagement.registerRoutes(app, resend, pool);

  // Initialize daily store confirmation gate (verify-store + override flow)
  await storeConfirmation.initStoreConfirmRequestsTable(pool);
  storeConfirmation.registerRoutes(app, resend, pool);

  // /instawork/save-image mutates the InstaWork sign-out artifact, so it
  // must carry a valid day-confirm token. /instawork/health stays open for
  // simple connectivity checks.
  app.use(
    '/instawork',
    createInstaworkRouter({
      resend,
      logger,
      saveImageGate: storeConfirmation.requireDayConfirm,
    })
  );

  // AI chat proxy for the SAS extension side panel. Auth is the global
  // requireAuth gate above (Cloudflare Access JWT, forwarded by the
  // extension from the CF_Authorization cookie).
  app.use('/api/ai', createAiRouter({ logger }));

  // ─── SYNC ROUTES ───────────────────────────────────────────────────────────
  app.post('/api/sync/run', requireRole('supervisor', 'admin'), async (req, res) => {

    try {
      const result = await runFullSync(pool);
      return res.json(result);
    } catch (err) {
      logger.error('Manual sync failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── 2AM CRON ──────────────────────────────────────────────────────────────
  cron.schedule('0 2 * * *', async () => {
    logger.info('2am cron triggered — starting sync...');
    try {
      const result = await runFullSync(pool);
      logger.info('2am sync result:', JSON.stringify(result));
    } catch (err) {
      logger.error('2am sync failed:', err.message);
    }
  }, {
    timezone: 'America/Los_Angeles',
  });

  logger.info('2am sync cron scheduled (America/Los_Angeles)');

  // ─── SAS AUTO-REFRESH CRON ─────────────────────────────────────────────────
  //
  // Re-mint the SAS session every 4 hours regardless of user activity.
  // SAS sessions are good for ~24h, so 4-hour cadence gives us plenty of
  // headroom while leaving long quiet windows where Tyson can use his
  // TOTP code on other devices without colliding with the server.  The
  // single-flight + 4h cooldown guard inside sas-auto-refresh deduplicates
  // any overlap between this cron and a stale-poll-driven kick.
  if (sasAutoRefresh.isConfigured()) {
    cron.schedule('0 */4 * * *', async () => {
      try {
        const result = await sasAutoRefresh.runAutoRefresh({ reason: 'cron:4h' });
        if (!result.ok && !result.skipped) {
          logger.error('4h SAS refresh failed:', result.error);
        }
      } catch (err) {
        logger.error('4h SAS refresh threw:', err.message);
      }
    }, { timezone: 'America/Los_Angeles' });
    logger.info('4-hour SAS auto-refresh cron scheduled (America/Los_Angeles)');

    // Run one refresh shortly after boot so a cold-started Railway instance
    // doesn't leave the SAS dot red until the next 4-hour tick.  Defer slightly so
    // the listener is up first and we don't hold the boot path on Okta.
    setTimeout(() => {
      sasAutoRefresh.runAutoRefresh({ reason: 'startup', force: true })
        .then((r) => logger.info('Startup SAS refresh:', JSON.stringify(r)))
        .catch((err) => logger.error('Startup SAS refresh threw:', err.message));
    }, 3000);
  } else {
    logger.info(
      `SAS auto-refresh DISABLED (missing ${sasAutoRefresh.missingEnvVars().join(', ')}). ` +
      'Falling back to external morning-auth.js + GH Actions cron.'
    );
  }

  // ─── Auth Status Notification ────────────────────────────────────────────────

  app.post('/api/auth-status', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.SAS_AUTH_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { status, error, time } = req.body;
    const subject = status === 'success'
      ? `SAS Auth ✓ — ${new Date(time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`
      : `SAS Auth FAILED — ${new Date(time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`;

    const html = status === 'success'
      ? `<p>Morning auth completed successfully at ${time}.</p><p>SAS session has been refreshed.</p>`
      : `<p>Morning auth <strong>failed</strong> at ${time}.</p><p><strong>Error:</strong> ${error || 'Unknown'}</p><p>The SAS session was NOT refreshed. Manual intervention may be required.</p>`;

    try {
      const authStatusPayload = {
        from: 'EOD System <noreply@retail-odyssey.com>',
        to: 'tyson.gauthier@retailodyssey.com',
        subject,
        html,
      };
      addReplyTo(authStatusPayload, {});
      await resend.emails.send(authStatusPayload);
      console.log(`[auth-status] ${status} notification email sent`);
      return res.json({ success: true, notified: true });
    } catch (err) {
      console.error(`[auth-status] Failed to send email: ${err.message}`);
      return res.json({ success: true, notified: false, emailError: err.message });
    }
  });

  // ─── Trigger SAS Auth ────────────────────────────────────────────────────────
  //
  // Any signed-in user can hit this — there's no role gate.  The auto-refresh
  // module's single-flight + cooldown guard makes it safe to call as often as
  // anyone wants; back-to-back calls coalesce into one Okta login.
  //
  // Preferred path: the in-process auto-refresher logs in directly using
  // SAS_USER / SAS_PASS / SAS_TOTP_SECRET on Railway.  This is what
  // /sas-auth-status also kicks lazily on every stale poll.
  //
  // Legacy fallback: if those secrets aren't configured (e.g. on a fresh
  // deploy that hasn't been wired up yet), dispatch the GitHub Actions
  // workflow_dispatch as before.  This keeps the endpoint working during a
  // staged rollout.

  app.post('/api/trigger-auth', async (req, res) => {
    if (sasAutoRefresh.isConfigured()) {
      try {
        const result = await sasAutoRefresh.runAutoRefresh({
          reason: 'manual:/api/trigger-auth',
          force: req.query.force === '1',
        });
        if (result.skipped) {
          return res.json({
            success: true,
            message: `Refresh skipped (${result.reason}). Existing session is still valid.`,
            ...result,
          });
        }
        if (result.ok) {
          return res.json({
            success: true,
            message: `Session refreshed in-process (${result.elapsed_ms}ms).`,
          });
        }
        return res.status(502).json({ success: false, error: result.error });
      } catch (err) {
        console.error('[trigger-auth] In-process refresh threw:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Fallback path: dispatch the GH Actions workflow.
    const githubPat = process.env.GITHUB_PAT;
    if (!githubPat) {
      console.error('[trigger-auth] In-process refresh not configured AND GITHUB_PAT missing');
      return res.status(500).json({
        error: 'Auth trigger not configured',
        hint: 'Set SAS_USER + SAS_PASS + SAS_TOTP_SECRET on Railway to enable in-process refresh',
      });
    }

    try {
      const resp = await fetch('https://api.github.com/repos/d6ewasupervisor-netizen/sas-auth/actions/workflows/daily-auth.yml/dispatches', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubPat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      });

      if (resp.status === 204) {
        return res.json({ success: true, message: 'Auth workflow triggered (legacy GH Actions path). Session will be active within ~60 seconds.' });
      }
      const body = await resp.text();
      console.error(`[trigger-auth] GitHub API returned ${resp.status}: ${body}`);
      return res.status(resp.status).json({ error: `GitHub API error: ${resp.status}`, details: body });
    } catch (err) {
      console.error('[trigger-auth] Failed to trigger workflow:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/send-eod', storeConfirmation.requireDayConfirm, async (req, res) => {
    const {
      storeNumber,
      subject,
      body,
      recipients,
      pdfBase64,
      pdfFilename,
      userName,
      userEmail,
      signoffPhotos,
      checkInManager,
      checkOutManager,
    } = req.body;

    if (!storeNumber || !subject || !body || !recipients?.length) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: storeNumber, subject, body, recipients',
      });
    }

    const from = buildFromAddress(storeNumber);
    const attachments = [];

    if (pdfBase64) {
      attachments.push({
        filename: pdfFilename || `EOD_Store${storeNumber}.pdf`,
        content: pdfBase64,
      });
    }

    if (Array.isArray(signoffPhotos)) {
      signoffPhotos.forEach((photo, i) => {
        const match = photo.match(/^data:(image\/\w+);base64,/);
        const contentType = match ? match[1] : 'image/jpeg';
        const ext = contentType.split('/')[1] || 'jpg';
        const rawBase64 = photo.replace(/^data:image\/\w+;base64,/, '');
        attachments.push({
          filename: `signoff_${i}.${ext}`,
          content: rawBase64,
          contentId: `signoff_${i}`,
          content_type: contentType,
        });
      });
    }

    const html = buildHtml({ body, signoffPhotos, userName, userEmail });

    const emailPayload = {
      from,
      to: Array.isArray(recipients) ? recipients : [recipients],
      subject,
      html,
      attachments,
    };

    addReplyTo(emailPayload, { userEmail });

    try {
      const { data, error } = await resend.emails.send(emailPayload);

      if (error) {
        logger.error({ error, storeNumber }, 'Resend API error sending EOD email');
        return res.status(502).json({ success: false, error: error.message ?? String(error) });
      }

      logger.info({ id: data?.id, storeNumber, from }, 'EOD email sent');

      logger.info('Attempting store data upsert for store:', storeNumber);
      try {
        const allRecipients = Array.isArray(recipients) ? recipients : [];
        // Only save canonical @stores.fredmeyer.com addresses to the pool.
        const fredmeyerEmails = allRecipients.filter(
          (e) => typeof e === 'string' && e.toLowerCase().endsWith('@stores.fredmeyer.com')
        );
        await upsertStoreData(storeNumber, {
          managerNames: [checkInManager, checkOutManager].filter(Boolean),
          fredmeyerEmails,
        });
        logger.info('Store data upserted successfully for store:', storeNumber);
      } catch (err) {
        logger.error('Store data upsert failed:', err.message);
      }

      return res.json({ success: true, id: data?.id });
    } catch (err) {
      logger.error({ err, storeNumber }, 'Unexpected error sending EOD email');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── KOMPASS Help Desk ticket email ────────────────────────────────────────
  // Sends a structured issue report to kompass@retailodyssey.com.
  // From address: FM###_C###@retail-odyssey.com
  // Reply-To: lead email (Alexandra Wright → personal alias)
  // CC: fixed team + shift lead + submitter (deduped)
  app.post('/send-helpdesk-ticket', storeConfirmation.requireDayConfirm, async (req, res) => {
    const {
      storeNumber,
      storeName,
      workDate,
      categoryNumber,
      categoryName,
      dbkey,
      version,
      source,
      issueTypeId,
      issueTypeLabel,
      issueTemplateSentence,
      issueDetails,
      measurements,
      additionalNotes,
      photos,
      photoCaptions,
      documents,
      userName,
      userEmail,
      shiftLeadEmail,
      leadEmail,
    } = req.body;

    // Required fields
    if (!storeNumber || !categoryNumber || !issueTypeId || !issueTypeLabel) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: storeNumber, categoryNumber, issueTypeId, issueTypeLabel',
      });
    }
    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one photo is required.',
      });
    }
    if (source === 'manual' && !dbkey && !version) {
      return res.status(400).json({
        success: false,
        error: 'For manually entered categories, at least one of dbkey or version is required.',
      });
    }
    if (photos.length > MAX_HELPDESK_PHOTOS) {
      return res.status(400).json({
        success: false,
        error: `Maximum ${MAX_HELPDESK_PHOTOS} photos per ticket.`,
      });
    }

    const docList = Array.isArray(documents) ? documents : [];
    if (docList.length > MAX_HELPDESK_DOCUMENTS) {
      return res.status(400).json({
        success: false,
        error: `Maximum ${MAX_HELPDESK_DOCUMENTS} documents per ticket.`,
      });
    }

    const from = dbkey
      ? CHECKLANES_FROM
      : buildHelpdeskFromAddress(storeNumber, categoryNumber);
    const routing = resolveHelpdeskRouting({
      userName,
      userEmail,
      shiftLeadEmail: shiftLeadEmail || leadEmail,
    });
    const replyTo = routing.replyTo;
    const cc = routing.cc;
    const subject = buildHelpdeskSubject({
      storeNumber,
      categoryNumber,
      dbkey,
      version,
      issueLabel: issueTypeLabel,
    });

    let attachments;
    try {
      attachments = buildHelpdeskAttachments(photos, docList);
    } catch (attachErr) {
      const status = attachErr.statusCode || 400;
      return res.status(status).json({ success: false, error: attachErr.message });
    }

    try {
      enforceAttachmentBudget(attachments);
    } catch (sizeErr) {
      return res.status(413).json({ success: false, error: sizeErr.message });
    }

    const documentNames = docList.map((doc, i) => {
      const name = doc?.name ? String(doc.name).trim() : '';
      return name || `document_${i + 1}`;
    });

    const html = buildHelpdeskHtml({
      storeName,
      storeNumber,
      workDate,
      userName,
      userEmail,
      categoryName,
      categoryNumber,
      dbkey,
      version,
      issueTypeLabel,
      issueTemplateSentence,
      issueDetails,
      measurements,
      additionalNotes,
      photoCount: photos.length,
      photoCaptions,
      documentNames,
    });

    const emailPayload = {
      from,
      to: [routing.to],
      cc,
      subject,
      html,
      attachments,
    };
    addReplyTo(emailPayload, { explicit: replyTo, userEmail });

    try {
      const { data, error } = await resend.emails.send(emailPayload);
      if (error) {
        logger.error({ error, storeNumber, categoryNumber }, 'Resend error sending helpdesk ticket');
        return res.status(502).json({ success: false, error: error.message ?? String(error) });
      }
      logger.info({ id: data?.id, storeNumber, categoryNumber, from }, 'Help desk ticket sent');
      return res.json({ success: true, id: data?.id });
    } catch (err) {
      logger.error({ err, storeNumber }, 'Unexpected error sending helpdesk ticket');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/store-data/:storeNumber', async (req, res) => {
    try {
      const data = await getStoreData(req.params.storeNumber);
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error fetching store data');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/store-data/:storeNumber', async (req, res) => {
    const { managerNames, recipientEmails, fredmeyerEmails } = req.body;
    try {
      const data = await upsertStoreData(req.params.storeNumber, {
        managerNames,
        recipientEmails,
        fredmeyerEmails,
      });
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error upserting store data');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/store-data/:storeNumber/manager-name', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    try {
      const data = await removeFromStoreData(req.params.storeNumber, { managerName: name });
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error removing manager name');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/store-data/:storeNumber/fredmeyer-email', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email is required' });
    try {
      const data = await removeFromStoreData(req.params.storeNumber, { fredmeyerEmail: email });
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error removing fredmeyer email');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.listen(PORT, () => {
    logger.info(`EOD API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start EOD API');
  process.exit(1);
});