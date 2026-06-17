'use strict';

// SI login exclusion list (NOT the district mutation guard in apply-scope.js).
// Stores in T's PROD footprint that are NOT assigned to this login in Store
// Intelligence. SI/Rebotics returns an indistinguishable empty for "not
// assigned to you" vs "assigned but no activity", so SI-absence for these
// stores is EXPECTED, not a finding. Their rows are partitioned into the
// `si_excluded` bucket: PROD data is preserved, the SI comparison is
// intentionally skipped, and the skip is logged on every run.
//
// SAFETY-CRITICAL LIST. Because SI gives no distinguishable access-denied
// signal, this list is the only thing separating "correctly excluded" from
// "silently wrong". Re-verify whenever store assignments change: if one of
// these IS later assigned to this login, prove the full SI fetch works for it
// first, then remove it here -- otherwise its real SI data keeps being skipped.
//
// Why these three (verified 2026-06):
//   701-00004 (FM4)  - fuel center, not assigned in SI; no Rebotics task on the probed PROD-visit date
//   701-00007 (FM7)  - fuel center, not assigned in SI; no Rebotics task on the probed PROD-visit date
//   701-00051 (FM51) - not assigned in SI in-app; API raw-tasks resolved it (internal 4751, out-of-band id)
//                      but the full SI fetch is unproven, so cordoned with the others rather than seeded
const SI_EXCLUDED_CUSTOM_IDS = Object.freeze([
  '701-00004',
  '701-00007',
  '701-00051',
]);

const SI_EXCLUDED_SET = new Set(SI_EXCLUDED_CUSTOM_IDS);

// Canonical row-state value for an SI-excluded row. Parallel to si_unverified.
const SI_EXCLUDED_STATE = 'si_excluded';

function isSiExcluded(customId) {
  if (customId == null) return false;
  return SI_EXCLUDED_SET.has(String(customId).trim());
}

module.exports = {
  SI_EXCLUDED_CUSTOM_IDS,
  SI_EXCLUDED_STATE,
  isSiExcluded,
};
