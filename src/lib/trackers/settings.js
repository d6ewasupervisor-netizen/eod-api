'use strict';

const DEFAULT_ADMIN_EMAILS = ['d6ewa.supervisor@gmail.com'];
const SETTINGS_CACHE_MS = 30 * 1000;
let settingsCache = { value: null, expiresAt: 0 };

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = parseInt(String(raw || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function parseBoolEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

const DEFAULTS = {
  reboticsRequestTimeoutMs: parseIntEnv('TRACKER_REBOTICS_REQUEST_TIMEOUT_MS', 30000),
  reboticsActionsPageLimit: parseIntEnv('TRACKER_REBOTICS_ACTIONS_PAGE_LIMIT', 200),
  reboticsMaxActionPages: parseIntEnv('TRACKER_REBOTICS_MAX_ACTION_PAGES', 40),
  reboticsMaxTaskPages: parseIntEnv('TRACKER_REBOTICS_MAX_TASK_PAGES', 20),
  reboticsMaxAttempts: parseIntEnv('TRACKER_REBOTICS_MAX_ATTEMPTS', 3),
  reboticsConcurrency: parseIntEnv('TRACKER_REBOTICS_CONCURRENCY', 3),
  sasRequestTimeoutMs: parseIntEnv('TRACKER_SAS_REQUEST_TIMEOUT_MS', 30000),
  sasMaxAttempts: parseIntEnv('TRACKER_SAS_MAX_ATTEMPTS', 3),
  sasConcurrency: parseIntEnv('TRACKER_SAS_CONCURRENCY', 3),
  runItemsPageSizeDefault: parseIntEnv('TRACKER_RUN_ITEMS_PAGE_SIZE_DEFAULT', 100),
  runItemsPageSizeMax: parseIntEnv('TRACKER_RUN_ITEMS_PAGE_SIZE_MAX', 500),
  maxRunStores: parseIntEnv('TRACKER_MAX_RUN_STORES', 120),
  maxRunDates: parseIntEnv('TRACKER_MAX_RUN_DATES', 14),
  maxRunWorkUnits: parseIntEnv('TRACKER_MAX_RUN_WORK_UNITS', 3000),
  trackerAllowSupervisors: parseBoolEnv('TRACKER_ALLOW_SUPERVISORS', true),
  trackerAllowAdmins: parseBoolEnv('TRACKER_ALLOW_ADMINS', true),
  trackerAllowedEmails: parseCsvEnv('TRACKER_ALLOWED_EMAILS', []).map((e) => e.toLowerCase()),
};

function trackerAdminEmails() {
  return [...new Set([
    ...DEFAULT_ADMIN_EMAILS,
    ...parseCsvEnv('TRACKER_ADMIN_EMAILS', []),
  ].map((e) => e.toLowerCase()))];
}

function sanitize(input = {}) {
  const out = {};
  out.reboticsRequestTimeoutMs = Math.min(60000, Math.max(2000, parseInt(input.reboticsRequestTimeoutMs, 10) || DEFAULTS.reboticsRequestTimeoutMs));
  out.reboticsActionsPageLimit = Math.min(500, Math.max(10, parseInt(input.reboticsActionsPageLimit, 10) || DEFAULTS.reboticsActionsPageLimit));
  out.reboticsMaxActionPages = Math.min(200, Math.max(1, parseInt(input.reboticsMaxActionPages, 10) || DEFAULTS.reboticsMaxActionPages));
  out.reboticsMaxTaskPages = Math.min(200, Math.max(1, parseInt(input.reboticsMaxTaskPages, 10) || DEFAULTS.reboticsMaxTaskPages));
  out.reboticsMaxAttempts = Math.min(5, Math.max(1, parseInt(input.reboticsMaxAttempts, 10) || DEFAULTS.reboticsMaxAttempts));
  out.reboticsConcurrency = Math.min(10, Math.max(1, parseInt(input.reboticsConcurrency, 10) || DEFAULTS.reboticsConcurrency));
  out.sasRequestTimeoutMs = Math.min(120000, Math.max(5000, parseInt(input.sasRequestTimeoutMs, 10) || DEFAULTS.sasRequestTimeoutMs));
  out.sasMaxAttempts = Math.min(5, Math.max(1, parseInt(input.sasMaxAttempts, 10) || DEFAULTS.sasMaxAttempts));
  out.sasConcurrency = Math.min(10, Math.max(1, parseInt(input.sasConcurrency, 10) || DEFAULTS.sasConcurrency));
  out.runItemsPageSizeDefault = Math.min(500, Math.max(10, parseInt(input.runItemsPageSizeDefault, 10) || DEFAULTS.runItemsPageSizeDefault));
  out.runItemsPageSizeMax = Math.min(1000, Math.max(50, parseInt(input.runItemsPageSizeMax, 10) || DEFAULTS.runItemsPageSizeMax));
  if (out.runItemsPageSizeDefault > out.runItemsPageSizeMax) {
    out.runItemsPageSizeDefault = out.runItemsPageSizeMax;
  }
  out.maxRunStores = Math.min(500, Math.max(1, parseInt(input.maxRunStores, 10) || DEFAULTS.maxRunStores));
  out.maxRunDates = Math.min(60, Math.max(1, parseInt(input.maxRunDates, 10) || DEFAULTS.maxRunDates));
  out.maxRunWorkUnits = Math.min(25000, Math.max(1, parseInt(input.maxRunWorkUnits, 10) || DEFAULTS.maxRunWorkUnits));
  out.trackerAllowSupervisors = Boolean(
    input.trackerAllowSupervisors != null ? input.trackerAllowSupervisors : DEFAULTS.trackerAllowSupervisors
  );
  out.trackerAllowAdmins = Boolean(
    input.trackerAllowAdmins != null ? input.trackerAllowAdmins : DEFAULTS.trackerAllowAdmins
  );
  const list = Array.isArray(input.trackerAllowedEmails)
    ? input.trackerAllowedEmails
    : String(input.trackerAllowedEmails || '').split(',');
  out.trackerAllowedEmails = [...new Set(list
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  return out;
}

async function loadTrackerSettings(pool) {
  const now = Date.now();
  if (settingsCache.value && now < settingsCache.expiresAt) {
    return settingsCache.value;
  }
  const { rows } = await pool.query(
    `SELECT setting_json, updated_by_email, updated_at FROM tracker_settings WHERE setting_key = 'global' LIMIT 1`
  );
  if (!rows.length) {
    const value = { ...DEFAULTS };
    settingsCache = { value, expiresAt: now + SETTINGS_CACHE_MS };
    return value;
  }
  const dbSettings = rows[0].setting_json || {};
  const value = {
    ...sanitize({ ...DEFAULTS, ...dbSettings }),
    updatedBy: rows[0].updated_by_email || null,
    updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
  };
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_MS };
  return value;
}

async function saveTrackerSettings(pool, input, updatedByEmail) {
  const normalized = sanitize(input);
  await pool.query(
    `INSERT INTO tracker_settings (setting_key, setting_json, updated_by_email, updated_at)
     VALUES ('global', $1::jsonb, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_json = EXCLUDED.setting_json,
           updated_by_email = EXCLUDED.updated_by_email,
           updated_at = NOW()`,
    [JSON.stringify(normalized), updatedByEmail || null],
  );
  const value = {
    ...normalized,
    updatedBy: updatedByEmail || null,
    updatedAt: new Date().toISOString(),
  };
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return value;
}

function isTrackerUserAllowed(user, settings) {
  const email = String(user?.email || '').trim().toLowerCase();
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  if (!email) return false;
  if (trackerAdminEmails().includes(email)) return true;
  if ((settings?.trackerAllowedEmails || []).includes(email)) return true;
  if (settings?.trackerAllowAdmins && roles.includes('admin')) return true;
  if (settings?.trackerAllowSupervisors && roles.includes('supervisor')) return true;
  return false;
}

module.exports = {
  DEFAULTS,
  sanitize,
  trackerAdminEmails,
  loadTrackerSettings,
  saveTrackerSettings,
  isTrackerUserAllowed,
};
