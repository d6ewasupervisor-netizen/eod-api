#!/usr/bin/env node
/**
 * Send store-specific tag batch test emails (8 planogram UPCs each).
 *
 * Usage:
 *   node scripts/send-store-tag-batch-test.js [storeNumber ...]
 *
 * Defaults: 23 682
 * Recipient: tyson.gauthier@retailodyssey.com (override with HUB_TAG_BATCH_EMAIL)
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
const POG_PRODUCTS_PATH = path.join(DEPLOY_ROOT, 'pog_products.json');
const PRODUCTS_PATH = path.join(DEPLOY_ROOT, 'products.json');
const POG_LAYOUTS_DIR = path.join(DEPLOY_ROOT, 'pog_layouts');
const TZ = 'America/Los_Angeles';

const RECIPIENT = (process.env.HUB_TAG_BATCH_EMAIL || CHECKLANES_OPS_EMAIL).trim();
const ACTOR = {
  email: 'd6ewa.supervisor@gmail.com',
  name: 'Supervisor Lead',
};
const ITEM_COUNT = 8;

const storeNumbers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['23', '682'];

function formatLocalDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatFilenameDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}`;
}

function formatStoreNumber(storeNumber) {
  const n = Number(storeNumber);
  if (!Number.isFinite(n)) return String(storeNumber);
  return String(n).padStart(5, '0');
}

function normalizeStoreKey(storeNumber) {
  const n = Number(storeNumber);
  return Number.isFinite(n) ? String(n) : String(storeNumber).replace(/^0+/, '');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const layoutCache = new Map();

function loadPogLayout(dbkey) {
  const key = String(dbkey);
  if (layoutCache.has(key)) return layoutCache.get(key);
  const filePath = path.join(POG_LAYOUTS_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) {
    layoutCache.set(key, null);
    return null;
  }
  const layout = loadJson(filePath);
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
          return {
            location: `601B${bayNum}F${fixtureNum}${posCode}`,
            description: product.desc_fallback || null,
          };
        }
      }
    }
  }
  return null;
}

function collectStoreProductPool(storeNumber, pogProducts) {
  const storeKey = normalizeStoreKey(storeNumber);
  const pool = [];

  for (const [dbkey, byStore] of Object.entries(pogProducts)) {
    const upcs = byStore[storeKey];
    if (!Array.isArray(upcs) || !upcs.length) continue;
    for (const upc of upcs) {
      if (!validateUpc(upc).valid) continue;
      pool.push({ dbkey, upc: String(upc) });
    }
  }
  return pool;
}

function pickRandomProducts(pool, count, productsCatalog) {
  if (pool.length < count) {
    throw new Error(`Need ${count} planogram products, found ${pool.length}`);
  }

  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const picked = [];
  const usedUpcs = new Set();
  for (const item of shuffled) {
    if (usedUpcs.has(item.upc)) continue;
    usedUpcs.add(item.upc);

    const layoutHit = findProductInLayout(item.dbkey, item.upc);
    const catalog = productsCatalog[item.upc];
    picked.push({
      dbkey: item.dbkey,
      upc: item.upc,
      description:
        catalog?.name ||
        catalog?.fallback_desc ||
        layoutHit?.description ||
        item.upc,
      location: layoutHit?.location || `601B0${picked.length + 1}F0${picked.length + 1}P0${picked.length + 1}`,
    });

    if (picked.length >= count) break;
  }

  if (picked.length < count) {
    throw new Error(`Could only pick ${picked.length} unique UPCs`);
  }
  return picked;
}

async function enrichTagForPdf(row, storeNumber) {
  const barcode = await generateBarcode(row.upc);
  const { locationLabel, planogramName } = {
    locationLabel: formatTagLocationLabel(row.location) || row.location || null,
    planogramName: lookupFixture({ storeNumber, dbkey: row.dbkey })?.name || null,
  };

  return {
    id: row.upc,
    dbkey: row.dbkey,
    upc: row.upc,
    rawUpc: row.upc,
    description: row.description,
    location: row.location,
    locationLabel,
    planogramName,
    valid: barcode.valid,
    reason: barcode.reason,
    displayDigits: barcode.displayDigits,
    primary: barcode.primary,
  };
}

async function sendStoreTagBatch({ resend, storeNumber, products }) {
  const storeLabel = formatStoreNumber(storeNumber);
  const storeKey = normalizeStoreKey(storeNumber);
  const visitId = Number(`99999${storeKey.padStart(3, '0').slice(-5)}`);
  const subject = `#${storeKey}`;
  const dateLabel = formatLocalDate();

  const pdfItems = await Promise.all(
    products.map((row) => enrichTagForPdf(row, storeKey)),
  );
  const sortedPdfItems = sortTagsByAisle(pdfItems);
  const pdfBuffer = await buildTagBatchPdf({
    store: storeLabel,
    visitId,
    dateLabel,
    items: sortedPdfItems,
  });

  const count = products.length;
  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:420px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Checklane tag print batch</h2>
  <p style="margin:0 0 8px;">${count} verified missing-tag item${count === 1 ? '' : 's'} for store ${storeLabel}, visit ${visitId}.</p>
  <p style="margin:0 0 8px;">Sent by ${ACTOR.name || ACTOR.email}.</p>
  <p style="margin:0;color:#6b7280;font-size:13px;">The attached PDF is formatted for fax — scan barcodes with the spa gun to print shelf tags.</p>
</body></html>`;

  const stamp = formatFilenameDate();
  const filename = `tag-batch_${storeLabel}_${visitId}_${stamp}.pdf`;

  const { data, error } = await resend.emails.send(
    buildSetRelatedEmailPayload({
      to: RECIPIENT,
      subject,
      html,
      actorEmail: ACTOR.email,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    }),
  );

  if (error) {
    throw new Error(error.message || String(error));
  }

  return {
    subject,
    count,
    resendId: data?.id,
    products,
  };
}

async function main() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const pogProducts = loadJson(POG_PRODUCTS_PATH);
  const productsCatalog = loadJson(PRODUCTS_PATH);
  const resend = new Resend(process.env.RESEND_API_KEY);

  console.log(`Recipient: ${RECIPIENT}`);

  for (const storeNumber of storeNumbers) {
    const pool = collectStoreProductPool(storeNumber, pogProducts);
    const products = pickRandomProducts(pool, ITEM_COUNT, productsCatalog);

    console.log(`\nStore #${normalizeStoreKey(storeNumber)} — selected products:`);
    for (const p of products) {
      console.log(`  - ${p.upc}  ${p.description}`);
    }

    const result = await sendStoreTagBatch({ resend, storeNumber, products });
    console.log(`Sent subject ${result.subject} (${result.count} items) → resendId ${result.resendId}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
