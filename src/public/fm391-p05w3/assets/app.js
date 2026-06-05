(function () {
  'use strict';

  const manifest = window.FM391_PHOTO_MANIFEST;
  const DB_NAME = 'fm391-p05w3-photos';
  const STORE_NAME = 'photos';
  const PHOTO_MAX_BYTES = 950 * 1024;
  const BATCH_MAX_BYTES = 17 * 1024 * 1024;
  const MAX_EDGE = 1600;
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

  function canvasDataUrl(canvas, quality) {
    return canvas.toDataURL('image/jpeg', quality);
  }

  async function compressPhoto(file) {
    const img = await readFileAsImage(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

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

  function renderSets() {
    els.setList.innerHTML = manifest.sets.map((set) => {
      const setTasks = tasks.filter((task) => task.setId === set.id);
      const captured = setTasks.filter((task) => photoState.has(task.id)).length;
      const needed = set.bays - captured;
      const bayRows = setTasks.map((task) => {
        const photo = photoState.get(task.id);
        const sentText = photo?.sentAt ? 'Sent' : photo ? 'Captured' : 'Needed';
        return `
          <div class="bay-row ${photo ? 'captured' : ''}" data-task-id="${task.id}">
            <div>
              <div class="bay-label">Bay ${task.bayNumber} of ${set.bays}</div>
              <div class="bay-detail">${sentText}</div>
            </div>
            <label class="capture-label">
              ${photo ? 'Retake' : 'Take photo'}
              <input class="file-input" type="file" accept="image/*" capture="environment" data-task-id="${task.id}">
            </label>
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
            </div>
            <div class="set-count">${captured} captured<br>${needed} needed</div>
          </div>
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

  async function handleCapture(input) {
    const task = taskById(input.dataset.taskId);
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    setStatus(`Saving bay ${task.bayNumber}...`, 'info');
    try {
      const compressed = await compressPhoto(file);
      await savePhoto({
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
      });
      setStatus(`Bay ${task.bayNumber} captured.`, 'good');
      await refresh();
    } catch (err) {
      setStatus(err.message || 'Save failed.', 'error');
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
      if (event.target.matches('.file-input')) {
        handleCapture(event.target);
      }
    });
    els.sendButton.addEventListener('click', () => sendPhotos({ includeSent: false }));
    els.resendButton.addEventListener('click', () => sendPhotos({ includeSent: true }));
    els.clearButton.addEventListener('click', async () => {
      if (!confirm('Clear all captured photos stored on this device?')) return;
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
