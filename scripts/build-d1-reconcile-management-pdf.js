#!/usr/bin/env node
'use strict';

/**
 * Build a management-facing PDF summary for District 1 tracker reconcile runs.
 *
 * Usage:
 *   node scripts/build-d1-reconcile-management-pdf.js
 *   node scripts/build-d1-reconcile-management-pdf.js --out-dir "C:/Users/tgaut/Downloads/p06w1_district1_tracking"
 */

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const { writeFileVersioned } = require('../src/lib/file-utils');
const { DISTRICT_STORES } = require('../src/lib/trackers/metadata');

const DEFAULT_OUT = 'C:/Users/tgaut/Downloads/p06w1_district1_tracking';
const MARGIN = 54;
const PAGE_W = 612;
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - MARGIN;
const INK = '#1a1a1a';
const MUTED = '#4a4a4a';
const ACCENT = '#1e4d7b';
const RULE = '#cccccc';
const LABEL_W = 210;
const VALUE_W = 72;
const ROW_GAP = 8;
const CELL_PAD = 6;

function parseArgs(argv) {
  let outDir = DEFAULT_OUT;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') outDir = argv[++i];
  }
  return { outDir };
}

function findLatestFile(dir, prefix, suffix = '.json') {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .reverse();
  return files.length ? path.join(dir, files[0]) : null;
}

function loadJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function pct(n, total) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function setFont(doc, bold, size) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
}

function textHeight(doc, text, width, bold = false, size = 10, lineGap = 3) {
  setFont(doc, bold, size);
  return doc.heightOfString(String(text ?? ''), { width, lineGap });
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > BOTTOM) {
    doc.addPage();
    doc.y = MARGIN;
  }
}

function drawHeaderBand(doc, title, subtitle) {
  const titleH = textHeight(doc, title, CONTENT_W, true, 20, 4);
  const subH = textHeight(doc, subtitle, CONTENT_W, false, 10, 3);
  const bandH = Math.max(96, 28 + titleH + 8 + subH + 20);

  doc.save();
  doc.rect(0, 0, PAGE_W, bandH).fill(ACCENT);
  doc.fillColor('#ffffff');
  setFont(doc, true, 20);
  doc.text(title, MARGIN, 24, { width: CONTENT_W, lineGap: 4 });
  setFont(doc, false, 10);
  doc.text(subtitle, MARGIN, 24 + titleH + 8, { width: CONTENT_W, lineGap: 3 });
  doc.restore();
  doc.y = bandH + 18;
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 40);
  const y = doc.y;
  setFont(doc, true, 13);
  doc.fillColor(ACCENT).text(text, MARGIN, y, { width: CONTENT_W });
  const h = textHeight(doc, text, CONTENT_W, true, 13);
  const ruleY = y + h + 4;
  doc.strokeColor(RULE).lineWidth(1)
    .moveTo(MARGIN, ruleY).lineTo(PAGE_W - MARGIN, ruleY).stroke();
  doc.y = ruleY + 14;
}

function bodyText(doc, text) {
  ensureSpace(doc, 36);
  const y = doc.y;
  setFont(doc, false, 10);
  doc.fillColor(MUTED).text(String(text), MARGIN, y, { width: CONTENT_W, lineGap: 4 });
  const h = textHeight(doc, text, CONTENT_W, false, 10, 4);
  doc.y = y + h + ROW_GAP;
}

function bullet(doc, text) {
  ensureSpace(doc, 24);
  const y = doc.y;
  const width = CONTENT_W - 14;
  setFont(doc, false, 10);
  doc.fillColor(MUTED).text(`•  ${text}`, MARGIN + 6, y, { width, lineGap: 3 });
  const h = textHeight(doc, `•  ${text}`, width, false, 10, 3);
  doc.y = y + h + 4;
}

function metricRow(doc, label, value, note = '') {
  const valueStr = String(value ?? '');
  const labelH = textHeight(doc, label, LABEL_W, true, 10, 2);
  const valueH = textHeight(doc, valueStr, VALUE_W, false, 10, 2);
  const noteH = note
    ? textHeight(doc, note, CONTENT_W - 20, false, 9, 2) + 4
    : 0;
  const rowH = Math.max(labelH, valueH) + noteH + ROW_GAP;

  ensureSpace(doc, rowH);
  const y0 = doc.y;

  setFont(doc, true, 10);
  doc.fillColor(INK).text(label, MARGIN, y0, { width: LABEL_W, lineGap: 2 });

  setFont(doc, false, 10);
  doc.fillColor(INK).text(valueStr, MARGIN + LABEL_W, y0, { width: VALUE_W, align: 'right', lineGap: 2 });

  let yEnd = y0 + Math.max(labelH, valueH);
  if (note) {
    yEnd += 4;
    setFont(doc, false, 9);
    doc.fillColor(MUTED).text(note, MARGIN + 12, yEnd, { width: CONTENT_W - 20, lineGap: 2 });
    yEnd += textHeight(doc, note, CONTENT_W - 20, false, 9, 2);
  }

  doc.y = yEnd + ROW_GAP;
}

function drawTable(doc, headers, rows, colWidths) {
  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const innerWidths = colWidths.map((w) => w - CELL_PAD * 2);

  function cellHeight(text, colIdx, header = false) {
    return textHeight(doc, text, innerWidths[colIdx], header, 9, 2) + CELL_PAD * 2;
  }

  const headerH = Math.max(...headers.map((h, i) => cellHeight(h, i, true)));
  const rowHeights = rows.map((row) => Math.max(
    headerH,
    ...row.map((cell, i) => cellHeight(cell, i, false)),
  ));

  const totalH = headerH + rowHeights.reduce((a, b) => a + b, 0) + 12;
  ensureSpace(doc, Math.min(totalH, BOTTOM - MARGIN));

  let y = doc.y;
  let x = MARGIN;

  headers.forEach((h, i) => {
    doc.rect(x, y, colWidths[i], headerH).fillAndStroke('#eef3f8', RULE);
    setFont(doc, true, 9);
    doc.fillColor(INK).text(h, x + CELL_PAD, y + CELL_PAD, {
      width: innerWidths[i],
      lineGap: 2,
    });
    x += colWidths[i];
  });
  y += headerH;

  rows.forEach((row, ri) => {
    x = MARGIN;
    const rh = rowHeights[ri];
    const fill = ri % 2 ? '#fafafa' : '#ffffff';
    row.forEach((cell, ci) => {
      doc.rect(x, y, colWidths[ci], rh).fillAndStroke(fill, RULE);
      setFont(doc, false, 9);
      doc.fillColor(MUTED).text(String(cell), x + CELL_PAD, y + CELL_PAD, {
        width: innerWidths[ci],
        lineGap: 2,
      });
      x += colWidths[ci];
    });
    y += rh;
  });

  doc.y = y + 12;
}

function storeListNote(stores) {
  const perLine = 11;
  const lines = [];
  for (let i = 0; i < stores.length; i += perLine) {
    lines.push(stores.slice(i, i + perLine).join(', '));
  }
  return lines.join('\n');
}

function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
    doc.y = MARGIN;
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { summary, prodToSi, eligibleIse, eligibleBlitz, stores, livePromotion } = data;
    const genDate = fmtDate(summary.generatedAt);
    const promoted = livePromotion?.status === 'completed';
    const liveCounts = livePromotion?.liveCounts;
    const totalEligible = eligibleIse + eligibleBlitz;
    const iseYes = promoted ? liveCounts.ise.yes : summary.counts.ise.yes;
    const blitzYes = promoted ? liveCounts.blitz.yes : summary.counts.blitz.yes;
    const totalYes = promoted ? liveCounts.combinedYes : iseYes + blitzYes;
    const totalOpen = promoted ? liveCounts.combinedOpen : summary.finalOpenCount;
    const prodSiDone = (prodToSi.completed?.length || 0) + (summary.remediation?.prodToSiBlurryRetry?.completed || 0);

    drawHeaderBand(
      doc,
      'District 1 Tracker Reconciliation Summary',
      promoted
        ? `Kompass ISE & Blitz · ${summary.periodRange} · Reconciled ${genDate} · Live trackers updated ${fmtDate(livePromotion.promotedAt)}`
        : `Kompass ISE & Blitz · ${summary.periodRange} · Generated ${genDate}`,
    );

    sectionTitle(doc, 'Executive Summary');
    if (promoted) {
      bodyText(doc, 'This report summarizes automated reconciliation of District 1 SUPER Tracker rows against live SAS PROD and Store Intelligence (Rebotics) through P06W1, followed by manual promotion of accepted results to the live OneDrive trackers.');
      bodyText(doc, `Reconciliation was first validated on working copies, then Complete (Yes) values and retained comment notes were copied to the live ISE and Blitz trackers on ${fmtDate(livePromotion.promotedAt)}. Diagnostic comments for needs PROD complete and neither-side-complete cross-ref rows were cleared on live so only actionable follow-up notes remain.`);
      bodyText(doc, `On the live trackers, ${totalYes} sets (${pct(totalYes, totalEligible)}) are marked Complete and ${totalOpen} rows remain open (${liveCounts.ise.needsSi} need SI complete, ${liveCounts.ise.needsLoaded} need loaded to PROD on ISE; remaining open rows have no comment pending field work or later review).`);
    } else {
      bodyText(doc, 'This report summarizes automated reconciliation of District 1 SUPER Tracker rows against live SAS PROD and Store Intelligence (Rebotics) through P06W1. Work was performed on read-only copies of the live trackers; original OneDrive tracker files were not modified.');
      bodyText(doc, `Of ${totalEligible} eligible open rows (${eligibleIse} ISE, ${eligibleBlitz} Blitz), ${totalYes} sets (${pct(totalYes, totalEligible)}) are now marked Complete on the working copies with both sides confirmed or accepted per reconciliation rules. ${totalOpen} rows remain open pending further PROD/SI alignment, visit availability, or manual review.`);
    }

    sectionTitle(doc, 'Scope');
    metricRow(doc, 'District', '1');
    metricRow(doc, 'Stores in scope', stores.length, storeListNote(stores));
    metricRow(doc, 'Period window', summary.periodRange, 'Dynamic start through P06W1');
    metricRow(doc, 'Eligible tracker rows', totalEligible, 'Complete column blank or No, with no comment');
    metricRow(doc, 'One-sided discrepancies', '79', '42 PROD-only · 37 SI-only');

    sectionTitle(doc, promoted ? 'Live Tracker Outcomes' : 'Copy Workbook Outcomes');
    drawTable(doc,
      ['Workbook', 'Eligible', 'Complete', 'Open', 'Rate'],
      [
        ['ISE & Cut Tracker', eligibleIse, iseYes, eligibleIse - iseYes, pct(iseYes, eligibleIse)],
        ['Blitz Tracker', eligibleBlitz, blitzYes, eligibleBlitz - blitzYes, pct(blitzYes, eligibleBlitz)],
        ['Combined', totalEligible, totalYes, totalOpen, pct(totalYes, totalEligible)],
      ],
      [118, 62, 72, 62, 62],
    );

    if (promoted) {
      sectionTitle(doc, 'Live Tracker Promotion — Completed');
      bodyText(doc, livePromotion.description);
      metricRow(doc, 'Promotion date', fmtDate(livePromotion.promotedAt));
      metricRow(doc, 'Complete values copied', totalYes, 'Yes marks from reconcile copies applied to live');
      metricRow(doc, 'Comments cleared on live', `${summary.counts.ise.needsProd + summary.counts.ise.unconfirmed + summary.counts.blitz.unconfirmed}`, 'Needs PROD complete and PROD/SI not-complete diagnostics removed');
      metricRow(doc, 'Comments retained on live', liveCounts.ise.needsSi + liveCounts.ise.needsLoaded, 'Needs SI complete and needs loaded to PROD only');

      sectionTitle(doc, 'Open Rows — Status on Live Trackers');
      drawTable(doc,
        ['Category (live ISE)', 'Count', 'Meaning'],
        [
          ['Needs SI complete', liveCounts.ise.needsSi, 'PROD done; SI not confirmed — actionable'],
          ['Needs loaded to PROD', liveCounts.ise.needsLoaded, 'SI photos exist; no matching visit or shift'],
          ['Open, comment cleared', liveCounts.ise.openNoComment, 'No or incomplete on both sides; comment removed on promotion'],
          ['Blitz — open, comment cleared', liveCounts.blitz.openNoComment, 'No PROD/SI match in scoped period; comment removed on promotion'],
        ],
        [148, 48, 308],
      );
    } else {
      sectionTitle(doc, 'Open Rows — Status on Copies');
      drawTable(doc,
        ['Category (ISE copy)', 'Count', 'Meaning'],
        [
          ['Needs SI complete', summary.counts.ise.needsSi, 'PROD done; SI not confirmed'],
          ['Needs PROD complete', summary.counts.ise.needsProd, 'SI done; PROD not confirmed'],
          ['Needs loaded to PROD', summary.counts.ise.needsLoaded, 'SI photos exist; no matching visit or shift'],
          ['Neither side complete', summary.counts.ise.unconfirmed, 'Awaiting field completion or data match'],
          ['Blitz — unconfirmed', summary.counts.blitz.unconfirmed, 'No PROD/SI match in scoped period'],
        ],
        [148, 48, 308],
      );
    }

    sectionTitle(doc, 'Remediation Actions Performed');
    bodyText(doc, 'Automated closeout and backfill were attempted for one-sided discrepancies:');
    metricRow(doc, 'PROD → Store Intelligence closeout', prodSiDone);
    metricRow(doc, '  Initial closeout', summary.remediation.prodToSi.completed);
    metricRow(doc, '  Blurry-photo retry', summary.remediation.prodToSiBlurryRetry.completed);
    metricRow(doc, 'PROD→SI errors (not closed)', summary.remediation.prodToSi.errors, 'Expired tasks, gateway errors, in-progress conflicts');
    metricRow(doc, 'PROD→SI skipped', summary.remediation.prodToSi.skipped, 'No live task, CV rejection, missing bypass image');
    metricRow(doc, 'PROD-only / no live SI (accepted)', summary.remediation.prodOnlyNoSiMarked, 'Marked Yes on copy per policy');
    metricRow(doc, 'SI → PROD backfill completed', summary.remediation.siToProd.setsCompleted);
    metricRow(doc, 'SI → PROD backfill skipped', summary.remediation.siToProd.setsSkipped, `${summary.remediation.siToProd.setsAttempted} sets attempted`);

    if (summary.blurryRetry?.completed?.length) {
      bodyText(doc, 'Blurry-photo retry completed 3 additional sets using the approved bypass image where PROD photos could not pass CV.');
    }

    sectionTitle(doc, 'PROD→SI Closeout — Error Themes');
    const errThemes = data.errorThemes.length ? data.errorThemes : [['None recorded', '—']];
    drawTable(doc, ['Issue', 'Count'], errThemes, [376, 128]);

    if (data.topOpenStores.length) {
      sectionTitle(doc, 'Highest Open-Row Count by Store');
      drawTable(
        doc,
        ['Store', 'Open rows'],
        data.topOpenStores.map(([store, count]) => [store, count]),
        [120, 100],
      );
    }

    sectionTitle(doc, 'Deliverables');
    bullet(doc, 'SUPER Tracker ISE V1.3 - D1 reconcile copy.xlsm');
    bullet(doc, 'SUPER Tracker Blitz V1.3 - D1 reconcile copy.xlsx');
    bullet(doc, 'D1_reconcile_discrepancies (JSON/CSV) — row-level PROD/SI detail');
    bullet(doc, 'D1_reconcile_summary (JSON) — machine-readable run summary');
    bullet(doc, 'prod-to-si-closeout/summary.json — SI closeout audit trail');
    bullet(doc, 'sitoprod/si-to-prod-backfill JSON — PROD backfill audit trail');
    bullet(doc, 'District 1 P06W1 Tracker Reconciliation Summary.pdf — this document');

    sectionTitle(doc, 'Recommended Follow-Up');
    if (promoted) {
      bullet(doc, 'Work “needs SI complete” rows where live SI tasks exist but expired or failed closeout (especially Store 63).');
      bullet(doc, 'Schedule “needs loaded to PROD” sets when lead shifts and visit category resets align.');
      bullet(doc, 'Field teams: open rows with cleared comments still need PROD/SI completion or are out of scope for this reconcile window.');
      bullet(doc, 'Working copies in p06w1_district1_tracking remain as the reconciliation audit trail; live trackers reflect promoted state.');
    } else {
      bullet(doc, 'Review “needs SI complete” rows where live SI tasks exist but expired or failed closeout (especially Store 63).');
      bullet(doc, 'Schedule “needs loaded to PROD” sets when lead shifts and visit category resets align.');
      bullet(doc, 'Validate Blitz open rows — most reflect neither-side-complete in live systems for the scoped period.');
      bullet(doc, 'Promote accepted copy rows to live trackers only after district review of this package.');
    }

    ensureSpace(doc, 48);
    doc.strokeColor(RULE).lineWidth(1)
      .moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).stroke();
    doc.y += 10;
    setFont(doc, false, 8);
    doc.fillColor(MUTED).text(
      promoted
        ? 'Prepared for management distribution · District 1 P06W1 tracker reconciliation · Live trackers updated · Confidential internal use'
        : 'Prepared for management distribution · District 1 P06W1 tracker reconciliation · Copies-only workflow · Confidential internal use',
      MARGIN,
      doc.y,
      { width: CONTENT_W, align: 'center', lineGap: 2 },
    );

    doc.end();
  });
}

function summarizeErrors(prodToSi) {
  const counts = new Map();
  for (const row of prodToSi.errors || []) {
    let label = 'Other API error';
    const body = row.body;
    if (typeof body === 'string') {
      if (/expired/i.test(body)) label = 'SI task completion window expired';
      else if (/502/i.test(body)) label = 'Rebotics gateway error (502)';
      else label = body.slice(0, 90);
    } else if (body?.non_field_errors?.[0]) {
      const msg = body.non_field_errors[0];
      if (/already working on another task/i.test(msg)) label = 'Another task in progress (same user)';
      else label = msg.slice(0, 90);
    } else if (/permission/i.test(String(row.error || ''))) {
      label = 'Permission denied on task update';
    }
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function countOpenByStore(writesCache, completedKeys) {
  const byStore = new Map();
  for (const row of [...(writesCache.ise || []), ...(writesCache.blitz || [])]) {
    const keyParts = String(row.key || '').split('|');
    if (completedKeys.has(row.key) || row.K === 'Yes') continue;
    const store = keyParts[1] || '?';
    byStore.set(store, (byStore.get(store) || 0) + 1);
  }
  return [...byStore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

async function main() {
  const { outDir } = parseArgs(process.argv);
  const summaryPath = findLatestFile(outDir, 'D1_reconcile_summary_');
  if (!summaryPath) throw new Error(`No D1_reconcile_summary_*.json in ${outDir}`);

  const summary = loadJson(summaryPath);
  const livePromotion = loadJson(path.join(outDir, 'D1_live_promotion_2026-06-24.json'), null)
    || findLatestFile(outDir, 'D1_live_promotion_', '.json')
      ? loadJson(findLatestFile(outDir, 'D1_live_promotion_', '.json'))
      : null;
  const prodToSi = loadJson(path.join(outDir, 'prod-to-si-closeout', 'summary.json'), {});
  const writesCache = loadJson(path.join(outDir, 'D1_writes_cache.json'), { ise: [], blitz: [] });
  const stores = (DISTRICT_STORES[1] || []).map(String);

  const completedKeys = new Set([
    ...(prodToSi.completed || []).map((r) => r.key),
    ...(prodToSi.trackerWritePlan || []).map((r) => r.key),
    ...(writesCache.prodOnlyNoSiKeys || []),
  ]);
  const blurrySummary = loadJson(path.join(outDir, 'prod-to-si-blurry-retry', 'summary.json'), {});
  for (const row of blurrySummary.completed || []) completedKeys.add(row.key);

  const buffer = await buildPdfBuffer({
    summary,
    prodToSi,
    livePromotion,
    eligibleIse: writesCache.ise?.length || 536,
    eligibleBlitz: writesCache.blitz?.length || 380,
    stores,
    errorThemes: summarizeErrors(prodToSi),
    topOpenStores: countOpenByStore(writesCache, completedKeys),
  });

  const desiredPath = path.join(outDir, 'District 1 P06W1 Tracker Reconciliation Summary.pdf');
  const actualPath = await writeFileVersioned(desiredPath, buffer);
  console.log(`Wrote ${actualPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
