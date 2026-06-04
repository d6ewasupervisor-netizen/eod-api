'use strict';

const DEFAULT_ADMIN_EMAILS = ['d6ewa.supervisor@gmail.com'];

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

const DEFAULTS = {
  reboticsRequestTimeoutMs: parseIntEnv('TRACKER_REBOTICS_REQUEST_TIMEOUT_MS', 15000),
  reboticsActionsPageLimit: parseIntEnv('TRACKER_REBOTICS_ACTIONS_PAGE_LIMIT', 200),
  reboticsMaxActionPages: parseIntEnv('TRACKER_REBOTICS_MAX_ACTION_PAGES', 40),
  reboticsMaxTaskPages: parseIntEnv('TRACKER_REBOTICS_MAX_TASK_PAGES', 20),
  runItemsPageSizeDefault: parseIntEnv('TRACKER_RUN_ITEMS_PAGE_SIZE_DEFAULT', 100),
  runItemsPageSizeMax: parseIntEnv('TRACKER_RUN_ITEMS_PAGE_SIZE_MAX', 500),
};

function trackerAdminEmails() {
  return parseCsvEnv('TRACKER_ADMIN_EMAILS', DEFAULT_ADMIN_EMAILS).map((e) => e.toLowerCase());
}

function sanitize(input = {}) {
  const out = {};
  out.reboticsRequestTimeoutMs = Math.min(60000, Math.max(2000, parseInt(input.reboticsRequestTimeoutMs, 10) || DEFAULTS.reboticsRequestTimeoutMs));
  out.reboticsActionsPageLimit = Math.min(500, Math.max(10, parseInt(input.reboticsActionsPageLimit, 10) || DEFAULTS.reboticsActionsPageLimit));
  out.reboticsMaxActionPages = Math.min(200, Math.max(1, parseInt(input.reboticsMaxActionPages, 10) || DEFAULTS.reboticsMaxActionPages));
  out.reboticsMaxTaskPages = Math.min(200, Math.max(1, parseInt(input.reboticsMaxTaskPages, 10) || DEFAULTS.reboticsMaxTaskPages));
  out.runItemsPageSizeDefault = Math.min(500, Math.max(10, parseInt(input.runItemsPageSizeDefault, 10) || DEFAULTS.runItemsPageSizeDefault));
  out.runItemsPageSizeMax = Math.min(1000, Math.max(50, parseInt(input.runItemsPageSizeMax, 10) || DEFAULTS.runItemsPageSizeMax));
  return out;
}

async function loadTrackerSettings(pool) {
  const { rows } = await pool.query(
    `SELECT setting_json FROM tracker_settings WHERE setting_key = 'global' LIMIT 1`
  );
  if (!rows.length) return { ...DEFAULTS };
  const dbSettings = rows[0].setting_json || {};
  return sanitize({ ...DEFAULTS, ...dbSettings });
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
  return normalized;
}

module.exports = {
  DEFAULTS,
  sanitize,
  trackerAdminEmails,
  loadTrackerSettings,
  saveTrackerSettings,
};
