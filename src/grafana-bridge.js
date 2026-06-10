'use strict';

const defaultAuthCore = require('./lib/trackers/grafana-auth-core');
const { sendAuthAlertEmail } = require('./lib/auth-alert-email');

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_ALERT_TO = 'tyson.gauthier@retailodyssey.com';
const ALERT_HTML = '<p>Railway Grafana auth automatic recovery FAILED after a single clean attempt. '
  + 'Investigate Railway Grafana/Rebotics auth recovery — the Grafana reporting cookie '
  + 'could not be re-established.</p>';

const logger = {
  info: (...args) => console.log('[grafana-bridge]', ...args),
  error: (...args) => console.error('[grafana-bridge]', ...args),
};

function epochToIso(expiryEpoch) {
  if (!Number.isFinite(expiryEpoch)) return null;
  const millis = expiryEpoch > 100000000000 ? expiryEpoch : expiryEpoch * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isDisabled() {
  return process.env.GRAFANA_AUTH_DISABLED === 'true';
}

function shouldAutoStart() {
  return (
    !isDisabled()
    && process.env.GRAFANA_AUTH_AUTO_START !== 'false'
    && process.env.RAILWAY_ENVIRONMENT === 'production'
  );
}

function createGrafanaBridge({
  authCore = defaultAuthCore,
  resend = null,
  now = () => Date.now(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  creds = {
    username: process.env.REBOTICS_USERNAME,
    password: process.env.REBOTICS_PASSWORD,
  },
} = {}) {
  let currentResend = resend;
  let cookieHeader = null;
  let expiryEpoch = null;
  let expiryIso = null;
  let lastValidatedAt = null;
  let lastRotatedAt = null;
  let lastColdLoginAt = null;
  let heartbeatHandle = null;
  let refreshPromise = null;
  let healthy = false;

  function disabled() {
    return isDisabled();
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function applySession(session = {}) {
    cookieHeader = session.cookieHeader || null;
    expiryEpoch = Number.isFinite(session.expiryEpoch) ? session.expiryEpoch : null;
    expiryIso = session.expiryIso || epochToIso(expiryEpoch);
    lastValidatedAt = session.validatedAt || isoNow();
    return getStatus();
  }

  function getGrafanaCookie() {
    if (disabled()) return null;
    return cookieHeader;
  }

  function getStatus() {
    return {
      hasCookie: Boolean(cookieHeader),
      expiryIso,
      lastValidatedAt,
      lastRotatedAt,
      lastColdLoginAt: lastColdLoginAt == null ? null : new Date(lastColdLoginAt).toISOString(),
      healthy,
      disabled: disabled(),
      heartbeatActive: Boolean(heartbeatHandle),
    };
  }

  async function seed() {
    if (disabled()) {
      healthy = false;
      return { ok: false, disabled: true, status: getStatus() };
    }
    const session = await authCore.coldLogin(creds);
    applySession(session);
    healthy = true;
    return { ok: true, status: getStatus() };
  }

  async function sendRecoveryFailureAlert(error) {
    const result = await sendAuthAlertEmail(currentResend, {
      from: 'EOD System <noreply@retail-odyssey.com>',
      to: process.env.GRAFANA_REAUTH_NOTIFY_EMAIL
        || process.env.REBOTICS_REAUTH_NOTIFY_EMAIL
        || DEFAULT_ALERT_TO,
      subject: 'KOMPASS GRAFANA AUTH',
      html: ALERT_HTML,
      replyToOptions: {},
      loggerLabel: 'grafana',
    });
    if (result?.ok === false) {
      logger.error('Grafana auth recovery alert failed:', result.error);
    } else {
      logger.error('Grafana auth recovery failed after one attempt; alert sent:', error?.message || 'unknown error');
    }
    return result;
  }

  async function coldRecover() {
    if (disabled()) {
      healthy = false;
      return { ok: false, disabled: true, status: getStatus() };
    }

    const currentTime = now();
    if (lastColdLoginAt != null && currentTime - lastColdLoginAt < cooldownMs) {
      healthy = false;
      logger.info('Grafana cold-recovery cooldown active');
      return { ok: false, deferred: true, reason: 'cooldown_active', status: getStatus() };
    }

    lastColdLoginAt = currentTime;
    try {
      const session = await authCore.coldLogin(creds);
      applySession(session);
      healthy = true;
      return { ok: true, recovered: true, status: getStatus() };
    } catch (error) {
      healthy = false;
      const alert = await sendRecoveryFailureAlert(error);
      return {
        ok: false,
        recovered: false,
        alert,
        error: error?.message || String(error),
        status: getStatus(),
      };
    }
  }

  async function rotate() {
    if (disabled()) {
      healthy = false;
      return { ok: false, disabled: true, status: getStatus() };
    }
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const session = await authCore.rotateSession(cookieHeader);
        applySession(session);
        lastRotatedAt = isoNow();
        healthy = true;
        return { ok: true, rotated: true, status: getStatus() };
      } catch (error) {
        if (error instanceof authCore.GrafanaStaleSessionError || error?.name === 'GrafanaStaleSessionError') {
          return coldRecover();
        }
        healthy = false;
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  function startHeartbeat() {
    if (disabled()) return { ok: false, disabled: true, status: getStatus() };
    if (heartbeatHandle) return { ok: true, alreadyStarted: true, status: getStatus() };
    heartbeatHandle = setInterval(() => {
      rotate().catch((error) => {
        healthy = false;
        logger.error('Grafana heartbeat rotation failed:', error?.message || String(error));
      });
    }, heartbeatMs);
    if (typeof heartbeatHandle.unref === 'function') heartbeatHandle.unref();
    return { ok: true, status: getStatus() };
  }

  function stopHeartbeat() {
    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    return { ok: true, status: getStatus() };
  }

  async function init(_app, _pool, options = {}) {
    if (options.resend !== undefined) currentResend = options.resend;
    if (disabled()) {
      healthy = false;
      return { ok: true, disabled: true, autoStarted: false, status: getStatus() };
    }
    if (!shouldAutoStart()) {
      return { ok: true, autoStarted: false, status: getStatus() };
    }
    await seed();
    startHeartbeat();
    return { ok: true, autoStarted: true, status: getStatus() };
  }

  return {
    applySession,
    coldRecover,
    getGrafanaCookie,
    getStatus,
    init,
    rotate,
    seed,
    shouldAutoStart,
    startHeartbeat,
    stopHeartbeat,
  };
}

module.exports = {
  createGrafanaBridge,
  shouldAutoStart,
};
