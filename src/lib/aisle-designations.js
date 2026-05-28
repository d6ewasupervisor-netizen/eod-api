'use strict';

/**
 * Store aisle designation presets for Checklane Reset Hub.
 * Each planogram section (visit + lane + dbkey) maps to one preset or custom label.
 */

const OTHER_PRESET = 'other';
const MAX_CUSTOM_LENGTH = 80;

const PRESET_GROUPS = [
  { key: 'aisle', label: 'Aisles', count: 25, itemLabel: (n) => `Aisle ${n}` },
  { key: 'belted_sco', label: 'Belted SCO', count: 6, itemLabel: (n) => `Belted SCO ${n}` },
  { key: 'uscan_bank', label: 'UScan bank', count: 6, itemLabel: (n) => `UScan bank ${n}` },
  { key: 'sco_bank', label: 'SCO bank', count: 6, itemLabel: (n) => `SCO bank ${n}` },
  { key: 'queuing_wall', label: 'Queuing Wall', count: 6, itemLabel: (n) => `Queuing Wall ${n}` },
  { key: 'queuing_fixture', label: 'Queuing Fixture', count: 6, itemLabel: (n) => `Queuing Fixture ${n}` },
];

function buildPresetCatalog() {
  const options = [];
  for (const group of PRESET_GROUPS) {
    for (let n = 1; n <= group.count; n += 1) {
      const id = `${group.key}_${n}`;
      options.push({
        id,
        group: group.key,
        groupLabel: group.label,
        label: group.itemLabel(n),
      });
    }
  }
  options.push({
    id: OTHER_PRESET,
    group: OTHER_PRESET,
    groupLabel: 'Other',
    label: 'Other (custom name)',
  });
  return options;
}

const PRESET_CATALOG = buildPresetCatalog();
const PRESET_BY_ID = new Map(PRESET_CATALOG.map((opt) => [opt.id, opt]));

function normalizePreset(preset) {
  if (preset == null) return '';
  return String(preset).trim();
}

function normalizeCustom(custom) {
  if (custom == null) return '';
  return String(custom).trim().slice(0, MAX_CUSTOM_LENGTH);
}

function resolveAisleLabel(preset, custom) {
  const presetKey = normalizePreset(preset);
  if (!presetKey) return null;
  if (presetKey === OTHER_PRESET) {
    const customLabel = normalizeCustom(custom);
    return customLabel || null;
  }
  const opt = PRESET_BY_ID.get(presetKey);
  return opt ? opt.label : null;
}

function validateAisleDesignation(preset, custom) {
  const presetKey = normalizePreset(preset);
  if (!presetKey) {
    return { ok: true, preset: null, custom: null, label: null };
  }

  if (presetKey === OTHER_PRESET) {
    const customLabel = normalizeCustom(custom);
    if (!customLabel) {
      return { ok: false, status: 400, error: 'Custom aisle name is required when preset is other' };
    }
    return { ok: true, preset: OTHER_PRESET, custom: customLabel, label: customLabel };
  }

  if (!PRESET_BY_ID.has(presetKey)) {
    return { ok: false, status: 400, error: 'Invalid aisle preset' };
  }

  return {
    ok: true,
    preset: presetKey,
    custom: null,
    label: PRESET_BY_ID.get(presetKey).label,
  };
}

function sectionDesignationKey(lane, dbkey) {
  return `${String(lane ?? '').trim()}|${String(dbkey ?? '').trim()}`;
}

module.exports = {
  OTHER_PRESET,
  MAX_CUSTOM_LENGTH,
  PRESET_GROUPS,
  PRESET_CATALOG,
  PRESET_BY_ID,
  normalizePreset,
  normalizeCustom,
  resolveAisleLabel,
  validateAisleDesignation,
  sectionDesignationKey,
};
