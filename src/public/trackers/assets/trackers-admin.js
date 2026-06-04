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
    document.getElementById('runItemsPageSizeDefault').value = settings.runItemsPageSizeDefault;
    document.getElementById('runItemsPageSizeMax').value = settings.runItemsPageSizeMax;
  }

  function collectSettings() {
    return {
      trackerAllowedEmails: document.getElementById('trackerAllowedEmails').value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      trackerAllowSupervisors: document.getElementById('trackerAllowSupervisors').value === 'true',
      trackerAllowAdmins: document.getElementById('trackerAllowAdmins').value === 'true',
      reboticsRequestTimeoutMs: parseInt(document.getElementById('reboticsRequestTimeoutMs').value, 10),
      reboticsActionsPageLimit: parseInt(document.getElementById('reboticsActionsPageLimit').value, 10),
      reboticsMaxActionPages: parseInt(document.getElementById('reboticsMaxActionPages').value, 10),
      reboticsMaxTaskPages: parseInt(document.getElementById('reboticsMaxTaskPages').value, 10),
      runItemsPageSizeDefault: parseInt(document.getElementById('runItemsPageSizeDefault').value, 10),
      runItemsPageSizeMax: parseInt(document.getElementById('runItemsPageSizeMax').value, 10),
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
          saveStatus.textContent = `Saved at ${new Date(saved.updatedAt).toLocaleString()}.`;
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
