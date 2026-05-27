'use strict';

/**
 * Server-side fixture catalog for Hub set metadata (name, action, manifest POG id).
 * JSON files live in src/data/hub-fixtures/{storeNumber}.json — synced from Reset Hub FIXTURES.
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./db');

const DATA_DIR = path.join(__dirname, '../data/hub-fixtures');
const catalogCache = new Map();

function normalizeStoreNumber(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? String(n) : digits.replace(/^0+/, '') || '0';
}

function normalizeLane(lane) {
  if (lane == null) return '';
  return String(lane).trim();
}

function normalizeDbkey(dbkey) {
  if (dbkey == null || dbkey === '') return null;
  return String(dbkey).trim();
}

function loadCatalog(storeNumber) {
  const storeKey = normalizeStoreNumber(storeNumber);
  if (!storeKey) return null;
  if (catalogCache.has(storeKey)) return catalogCache.get(storeKey);

  const filePath = path.join(DATA_DIR, `${storeKey}.json`);
  if (!fs.existsSync(filePath)) {
    catalogCache.set(storeKey, null);
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('[hub-fixture-catalog] failed to parse', filePath, err.message);
    catalogCache.set(storeKey, null);
    return null;
  }

  const fixtures = Array.isArray(raw) ? raw : raw.fixtures || [];
  const byLaneDbkey = new Map();
  const byDbkey = new Map();

  for (const fixture of fixtures) {
    const dk = normalizeDbkey(fixture.dbkey);
    if (!dk) continue;
    const lane = normalizeLane(fixture.lane);
    byLaneDbkey.set(`${lane}|${dk}`, fixture);
    if (!byDbkey.has(dk)) byDbkey.set(dk, fixture);
  }

  const catalog = { storeNumber: storeKey, byLaneDbkey, byDbkey };
  catalogCache.set(storeKey, catalog);
  return catalog;
}

function lookupFixture({ storeNumber, lane, dbkey }) {
  const dk = normalizeDbkey(dbkey);
  if (!dk) return null;

  const catalog = loadCatalog(storeNumber);
  if (!catalog) return null;

  const laneNorm = normalizeLane(lane);
  if (laneNorm) {
    const exact = catalog.byLaneDbkey.get(`${laneNorm}|${dk}`);
    if (exact) return exact;
  }

  return catalog.byDbkey.get(dk) || null;
}

async function resolveStoreForVisit(visitIdNum) {
  try {
    const { rows } = await query(
      `SELECT store_number
       FROM schedules
       WHERE visit_id = $1
       ORDER BY scheduled_date DESC
       LIMIT 1`,
      [visitIdNum],
    );
    if (rows.length && rows[0].store_number != null) {
      return normalizeStoreNumber(rows[0].store_number);
    }
  } catch (err) {
    console.error('[hub-fixture-catalog] schedule lookup failed:', err.message);
  }

  // Hub test visits: 99999163 → store 163 (see migrations/008_hub.sql).
  const m = String(visitIdNum).match(/^99999(\d{3,5})$/);
  if (m) return normalizeStoreNumber(m[1]);

  return null;
}

/**
 * Merge pending payload with catalog fixture fields (catalog fills gaps only).
 */
function enrichNisPayload(payload, fixture) {
  const base = { ...(payload || {}) };
  if (!fixture) return base;

  if (!base.set_name && fixture.name) base.set_name = fixture.name;
  if (!base.manifest_pog_id && fixture.manifest_pog_id) {
    base.manifest_pog_id = fixture.manifest_pog_id;
  }
  if (!base.action && fixture.action) base.action = fixture.action;

  return base;
}

async function resolveNisSetMetadata({ visitIdNum, lane, dbkey, payload }) {
  const storeNumber = await resolveStoreForVisit(visitIdNum);
  const fixture = storeNumber ? lookupFixture({ storeNumber, lane, dbkey }) : null;
  return {
    storeNumber,
    payload: enrichNisPayload(payload, fixture),
    catalogHit: Boolean(fixture),
  };
}

module.exports = {
  normalizeStoreNumber,
  lookupFixture,
  resolveStoreForVisit,
  enrichNisPayload,
  resolveNisSetMetadata,
  loadCatalog,
};
