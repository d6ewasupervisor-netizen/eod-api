'use strict';

/**
 * Parse category and version tokens from manifest POG ids or action strings.
 * Example: D701_L00000_D03_C201_V417_I145_MX_9088146 → C201, 417 (not D701).
 */

function parsePogMeta({ manifestPogId, action, dbkey } = {}) {
  const sources = [manifestPogId, action].filter(Boolean).map((s) => String(s).trim());

  let category = null;
  let version = null;

  for (const s of sources) {
    if (!category) {
      const cat = s.match(/_C(\d+)_/i) || s.match(/^C(\d+)_/i);
      if (cat) category = cat[1];
    }
    if (!version) {
      const ver = s.match(/_V([A-Z0-9]+)_/i) || s.match(/^C\d+_V([A-Z0-9]+)_/i);
      if (ver) version = ver[1];
    }
  }

  return {
    category,
    version,
    dbkey: dbkey != null && dbkey !== '' ? String(dbkey).trim() : null,
  };
}

/**
 * Subject: FM163 C201 V417 DBKEY9088146
 */
function buildNisHelpdeskSubject({ storeNumber, category, version, dbkey }) {
  const store = String(storeNumber).replace(/\D/g, '');
  const fm = store ? String(Number(store)).padStart(3, '0') : '000';
  const parts = [`FM${fm}`];
  if (category) parts.push(`C${category}`);
  if (version) parts.push(`V${version}`);
  if (dbkey) parts.push(`DBKEY${dbkey}`);
  return parts.join(' ');
}

module.exports = {
  parsePogMeta,
  buildNisHelpdeskSubject,
};
