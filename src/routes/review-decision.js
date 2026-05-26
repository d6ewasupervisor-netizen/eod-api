// GET /api/review/:id — mobile review page (prefetch-safe, no commit)
// POST /api/review/:id/submit — atomic decision
// GET /api/review/:id/status — polled by local flow

const express = require('express');
const crypto = require('node:crypto');
const {
  getReviewSession,
  submitReviewDecision,
  ackReviewDecision,
} = require('../lib/review-sessions-db');
const { computeReviewToken } = require('./review-tokens');

const router = express.Router({ mergeParams: true });
router.use(express.urlencoded({ extended: false }));

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function verifyToken(reviewId, action, approverEmail, token) {
  let expected;
  try {
    expected = computeReviewToken(reviewId, action, approverEmail);
  } catch {
    return false;
  }
  const tokBuf = Buffer.from(String(token || ''), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  return tokBuf.length === expBuf.length && crypto.timingSafeEqual(tokBuf, expBuf);
}

const PAGE_CSS = `
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f2f5;margin:0;padding:12px;color:#1f2937;font-size:16px;line-height:1.45}
    .card{background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);padding:16px;margin-bottom:12px;border:1px solid #e5e7eb}
    h1{font-size:20px;color:#1a3a6e;margin:0 0 8px}
    h2{font-size:16px;color:#1a3a6e;margin:0 0 10px}
    .muted{color:#6b7280;font-size:13px}
    .badge{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px}
    .hard{background:#fef2f2;color:#b91c1c}
    .soft{background:#eff6ff;color:#1d4ed8}
    .locked{background:#f3f4f6;color:#6b7280}
    .finding{padding:12px 0;border-bottom:1px solid #f3f4f6}
    .finding:last-child{border-bottom:0}
    .fix{font-size:13px;color:#374151;background:#f9fafb;border-radius:8px;padding:8px;margin-top:6px;white-space:pre-wrap}
    .finding-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .finding-actions button{flex:1;min-width:120px;padding:12px 10px;font:inherit;font-weight:700;border-radius:10px;border:0;cursor:pointer}
    .btn-accept{background:#15803d;color:#fff}
    .btn-reject{background:#fff;color:#6b7280;border:1px solid #d1d5db!important}
    .finding-check{position:absolute;opacity:0;pointer-events:none;width:0;height:0}
    textarea.sec-field{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
    .sec-preview{white-space:pre-wrap;font-size:15px;color:#374151;margin:8px 0 0;max-height:8em;overflow:hidden}
    .sec-preview.expanded{max-height:none}
    .struct{display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;margin-top:8px}
    .struct div{background:#f9fafb;padding:6px 8px;border-radius:6px}
    .struct-locked .struct div{background:#f3f4f6;color:#6b7280}
    .edit-btn{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:12px 16px;font:inherit;font-weight:600;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#1a3a6e;cursor:pointer;min-height:44px}
    .edit-btn:active{background:#f3f4f6}
    .gm-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
    .gm-table th,.gm-table td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}
    .gm-table th{background:#f9fafb;font-weight:700}
    .gm-table td:first-child,.gm-table th:first-child{white-space:nowrap}
    .gm-totals{margin-top:10px;font-size:14px}
    .actions{position:sticky;bottom:0;background:#f0f2f5;padding:12px 0;margin-top:8px}
    button{font:inherit;border:0;border-radius:10px;padding:14px;width:100%;font-weight:700;cursor:pointer;margin-bottom:8px}
    .approve{background:#15803d;color:#fff}
    .approveAlt{background:#1a3a6e;color:#fff}
    .reject{background:#fff;color:#b91c1c;border:2px solid #fecaca}
    .promo{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;margin:8px 0}
    .fs-editor{position:fixed;inset:0;z-index:100;background:#fff;display:flex;flex-direction:column}
    .fs-editor.hidden{display:none}
    .fs-bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb;gap:8px;min-height:52px}
    .fs-bar h2{flex:1;font-size:16px;margin:0;text-align:center;color:#1a3a6e}
    .fs-bar button{font:inherit;font-weight:700;border:0;background:none;color:#1a3a6e;padding:10px 12px;cursor:pointer;min-width:72px;min-height:44px;border-radius:8px}
    .fs-bar button.fs-done{color:#15803d;font-weight:800}
    .fs-body{flex:1;display:flex;flex-direction:column;padding:12px 16px 16px;overflow:auto}
    .fs-locked{margin-bottom:12px;padding:10px;background:#f3f4f6;border-radius:8px;font-size:13px;color:#6b7280}
    .fs-locked .struct{margin-top:6px}
    #fsTextarea{flex:1;width:100%;min-height:50vh;font:inherit;font-size:17px;line-height:1.5;border:1px solid #d1d5db;border-radius:10px;padding:14px;resize:none}
  </style>`;

function renderError(title, msg) {
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${esc(title)}</title></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

function renderGmTable(gm) {
  let body = '<table class="gm-table"><thead><tr><th>COM#</th><th>Description</th><th>Hours</th><th>Type</th></tr></thead><tbody>';
  for (const row of (gm.rows || [])) {
    body += `<tr><td>${esc(row.com_code)}</td><td>${esc(row.description)}</td>`
      + `<td>${esc(row.hours != null ? row.hours : '')}</td><td>${esc(row.type || '')}</td></tr>`;
  }
  body += '</tbody></table>';
  const totals = [];
  if (gm.total_no_blitz_hours != null) totals.push(`Total (no blitz): ${gm.total_no_blitz_hours} hrs`);
  if (gm.total_with_blitz_hours != null) totals.push(`Total (with blitz): ${gm.total_with_blitz_hours} hrs`);
  if (totals.length) {
    body += `<p class="gm-totals"><strong>${esc(totals.join(' · '))}</strong></p>`;
  }
  return body;
}

function renderEditableField(sec, prose, lockedMeta) {
  const fieldId = `sec-${esc(sec.id)}`;
  const preview = esc(prose).slice(0, 600) + (prose.length > 600 ? '…' : '');
  const metaJson = lockedMeta ? esc(JSON.stringify(lockedMeta)) : '';
  return `<div class="sec-preview" id="preview-${fieldId}">${preview || '<span class="muted">(empty)</span>'}</div>`
    + `<textarea name="section_${esc(sec.anchor)}" id="${fieldId}" class="sec-field">${esc(prose)}</textarea>`
    + `<button type="button" class="edit-btn" data-field="${fieldId}" data-label="${esc(sec.label)}"`
    + ` data-locked-meta="${metaJson}">Edit</button>`;
}

function renderSectionCard(sec) {
  const locked = sec.locked ? '<span class="badge locked">locked</span>' : '';
  let body = '';

  if (sec.kind === 'gm-table' && sec.content && typeof sec.content === 'object') {
    body = renderGmTable(sec.content);
  } else if (sec.kind === 'card' && sec.content && typeof sec.content === 'object') {
    const c = sec.content;
    body += `<div class="struct struct-locked">`;
    if (c.comCode) body += `<div><strong>COM#</strong> ${esc(c.comCode)}</div>`;
    if (c.type?.value != null || c.type) body += `<div><strong>Type</strong> ${esc(c.type?.value ?? c.type)}</div>`;
    if (c.hours?.value != null || c.hours != null) body += `<div><strong>Hours</strong> ${esc(c.hours?.value ?? c.hours)}</div>`;
    if (c.new?.value != null || c.new != null) body += `<div><strong>New</strong> ${esc(c.new?.display ?? c.new?.value ?? c.new ?? '—')}</div>`;
    if (c.changes?.value != null || c.changes != null) body += `<div><strong>Changes</strong> ${esc(c.changes?.display ?? c.changes?.value ?? c.changes ?? '—')}</div>`;
    if (c.deletes?.value != null || c.deletes != null) body += `<div><strong>Deletes</strong> ${esc(c.deletes?.display ?? c.deletes?.value ?? c.deletes ?? '—')}</div>`;
    body += `</div>`;
    const prose = c.prose || '';
    if (sec.locked) {
      body += `<p style="margin-top:10px">${esc(prose)}</p>`;
    } else {
      const lockedMeta = {
        comCode: c.comCode,
        type: c.type?.value ?? c.type,
        hours: c.hours?.value ?? c.hours,
        new: c.new?.display ?? c.new?.value ?? c.new,
        changes: c.changes?.display ?? c.changes?.value ?? c.changes,
        deletes: c.deletes?.display ?? c.deletes?.value ?? c.deletes,
      };
      body += renderEditableField(sec, prose, lockedMeta);
    }
  } else if (typeof sec.content === 'string') {
    if (sec.locked) {
      body += `<p>${esc(sec.content)}</p>`;
    } else {
      body += renderEditableField(sec, sec.content, null);
    }
  } else if (Array.isArray(sec.content)) {
    const text = sec.content.join('\n');
    body += sec.locked
      ? `<p>${esc(text)}</p>`
      : renderEditableField(sec, text, null);
  }

  return `<div class="card"><h2>${esc(sec.label)} ${locked}</h2>${body}</div>`;
}

function renderFindingRow(f, defaultChecked) {
  const checked = defaultChecked ? ' checked' : '';
  return `<div class="finding" data-finding-id="${esc(f.id)}">
    <input type="checkbox" name="finding" value="${esc(f.id)}" class="finding-check" id="find-${esc(f.id)}"${checked}>
    <div><strong>${esc(f.ruleName)}</strong>${f.tier === 'soft' ? ` <span class="muted">(${Math.round((f.confidence || 0) * 100)}%)</span>` : ''} — ${esc(f.message)}
    ${f.proposedFix ? `<div class="fix">${esc(f.proposedFix)}</div>` : ''}
    ${f.proposedFix ? `<div class="finding-actions">
      <button type="button" class="btn-accept accept-fix" data-finding-id="${esc(f.id)}" data-anchor="${esc(f.anchor || '')}">Accept</button>
      <button type="button" class="btn-reject reject-fix" data-finding-id="${esc(f.id)}">Reject</button>
    </div>` : ''}
    </div></div>`;
}

function renderReviewPage(session, reviewToken, submitToken, approverEmail) {
  const draft = session.draft_json || {};
  const findings = session.findings_json || [];
  const offers = session.promotion_offers_json || [];
  const hard = findings.filter((f) => f.tier === 'hard');
  const soft = findings.filter((f) => f.tier === 'soft');

  let findingsHtml = '';
  if (hard.length) {
    findingsHtml += `<div class="card"><h2>Hard findings <span class="badge hard">${hard.length}</span></h2>`;
    for (const f of hard) findingsHtml += renderFindingRow(f, true);
    findingsHtml += '</div>';
  }
  if (soft.length) {
    findingsHtml += `<div class="card"><h2>Soft suggestions <span class="badge soft">${soft.length}</span></h2>`;
    for (const f of soft) findingsHtml += renderFindingRow(f, false);
    findingsHtml += '</div>';
  }

  let promoHtml = '';
  if (offers.length) {
    promoHtml = `<div class="card"><h2>Make permanent?</h2>`;
    for (const o of offers) {
      promoHtml += `<label class="promo"><input type="checkbox" name="promotion" value="${esc(o.id)}">
        ${esc(o.summary)} <span class="muted">(${o.occurrenceCount} weeks)</span></label>`;
    }
    promoHtml += '</div>';
  }

  const sectionsHtml = (draft.sections || []).map(renderSectionCard).join('');
  const findingFixesJson = JSON.stringify(
    findings.filter((f) => f.proposedFix).map((f) => ({
      id: f.id,
      anchor: f.anchor,
      fix: f.proposedFix,
    })),
  ).replace(/</g, '\\u003c');

  return `<!DOCTYPE html><html><head>${PAGE_CSS}
<title>Review ${esc(session.surface_id)} ${esc(session.period_week || '')}</title></head>
<body>
<div class="card">
  <h1>${esc(session.surface_id)} ${esc(session.period_week || '')}</h1>
  <p class="muted">Accept fixes with one tap, or tap Edit on a section for full-screen editing. GET-only prefetch cannot publish.</p>
</div>
${findingsHtml}
${promoHtml}
<form method="post" action="/api/review/${esc(session.id)}/submit" id="reviewForm">
  <input type="hidden" name="token" value="${esc(submitToken)}">
  <input type="hidden" name="by" value="${esc(approverEmail)}">
  ${sectionsHtml}
  <div class="actions">
    <button type="submit" name="action" value="approve" class="approve">Approve &amp; Publish</button>
    <button type="submit" name="action" value="approve" class="approveAlt">Approve with my changes</button>
    <button type="submit" name="action" value="reject" class="reject">Reject — do not publish</button>
  </div>
</form>
<div id="fsEditor" class="fs-editor hidden" aria-hidden="true">
  <div class="fs-bar">
    <button type="button" id="fsCancel">Cancel</button>
    <h2 id="fsLabel"></h2>
    <button type="button" id="fsDone" class="fs-done">Done</button>
  </div>
  <div class="fs-body">
    <div id="fsLocked" class="fs-locked hidden"></div>
    <textarea id="fsTextarea"></textarea>
  </div>
</div>
<script>
(function() {
  var FINDING_FIXES = ${findingFixesJson};
  var fs = document.getElementById('fsEditor');
  var fsText = document.getElementById('fsTextarea');
  var fsLabel = document.getElementById('fsLabel');
  var fsLocked = document.getElementById('fsLocked');
  var activeField = null;
  var snapshot = '';

  function anchorToFieldId(anchor) {
    var el = document.querySelector('textarea[name="section_' + anchor + '"]');
    return el ? el.id : null;
  }

  function updatePreview(fieldId) {
    var field = document.getElementById(fieldId);
    var preview = document.getElementById('preview-' + fieldId);
    if (!field || !preview) return;
    var text = field.value || '';
    preview.textContent = text.length > 600 ? text.slice(0, 600) + '…' : (text || '(empty)');
  }

  function renderLockedMeta(meta) {
    if (!meta) return '';
    var parts = [];
    if (meta.comCode) parts.push('<div><strong>COM#</strong> ' + meta.comCode + '</div>');
    if (meta.type != null) parts.push('<div><strong>Type</strong> ' + meta.type + '</div>');
    if (meta.hours != null) parts.push('<div><strong>Hours</strong> ' + meta.hours + '</div>');
    if (meta.new != null) parts.push('<div><strong>New</strong> ' + meta.new + '</div>');
    if (meta.changes != null) parts.push('<div><strong>Changes</strong> ' + meta.changes + '</div>');
    if (meta.deletes != null) parts.push('<div><strong>Deletes</strong> ' + meta.deletes + '</div>');
    return '<span class="badge locked">locked fields</span><div class="struct">' + parts.join('') + '</div>';
  }

  function openEditor(btn) {
    var fieldId = btn.getAttribute('data-field');
    var field = document.getElementById(fieldId);
    if (!field) return;
    activeField = field;
    snapshot = field.value;
    fsLabel.textContent = btn.getAttribute('data-label') || 'Edit section';
    fsText.value = field.value;
    var metaRaw = btn.getAttribute('data-locked-meta');
    if (metaRaw) {
      try {
        fsLocked.innerHTML = renderLockedMeta(JSON.parse(metaRaw));
        fsLocked.classList.remove('hidden');
      } catch (e) {
        fsLocked.classList.add('hidden');
      }
    } else {
      fsLocked.classList.add('hidden');
      fsLocked.innerHTML = '';
    }
    fs.classList.remove('hidden');
    fs.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(function() { fsText.focus(); }, 50);
  }

  function closeEditor(save) {
    if (save && activeField) {
      activeField.value = fsText.value;
      updatePreview(activeField.id);
    } else if (activeField) {
      activeField.value = snapshot;
    }
    fs.classList.add('hidden');
    fs.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    activeField = null;
    snapshot = '';
  }

  document.querySelectorAll('.edit-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { openEditor(btn); });
  });
  document.getElementById('fsCancel').addEventListener('click', function() { closeEditor(false); });
  document.getElementById('fsDone').addEventListener('click', function() { closeEditor(true); });

  function setFindingChecked(id, checked) {
    var cb = document.getElementById('find-' + id);
    if (cb) cb.checked = checked;
  }

  function applyFix(anchor, fix) {
    var fieldId = anchorToFieldId(anchor);
    if (!fieldId) return;
    var field = document.getElementById(fieldId);
    if (!field) return;
    field.value = fix;
    updatePreview(fieldId);
  }

  document.querySelectorAll('.accept-fix').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var fid = btn.getAttribute('data-finding-id');
      var anchor = btn.getAttribute('data-anchor');
      var entry = FINDING_FIXES.find(function(x) { return x.id === fid; });
      if (entry && entry.fix) {
        applyFix(entry.anchor || anchor, entry.fix);
        setFindingChecked(fid, true);
      }
    });
  });

  document.querySelectorAll('.reject-fix').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setFindingChecked(btn.getAttribute('data-finding-id'), false);
    });
  });

  document.getElementById('reviewForm').addEventListener('submit', function() {
    var btn = document.activeElement;
    if (btn && btn.name === 'action') return;
  });
})();
</script>
</body></html>`;
}

function renderConfirmPage(session, submitToken, approverEmail) {
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>Confirm publish</title></head>
<body><div class="card">
  <h1>Confirm publish</h1>
  <p>This will record your decision and release <strong>${esc(session.surface_id)} ${esc(session.period_week || '')}</strong> for local PDF publish.</p>
  <p class="muted">Email link scanners cannot reach this step — only this form POST commits.</p>
  <form method="post" action="/api/review/${esc(session.id)}/submit">
    <input type="hidden" name="token" value="${esc(submitToken)}">
    <input type="hidden" name="by" value="${esc(approverEmail)}">
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">Yes, approve &amp; publish</button>
      <button type="submit" name="action" value="reject" class="reject">Reject</button>
    </div>
  </form>
</div></body></html>`;
}

function parseSectionEdits(body, draft) {
  const edits = {};
  for (const sec of (draft?.sections || [])) {
    if (sec.locked) continue;
    const key = `section_${sec.anchor}`;
    if (body[key] != null) edits[sec.anchor] = String(body[key]);
  }
  return edits;
}

function authorizeBearer(req, res, next) {
  const secret = process.env.REVIEW_REQUEST_SECRET;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secret || token !== secret) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

function buildStatusResponse(session) {
  if (!session) return { notFound: true };

  if (session.status === 'pending') {
    if (new Date(session.expires_at) < new Date()) {
      return { expired: true };
    }
    return { status: 'pending' };
  }

  if (session.status === 'purged') {
    return { purged: true };
  }

  if (session.decision_payload) {
    return {
      decided: true,
      payload: session.decision_payload,
    };
  }

  if (session.status === 'expired') {
    return { expired: true };
  }

  return { purged: true };
}

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { token, by: approverEmail } = req.query;
    if (!verifyToken(id, 'review', approverEmail, token)) {
      return res.status(403).send(renderError('Invalid link', 'This review link is invalid or has been tampered with.'));
    }
    const session = await getReviewSession(id);
    if (!session) return res.status(404).send(renderError('Not found', 'Review session not found.'));
    if (session.status !== 'pending') {
      return res.send(renderError('Already decided', `This review was already ${session.status}.`));
    }
    if (new Date(session.expires_at) < new Date()) {
      return res.send(renderError('Expired', 'This review session has expired.'));
    }
    const submitToken = computeReviewToken(id, 'submit', approverEmail);
    return res.send(renderReviewPage(session, token, submitToken, approverEmail));
  } catch (err) {
    console.error('[review-decision] GET', err);
    return res.status(500).send(renderError('Error', 'Could not load review page.'));
  }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;
    const { token, by: approverEmail, action } = req.body || {};
    if (!verifyToken(id, 'submit', approverEmail, token)) {
      return res.status(403).send(renderError('Invalid submission', 'Token verification failed.'));
    }
    const session = await getReviewSession(id);
    if (!session) return res.status(404).send(renderError('Not found', 'Review session not found.'));
    if (session.status !== 'pending') {
      return res.send(renderError('Already decided', `This review was already ${session.status}.`));
    }

    const draft = session.draft_json || {};
    const allFindings = session.findings_json || [];
    const acceptedFindingIds = [];
    const findingInputs = req.body.finding;
    const findingList = findingInputs == null ? [] : (Array.isArray(findingInputs) ? findingInputs : [findingInputs]);
    for (const fid of findingList) acceptedFindingIds.push(String(fid));

    const promoInputs = req.body.promotion;
    const promoList = promoInputs == null ? [] : (Array.isArray(promoInputs) ? promoInputs : [promoInputs]);

    const decisionPayload = {
      action: action === 'reject' ? 'reject' : 'approve',
      acceptedFindingIds,
      rejectedSoftFindingIds: allFindings
        .filter((f) => f.tier === 'soft' && !acceptedFindingIds.includes(f.id))
        .map((f) => f.id),
      sectionEdits: parseSectionEdits(req.body, draft),
      acceptedPromotionOfferIds: promoList.map(String),
      decidedBy: approverEmail,
      decidedAtIso: new Date().toISOString(),
    };

    const decided = await submitReviewDecision(id, decisionPayload, decisionPayload.action);
    if (!decided) {
      const current = await getReviewSession(id);
      if (current) return res.send(renderError('Already decided', `This review was already ${current.status}.`));
      return res.status(404).send(renderError('Not found', 'Review session not found.'));
    }

    console.log(`[review-decision] ${decisionPayload.action} by ${approverEmail} for ${id}`);
    const msg = decisionPayload.action === 'approve'
      ? 'Approved — the local flow will publish the PDF shortly.'
      : 'Rejected — no PDF will be published.';
    return res.send(`<!DOCTYPE html><html><head>${PAGE_CSS}<title>Decision recorded</title></head>
<body><div class="card"><h1>Decision recorded</h1><p>${esc(msg)}</p></div></body></html>`);
  } catch (err) {
    console.error('[review-decision] POST', err);
    return res.status(500).send(renderError('Error', 'Could not record decision.'));
  }
});

router.get('/:id/status', authorizeBearer, async (req, res) => {
  try {
    const session = await getReviewSession(req.params.id);
    const body = buildStatusResponse(session);
    if (body.notFound) {
      return res.status(404).json({ ok: false, notFound: true, error: 'Not found' });
    }
    return res.json({ ok: true, ...body });
  } catch (err) {
    console.error('[review-decision] status', err);
    return res.status(500).json({ ok: false, error: 'Status check failed' });
  }
});

router.post('/:id/ack', authorizeBearer, async (req, res) => {
  try {
    const acked = await ackReviewDecision(req.params.id);
    if (!acked) {
      const session = await getReviewSession(req.params.id);
      if (!session) {
        return res.status(404).json({ ok: false, error: 'Not found' });
      }
      if (session.payload_acked_at) {
        return res.json({ ok: true, alreadyAcked: true });
      }
      return res.status(410).json({ ok: false, purged: true, error: 'Decision payload no longer available' });
    }
    console.log(`[review-decision] ack for ${req.params.id}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[review-decision] ack', err);
    return res.status(500).json({ ok: false, error: 'Ack failed' });
  }
});

module.exports = router;
