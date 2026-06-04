(function () {
  const state = {
    runId: null,
    pollTimer: null,
    bootstrap: null,
  };

  function tokenHeader() {
    const token =
      localStorage.getItem('eod_session_token') ||
      localStorage.getItem('session_token') ||
      '';
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

  function setRunStatus(text) {
    document.getElementById('runStatus').textContent = text;
  }

  function populateFiscal(weeks) {
    const years = [...new Set(weeks.map((w) => w.fiscalYear))].sort((a, b) => a - b);
    const fiscalYear = document.getElementById('fiscalYear');
    const period = document.getElementById('period');
    fiscalYear.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    period.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
      .map((n) => `<option value="${n}">${String(n).padStart(2, '0')}</option>`)
      .join('');
  }

  function renderStatus(bootstrap) {
    const statusGrid = document.getElementById('statusGrid');
    const projectPreview = bootstrap.projects.slice(0, 8).map((p) => `${p.id}`).join(', ');
    statusGrid.innerHTML = `
      <div class="status-chip"><strong>User</strong><div>${bootstrap.auth.email || 'unknown'}</div></div>
      <div class="status-chip"><strong>SAS</strong><div>${bootstrap.sas.active ? 'active' : 'not active'}</div></div>
      <div class="status-chip"><strong>Rebotics</strong><div>${bootstrap.rebotics.ok ? 'token loaded' : 'token missing'}${bootstrap.rebotics.stale ? ' (stale)' : ''}</div></div>
      <div class="status-chip"><strong>Projects</strong><div>${bootstrap.projects.length} discovered (${projectPreview}${bootstrap.projects.length > 8 ? ', ...' : ''})</div></div>
    `;
  }

  async function loadBootstrap() {
    const bootstrap = await api('/api/trackers/bootstrap');
    state.bootstrap = bootstrap;
    populateFiscal(bootstrap.weeks);
    renderStatus(bootstrap);
  }

  function bodyForRun() {
    const stores = document.getElementById('stores').value;
    const projects = document.getElementById('projects').value;
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    const fiscalYear = document.getElementById('fiscalYear').value;
    const period = document.getElementById('period').value;
    const week = document.getElementById('week').value;
    const body = {
      stores: stores.split(',').map((s) => s.trim()).filter(Boolean),
      projects: projects.split(',').map((s) => s.trim()).filter(Boolean),
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
    const data = await api(`/api/trackers/runs/${state.runId}/items?page=1&pageSize=200&search=${search}&confidence=${confidence}`);
    const summary = document.getElementById('summary');
    summary.textContent = `Rows: ${data.total} (page ${data.page})`;
    const body = document.getElementById('resultsBody');
    body.innerHTML = '';
    for (const item of data.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.store_number || ''}</td>
        <td>${item.work_date || ''}</td>
        <td>${item.period_week || ''}</td>
        <td>${item.dbkey || ''}</td>
        <td>${item.category_set_label || ''}</td>
        <td><span class="badge">${item.prod_status || ''}</span></td>
        <td><span class="badge">${item.si_status || ''}</span></td>
        <td>${item.prod_photo_count || 0}/${item.si_photo_count || 0}</td>
        <td>${item.confidence || ''}</td>
        <td><button data-item-id="${item.id}" class="view-images-btn">Images</button></td>
      `;
      body.appendChild(tr);
    }
    document.querySelectorAll('.view-images-btn').forEach((btn) => {
      btn.addEventListener('click', () => openImages(btn.getAttribute('data-item-id')));
    });
  }

  async function openImages(itemId) {
    const data = await api(`/api/trackers/runs/${state.runId}/images?itemId=${itemId}`);
    const grid = document.getElementById('imagesGrid');
    grid.innerHTML = '';
    for (const image of data.images) {
      const card = document.createElement('div');
      card.innerHTML = `
        <div><strong>${image.source_system}</strong> ${image.source_ref || ''}</div>
        <div>Bay ${image.bay_index || '-'}</div>
        <img src="${image.stream_url}" alt="tracker source image" />
      `;
      grid.appendChild(card);
    }
    document.getElementById('imagesDialog').showModal();
  }

  async function pollRun() {
    if (!state.runId) return;
    try {
      const data = await api(`/api/trackers/runs/${state.runId}`);
      const run = data.run;
      setRunStatus(
        `Status: ${run.status}\n` +
        `Stage: ${run.progress.stage || 'unknown'} (${run.progress.progress || 0}%)\n` +
        `Warnings: ${(run.warnings || []).length}\n` +
        `${run.error ? `Error: ${run.error}` : ''}`
      );
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
    setRunStatus('Submitting run...');
    try {
      const created = await api('/api/trackers/runs', {
        method: 'POST',
        body: JSON.stringify(bodyForRun()),
      });
      state.runId = created.runId;
      setRunStatus(`Run ${state.runId} created. Waiting...`);
      await pollRun();
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = setInterval(pollRun, 3000);
    } catch (err) {
      setRunStatus(`Run start failed: ${err.message}`);
    }
  }

  function bindEvents() {
    document.getElementById('runForm').addEventListener('submit', startRun);
    document.getElementById('refreshResults').addEventListener('click', refreshResults);
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
