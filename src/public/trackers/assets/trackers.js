(function () {
  const state = {
    runId: null,
    pollTimer: null,
    bootstrap: null,
    page: 1,
    pageSize: 200,
    total: 0,
  };

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body || {};
      this.errorType = this.body.errorType || null;
    }
  }

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
    if (!res.ok) throw new ApiError(body.error || body.message || `HTTP ${res.status}`, res.status, body);
    return body;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setRunStatus(text) {
    document.getElementById('runStatus').textContent = text;
  }

  function setProgress(progress) {
    const pct = Math.max(0, Math.min(100, Number(progress || 0)));
    document.getElementById('runProgressBar').style.width = `${pct}%`;
  }

  function showRunError(err, prefix) {
    const el = document.getElementById('runError');
    const type = err.errorType || err.body?.errorType || '';
    const label = type === 'auth'
      ? 'Authentication needed'
      : type === 'source_timeout'
        ? 'Source timeout'
        : type === 'request_too_large'
          ? 'Request too large'
          : 'Run error';
    el.textContent = `${prefix || label}: ${err.message}`;
    el.classList.remove('hidden');
  }

  function clearRunError() {
    const el = document.getElementById('runError');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function populateFiscal(weeks) {
    const years = [...new Set(weeks.map((w) => w.fiscalYear))].sort((a, b) => a - b);
    const fiscalYear = document.getElementById('fiscalYear');
    const period = document.getElementById('period');
    fiscalYear.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    period.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
      .map((n) => `<option value="${n}">${String(n).padStart(2, '0')}</option>`)
      .join('');
    const today = new Date().toISOString().slice(0, 10);
    const current = weeks.find((w) => String(w.start) <= today && today <= String(w.end));
    const recent = [...weeks].reverse().find((w) => String(w.start) <= today);
    const fallback = current || recent || weeks[weeks.length - 1];
    if (fallback) {
      fiscalYear.value = String(fallback.fiscalYear);
      period.value = String(fallback.period);
      document.getElementById('week').value = String(fallback.week);
    }
  }

  function populateDistricts(districts) {
    const select = document.getElementById('districts');
    select.innerHTML = (districts || [])
      .map((d) => `<option value="${d.id}">${escapeHtml(d.label)} (${d.storeCount} stores)</option>`)
      .join('');
  }

  function populateProjects(projects, defaults) {
    const selected = new Set((defaults || []).map((id) => String(id)));
    const el = document.getElementById('projectChoices');
    el.innerHTML = (projects || []).map((p) => {
      const label = p.displayName || p.name || p.label || 'Project';
      const checked = selected.has(String(p.id)) ? 'checked' : '';
      return `
        <label class="choice">
          <input type="checkbox" name="project" value="${p.id}" ${checked} />
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }).join('');
  }

  function renderStatus(bootstrap) {
    const status = document.getElementById('connectionStatus');
    const sasOnline = Boolean(bootstrap.sas?.active);
    const siOnline = Boolean(bootstrap.rebotics?.ok && !bootstrap.rebotics?.stale);
    status.innerHTML = `
      <span class="connection-pill ${sasOnline ? 'is-online' : 'is-offline'}">
        <span class="bulb"></span>PROD ${sasOnline ? 'online' : 'offline'}
      </span>
      <span class="connection-pill ${siOnline ? 'is-online' : 'is-offline'}">
        <span class="bulb"></span>SI ${siOnline ? 'online' : 'offline'}
      </span>
      ${sasOnline && siOnline ? '' : '<button id="reconnectSources" type="button" class="link-button">Reconnect</button>'}
    `;
    const reconnect = document.getElementById('reconnectSources');
    if (reconnect) reconnect.addEventListener('click', refreshSources);
  }

  async function loadBootstrap() {
    const bootstrap = await api('/api/trackers/bootstrap');
    state.bootstrap = bootstrap;
    populateFiscal(bootstrap.weeks);
    populateDistricts(bootstrap.districts || []);
    populateProjects(bootstrap.projects || [], bootstrap.defaults?.projects || []);
    renderStatus(bootstrap);
    updateRunEstimate();
  }

  function selectedDistricts() {
    return [...document.getElementById('districts').selectedOptions].map((o) => o.value);
  }

  function selectedProjects() {
    return [...document.querySelectorAll('input[name="project"]:checked')].map((input) => input.value);
  }

  function parseStores(value) {
    return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function selectedFiscalWeek() {
    if (!state.bootstrap) return null;
    const fy = Number(document.getElementById('fiscalYear').value);
    const period = Number(document.getElementById('period').value);
    const week = Number(document.getElementById('week').value);
    return (state.bootstrap.weeks || []).find((w) => w.fiscalYear === fy && w.period === period && w.week === week) || null;
  }

  function estimateDates() {
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    if (dateFrom && dateTo) {
      const start = new Date(`${dateFrom}T12:00:00`);
      const end = new Date(`${dateTo}T12:00:00`);
      if (end < start) return 0;
      return Math.round((end - start) / 86400000) + 1;
    }
    const week = selectedFiscalWeek();
    if (!week) return 0;
    return 7;
  }

  function estimateStores() {
    const explicit = new Set(parseStores(document.getElementById('stores').value));
    const districts = new Set(selectedDistricts());
    for (const district of state.bootstrap?.districts || []) {
      if (!districts.has(String(district.id))) continue;
      for (const store of district.stores || []) explicit.add(String(store));
    }
    return explicit.size;
  }

  function updateRunEstimate() {
    if (!state.bootstrap) return;
    const stores = estimateStores();
    const dates = estimateDates();
    const projects = selectedProjects().length;
    const workUnits = stores * dates * projects;
    const max = state.bootstrap.trackerDefaults?.maxRunWorkUnits || 3000;
    const detail = !projects
      ? 'Choose at least one project.'
      : stores || selectedDistricts().length
      ? `${stores} stores, ${dates || '?'} days, ${projects} projects${selectedFiscalWeek() ? ` (${selectedFiscalWeek().short}: ${selectedFiscalWeek().start} to ${selectedFiscalWeek().end})` : ''}.`
      : 'Choose at least one store or district.';
    const warning = workUnits > max
      ? ` Over the ${max} check limit. Split the run.`
      : workUnits > max * 0.75
        ? ' Large run; this may take a few minutes.'
        : '';
    document.getElementById('runEstimate').textContent = `${detail}${warning}`;
  }

  function bodyForRun() {
    const stores = document.getElementById('stores').value;
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    const fiscalYear = document.getElementById('fiscalYear').value;
    const period = document.getElementById('period').value;
    const week = document.getElementById('week').value;
    const projects = selectedProjects();
    if (!projects.length) throw new Error('Choose at least one project.');
    const body = {
      stores: parseStores(stores),
      districts: selectedDistricts(),
      projects,
    };
    if (dateFrom && dateTo) {
      body.dateFrom = dateFrom;
      body.dateTo = dateTo;
    } else {
      body.fiscalYear = fiscalYear;
      body.period = period;
      body.week = week;
    }
    return body;
  }

  async function refreshResults() {
    if (!state.runId) return;
    const search = encodeURIComponent(document.getElementById('search').value || '');
    const confidence = encodeURIComponent(document.getElementById('confidence').value || '');
    const status = encodeURIComponent(document.getElementById('status').value || '');
    const store = encodeURIComponent(document.getElementById('filterStore').value || '');
    const sort = encodeURIComponent(document.getElementById('sort').value || 'store');
    const order = encodeURIComponent(document.getElementById('order').value || 'asc');
    const data = await api(`/api/trackers/runs/${state.runId}/items?page=${state.page}&pageSize=${state.pageSize}&search=${search}&confidence=${confidence}&status=${status}&store=${store}&sort=${sort}&order=${order}`);
    state.total = data.total || 0;
    renderSummaryCards(state.lastRun?.summary || {}, data.total || 0);
    updatePager();
    const body = document.getElementById('resultsBody');
    body.innerHTML = '';
    if (!data.items.length) {
      body.innerHTML = '<tr><td colspan="10">No matching rows.</td></tr>';
      return;
    }
    for (const item of data.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.store_number || '')}</td>
        <td>${escapeHtml(item.work_date || '')}</td>
        <td>${escapeHtml(item.period_week || '')}</td>
        <td>${escapeHtml(item.dbkey || '')}</td>
        <td>${escapeHtml(item.category_set_label || '')}</td>
        <td><span class="badge">${escapeHtml(item.prod_status || '')}</span></td>
        <td><span class="badge">${escapeHtml(item.si_status || '')}</span></td>
        <td>${item.prod_photo_count || 0}/${item.si_photo_count || 0}</td>
        <td>${escapeHtml(item.confidence || '')}</td>
        <td><button data-item-id="${item.id}" class="view-images-btn">Images</button></td>
      `;
      body.appendChild(tr);
    }
    document.querySelectorAll('.view-images-btn').forEach((btn) => {
      btn.addEventListener('click', () => openImages(btn.getAttribute('data-item-id')));
    });
  }

  function renderSummaryCards(runSummary, filteredTotal) {
    const summaryEl = document.getElementById('summary');
    const byStatus = runSummary.byStatus || {};
    summaryEl.innerHTML = `
      <div class="summary-card"><strong>${runSummary.total || 0}</strong><span>Total compared</span></div>
      <div class="summary-card"><strong>${filteredTotal}</strong><span>Filtered rows</span></div>
      <div class="summary-card"><strong>${runSummary.needsReview || 0}</strong><span>Needs review</span></div>
      <div class="summary-card"><strong>${runSummary.prodRows || 0}/${runSummary.siRows || 0}</strong><span>Source rows PROD/SI</span></div>
      <div class="summary-card"><strong>${byStatus.prod_only || 0}</strong><span>PROD only</span></div>
      <div class="summary-card"><strong>${byStatus.si_only || 0}</strong><span>SI only</span></div>
    `;
  }

  function updatePager() {
    const totalPages = Math.max(1, Math.ceil((state.total || 0) / state.pageSize));
    document.getElementById('pageStatus').textContent = `Page ${state.page} of ${totalPages}`;
    document.getElementById('prevPage').disabled = state.page <= 1;
    document.getElementById('nextPage').disabled = state.page >= totalPages;
  }

  async function openImages(itemId) {
    const data = await api(`/api/trackers/runs/${state.runId}/images?itemId=${itemId}`);
    const grid = document.getElementById('imagesGrid');
    grid.innerHTML = '';
    if (!data.images.length) {
      grid.innerHTML = '<div class="hint">No source images found for this row.</div>';
      document.getElementById('imagesDialog').showModal();
      return;
    }
    for (const image of data.images) {
      const card = document.createElement('div');
      card.innerHTML = `
        <div><strong>${escapeHtml(image.source_system)}</strong> ${escapeHtml(image.source_ref || '')}</div>
        <div>Bay ${escapeHtml(image.bay_index || '-')}</div>
        <div class="image-placeholder">Loading...</div>
      `;
      grid.appendChild(card);
      loadImageIntoCard(card, image.stream_url);
    }
    document.getElementById('imagesDialog').showModal();
  }

  async function loadImageIntoCard(card, url) {
    const placeholder = card.querySelector('.image-placeholder');
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: tokenHeader(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = objectUrl;
      img.alt = 'tracker source image';
      img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
      placeholder.replaceWith(img);
    } catch (err) {
      placeholder.textContent = `Could not load image: ${err.message}`;
      placeholder.classList.add('image-error');
    }
  }

  async function pollRun() {
    if (!state.runId) return;
    try {
      const data = await api(`/api/trackers/runs/${state.runId}`);
      const run = data.run;
      state.lastRun = run;
      setProgress(run.progress.progress || 0);
      setRunStatus(
        `Status: ${run.status}\n` +
        `Stage: ${run.progress.stage || 'unknown'} (${run.progress.progress || 0}%) ${run.progress.message ? `- ${run.progress.message}` : ''}\n` +
        `Scope: ${run.progress.stores || run.params.stores?.length || 0} stores, ${run.progress.dates || '?'} days, ${run.progress.projects || run.params.projects?.length || 0} projects\n` +
        `Dates: ${run.progress.dateFrom || run.params.dateFrom || '-'} to ${run.progress.dateTo || run.params.dateTo || '-'}\n` +
        `Rows: PROD ${run.progress.prodRows ?? run.summary.prodRows ?? '-'} / SI ${run.progress.siRows ?? run.summary.siRows ?? '-'}\n` +
        `Warnings: ${(run.warnings || []).length}\n` +
        `${run.error ? `Error: ${run.error}` : ''}`
      );
      if (run.error) showRunError({ message: run.error, errorType: run.progress.errorType }, 'Run failed');
      if (run.status === 'completed' || run.status === 'failed') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        document.getElementById('runActions').classList.remove('hidden');
        document.getElementById('manifestJson').href = `/api/trackers/runs/${state.runId}/manifest.json`;
        document.getElementById('manifestCsv').href = `/api/trackers/runs/${state.runId}/manifest.csv`;
        await refreshResults();
      }
    } catch (err) {
      setRunStatus(`Polling error: ${err.message}`);
    }
  }

  async function startRun(event) {
    event.preventDefault();
    clearRunError();
    setProgress(2);
    setRunStatus('Submitting run...');
    try {
      const created = await api('/api/trackers/runs', {
        method: 'POST',
        body: JSON.stringify(bodyForRun()),
      });
      state.runId = created.runId;
      state.page = 1;
      setRunStatus(`Run ${state.runId} created. Waiting...${created.warnings?.length ? `\nWarnings: ${created.warnings.join('; ')}` : ''}`);
      await pollRun();
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = setInterval(pollRun, 3000);
    } catch (err) {
      setProgress(0);
      setRunStatus('Run start failed.');
      showRunError(err, 'Run start failed');
    }
  }

  async function refreshSources() {
    const status = document.getElementById('connectionStatus');
    status.classList.add('is-refreshing');
    try {
      await Promise.allSettled([
        api('/api/trigger-auth?force=1', { method: 'POST' }),
        api('/api/trackers/auth/rebotics/refresh', { method: 'POST' }),
      ]);
      await loadBootstrap();
    } finally {
      status.classList.remove('is-refreshing');
    }
  }

  function bindEvents() {
    document.getElementById('runForm').addEventListener('submit', startRun);
    document.getElementById('refreshResults').addEventListener('click', () => {
      state.page = 1;
      refreshResults().catch((err) => showRunError(err, 'Refresh failed'));
    });
    ['stores', 'districts', 'dateFrom', 'dateTo', 'fiscalYear', 'period', 'week'].forEach((id) => {
      document.getElementById(id).addEventListener('change', updateRunEstimate);
      document.getElementById(id).addEventListener('input', updateRunEstimate);
    });
    document.getElementById('projectChoices').addEventListener('change', updateRunEstimate);
    ['search', 'confidence', 'status', 'filterStore', 'sort', 'order'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => {
        state.page = 1;
        refreshResults().catch((err) => showRunError(err, 'Refresh failed'));
      });
    });
    document.getElementById('prevPage').addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        refreshResults().catch((err) => showRunError(err, 'Refresh failed'));
      }
    });
    document.getElementById('nextPage').addEventListener('click', () => {
      state.page += 1;
      refreshResults().catch((err) => showRunError(err, 'Refresh failed'));
    });
    document.getElementById('closeImages').addEventListener('click', () => {
      document.getElementById('imagesDialog').close();
    });
  }

  async function init() {
    bindEvents();
    await loadBootstrap();
  }

  init().catch((err) => setRunStatus(`Bootstrap failed: ${err.message}`));
})();
