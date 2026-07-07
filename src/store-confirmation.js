/**
 * Daily Store Confirmation Gate
 * ────────────────────────────────────────────────────────────────────────────
 * Forces every EOD lead to re-confirm which store they're at the start of
 * each shift. Mints a short-lived signed `dayConfirm` token bound to
 * (email, store, workDate). The token must accompany /send-eod and
 * /instawork/save-image via the X-Day-Confirm header.
 *
 * Roster check uses the locally-synced `schedules` + `employees` tables (see
 * sas-sync.js / index.js). When that row is older than ~12h we fall through
 * to a live SAS call so a stale sync doesn't strand a real lead.
 *
 * Off-roster leads can request a one-click email override from the
 * supervisor — same APPROVE/DENY pattern as src/shift-management.js.
 *
 * Routes:
 *   POST /api/verify-store                       — issue token if eligible
 *   POST /api/store-confirm-request              — kick off override email
 *   GET  /api/store-confirm-request/:id/status   — SPA polls until resolved
 *   Supervisors approve/deny via the-dump-bin decide.html → POST /api/decide
 *
 * Middleware:
 *   requireDayConfirm — gates routes that mutate EOD state
 */

const crypto = require('crypto');
const { addReplyTo } = require('./lib/resend-reply-to');
const { dispatchTrackedEmail } = require('./lib/resend-outbox');
const { issueReviewToken } = require('./lib/decision-review-jwt');
const { sasGet, isSessionAlive } = require('./sas-bridge');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

// Token lifetime covers next-day completion of yesterday's EOD (a real-world
// pattern — close out paperwork the morning after the shift).
const TOKEN_TTL_MS = 36 * 60 * 60 * 1000; // 36h

// Re-fetch a fresh roster from SAS if the local cache is older than this.
const SCHEDULES_STALE_MS = 12 * 60 * 60 * 1000; // 12h

// How long an override request stays open before auto-expiring.
const REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

const DUMP_BIN_SITE = (process.env.DUMP_BIN_SITE || 'https://the-dump-bin.com').replace(/\/$/, '');

// Supervisor receives override requests. Falls back to the same address used
// by shift-management.js so behaviour stays consistent across the API.
const OVERRIDE_APPROVER_EMAIL =
  process.env.OVERRIDE_APPROVER_EMAIL ||
  process.env.SHIFT_REQUEST_APPROVER_EMAIL ||
  'tyson.gauthier@retailodyssey.com';

const { retailOdysseyFrom } = require('./lib/email-from');
const OVERRIDE_FROM_ADDRESS =
  process.env.OVERRIDE_FROM_ADDRESS || retailOdysseyFrom('Retail Odyssey Shifts');

const SAS_CUSTOMER_ID = 2;
const SAS_PROGRAM_ID = 1;

const logger = {
  info: (...a) => console.log('[store-confirm]', ...a),
  warn: (...a) => console.warn('[store-confirm]', ...a),
  error: (...a) => console.error('[store-confirm]', ...a),
};

// ─── TOKEN SIGN / VERIFY ────────────────────────────────────────────────────

function getSecret() {
  const s = process.env.DAY_CONFIRM_SECRET;
  if (!s || s.length < 16) {
    // Don't crash boot — but make verify always fail loudly if unset.
    return null;
  }
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = 4 - (str.length % 4);
  const padded = pad === 4 ? str : str + '='.repeat(pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeStore(store) {
  // Strip leading zeros and any non-digits so 028 / "28" / 28 all match.
  return String(store || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

function normalizeDate(date) {
  // Accepts YYYY-MM-DD, MM/DD/YYYY, M/D/YY, etc. Returns YYYY-MM-DD or ''.
  const s = String(date || '').trim();
  if (!s) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (us) {
    const [, m, d, y] = us;
    const yyyy = y.length === 2 ? `20${y.padStart(2, '0')}` : y.padStart(4, '0');
    return `${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const fallback = new Date(s);
  if (!isNaN(fallback.getTime())) {
    const yyyy = fallback.getFullYear();
    const mm = String(fallback.getMonth() + 1).padStart(2, '0');
    const dd = String(fallback.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return '';
}

function signDayConfirm({ email, store, date }) {
  const secret = getSecret();
  if (!secret) {
    throw new Error('DAY_CONFIRM_SECRET is not configured');
  }
  const payload = {
    email: normalizeEmail(email),
    store: normalizeStore(store),
    date: normalizeDate(date),
    issuedAt: Date.now(),
  };
  if (!payload.email || !payload.store || !payload.date) {
    throw new Error('signDayConfirm requires email, store, and date');
  }
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

function verifyDayConfirm(token, { email, store, date }) {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: 'secret_missing' };
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = token.split('.', 2);
  let expected;
  try {
    expected = b64urlEncode(
      crypto.createHmac('sha256', secret).update(payloadB64).digest()
    );
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  // Constant-time compare to avoid token-recovery timing oracles.
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  if (Date.now() - Number(payload.issuedAt || 0) > TOKEN_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.email !== normalizeEmail(email)) {
    return { ok: false, reason: 'email_mismatch' };
  }
  if (payload.store !== normalizeStore(store)) {
    return { ok: false, reason: 'store_mismatch' };
  }
  if (payload.date !== normalizeDate(date)) {
    return { ok: false, reason: 'date_mismatch' };
  }
  return { ok: true, payload };
}

// ─── ROSTER LOOKUP ──────────────────────────────────────────────────────────

async function lookupRosterMatchLocal(pool, { email, store, date }) {
  const e = normalizeEmail(email);
  const s = normalizeStore(store);
  const d = normalizeDate(date);
  if (!e || !s || !d) return { matched: false, stale: false, hasRow: false };

  // Find any schedule row for that store/date and inspect freshness.
  const { rows } = await pool.query(
    `SELECT
       MAX(s.synced_at) AS latest_sync,
       BOOL_OR(
         LOWER(s.visit_lead) = LOWER(e.name)
         OR LOWER(s.visit_lead) = LOWER(e.preferred_name)
       ) AS matched
     FROM schedules s
     LEFT JOIN employees e
       ON LOWER(e.email) = $1
     WHERE CAST(s.store_number AS TEXT) = $2
       AND s.scheduled_date = $3::date`,
    [e, s, d]
  );

  const row = rows[0] || {};
  const latest = row.latest_sync ? new Date(row.latest_sync).getTime() : 0;
  const stale = !latest || Date.now() - latest > SCHEDULES_STALE_MS;
  return {
    matched: Boolean(row.matched),
    stale,
    hasRow: Boolean(latest),
  };
}

async function lookupRosterMatchSas(pool, { email, store, date }) {
  if (!isSessionAlive()) {
    return { matched: false, available: false };
  }
  const e = normalizeEmail(email);
  const s = normalizeStore(store);
  const d = normalizeDate(date);
  if (!e || !s || !d) return { matched: false, available: true };

  // Resolve store -> account_store_id (same flow as shift-management.js).
  let accountStoreId;
  try {
    const storeResp = await sasGet('/api/v1/projects/store-numbers/', {
      customer: SAS_CUSTOMER_ID,
      program: SAS_PROGRAM_ID,
      search: s,
      page: 1,
      page_size: 8,
    });
    const results = Array.isArray(storeResp.data)
      ? storeResp.data
      : storeResp.data?.results || [];
    const exact = results.find((r) => normalizeStore(r.store__number) === s);
    if (!exact) return { matched: false, available: true };
    accountStoreId = exact.store__id;
  } catch (err) {
    logger.warn(`SAS store lookup failed: ${err.message}`);
    return { matched: false, available: false };
  }

  // Fetch visits + visit-leads for that day at that store.
  let visits = [];
  try {
    const fieldResp = await sasGet('/api/v1/operations/field-data/', {
      account_store_id: accountStoreId,
      customer_id: SAS_CUSTOMER_ID,
      program_id: SAS_PROGRAM_ID,
      scheduled_dt_from: d,
      scheduled_dt_to: d,
      page: 1,
      page_size: 20,
      merchandiser: '',
      supervisor_id: '',
    });
    visits = Array.isArray(fieldResp.data)
      ? fieldResp.data
      : fieldResp.data?.results || [];
  } catch (err) {
    logger.warn(`SAS shift lookup failed: ${err.message}`);
    return { matched: false, available: false };
  }

  if (!visits.length) return { matched: false, available: true };

  // Map visit_lead names against the local employees table to find an email
  // match. Same join logic as the local query, just over a fresh visit list.
  const leadNames = [
    ...new Set(
      visits.map((v) => String(v.visit_lead || '').trim().toLowerCase()).filter(Boolean)
    ),
  ];
  if (!leadNames.length) return { matched: false, available: true };

  const { rows } = await pool.query(
    `SELECT 1
       FROM employees
      WHERE LOWER(email) = $1
        AND (LOWER(name) = ANY($2::text[]) OR LOWER(preferred_name) = ANY($2::text[]))
      LIMIT 1`,
    [e, leadNames]
  );
  return { matched: rows.length > 0, available: true };
}

async function isOnRoster(pool, { email, store, date }) {
  const local = await lookupRosterMatchLocal(pool, { email, store, date });
  if (local.matched) return { matched: true, source: 'local' };
  if (!local.stale && local.hasRow) {
    // Fresh sync, no match — trust it.
    return { matched: false, source: 'local' };
  }
  // Either no row or the row is stale; try SAS live.
  const sas = await lookupRosterMatchSas(pool, { email, store, date });
  if (sas.matched) return { matched: true, source: 'sas' };
  return {
    matched: false,
    source: sas.available ? 'sas' : 'local-stale',
  };
}

// ─── EMAIL TEMPLATES ────────────────────────────────────────────────────────

function buildOverrideApprovalEmail(request) {
  const { requestId, storeNumber, date, requestedBy, reason, reviewUrl } = request;

  const reasonHtml = reason
    ? `<p><strong>Reason given:</strong></p><blockquote style="margin:8px 0 16px 0;padding:8px 12px;border-left:3px solid #88c4ed;background:#f3f4f6;">${escapeHtml(reason)}</blockquote>`
    : '<p style="color:#6b7280;"><em>No reason provided.</em></p>';

  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px;color:#111827;">
<h2>Store Confirmation Override — Store #${escapeHtml(storeNumber)} ${escapeHtml(date)}</h2>
<p><strong>Requested by:</strong> ${escapeHtml(requestedBy)}</p>
<p><strong>Store:</strong> #${escapeHtml(storeNumber)}</p>
<p><strong>Work date:</strong> ${escapeHtml(date)}</p>
${reasonHtml}
<p style="color:#6b7280;font-size:13px;">This lead does not appear on today's SAS roster for that store. Approving will let them submit an EOD for store #${escapeHtml(storeNumber)} on ${escapeHtml(date)}. The override is good for ~36 hours.</p>
<p style="color:#374151;font-size:14px;margin-top:16px;">Open the review page to approve or deny — email scanners will not change the request.</p>
<div style="margin-top:24px;">
  <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:14px 28px;background:#0d4f8b;color:white;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;">Review request</a>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail(resend, { to, subject, html, userEmail }) {
  if (!resend) {
    logger.warn('Resend not configured — skipping override approval email');
    return null;
  }
  const payload = {
    from: OVERRIDE_FROM_ADDRESS,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  addReplyTo(payload, { userEmail });
  const { data, error } = await dispatchTrackedEmail(resend, {
    sourceType: 'store-override-request',
    sentByEmail: userEmail,
    metadata: { to: Array.isArray(to) ? to : [to], subject },
  }, payload);
  if (error) {
    logger.error('Email send failed:', error);
    throw new Error(error.message || String(error));
  }
  logger.info(`Override email sent: ${data?.id} to ${to}`);
  return data;
}

/**
 * Supervisor decision for store confirmation override (POST /api/decide).
 * @param {'approved'|'denied'} decision
 */
async function applyStoreConfirmDecision(pool, requestId, decision) {
  let request;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM store_confirm_requests WHERE id = $1',
      [requestId]
    );
    if (!rows.length) {
      return { ok: false, status: 'not_found', error: 'not_found' };
    }
    request = rows[0];
  } catch (err) {
    logger.error(`applyStoreConfirmDecision lookup: ${err.message}`);
    return { ok: false, status: 'error', error: 'database' };
  }

  if (
    request.status === 'pending' &&
    Date.now() - new Date(request.created_at).getTime() > REQUEST_EXPIRY_MS
  ) {
    await pool.query(
      "UPDATE store_confirm_requests SET status = 'expired', processed_at = NOW() WHERE id = $1",
      [requestId]
    );
    return { ok: true, status: 'expired' };
  }

  if (request.status !== 'pending') {
    return { ok: true, status: request.status };
  }

  if (decision === 'approved') {
    let token;
    try {
      token = signDayConfirm({
        email: request.requested_by_email,
        store: request.store_number,
        date: request.date,
      });
    } catch (err) {
      logger.error(`Approve sign failed: ${err.message}`);
      return { ok: false, status: 'error', error: err.message };
    }

    try {
      await pool.query(
        `UPDATE store_confirm_requests
            SET status = 'approved',
                approved_token = $1,
                processed_at = NOW()
          WHERE id = $2`,
        [token, requestId]
      );
    } catch (err) {
      logger.error(`Approve update failed: ${err.message}`);
      return { ok: false, status: 'error', error: 'save_failed' };
    }
    return { ok: true, status: 'approved' };
  }

  if (decision === 'denied') {
    try {
      await pool.query(
        "UPDATE store_confirm_requests SET status = 'denied', processed_at = NOW() WHERE id = $1",
        [requestId]
      );
    } catch (err) {
      logger.error(`Deny update failed: ${err.message}`);
      return { ok: false, status: 'error', error: 'save_failed' };
    }
    return { ok: true, status: 'denied' };
  }

  return { ok: false, status: 'error', error: 'invalid_decision' };
}

// ─── DB INIT ────────────────────────────────────────────────────────────────

async function initStoreConfirmRequestsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_confirm_requests (
      id TEXT PRIMARY KEY,
      requested_by_email TEXT NOT NULL,
      store_number TEXT NOT NULL,
      date TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `);
}

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────

function pickStoreFromReq(req) {
  return (
    req.body?.storeNumber ??
    req.body?.store ??
    req.body?.store_number ??
    req.query?.store ??
    null
  );
}

function pickDateFromReq(req) {
  return (
    req.body?.workDate ??
    req.body?.date ??
    req.body?.DateMMDDYYYY ??
    req.query?.date ??
    null
  );
}

// Hard gate: rejects requests that don't carry a valid X-Day-Confirm token
// matching the user + store + workDate they're trying to submit. Returns 412
// (Precondition Failed) so the SPA can distinguish this from a 401/403 and
// re-open the confirmation modal cleanly.
function requireDayConfirm(req, res, next) {
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = req.headers['x-day-confirm'];
  const store = pickStoreFromReq(req);
  const date = pickDateFromReq(req);
  if (!token) {
    return res.status(412).json({
      error: 'day_confirm_required',
      reason: 'missing_token',
    });
  }
  if (!store || !date) {
    return res.status(412).json({
      error: 'day_confirm_required',
      reason: 'missing_store_or_date',
    });
  }
  const result = verifyDayConfirm(token, { email, store, date });
  if (!result.ok) {
    return res.status(412).json({
      error: 'day_confirm_required',
      reason: result.reason,
    });
  }
  return next();
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

function registerRoutes(app, resend, pool) {
  // 1. POST /api/verify-store — issue a dayConfirm token if eligible.
  app.post('/api/verify-store', async (req, res) => {
    const email = req.user?.email;
    const roles = req.user?.roles || [];
    if (!email) {
      return res.status(401).json({ ok: false, reason: 'not_authenticated' });
    }
    const store = normalizeStore(pickStoreFromReq(req));
    const date = normalizeDate(pickDateFromReq(req));
    if (!store || !date) {
      return res
        .status(400)
        .json({ ok: false, reason: 'missing_store_or_date' });
    }

    // Role auto-pass for supervisor / admin — they manage the gate, never
    // hit it themselves.
    if (roles.includes('supervisor') || roles.includes('admin')) {
      try {
        const token = signDayConfirm({ email, store, date });
        return res.json({
          ok: true,
          token,
          source: 'role',
          expiresInMs: TOKEN_TTL_MS,
        });
      } catch (err) {
        logger.error('Failed to mint role-pass token:', err.message);
        return res
          .status(500)
          .json({ ok: false, reason: 'sign_failed', detail: err.message });
      }
    }

    let roster;
    try {
      roster = await isOnRoster(pool, { email, store, date });
    } catch (err) {
      logger.error('Roster lookup threw:', err.message);
      return res
        .status(500)
        .json({ ok: false, reason: 'lookup_failed', detail: err.message });
    }

    if (!roster.matched) {
      return res.status(403).json({
        ok: false,
        reason: 'not_on_roster',
        rosterSource: roster.source,
      });
    }

    try {
      const token = signDayConfirm({ email, store, date });
      return res.json({
        ok: true,
        token,
        source: roster.source,
        expiresInMs: TOKEN_TTL_MS,
      });
    } catch (err) {
      logger.error('Failed to mint roster-pass token:', err.message);
      return res
        .status(500)
        .json({ ok: false, reason: 'sign_failed', detail: err.message });
    }
  });

  // 2. POST /api/store-confirm-request — kick off override approval email.
  app.post('/api/store-confirm-request', async (req, res) => {
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const store = normalizeStore(pickStoreFromReq(req));
    const date = normalizeDate(pickDateFromReq(req));
    const reason = String(req.body?.reason || '').slice(0, 500);
    if (!store || !date) {
      return res.status(400).json({ error: 'Missing store or date' });
    }

    const requestId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO store_confirm_requests
         (id, requested_by_email, store_number, date, reason, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [requestId, normalizeEmail(email), store, date, reason || null]
      );
    } catch (err) {
      logger.error(`Failed to persist override request: ${err.message}`);
      return res
        .status(500)
        .json({ error: 'Failed to create override request' });
    }

    try {
      const reviewToken = issueReviewToken({
        requestId,
        decisionType: 'store',
        approverEmail: OVERRIDE_APPROVER_EMAIL,
      });
      const reviewUrl = `${DUMP_BIN_SITE}/decide.html?type=store&id=${encodeURIComponent(requestId)}&token=${encodeURIComponent(reviewToken)}`;

      await sendEmail(resend, {
        to: OVERRIDE_APPROVER_EMAIL,
        subject: `Store Confirmation Override — Store #${store} ${date}`,
        html: buildOverrideApprovalEmail({
          requestId,
          storeNumber: store,
          date,
          requestedBy: email,
          reason,
          reviewUrl,
        }),
        userEmail: email,
      });
    } catch (err) {
      logger.error(`Failed to send override email: ${err.message}`);
      // Don't fail the request — supervisor can still load /status manually
      // and approve another way. Surface the email failure for visibility.
      return res.json({
        requestId,
        status: 'pending',
        emailDelivered: false,
        emailError: err.message,
      });
    }

    return res.json({
      requestId,
      status: 'pending',
      emailDelivered: true,
      approverEmail: OVERRIDE_APPROVER_EMAIL,
    });
  });

  // Legacy GET /approve and /deny removed — supervisors use the-dump-bin.com/decide.html + POST /api/decide

  // 5. GET /api/store-confirm-request/:id/status — SPA polls until resolved.
  // Authenticated; only the original requester can read the token.
  app.get('/api/store-confirm-request/:requestId/status', async (req, res) => {
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { requestId } = req.params;
    let request;
    try {
      const { rows } = await pool.query(
        'SELECT * FROM store_confirm_requests WHERE id = $1',
        [requestId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Not found' });
      }
      request = rows[0];
    } catch (err) {
      logger.error(`status lookup failed: ${err.message}`);
      return res.status(500).json({ error: 'Database error' });
    }

    if (
      normalizeEmail(request.requested_by_email) !== normalizeEmail(email) &&
      !(req.user?.roles || []).some((r) => r === 'supervisor' || r === 'admin')
    ) {
      return res.status(403).json({ error: 'Not your request' });
    }

    // Lazily expire pending rows on poll.
    if (
      request.status === 'pending' &&
      Date.now() - new Date(request.created_at).getTime() > REQUEST_EXPIRY_MS
    ) {
      await pool.query(
        "UPDATE store_confirm_requests SET status = 'expired', processed_at = NOW() WHERE id = $1",
        [requestId]
      );
      request.status = 'expired';
    }

    const out = {
      status: request.status,
      storeNumber: request.store_number,
      date: request.date,
    };
    if (request.status === 'approved' && request.approved_token) {
      out.token = request.approved_token;
      out.expiresInMs = TOKEN_TTL_MS;
    }
    return res.json(out);
  });
}

module.exports = {
  initStoreConfirmRequestsTable,
  registerRoutes,
  requireDayConfirm,
  signDayConfirm,
  verifyDayConfirm,
  applyStoreConfirmDecision,
  STORE_CONFIRM_REQUEST_EXPIRY_MS: REQUEST_EXPIRY_MS,
  TOKEN_TTL_MS,
  // Exposed for tests / introspection only.
  _internals: {
    normalizeStore,
    normalizeDate,
    normalizeEmail,
    isOnRoster,
    REQUEST_EXPIRY_MS,
    TOKEN_TTL_MS,
  },
};
