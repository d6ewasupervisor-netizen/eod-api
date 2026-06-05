'use strict';

const DISTRICT_STORES = {
  1: [4, 35, 40, 51, 60, 63, 143, 153, 218, 220, 240, 242, 285, 375, 377, 393, 462, 482, 516, 651, 661, 694],
  2: [75, 93, 125, 127, 135, 140, 150, 185, 208, 236, 255, 360, 372, 460, 600, 614, 660, 663, 683],
  3: [5, 7, 70, 90, 225, 227, 325, 328, 355, 417],
  4: [13, 24, 25, 122, 180, 209, 210, 457, 458, 608, 667, 681, 688],
  5: [41, 111, 171, 186, 265, 390, 424, 603, 604, 605, 615, 655, 659, 665, 691],
  6: [49, 163, 214, 286, 351, 486, 652, 654, 657],
  7: [11, 17, 18, 71, 158, 224, 485, 649, 653, 656, 668],
  8: [19, 23, 28, 31, 53, 215, 391, 459, 658, 682],
  9: [156, 198, 226, 260, 383, 439, 449, 613, 662, 685],
  10: [21, 30, 50, 126, 165, 195, 196, 281, 464, 650],
};

const PROJECT_LABELS = {
  1: 'Kompass ISE',
  1668: 'Cut In',
  1715: 'Blitz',
  3568: 'DIV',
  9295: 'Central Pet',
};

const DEFAULT_PROJECT_IDS = Object.keys(PROJECT_LABELS).map((id) => Number(id));

function normalizeDistricts(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(values
    .map((d) => parseInt(String(d).replace(/^district\s*/i, '').trim(), 10))
    .filter((n) => Number.isFinite(n) && DISTRICT_STORES[n]))];
}

function storesForDistricts(districts) {
  const out = [];
  for (const district of normalizeDistricts(districts)) {
    out.push(...DISTRICT_STORES[district]);
  }
  return [...new Set(out)].sort((a, b) => a - b).map((n) => String(n));
}

function districtOptions() {
  return Object.entries(DISTRICT_STORES).map(([district, stores]) => ({
    id: Number(district),
    label: `District ${district}`,
    stores: stores.map((n) => String(n)),
    storeCount: stores.length,
  }));
}

function projectLabel(projectId, fallback) {
  return PROJECT_LABELS[Number(projectId)] || fallback || `Project ${projectId}`;
}

function knownProjectOptions() {
  return DEFAULT_PROJECT_IDS.map((id) => ({
    id,
    name: PROJECT_LABELS[id],
    displayName: PROJECT_LABELS[id],
    label: PROJECT_LABELS[id],
    source: 'preset',
  }));
}

module.exports = {
  DISTRICT_STORES,
  PROJECT_LABELS,
  DEFAULT_PROJECT_IDS,
  normalizeDistricts,
  storesForDistricts,
  districtOptions,
  projectLabel,
  knownProjectOptions,
};
