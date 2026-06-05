(function () {
  'use strict';

  const manifest = window.FM391_PHOTO_MANIFEST;
  const DB_NAME = 'fm391-p05w3-photos';
  const STORE_NAME = 'photos';
  const PHOTO_MAX_BYTES = 950 * 1024;
  const BATCH_MAX_BYTES = 17 * 1024 * 1024;
  const MAX_EDGE = 1600;
  const IMAGE_ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif';
  const HEIC_RE = /\.(hei[cf])$/i;
  const HEIC_MIME_RE = /^image\/hei[cf]$/i;
  const HEIC_CONVERTER_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const API_BASE = location.hostname.includes('github.io')
    ? 'https://eod-api.the-dump-bin.com'
    : '';

  const els = {
    setList: document.querySelector('#set-list'),
    status: document.querySelector('#status'),
    progressText: document.querySelector('#progress-text'),
    progressFill: document.querySelector('#progress-fill'),
    sendButton: document.querySelector('#send-button'),
    resendButton: document.querySelector('#resend-button'),
    clearButton: document.querySelector('#clear-button'),
  };

  const tasks = manifest.sets.flatMap((set) =>
    Array.from({ length: set.bays }, (_, idx) => {
      const bayNumber = idx + 1;
      return {
        id: `${set.id}-B${String(bayNumber).padStart(2, '0')}`,
        setId: set.id,
        bayNumber,
        set,
      };
    })
  );

  let dbPromise = null;
  let photoState = new Map();
  let nextTaskId = null;
  let pendingBulk = null;
  let heicConverterPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbTxn(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getAllPhotos() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function savePhoto(record) {
    await dbTxn('readwrite', (store) => store.put(record));
    photoState.set(record.id, record);
  }

  async function patchPhoto(id, patch) {
    const existing = photoState.get(id);
    if (!existing) return;
    const next = { ...existing, ...patch };
    await savePhoto(next);
  }

  async function clearPhotos() {
    await dbTxn('readwrite', (store) => store.clear());
    photoState = new Map();
  }

  function setStatus(message, type = 'info') {
    els.status.textContent = message || '';
    els.status.className = `status ${type}`;
  }

  function bytesFromDataUrl(dataUrl) {
    const base64 = String(dataUrl).split(',')[1] || '';
    return Math.floor((base64.length * 3) / 4);
  }

  function categorySlug(value) {
    return String(value || '')
      .replace(/&/g, 'and')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 70);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fileNameFor(task) {
    const set = task.set;
    const bay = String(task.bayNumber).padStart(2, '0');
    const total = String(set.bays).padStart(2, '0');
    return [
      manifest.store,
      manifest.periodWeek,
      `C${set.categoryNumber}`,
      `POG${set.pogShort}`,
      `Bay${bay}of${total}`,
      categorySlug(set.categoryName),
    ].join('_') + '.jpg';
  }

  function isHeicFile(file) {
    return HEIC_MIME_RE.test(file.type || '') || HEIC_RE.test(file.name || '');
  }

  function loadHeicConverter() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (heicConverterPromise) return heicConverterPromise;
    heicConverterPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = HEIC_CONVERTER_URL;
      script.async = true;
      script.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC converter unavailable.'));
      script.onerror = () => reject(new Error('Could not load HEIC converter.'));
      document.head.appendChild(script);
    });
    return heicConverterPromise;
  }

  async function convertHeicToJpeg(file) {
    const heic2any = await loadHeicConverter();
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.88,
    });
    return Array.isArray(converted) ? converted[0] : converted;
  }

  function readFileAsImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the selected image.'));
      };
      img.src = url;
    });
  }

  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall back to Image/object URL below */
      }
    }
    return readFileAsImage(file);
  }

  function canvasDataUrl(canvas, quality) {
    return canvas.toDataURL('image/jpeg', quality);
  }

  async function compressPhoto(file) {
    let decodeFile = file;
    let img;
    try {
      img = await decodeImage(decodeFile);
    } catch (err) {
      if (!isHeicFile(file)) throw err;
      const jpegBlob = await convertHeicToJpeg(file);
      decodeFile = new File([jpegBlob], `${file.name || 'photo'}.jpg`, { type: 'image/jpeg' });
      img = await decodeImage(decodeFile);
    }
    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (typeof img.close === 'function') img.close();

    let quality = 0.74;
    let dataUrl = canvasDataUrl(canvas, quality);
    while (bytesFromDataUrl(dataUrl) > PHOTO_MAX_BYTES && quality > 0.46) {
      quality -= 0.07;
      dataUrl = canvasDataUrl(canvas, quality);
    }
    return {
      dataUrl,
      bytes: bytesFromDataUrl(dataUrl),
      width: canvas.width,
      height: canvas.height,
    };
  }

  function renderBulkReview(set, setTasks) {
    if (!pendingBulk || pendingBulk.setId !== set.id) return '';
    const rows = pendingBulk.items.map((item, index) => {
      const bayOptions = setTasks.map((task) => `
        <option value="${task.bayNumber}" ${task.bayNumber === item.assignmentBayNumber ? 'selected' : ''}>
          Bay ${task.bayNumber} of ${set.bays}
        </option>
      `).join('');
      return `
        <div class="bulk-item" data-bulk-index="${index}">
          <img class="bulk-thumb" src="${item.url}" alt="">
          <div class="bulk-fields">
            <div class="bulk-file">${escapeHtml(item.file.name || `Photo ${index + 1}`)}</div>
            <label class="bulk-select-label">
              Bay
              <select class="bulk-bay-select" data-bulk-index="${index}">
                ${bayOptions}
              </select>
            </label>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="bulk-review" data-set-id="${set.id}">
        <div class="bulk-title">Review bay assignments</div>
        ${rows}
        <div class="bulk-actions">
          <button class="button button-primary bulk-save-button" type="button">Save assigned photos</button>
          <button class="button button-secondary bulk-cancel-button" type="button">Cancel</button>
        </div>
      </div>
    `;
  }

  function renderSets() {
    els.setList.innerHTML = manifest.sets.map((set) => {
      const setTasks = tasks.filter((task) => task.setId === set.id);
      const captured = setTasks.filter((task) => photoState.has(task.id)).length;
      const needed = set.bays - captured;
      const bayRows = setTasks.map((task) => {
        const photo = photoState.get(task.id);
        const sentText = photo?.sentAt ? 'Sent' : photo ? 'Captured' : 'Needed';
        return `
          <div class="bay-row ${photo ? 'captured' : ''} ${task.id === nextTaskId ? 'next-bay' : ''}" data-task-id="${task.id}">
            <div>
              <div class="bay-label">Bay ${task.bayNumber} of ${set.bays}</div>
              <div class="bay-detail">${sentText}</div>
            </div>
            <div class="bay-actions">
              <label class="capture-label">
                Take
                <input class="file-input bay-file-input" type="file" accept="${IMAGE_ACCEPT}" capture="environment" data-mode="take" data-task-id="${task.id}">
              </label>
              <label class="capture-label">
                Load
                <input class="file-input bay-file-input" type="file" accept="${IMAGE_ACCEPT}" data-mode="load" data-task-id="${task.id}">
              </label>
            </div>
          </div>`;
      }).join('');

      return `
        <section class="set-card">
          <div class="set-header">
            <div>
              <h2 class="set-title">${set.categoryName}</h2>
              <div class="set-meta">
                <span class="badge">${set.source}</span>
                <span class="badge">${set.setType}</span>
                <span class="badge">${set.sectionSizeFeet} ft</span>
                <span class="badge">POG ${set.pogShort}</span>
                <span class="badge">${set.department}</span>
              </div>
              <div class="set-actions">
                <label class="bulk-label">
                  Add set photos
                  <input class="file-input set-file-input" type="file" accept="${IMAGE_ACCEPT}" multiple data-set-id="${set.id}">
                </label>
              </div>
            </div>
            <div class="set-count">${captured} captured<br>${needed} needed</div>
          </div>
          ${renderBulkReview(set, setTasks)}
          <div class="bay-grid">${bayRows}</div>
        </section>`;
    }).join('');

  }

  function updateProgress() {
    const captured = tasks.filter((task) => photoState.has(task.id)).length;
    const sent = tasks.filter((task) => photoState.get(task.id)?.sentAt).length;
    const needed = tasks.length - captured;
    const pct = Math.round((captured / tasks.length) * 100);
    els.progressText.textContent = `Captured ${captured} | Needed ${needed} | Sent ${sent}`;
    els.progressFill.style.width = `${pct}%`;
    els.sendButton.disabled = !captured || sent === captured;
    els.resendButton.disabled = !captured;
  }

  async function refresh() {
    const rows = await getAllPhotos();
    photoState = new Map(rows.map((row) => [row.id, row]));
    renderSets();
    updateProgress();
  }

  function taskById(id) {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Unknown bay task: ${id}`);
    return task;
  }

  function tasksForSet(setId) {
    return tasks.filter((task) => task.setId === setId);
  }

  function buildPhotoRecord(task, compressed) {
    return {
      id: task.id,
      setId: task.setId,
      bayNumber: task.bayNumber,
      fileName: fileNameFor(task),
      contentType: 'image/jpeg',
      dataUrl: compressed.dataUrl,
      bytes: compressed.bytes,
      width: compressed.width,
      height: compressed.height,
      capturedAt: new Date().toISOString(),
      sentAt: null,
      manifest: {
        store: manifest.store,
        periodWeek: manifest.periodWeek,
        workDate: manifest.workDate,
        source: task.set.source,
        categoryNumber: task.set.categoryNumber,
        categoryName: task.set.categoryName,
        sectionSizeFeet: task.set.sectionSizeFeet,
        bayCount: task.set.bays,
        pogId: task.set.pogId,
        pogShort: task.set.pogShort,
        setType: task.set.setType,
        department: task.set.department,
      },
    };
  }

  function findNextNeededTask(afterTaskId) {
    const startIndex = Math.max(0, tasks.findIndex((task) => task.id === afterTaskId));
    const after = tasks.slice(startIndex + 1).find((task) => !photoState.has(task.id));
    if (after) return after;
    return tasks.slice(0, startIndex + 1).find((task) => !photoState.has(task.id)) || null;
  }

  function focusNextTask() {
    if (!nextTaskId) return;
    const row = document.querySelector(`[data-task-id="${nextTaskId}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openNextCamera(taskId) {
    const input = document.querySelector(`.bay-file-input[data-task-id="${taskId}"][data-mode="take"]`);
    if (!input) return;
    setTimeout(() => input.click(), 650);
  }

  function clearPendingBulk() {
    if (pendingBulk?.items) {
      pendingBulk.items.forEach((item) => URL.revokeObjectURL(item.url));
    }
    pendingBulk = null;
  }

  async function handleCapture(input) {
    const task = taskById(input.dataset.taskId);
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    setStatus(`Saving bay ${task.bayNumber}...`, 'info');
    try {
      const compressed = await compressPhoto(file);
      await savePhoto(buildPhotoRecord(task, compressed));
      const nextTask = findNextNeededTask(task.id);
      nextTaskId = nextTask?.id || null;
      const shouldOpenNextCamera = input.dataset.mode === 'take' && !!nextTask;
      setStatus(
        shouldOpenNextCamera ? `Saved. Opening bay ${nextTask.bayNumber}.` : nextTask ? `Next: Bay ${nextTask.bayNumber}.` : 'Complete.',
        'good'
      );
      await refresh();
      focusNextTask();
      if (shouldOpenNextCamera) openNextCamera(nextTask.id);
    } catch (err) {
      setStatus(err.message || 'Save failed.', 'error');
    }
  }

  async function handleSetBulk(input) {
    const setTasks = tasksForSet(input.dataset.setId);
    const files = Array.from(input.files || []);
    input.value = '';
    if (!setTasks.length || !files.length) return;

    const openTasks = setTasks.filter((task) => !photoState.has(task.id));
    const capturedTasks = setTasks.filter((task) => photoState.has(task.id));
    const orderedTargets = files.length >= setTasks.length ? setTasks : [...openTasks, ...capturedTasks];
    const targetTasks = orderedTargets.slice(0, Math.min(files.length, setTasks.length));

    clearPendingBulk();
    pendingBulk = {
      setId: input.dataset.setId,
      items: files.slice(0, targetTasks.length).map((file, index) => ({
        file,
        url: URL.createObjectURL(file),
        assignmentBayNumber: targetTasks[index].bayNumber,
      })),
    };
    setStatus(`Review ${pendingBulk.items.length}.`, 'info');
    await refresh();
    document.querySelector(`.bulk-review[data-set-id="${pendingBulk.setId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function handleBulkBayChange(select) {
    if (!pendingBulk) return;
    const item = pendingBulk.items[Number(select.dataset.bulkIndex)];
    if (item) item.assignmentBayNumber = parseInt(select.value, 10);
  }

  async function savePendingBulk() {
    if (!pendingBulk) return;
    const setTasks = tasksForSet(pendingBulk.setId);
    const bayNumbers = pendingBulk.items.map((item) => item.assignmentBayNumber);
    if (new Set(bayNumbers).size !== bayNumbers.length) {
      setStatus('Duplicate bay selected.', 'error');
      return;
    }

    let lastTask = null;
    try {
      for (let i = 0; i < pendingBulk.items.length; i += 1) {
        const item = pendingBulk.items[i];
        const task = setTasks.find((candidate) => candidate.bayNumber === item.assignmentBayNumber);
        if (!task) throw new Error(`Bay ${item.assignmentBayNumber} not found.`);
        setStatus(`Saving ${i + 1}/${pendingBulk.items.length}...`, 'info');
        const compressed = await compressPhoto(item.file);
        await savePhoto(buildPhotoRecord(task, compressed));
        lastTask = task;
      }
      const nextTask = findNextNeededTask(lastTask?.id);
      nextTaskId = nextTask?.id || null;
      const savedCount = pendingBulk.items.length;
      clearPendingBulk();
      setStatus(`Saved ${savedCount}.`, 'good');
      await refresh();
      focusNextTask();
    } catch (err) {
      setStatus(err.message || 'Bulk add failed.', 'error');
    }
  }

  function buildBatches(records) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const record of records) {
      if (current.length && currentBytes + record.bytes > BATCH_MAX_BYTES) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(record);
      currentBytes += record.bytes;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  function payloadRecord(record) {
    return {
      id: record.id,
      fileName: record.fileName,
      contentType: record.contentType,
      imageBase64: record.dataUrl,
      bytes: record.bytes,
      capturedAt: record.capturedAt,
      bayNumber: record.bayNumber,
      manifest: record.manifest,
    };
  }

  async function uploadRecords(records) {
    const batches = buildBatches(records);
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      setStatus(`Sending ${i + 1}/${batches.length}...`, 'info');
      const res = await fetch(`${API_BASE}/api/fm391-p05w3/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store: manifest.store,
          periodWeek: manifest.periodWeek,
          workDate: manifest.workDate,
          batchIndex: i + 1,
          totalBatches: batches.length,
          photos: batch.map(payloadRecord),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || `Batch ${i + 1} failed with HTTP ${res.status}`);
      }
      await Promise.all(batch.map((record) =>
        patchPhoto(record.id, {
          sentAt: new Date().toISOString(),
          resendId: json.resendId || null,
        })
      ));
      await refresh();
    }
  }

  async function sendPhotos({ includeSent }) {
    const records = Array.from(photoState.values())
      .filter((record) => includeSent || !record.sentAt)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!records.length) {
      setStatus(includeSent ? 'No photos captured.' : 'No unsent photos.', 'warn');
      return;
    }

    els.sendButton.disabled = true;
    els.resendButton.disabled = true;
    try {
      await uploadRecords(records);
      setStatus(`Sent ${records.length}.`, 'good');
    } catch (err) {
      setStatus(err.message || 'Upload failed.', 'error');
    } finally {
      updateProgress();
    }
  }

  function wireEvents() {
    els.setList.addEventListener('change', (event) => {
      if (event.target.matches('.set-file-input')) {
        handleSetBulk(event.target);
      } else if (event.target.matches('.bay-file-input')) {
        handleCapture(event.target);
      } else if (event.target.matches('.bulk-bay-select')) {
        handleBulkBayChange(event.target);
      }
    });
    els.setList.addEventListener('click', (event) => {
      if (event.target.matches('.bulk-save-button')) {
        savePendingBulk();
      } else if (event.target.matches('.bulk-cancel-button')) {
        clearPendingBulk();
        setStatus('Cancelled.', 'warn');
        refresh();
      }
    });
    els.sendButton.addEventListener('click', () => sendPhotos({ includeSent: false }));
    els.resendButton.addEventListener('click', () => sendPhotos({ includeSent: true }));
    els.clearButton.addEventListener('click', async () => {
      if (!confirm('Clear all captured photos stored on this device?')) return;
      clearPendingBulk();
      await clearPhotos();
      setStatus('Cleared.', 'warn');
      await refresh();
    });
  }

  async function init() {
    wireEvents();
    await refresh();
    setStatus('', 'info');
  }

  init().catch((err) => setStatus(err.message || 'App failed.', 'error'));
}());
