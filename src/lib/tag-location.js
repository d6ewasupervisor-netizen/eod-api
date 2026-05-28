/**
 * Parse aisle numbers from tag location strings and sort tags for print batches.
 */

/**
 * Extract a numeric aisle from a location label.
 * Supports compact peg labels (1R02C03), "Lane 607", and leading bay digits.
 * @returns {number|null}
 */
function parseAisleFromLocation(location) {
  const s = String(location || '').trim();
  if (!s) return null;

  const compact = s.match(/^(\d+)R\d+C\d+$/i);
  if (compact) return Number(compact[1]);

  const lane = s.match(/(?:^|\b)(?:lane|aisle)\s*(\d+)/i);
  if (lane) return Number(lane[1]);

  const bay = s.match(/^(\d+)B\d+F\d+P\d+$/i);
  if (bay) return Number(bay[1]);

  const leading = s.match(/^(\d+)/);
  if (leading) return Number(leading[1]);

  return null;
}

/**
 * Expand compact tag locations (601B01F02P03, 607R02C03) for fax / print labels.
 * Passes through human-readable labels unchanged.
 * @returns {string|null}
 */
function formatTagLocationLabel(location) {
  const s = String(location || '').trim();
  if (!s) return null;

  if (/bay\s+\d+/i.test(s) || s.includes('·')) {
    return s;
  }

  if (s.includes('\n')) {
    return s
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(', ');
  }

  const peg = s.match(/^(\d+)R(\d+)C(\d+)$/i);
  if (peg) {
    return `Reg ${Number(peg[1])}, Row ${Number(peg[2])}, Column ${Number(peg[3])}`;
  }

  const shelf = s.match(/^(\d+)B(\d+)F(\d+)P(\d+)$/i);
  if (shelf) {
    return `Reg ${Number(shelf[1])}, Bay ${Number(shelf[2])}, Shelf ${Number(shelf[3])}, Position ${Number(shelf[4])}`;
  }

  const shelfRowCol = s.match(/^(\d+)B(\d+)F(\d+)R(\d+)C(\d+)$/i);
  if (shelfRowCol) {
    return `Reg ${Number(shelfRowCol[1])}, Bay ${Number(shelfRowCol[2])}, Shelf ${Number(shelfRowCol[3])}, Row ${Number(shelfRowCol[4])}, Column ${Number(shelfRowCol[5])}`;
  }

  return s;
}

/**
 * Prepend store aisle designation to a shelf location for print / field display.
 * @returns {string|null}
 */
function enrichLocationWithStoreAisle(location, storeAisleLabel) {
  const label = String(storeAisleLabel ?? '').trim();
  const formatted = formatTagLocationLabel(location) || String(location || '').trim() || null;
  if (!label) return formatted;
  if (!formatted) return label;
  if (formatted.includes(label)) return formatted;
  return `${label} · ${formatted}`;
}

/**
 * @param {{ location?: string|null, dbkey?: string|null, lane?: string|number|null, storeAisleLabel?: string|null }} tag
 * @returns {number}
 */
function registerSortKey(tag) {
  const fromLoc = parseAisleFromLocation(tag.location);
  if (fromLoc != null && Number.isFinite(fromLoc)) return fromLoc;

  if (tag.lane != null && tag.lane !== '') {
    const laneNum = Number(String(tag.lane).replace(/\D/g, ''));
    if (Number.isFinite(laneNum)) return laneNum;
  }

  return 99999;
}

function storeAisleSortKey(tag) {
  const label = String(tag.storeAisleLabel || '').trim();
  if (label) return label.toLowerCase();
  const reg = registerSortKey(tag);
  return reg >= 99999 ? 'zzz-unknown' : `reg-${String(reg).padStart(5, '0')}`;
}

/**
 * Sort tags for print: store aisle label, then register, then location, then description.
 * @param {Array<object>} tags
 * @returns {Array<object>}
 */
function sortTagsByAisle(tags) {
  return tags.slice().sort((a, b) => {
    const aisleA = storeAisleSortKey(a);
    const aisleB = storeAisleSortKey(b);
    if (aisleA !== aisleB) return aisleA.localeCompare(aisleB, undefined, { numeric: true });

    const regA = registerSortKey(a);
    const regB = registerSortKey(b);
    if (regA !== regB) return regA - regB;

    const locA = String(a.location || a.dbkey || '');
    const locB = String(b.location || b.dbkey || '');
    if (locA !== locB) return locA.localeCompare(locB, undefined, { numeric: true });

    const descA = String(a.description || '');
    const descB = String(b.description || '');
    return descA.localeCompare(descB);
  });
}

const UNASSIGNED_AISLE_KEY = '__unassigned__';

/**
 * Canonical, stable identifier for a tag's store aisle. Used to group, assign,
 * and send batches per aisle so the UI and server agree on the same key.
 * @param {object} tag
 * @returns {string}
 */
function aisleKeyForTag(tag) {
  // Sweep-added tags freeze the canonical aisle key chosen at scan time so they
  // group with exactly the aisle the lead/assignee targeted.
  const explicit = String(tag.aisleKeyExplicit || '').trim();
  if (explicit) return explicit;
  const storeLabel = String(tag.storeAisleLabel || '').trim();
  if (storeLabel) return storeLabel;
  const reg = registerSortKey(tag);
  return reg >= 99999 ? UNASSIGNED_AISLE_KEY : `reg-${reg}`;
}

/**
 * Group sorted tags by store aisle designation for UI / PDF section headers.
 * @param {Array<object>} tags
 * @returns {Array<{ aisle: string|null, aisleKey: string, aisleLabel: string, tags: Array<object> }>}
 */
function groupTagsByAisle(tags) {
  const sorted = sortTagsByAisle(tags);
  const groups = [];
  const byKey = new Map();

  for (const tag of sorted) {
    const storeLabel = String(tag.storeAisleLabel || '').trim();
    const reg = registerSortKey(tag);
    const aisleLabel = storeLabel || (reg >= 99999 ? 'Unassigned store aisle' : `Register ${reg}`);
    const aisleKey = aisleKeyForTag(tag);
    const legacyAisle = storeLabel || (reg >= 99999 ? null : String(reg));

    // Key-based (not adjacency-based) so frozen sweep tags always land in the
    // exact aisle group they targeted, even if their sort order differs.
    let group = byKey.get(aisleKey);
    if (!group) {
      group = { aisle: legacyAisle, aisleKey, aisleLabel, tags: [] };
      byKey.set(aisleKey, group);
      groups.push(group);
    }
    group.tags.push(tag);
  }

  return groups;
}

module.exports = {
  parseAisleFromLocation,
  formatTagLocationLabel,
  enrichLocationWithStoreAisle,
  registerSortKey,
  storeAisleSortKey,
  sortTagsByAisle,
  groupTagsByAisle,
  aisleKeyForTag,
  UNASSIGNED_AISLE_KEY,
};
