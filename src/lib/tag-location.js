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
    return `Aisle ${Number(peg[1])}, Row ${Number(peg[2])}, Column ${Number(peg[3])}`;
  }

  const shelf = s.match(/^(\d+)B(\d+)F(\d+)P(\d+)$/i);
  if (shelf) {
    return `Aisle ${Number(shelf[1])}, Bay ${Number(shelf[2])}, Shelf ${Number(shelf[3])}, Position ${Number(shelf[4])}`;
  }

  const shelfRowCol = s.match(/^(\d+)B(\d+)F(\d+)R(\d+)C(\d+)$/i);
  if (shelfRowCol) {
    return `Aisle ${Number(shelfRowCol[1])}, Bay ${Number(shelfRowCol[2])}, Shelf ${Number(shelfRowCol[3])}, Row ${Number(shelfRowCol[4])}, Column ${Number(shelfRowCol[5])}`;
  }

  return s;
}

/**
 * Human label for a register lane with optional physical store name.
 * @returns {string}
 */
function laneDisplayLabel(lane, physicalName) {
  const laneStr = String(lane ?? '').trim();
  const name = String(physicalName ?? '').trim();
  if (!laneStr) return name;
  if (!name) return laneStr;
  return `${laneStr} · ${name}`;
}

/**
 * Section header for grouped tags / assignments.
 * @param {number|null} aisle
 * @param {Record<string, string>|null|undefined} laneNamesMap
 * @returns {string}
 */
function aisleGroupLabel(aisle, laneNamesMap) {
  if (aisle == null || aisle >= 99999) return 'Unknown aisle';
  const key = String(aisle);
  const physicalName = laneNamesMap?.[key];
  if (physicalName) return laneDisplayLabel(aisle, physicalName);
  return `Aisle ${aisle}`;
}

/**
 * Add physical lane name to a tag location string for print / field display.
 * Original register numbers stay in compact codes; human labels gain the store name.
 * @returns {string|null}
 */
function enrichLocationWithPhysicalName(location, lane, physicalName) {
  const name = String(physicalName ?? '').trim();
  if (!name) return formatTagLocationLabel(location) || location || null;

  const raw = String(location ?? '').trim();
  const formatted = formatTagLocationLabel(location) || raw;
  if (!formatted) return name;

  const laneStr = lane != null && lane !== '' ? String(lane).trim() : '';
  if (laneStr && formatted.includes(`Aisle ${laneStr}`)) {
    return formatted.replace(`Aisle ${laneStr}`, name);
  }
  if (/^Lane\s+\d+/i.test(formatted)) {
    return formatted.replace(/^Lane\s+\d+/i, name);
  }
  if (raw && /^\d+[BRFP]/i.test(raw)) {
    const expanded = formatTagLocationLabel(raw);
    if (expanded && laneStr && expanded.includes(`Aisle ${laneStr}`)) {
      return expanded.replace(`Aisle ${laneStr}`, name);
    }
    return `${name} · ${formatted}`;
  }
  if (formatted.includes(name)) return formatted;
  return `${name} · ${formatted}`;
}

/**
 * @param {{ location?: string|null, dbkey?: string|null, lane?: string|number|null }} tag
 * @returns {number}
 */
function aisleSortKey(tag) {
  const fromLoc = parseAisleFromLocation(tag.location);
  if (fromLoc != null && Number.isFinite(fromLoc)) return fromLoc;

  if (tag.lane != null && tag.lane !== '') {
    const laneNum = Number(String(tag.lane).replace(/\D/g, ''));
    if (Number.isFinite(laneNum)) return laneNum;
  }

  return 99999;
}

/**
 * Sort tags for print: aisle ascending, then location, then description.
 * @param {Array<object>} tags
 * @returns {Array<object>}
 */
function sortTagsByAisle(tags) {
  return tags.slice().sort((a, b) => {
    const aisleA = aisleSortKey(a);
    const aisleB = aisleSortKey(b);
    if (aisleA !== aisleB) return aisleA - aisleB;

    const locA = String(a.location || a.dbkey || '');
    const locB = String(b.location || b.dbkey || '');
    if (locA !== locB) return locA.localeCompare(locB, undefined, { numeric: true });

    const descA = String(a.description || '');
    const descB = String(b.description || '');
    return descA.localeCompare(descB);
  });
}

/**
 * Group sorted tags by aisle number for UI / PDF section headers.
 * @param {Array<object>} tags
 * @returns {Array<{ aisle: number|null, aisleLabel: string, tags: Array<object> }>}
 */
function groupTagsByAisle(tags, laneNamesMap) {
  const sorted = sortTagsByAisle(tags);
  const groups = [];
  let current = null;

  for (const tag of sorted) {
    const aisle = aisleSortKey(tag);
    const aisleLabel = aisleGroupLabel(aisle >= 99999 ? null : aisle, laneNamesMap);
    if (!current || current.aisle !== aisle) {
      current = { aisle: aisle >= 99999 ? null : aisle, aisleLabel, tags: [] };
      groups.push(current);
    }
    current.tags.push(tag);
  }

  return groups;
}

module.exports = {
  parseAisleFromLocation,
  formatTagLocationLabel,
  laneDisplayLabel,
  aisleGroupLabel,
  enrichLocationWithPhysicalName,
  aisleSortKey,
  sortTagsByAisle,
  groupTagsByAisle,
};
