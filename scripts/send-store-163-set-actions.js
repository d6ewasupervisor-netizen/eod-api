#!/usr/bin/env node
/**
 * One-off: send a Checklane tag-print batch for store 163 built from set-action
 * items (NOT random/missing tags). Reuses the in-place tag-batch path:
 * generateBarcode -> buildTagBatchPdf -> buildSetRelatedEmailPayload (Resend).
 *
 * Selection (from checklane-deploy/scan_index/163.json):
 *   - 4 TRUE DELETE   (del on a POG, not active anywhere at the store)
 *   - 2 RELOCATED     (off this set, moves to another location in the store)
 *   - 2 UPC CHANGE    (new UPC that replaces an old one — barcode = new UPC)
 *
 * Subject: #999   Recipient: tyson.gauthier@retailodyssey.com
 *
 * Run with Resend creds injected from Railway:
 *   railway run node scripts/send-store-163-set-actions.js
 *   railway run node scripts/send-store-163-set-actions.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { generateBarcode, validateUpc } = require('../src/lib/barcode');
const { buildTagBatchPdf } = require('../src/lib/tag-batch-pdf');
const { buildSetRelatedEmailPayload } = require('../src/lib/checklanes-email');
const { sortTagsByAisle, formatTagLocationLabel } = require('../src/lib/tag-location');

const DRY_RUN = process.argv.includes('--dry-run');
// --good: pick 8 valid UPCs actually set on planograms at the store instead of
// the 4 delete / 2 relocate / 2 UPC-change set-action mix.
const GOOD_MODE = process.argv.includes('--good');
const STORE = '163';
const SUBJECT = '#999';
const RECIPIENT = 'tyson.gauthier@retailodyssey.com';
const ACTOR = { email: 'd6ewa.supervisor@gmail.com', name: 'Supervisor Lead' };
const TZ = 'America/Los_Angeles';

const DEPLOY_ROOT = path.join(__dirname, '../../Checklanes/Checklanes/checklane-deploy');
const SCAN_INDEX_PATH = path.join(DEPLOY_ROOT, 'scan_index', `${STORE}.json`);
const PRODUCTS_PATH = path.join(DEPLOY_ROOT, 'products.json');
const POG_PRODUCTS_PATH = path.join(DEPLOY_ROOT, 'pog_products.json');
const POG_LAYOUTS_DIR = path.join(DEPLOY_ROOT, 'pog_layouts');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function formatLocalDate(date = new Date()) {
  return date.toLocaleDateString('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
}

function formatFilenameDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}`;
}

const layoutCache = new Map();
function loadPogLayout(dbkey) {
  const key = String(dbkey);
  if (layoutCache.has(key)) return layoutCache.get(key);
  const filePath = path.join(POG_LAYOUTS_DIR, `${key}.json`);
  const layout = fs.existsSync(filePath) ? loadJson(filePath) : null;
  layoutCache.set(key, layout);
  return layout;
}

function findProductInLayout(dbkey, upc) {
  const layout = loadPogLayout(dbkey);
  if (!layout?.bays) return null;
  const target = String(upc);
  for (const bay of layout.bays) {
    for (const fixture of bay.fixtures || []) {
      for (const product of fixture.products || []) {
        if (String(product.upc) === target) {
          const bayNum = String(bay.bay_num || 1).padStart(2, '0');
          const fixtureNum = String(fixture.fixture_num || 1).padStart(2, '0');
          const posCode = product.position_code && /^R\d+C\d+$/i.test(product.position_code)
            ? product.position_code
            : `P${String(product.pos).padStart(2, '0')}`;
          return { location: `601B${bayNum}F${fixtureNum}${posCode}`, description: product.desc_fallback || null };
        }
      }
    }
  }
  return null;
}

function classify(items) {
  const trueDeletes = [];
  const relocated = [];
  const upcChanges = [];
  for (const [upc, it] of Object.entries(items)) {
    if ('cf' in it || 'ct' in it) {
      upcChanges.push([upc, it]);
      continue;
    }
    if (Array.isArray(it.del) && it.del.length) {
      if (Array.isArray(it.act) && it.act.length) relocated.push([upc, it]);
      else trueDeletes.push([upc, it]);
    }
  }
  return { trueDeletes, relocated, upcChanges };
}

function pickSelection(items) {
  const { trueDeletes, relocated, upcChanges } = classify(items);
  if (trueDeletes.length < 4) throw new Error(`Need 4 true deletes, found ${trueDeletes.length}`);
  if (relocated.length < 2) throw new Error(`Need 2 relocations, found ${relocated.length}`);

  const rows = [];

  for (const [upc, it] of trueDeletes.slice(0, 4)) {
    rows.push({ action: 'TRUE DELETE', upc, scanDesc: it.desc, dbkey: (it.del || [])[0] || null });
  }

  for (const [upc, it] of relocated.slice(0, 2)) {
    rows.push({ action: 'RELOCATED', upc, scanDesc: it.desc, dbkey: (it.act || [])[0] || null });
  }

  // UPC changes: prefer the NEW UPC (the item the store should set/print).
  const newUpcChanges = upcChanges.filter(([, it]) => 'ct' in it);
  const source = newUpcChanges.length >= 2 ? newUpcChanges : upcChanges;
  if (source.length < 2) throw new Error(`Need 2 UPC changes, found ${source.length}`);
  for (const [upc, it] of source.slice(0, 2)) {
    const dbkey = (it.ct?.on || it.cf?.on || [])[0] || null;
    const oldUpc = it.ct?.from || null;
    rows.push({ action: 'UPC CHANGE', upc, scanDesc: it.desc || it.ct?.fromDesc || '', dbkey, oldUpc });
  }

  return rows;
}

function pickGoodUpcs(pogProducts, productsCatalog, count = 8) {
  // Valid UPCs actually set on planograms at the store, preferring ones with a
  // resolved catalog name so the printed tags carry a real description.
  const seen = new Set();
  const withName = [];
  const withoutName = [];
  for (const [dbkey, byStore] of Object.entries(pogProducts)) {
    const upcs = byStore[STORE];
    if (!Array.isArray(upcs)) continue;
    for (const upc of upcs) {
      const u = String(upc);
      if (seen.has(u) || !validateUpc(u).valid) continue;
      seen.add(u);
      const cat = productsCatalog[u];
      const row = { action: 'GOOD', upc: u, scanDesc: cat?.name || cat?.fallback_desc || '', dbkey };
      if (cat?.name || cat?.fallback_desc) withName.push(row);
      else withoutName.push(row);
    }
  }
  const ordered = withName.concat(withoutName);
  if (ordered.length < count) throw new Error(`Need ${count} good UPCs, found ${ordered.length}`);
  return ordered.slice(0, count);
}

async function buildTagItem(row, productsCatalog) {
  const layoutHit = row.dbkey ? findProductInLayout(row.dbkey, row.upc) : null;
  const catalog = productsCatalog[row.upc];
  let description =
    catalog?.name || catalog?.fallback_desc || row.scanDesc || layoutHit?.description || row.upc;
  if (row.action === 'UPC CHANGE' && row.oldUpc) {
    description = `${description} (NEW UPC, was ${row.oldUpc})`;
  } else if (row.action !== 'GOOD') {
    description = `[${row.action}] ${description}`;
  }

  const location = layoutHit?.location || row.dbkey || null;
  const barcode = await generateBarcode(row.upc);

  return {
    id: row.upc,
    dbkey: row.dbkey,
    upc: row.upc,
    rawUpc: row.upc,
    description,
    location,
    locationLabel: formatTagLocationLabel(location) || location || null,
    planogramName: null,
    valid: barcode.valid,
    reason: barcode.reason,
    displayDigits: barcode.displayDigits,
    primary: barcode.primary,
  };
}

async function main() {
  const productsCatalog = loadJson(PRODUCTS_PATH);

  let rows;
  if (GOOD_MODE) {
    const pogProducts = loadJson(POG_PRODUCTS_PATH);
    rows = pickGoodUpcs(pogProducts, productsCatalog, 8);
  } else {
    const scan = loadJson(SCAN_INDEX_PATH);
    rows = pickSelection(scan.items);
  }
  const items = await Promise.all(rows.map((r) => buildTagItem(r, productsCatalog)));
  const sorted = sortTagsByAisle(items);

  const dateLabel = formatLocalDate();
  const visitId = 99999163;
  const pdfBuffer = await buildTagBatchPdf({
    store: STORE,
    visitId,
    dateLabel,
    items: sorted,
  });

  console.log(`Store ${STORE} — ${items.length} ${GOOD_MODE ? 'good planogram' : 'set-action'} items for subject ${SUBJECT}:`);
  for (const it of sorted) {
    console.log(`  - ${it.upc}  valid=${it.valid}  ${it.description}  [${it.locationLabel || it.dbkey || '—'}]`);
  }

  const stamp = formatFilenameDate();
  const filename = `tag-batch_${String(STORE).padStart(5, '0')}_${visitId}_${stamp}.pdf`;

  if (DRY_RUN) {
    const outPath = path.join(__dirname, `..\\${filename}`);
    fs.writeFileSync(outPath, pdfBuffer);
    console.log(`\n[dry-run] No email sent. PDF written to ${outPath} (${pdfBuffer.length} bytes).`);
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set (run via: railway run node scripts/send-store-163-set-actions.js)');
  }
  const resend = new Resend(process.env.RESEND_API_KEY);

  const count = items.length;
  const summary = GOOD_MODE
    ? `${count} planogram items for store ${String(STORE).padStart(5, '0')}.`
    : `${count} items for store ${String(STORE).padStart(5, '0')}: 4 true deletes, 2 relocations, 2 UPC changes.`;
  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:440px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Checklane tag print batch</h2>
  <p style="margin:0 0 8px;">${summary}</p>
  <p style="margin:0 0 8px;">Sent by ${ACTOR.name}.</p>
  <p style="margin:0;color:#6b7280;font-size:13px;">The attached PDF is formatted for fax — scan barcodes with the spa gun to print shelf tags.</p>
</body></html>`;

  const { data, error } = await resend.emails.send(
    buildSetRelatedEmailPayload({
      to: RECIPIENT,
      subject: SUBJECT,
      html,
      actorEmail: ACTOR.email,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    }),
  );

  if (error) throw new Error(error.message || String(error));
  console.log(`\nSent subject ${SUBJECT} → ${RECIPIENT} (resendId ${data?.id || '(none)'})`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
