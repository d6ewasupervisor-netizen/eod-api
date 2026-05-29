#!/usr/bin/env node
/**
 * Send a Checklane fax batch of 8 barcodes hand-picked by scan-intelligence
 * category for a single store:
 *   - 4 true deletes  (deleted from a set, not active anywhere else in store)
 *   - 2 relocated     (deleted from a set but still active elsewhere in store)
 *   - 2 UPC changes   (old -> new; the NEW barcode is printed)
 *
 * Subject line: #999   Recipient: CHECKLANES_OPS_EMAIL (tyson.gauthier@...)
 *
 * Usage:
 *   node scripts/send-scan-categories-fax.js [storeNumber]
 * If no store is given, the first store with enough of each category is used.
 */

if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { generateBarcode, validateUpc } = require('../src/lib/barcode');
const { buildTagBatchPdf } = require('../src/lib/tag-batch-pdf');
const { buildSetRelatedEmailPayload, CHECKLANES_OPS_EMAIL } = require('../src/lib/checklanes-email');
const { sortTagsByAisle, formatTagLocationLabel } = require('../src/lib/tag-location');
const { lookupFixture } = require('../src/lib/hub-fixture-catalog');

const DEPLOY_ROOT = path.join(__dirname, '../../Checklanes/Checklanes/checklane-deploy');
const SCAN_INDEX_DIR = path.join(DEPLOY_ROOT, 'scan_index');
const PRODUCTS_PATH = path.join(DEPLOY_ROOT, 'products.json');
const POG_LAYOUTS_DIR = path.join(DEPLOY_ROOT, 'pog_layouts');
const TZ = 'America/Los_Angeles';

const SUBJECT = '#999';
const RECIPIENT = (process.env.HUB_TAG_BATCH_EMAIL || CHECKLANES_OPS_EMAIL).trim();
const ACTOR = { email: 'd6ewa.supervisor@gmail.com', name: 'Supervisor Lead' };

const WANT = { trueDelete: 4, relocated: 2, upcChange: 2 };

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function formatLocalDate(date = new Date()) {
  return date.toLocaleDateString('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
}
function formatFilenameDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}`;
}
function formatStoreNumber(s) { const n = Number(s); return Number.isFinite(n) ? String(n).padStart(5, '0') : String(s); }

const layoutCache = new Map();
function loadPogLayout(dbkey) {
  const key = String(dbkey);
  if (layoutCache.has(key)) return layoutCache.get(key);
  const fp = path.join(POG_LAYOUTS_DIR, `${key}.json`);
  const layout = fs.existsSync(fp) ? loadJson(fp) : null;
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
            ? product.position_code : `P${String(product.pos).padStart(2, '0')}`;
          return { location: `601B${bayNum}F${fixtureNum}${posCode}`, description: product.desc_fallback || null };
        }
      }
    }
  }
  return null;
}

function describe(upc, products, fallback) {
  const c = products[String(upc)];
  return (c && (c.name || c.fallback_desc)) || fallback || String(upc);
}

/** Build the 8-item pick for a store, or null if it can't satisfy the quota. */
function buildSelection(storeFile, products) {
  const idx = loadJson(storeFile);
  const items = idx.items || {};
  const cats = { trueDelete: [], relocated: [], upcChange: [] };

  for (const [upc, it] of Object.entries(items)) {
    const del = Array.isArray(it.del) ? it.del : [];
    const act = Array.isArray(it.act) ? it.act : [];
    if (it.cf && it.cf.to) {
      const newUpc = String(it.cf.to);
      if (validateUpc(newUpc).valid) {
        cats.upcChange.push({
          kind: 'upcChange', upc: newUpc, dbkey: (it.cf.on || [])[0] || del[0] || act[0],
          description: describe(newUpc, products, it.cf.toDesc),
          note: `UPC change: old ${upc} -> new ${newUpc}`,
        });
      }
      continue;
    }
    if (del.length && validateUpc(upc).valid) {
      if (act.length) {
        cats.relocated.push({ kind: 'relocated', upc, dbkey: del[0],
          description: describe(upc, products, it.desc), note: `Moves to ${act.join(', ')}` });
      } else {
        cats.trueDelete.push({ kind: 'trueDelete', upc, dbkey: del[0],
          description: describe(upc, products, it.desc), note: 'True store-wide delete' });
      }
    }
  }

  if (cats.trueDelete.length < WANT.trueDelete) return null;
  if (cats.relocated.length < WANT.relocated) return null;
  if (cats.upcChange.length < WANT.upcChange) return null;

  const sortByDesc = (a, b) => String(a.description).localeCompare(String(b.description));
  cats.trueDelete.sort(sortByDesc); cats.relocated.sort(sortByDesc); cats.upcChange.sort(sortByDesc);

  const picked = [
    ...cats.trueDelete.slice(0, WANT.trueDelete),
    ...cats.relocated.slice(0, WANT.relocated),
    ...cats.upcChange.slice(0, WANT.upcChange),
  ];
  // De-dupe defensively on UPC.
  const seen = new Set();
  const unique = picked.filter((p) => (seen.has(p.upc) ? false : seen.add(p.upc)));
  if (unique.length < 8) return null;

  return { store: idx.store, items: unique };
}

async function enrichTagForPdf(row, storeKey) {
  const barcode = await generateBarcode(row.upc);
  const layoutHit = findProductInLayout(row.dbkey, row.upc);
  const location = layoutHit?.location || null;
  return {
    id: row.upc, dbkey: row.dbkey, upc: row.upc, rawUpc: row.upc,
    description: row.description, location,
    locationLabel: location ? (formatTagLocationLabel(location) || location) : null,
    planogramName: lookupFixture({ storeNumber: storeKey, dbkey: row.dbkey })?.name || null,
    valid: barcode.valid, reason: barcode.reason,
    displayDigits: barcode.displayDigits, primary: barcode.primary,
  };
}

async function main() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const products = loadJson(PRODUCTS_PATH);
  const requested = process.argv.slice(2)[0];

  let candidateFiles;
  if (requested) {
    candidateFiles = [path.join(SCAN_INDEX_DIR, `${String(Number(requested))}.json`)];
  } else {
    candidateFiles = fs.readdirSync(SCAN_INDEX_DIR)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => Number(a.replace('.json', '')) - Number(b.replace('.json', '')))
      .map((f) => path.join(SCAN_INDEX_DIR, f));
  }

  let selection = null;
  for (const file of candidateFiles) {
    if (!fs.existsSync(file)) continue;
    const sel = buildSelection(file, products);
    if (sel) { selection = sel; break; }
  }
  if (!selection) throw new Error('No store satisfies 4 true-delete + 2 relocated + 2 UPC-change with valid barcodes');

  const storeKey = String(selection.store);
  const storeLabel = formatStoreNumber(storeKey);

  console.log(`Store #${storeKey} — fax batch (subject ${SUBJECT}) -> ${RECIPIENT}`);
  for (const it of selection.items) {
    console.log(`  [${it.kind}] ${it.upc}  ${it.description}  (${it.note})`);
  }

  const pdfItems = sortTagsByAisle(
    await Promise.all(selection.items.map((row) => enrichTagForPdf(row, storeKey))),
  );

  const visitId = 999;
  const pdfBuffer = await buildTagBatchPdf({
    store: storeLabel, visitId, dateLabel: formatLocalDate(), items: pdfItems,
  });

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:440px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Checklane scan-category fax batch</h2>
  <p style="margin:0 0 8px;">8 barcodes for store ${storeLabel}: 4 true deletes, 2 moves-in-store, 2 UPC changes.</p>
  <p style="margin:0 0 8px;">Sent by ${ACTOR.name}.</p>
  <p style="margin:0;color:#6b7280;font-size:13px;">The attached PDF is formatted for fax — scan barcodes with the spa gun to print shelf tags.</p>
</body></html>`;

  const filename = `tag-batch_${storeLabel}_999_${formatFilenameDate()}.pdf`;
  const resend = new Resend(process.env.RESEND_API_KEY);
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
  console.log(`Sent subject ${SUBJECT} (8 items) -> resendId ${data?.id}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
