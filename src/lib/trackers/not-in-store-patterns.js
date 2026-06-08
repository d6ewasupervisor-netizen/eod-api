'use strict';

const DEFAULT_NOT_IN_STORE_PATTERNS = [
  'not in store',
  'store does not have',
  'do not have in store',
  'do not have rack',
  "store doesn't have",
  'not inn store',
];

function normalizePhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedPatternSet(patterns = DEFAULT_NOT_IN_STORE_PATTERNS) {
  return new Set((patterns || [])
    .map(normalizePhrase)
    .filter(Boolean));
}

function isBacklogException(value) {
  return normalizePhrase(value).includes('backlog');
}

function isNotInSiClaim(value) {
  const normalized = normalizePhrase(value);
  return /\bnot\s+in\s+s\.?i\.?\b/.test(normalized) || /\bnot\s+in\s+store\s+intelligence\b/.test(normalized);
}

function describeNotInStoreMatch(comment, patterns = DEFAULT_NOT_IN_STORE_PATTERNS) {
  const normalized = normalizePhrase(comment);
  if (!normalized || isNotInSiClaim(normalized)) {
    return { state: 'none', phrase: normalized };
  }
  if (normalizedPatternSet(patterns).has(normalized)) {
    return { state: 'confirmed', phrase: normalized, matchedPattern: normalized };
  }

  const isShort = normalized.length <= 80;
  const hasAbsenceToken = /\b(store|stre|have|hav|has|carry|carries|carried|stock|stocked|discontinu|n\/a|not applicable)\b/.test(normalized);
  const hasNegativeCue = /\b(no|not|doesn'?t|doesnt|dosnt|dont|don't|cannot|can't|cant|n\/a|not applicable)\b|n't\b|discontinu/.test(normalized);
  if (isShort && hasAbsenceToken && hasNegativeCue) {
    return { state: 'candidate', phrase: normalized };
  }
  return { state: 'none', phrase: normalized };
}

function matchNotInStore(comment, patterns = DEFAULT_NOT_IN_STORE_PATTERNS) {
  return describeNotInStoreMatch(comment, patterns).state;
}

module.exports = {
  DEFAULT_NOT_IN_STORE_PATTERNS,
  describeNotInStoreMatch,
  isBacklogException,
  isNotInSiClaim,
  matchNotInStore,
  normalizePhrase,
};
