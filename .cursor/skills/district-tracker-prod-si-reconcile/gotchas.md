# Gotchas — District Tracker PROD/SI Reconcile

Hard-won lessons from D1 P06W2 reconcile (June 2026). Read before a long run.

## Scope and matching

- **SAS PROD substring store filters lie.** `store_number=28` returns 281, 428, etc. Reconcile uses store list from `metadata.js` and client-side exact match on join key.
- **Eligible row filter skips adjudicated rows:** K=`No` with non-blank L are excluded from reconcile scope.
- **After marking K=Yes, rows drop out of `isEligibleRow`** — delta scan must use **fixed key list from cache**, not re-scan eligible-only from live OneDrive.
- **Scoped Yes count ≠ sheet Yes count.** ISE sheet may show 9k+ Yes historically; reconcile scope might be 412 rows. Always verify against cache keys.

## Orchestrator and scripts

- **`d6-d8-tracking-reconcile.js` may live on `tracker-reconciliation` branch**, not `main`. Restore with:
  `git checkout tracker-reconciliation -- scripts/d6-d8-tracking-reconcile.js`
- **Never redirect Node output to save the script in PowerShell** — can corrupt file as UTF-16. Use `git checkout` to restore.
- **Main reconcile can hang after remediation** (~50+ min) while SAS bridge heartbeats continue — cross-ref done, Excel write not started. Use `district-tracker-finish-writes.js`.
- **`_finish-d1-writes.js` pattern:** merge cache + prod-to-si + si-to-prod completed keys before write. Raw `{Label}_writes_cache.json` alone understates Yes (e.g. 58 vs 67) until merge.

## Cache vs Excel drift

- **Excel copies reflect finish-write; cache may lag** until delta apply patches it.
- **Delta baseline must merge remediation keys** (prod-to-si `completed`, si-to-prod `status=completed`, shift-miss → `needs loaded to PROD`) or false "newly Yes" / wrong before state.
- **After delta apply, trust Excel scoped count** over cache `countOutcomes` if cache was stale pre-merge.

## Performance

- **SI task-layer fetch dominates runtime** (~13 min per fiscal week × ~20 D1 stores). Full P03W4..P06W2 ≈ 13 weeks ≈ 2+ hours.
- **Do not fetch ISE and Blitz separately** — union tracker rows, one PROD+SI fetch, classify twice.
- **Delta default `P06W1,P06W2`** covers most open rows (643/696 on D1 run); older periods unlikely to change overnight.
- **Confirmed-sets cache** (`{Label}_confirmed_sets.json`) skips both-complete keys on later full reconcile + delta fetch. Without it, live OneDrive blank/No K rows get re-scanned every week even after copies were marked Yes.
- **Killing a run:** exit code `4294967295` on Windows = process stopped, not a logic error.

## Remediation

- **Railway `DATABASE_URL` unset locally** — `[db]` warnings normal. Use `--discrepancies` JSON for prod-to-si; do not rely on DB join locally.
- **PROD→SI:** 11 candidates → 4 completed, 4 skipped, 3 errors typical. CV reject, no task-layer match, missing blurry path.
- **SI→PROD:** 19 sets → 5 completed, 14 skipped (no SAS visit / POG not on visit) → L becomes `needs loaded to PROD` at finish-write.
- **4 PROD→SI completes are 4 of the reconcile Yes**, not all 67. Majority (58) were already both-complete at cross-ref.

## K/L semantics

| User phrase | Meaning |
|-------------|---------|
| needs SI complete | PROD done, SI not |
| needs PROD complete | SI done, PROD not |
| needs loaded to PROD | SI done but no SAS visit to receive backfill |
| PROD absent → not_done | Visit appeared since last scan (note-only delta) |

- **Blitz often lags ISE** — same stores/periods may stay dual-incomplete on Blitz while ISE flips Yes (cat-201 Blitz batch common).
- **Zero lost Yes on delta** is a good sanity check — regressions are rare but watch for SI task expiry.

## Writes and safety

- **`write_tracker.py` creates `.bak-<timestamp>`** before mutating — check backup if wrong apply.
- **Write both reconcile copy and working copy** — users open `- D1 copy`; reconcile copy is write pipeline source.
- **Live OneDrive never touched** — promote to live only via explicit human copy.

## Auth

- SAS: `sas-auth/.sas-session/auth-state.json` via `morning-auth.js`
- Rebotics: Railway bridge from `rebotics-carry-forward/.env`
- Grafana Query 46 cookie optional; task-layer API used when token available

## When to re-run what

| Situation | Action |
|-----------|--------|
| Field week closed, new completions | Delta scan → apply |
| First time district/period | Full reconcile |
| Reconcile hung mid-run | Finish-writes |
| Only remediation needed | Discrepancy JSON → prod-to-si / si-to-prod → finish-writes |
| User asks "what changed since last scan" | Delta scan (Workflow C), not full reconcile |
