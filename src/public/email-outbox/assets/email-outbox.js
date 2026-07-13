(function () {
  const state = {
    page: 1,
    pageSize: 50,
    total: 0,
    selectedId: null,
    filters: {},
    sources: [],
  };

  function tokenHeader() {
    let token = '';
    try {
      if (window.dumpBinAuth && typeof window.dumpBinAuth.getSession === 'function') {
        token = window.dumpBinAuth.getSession() || '';
      }
      if (!token) {
        token = localStorage.getItem('dumpBinSession') || localStorage.getItem('eodSession') || '';
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

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch (_err) {
      return iso;
    }
  }

  function badge(label, kind) {
    return `<span class="badge badge-${kind}">${label}</span>`;
  }

  function statusBadge(status) {
    const s = String(status || 'unknown').toLowerCase();
    if (s === 'sent') return badge('Sent', 'sent');
    if (s === 'failed') return badge('Failed', 'failed');
    if (s === 'pending') return badge('Pending', 'pending');
    return badge(status || '—', 'pending');
  }

  function deliveryBadge(delivery) {
    const d = String(delivery || 'unknown').toLowerCase();
    if (d === 'delivered') return badge('Delivered', 'delivered');
    if (d === 'failed') return badge('Failed', 'failed');
    if (d === 'complained') return badge('Complained', 'complained');
    if (d === 'sent') return badge('In flight', 'sent');
    return badge(delivery || '—', 'pending');
  }

  function renderRows(items) {
    const tbody = document.getElementById('emailRows');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No emails match these filters.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((item) => {
      const selected = item.id === state.selectedId ? ' is-selected' : '';
      const to = (item.to || []).join(', ');
      return `<tr data-id="${item.id}" class="${selected}">
        <td>${fmtDate(item.createdAt)}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${deliveryBadge(item.deliveryStatus || item.lastEvent)}</td>
        <td><div>${item.sourceSystem}</div><div class="muted">${item.sourceType}</div></td>
        <td class="from-cell">${escapeHtml(item.from || '—')}</td>
        <td class="subject-cell">${escapeHtml(item.subject || '—')}</td>
        <td class="to-cell">${escapeHtml(to || '—')}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => selectEmail(Number(row.dataset.id)));
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadList() {
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    Object.entries(state.filters).forEach(([k, v]) => {
      if (v) params.set(k, v);
    });
    const data = await api(`/api/email-outbox?${params.toString()}`);
    state.total = data.total || 0;
    document.getElementById('listSummary').textContent = `${state.total} email(s)`;
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    document.getElementById('pageLabel').textContent = `Page ${state.page} / ${totalPages}`;
    document.getElementById('prevPage').disabled = state.page <= 1;
    document.getElementById('nextPage').disabled = state.page >= totalPages;
    renderRows(data.items || []);
  }

  async function loadSources() {
    const data = await api('/api/email-outbox/sources');
    state.sources = data.sources || [];
    const systems = [...new Set(state.sources.map((s) => s.source_system))].sort();
    const types = [...new Set(state.sources.map((s) => s.source_type))].sort();
    fillSelect('sourceSystem', systems);
    fillSelect('sourceType', types);
  }

  function fillSelect(id, values) {
    const el = document.getElementById(id);
    const current = el.value;
    el.innerHTML = '<option value="">Any</option>' + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(current)) el.value = current;
  }

  async function selectEmail(id) {
    state.selectedId = id;
    document.querySelectorAll('#emailRows tr[data-id]').forEach((row) => {
      row.classList.toggle('is-selected', Number(row.dataset.id) === id);
    });
    const data = await api(`/api/email-outbox/${id}`);
    renderDetail(data.item);
  }

  function renderDetail(item) {
    document.getElementById('detailEmpty').hidden = true;
    document.getElementById('detailBody').hidden = false;
    const meta = document.getElementById('detailMeta');
    const rows = [
      ['When', fmtDate(item.createdAt)],
      ['Status', item.status],
      ['Delivery', item.deliveryStatus || item.lastEvent || '—'],
      ['From', item.from || '—'],
      ['To', (item.to || []).join(', ') || '—'],
      ['CC', (item.cc || []).join(', ') || '—'],
      ['Subject', item.subject || '—'],
      ['Source', `${item.sourceSystem} / ${item.sourceType}`],
      ['Resend ID', item.resendId || '—'],
      ['Attachments', String(item.attachmentCount || 0)],
      ['Can resend', item.canResend ? 'Yes' : 'No'],
    ];
    if (item.errorMessage) rows.push(['Error', item.errorMessage]);
    if (item.compacted) rows.push(['Storage', 'Compacted (body/attachments cleared)']);
    meta.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');

    document.getElementById('editSubject').value = item.subject || '';
    document.getElementById('editTo').value = (item.to || []).join(', ');
    document.getElementById('editCc').value = (item.cc || []).join(', ');
    document.getElementById('editDelivery').value = '';

    const iframe = document.getElementById('htmlPreview');
    iframe.srcdoc = item.htmlBody || '<p style="font-family:sans-serif;color:#666;">No HTML body stored.</p>';

    const attachments = document.getElementById('attachmentList');
    const list = Array.isArray(item.attachments) ? item.attachments : [];
    attachments.innerHTML = list.length
      ? list.map((a) => `<li>${escapeHtml(a.filename || 'attachment')}${a.content_type ? ` <span class="muted">(${escapeHtml(a.content_type)})</span>` : ''}</li>`).join('')
      : '<li class="muted">No attachments</li>';

    const err = document.getElementById('detailError');
    err.hidden = true;
    err.textContent = '';

    const resendBtn = document.getElementById('resendBtn');
    resendBtn.disabled = !item.canResend;
    resendBtn.onclick = async () => {
      if (!item.canResend) return;
      if (!window.confirm('Resend this email exactly as stored (recipients, body, attachments)?')) return;
      resendBtn.disabled = true;
      try {
        const result = await api(`/api/email-outbox/${item.id}/resend`, { method: 'POST', body: '{}' });
        alert(`Resent. New Resend ID: ${result.resendId || 'unknown'}`);
        await loadList();
        if (result.recordId) await selectEmail(result.recordId);
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
      } finally {
        resendBtn.disabled = !item.canResend;
      }
    };

    const compactBtn = document.getElementById('compactBtn');
    compactBtn.disabled = item.compacted;
    compactBtn.onclick = async () => {
      if (!window.confirm('Clear stored HTML, attachments, and resend payload? Metadata (subject, recipients, delivery) is kept.')) return;
      compactBtn.disabled = true;
      try {
        await api(`/api/email-outbox/${item.id}`, { method: 'PATCH', body: JSON.stringify({ compact: true }) });
        await loadList();
        await selectEmail(item.id);
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
      } finally {
        compactBtn.disabled = false;
      }
    };

    document.getElementById('deleteBtn').onclick = async () => {
      if (!window.confirm('Permanently delete this email record?')) return;
      try {
        await api(`/api/email-outbox/${item.id}`, { method: 'DELETE' });
        state.selectedId = null;
        document.getElementById('detailEmpty').hidden = false;
        document.getElementById('detailBody').hidden = true;
        await loadList();
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
      }
    };

    document.getElementById('editForm').onsubmit = async (e) => {
      e.preventDefault();
      const payload = {
        subject: document.getElementById('editSubject').value.trim(),
        to: document.getElementById('editTo').value.split(',').map((s) => s.trim()).filter(Boolean),
        cc: document.getElementById('editCc').value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      const delivery = document.getElementById('editDelivery').value;
      if (delivery) payload.deliveryStatus = delivery;
      try {
        await api(`/api/email-outbox/${item.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        await loadList();
        await selectEmail(item.id);
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message;
      }
    };
  }

  function readFiltersFromForm() {
    state.filters = {
      search: document.getElementById('search').value.trim(),
      status: document.getElementById('status').value,
      deliveryStatus: document.getElementById('deliveryStatus').value,
      sourceSystem: document.getElementById('sourceSystem').value,
      sourceType: document.getElementById('sourceType').value,
    };
    state.page = 1;
  }

  async function boot() {
    if (window.dumpBinAuthReady) await window.dumpBinAuthReady;
    document.getElementById('filterForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      readFiltersFromForm();
      await loadList();
    });
    document.getElementById('clearFilters').addEventListener('click', async () => {
      document.getElementById('search').value = '';
      document.getElementById('status').value = '';
      document.getElementById('deliveryStatus').value = '';
      document.getElementById('sourceSystem').value = '';
      document.getElementById('sourceType').value = '';
      readFiltersFromForm();
      await loadList();
    });
    document.getElementById('refreshBtn').addEventListener('click', loadList);
    document.getElementById('prevPage').addEventListener('click', async () => {
      if (state.page > 1) { state.page -= 1; await loadList(); }
    });
    document.getElementById('nextPage').addEventListener('click', async () => {
      state.page += 1;
      await loadList();
    });
    document.getElementById('syncBtn').addEventListener('click', async () => {
      const btn = document.getElementById('syncBtn');
      btn.disabled = true;
      try {
        const result = await api('/api/email-outbox/sync/resend', { method: 'POST', body: '{}' });
        alert(`Sync complete. Imported ${result.imported}, updated ${result.updated}.`);
        await loadSources();
        await loadList();
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });

    await loadSources();
    await loadList();
  }

  boot().catch((err) => {
    document.getElementById('listSummary').textContent = err.message;
  });
})();
