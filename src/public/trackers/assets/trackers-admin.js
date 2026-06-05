(function () {
  function tokenHeader() {
    let token = '';
    try {
      if (window.dumpBinAuth && typeof window.dumpBinAuth.getSession === 'function') {
        token = window.dumpBinAuth.getSession() || '';
      }
      if (!token) {
        token =
          localStorage.getItem('dumpBinSession') ||
          localStorage.getItem('eodSession') ||
          localStorage.getItem('eod_session_token') ||
          localStorage.getItem('session_token') ||
          '';
      }
    } catch (_err) {}
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...tokenHeader(),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
    return body;
  }

  function bindSettings(settings) {
    document.getElementById('trackerAllowedEmails').value = (settings.trackerAllowedEmails || []).join(', ');
    document.getElementById('trackerAllowSupervisors').value = String(Boolean(settings.trackerAllowSupervisors));
    document.getElementById('trackerAllowAdmins').value = String(Boolean(settings.trackerAllowAdmins));
    document.getElementById('reboticsRequestTimeoutMs').value = settings.reboticsRequestTimeoutMs;
    document.getElementById('reboticsActionsPageLimit').value = settings.reboticsActionsPageLimit;
    document.getElementById('reboticsMaxActionPages').value = settings.reboticsMaxActionPages;
    document.getElementById('reboticsMaxTaskPages').value = settings.reboticsMaxTaskPages;
    document.getElementById('reboticsMaxAttempts').value = settings.reboticsMaxAttempts;
    document.getElementById('sasRequestTimeoutMs').value = settings.sasRequestTimeoutMs;
    document.getElementById('sasMaxAttempts').value = settings.sasMaxAttempts;
    document.getElementById('runItemsPageSizeDefault').value = settings.runItemsPageSizeDefault;
    document.getElementById('runItemsPageSizeMax').value = settings.runItemsPageSizeMax;
    document.getElementById('maxRunStores').value = settings.maxRunStores;
    document.getElementById('maxRunDates').value = settings.maxRunDates;
    document.getElementById('maxRunWorkUnits').value = settings.maxRunWorkUnits;
    const audit = document.getElementById('auditStatus');
    audit.textContent = settings.updatedAt
      ? `Last updated ${new Date(settings.updatedAt).toLocaleString()} by ${settings.updatedBy || 'unknown'}.`
      : 'Using defaults; no saved tracker settings row yet.';
  }

  function readNumber(id) {
    const input = document.getElementById(id);
    const value = parseInt(input.value, 10);
    const min = parseInt(input.min || '-999999', 10);
    const max = parseInt(input.max || '999999', 10);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${id} must be between ${min} and ${max}`);
    }
    return value;
  }

  function collectSettings() {
    const defaultPageSize = readNumber('runItemsPageSizeDefault');
    const maxPageSize = readNumber('runItemsPageSizeMax');
    if (defaultPageSize > maxPageSize) {
      throw new Error('Run Items Default Page Size must be less than or equal to Run Items Max Page Size');
    }
    return {
      trackerAllowedEmails: document.getElementById('trackerAllowedEmails').value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      trackerAllowSupervisors: document.getElementById('trackerAllowSupervisors').value === 'true',
      trackerAllowAdmins: document.getElementById('trackerAllowAdmins').value === 'true',
      reboticsRequestTimeoutMs: readNumber('reboticsRequestTimeoutMs'),
      reboticsActionsPageLimit: readNumber('reboticsActionsPageLimit'),
      reboticsMaxActionPages: readNumber('reboticsMaxActionPages'),
      reboticsMaxTaskPages: readNumber('reboticsMaxTaskPages'),
      reboticsMaxAttempts: readNumber('reboticsMaxAttempts'),
      sasRequestTimeoutMs: readNumber('sasRequestTimeoutMs'),
      sasMaxAttempts: readNumber('sasMaxAttempts'),
      runItemsPageSizeDefault: defaultPageSize,
      runItemsPageSizeMax: maxPageSize,
      maxRunStores: readNumber('maxRunStores'),
      maxRunDates: readNumber('maxRunDates'),
      maxRunWorkUnits: readNumber('maxRunWorkUnits'),
    };
  }

  async function init() {
    const status = document.getElementById('adminStatus');
    const saveStatus = document.getElementById('saveStatus');
    try {
      const data = await api('/api/trackers/admin/settings');
      status.textContent = `Authorized as ${data.auth.email}.`;
      bindSettings(data.settings);
      document.getElementById('settingsForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        saveStatus.textContent = 'Saving...';
        try {
          const saved = await api('/api/trackers/admin/settings', {
            method: 'PUT',
            body: JSON.stringify({ settings: collectSettings() }),
          });
          bindSettings(saved.settings);
          saveStatus.textContent = `Saved at ${new Date(saved.settings.updatedAt || saved.updatedAt).toLocaleString()}.`;
        } catch (err) {
          saveStatus.textContent = `Save failed: ${err.message}`;
        }
      });
    } catch (err) {
      status.textContent = `Access denied: ${err.message}`;
    }
  }

  init();
})();
