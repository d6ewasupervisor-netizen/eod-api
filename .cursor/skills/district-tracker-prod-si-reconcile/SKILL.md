---
name: district-tracker-prod-si-reconcile
description: >-
  Reconcile SUPER Tracker ISE/Blitz copies for any Kompass district against live SAS PROD
  and Store Intelligence; run remediation (PROD→SI, SI→PROD); delta-scan since last write;
  apply K/L to working copies only. Use for district tracker cross-ref, D1/D6/D8 reconcile,
  needs SI complete, needs loaded to PROD, delta scan, p06w2, prod-to-si closeout,
  si-to-prod backfill, or SUPER Tracker K/L columns. Never write live OneDrive trackers.
---

# District Tracker PROD/SI Reconcile

Batch workflow: cross-reference tracker rows with **live SAS PROD + Store Intelligence (SI)**, write **K** (Complete) and **L** (Notes) to **working copies only**, optionally remediate one-sided gaps, then **delta-scan** and apply new completions.

**Repo:** `eod-api/scripts/` · **Stores:** `eod-api/src/lib/trackers/metadata.js` · **Join key:** `P##W#|store|categoryId|dbkey`

## Hard rules

1. **Never modify live OneDrive trackers** — only copies under `Downloads/`.
2. **Auston's OneDrive is read-only unless the user explicitly authorizes a live write.** Do not create backups, promote Yes rows, or save anything under `Auston Nix's files - Trackers` (or other Auston paths) without that instruction. Backups go to **Tyson's** `Downloads/` or Tyson's OneDrive. See `.cursor/rules/onedrive-write-safety.mdc`.
3. **Exact store matching** — normalize to integer strings; never trust SAS `store_number=` substring filters alone (use `lib/sas-store-match.js` elsewhere).
4. **Eligible rows:** store ∈ district, K blank/`No` with L blank (skip adjudicated rows), period within window.
5. **Close Excel** before writes (`~$` lock file will fail `write_tracker.py`).
6. **Count Yes on scoped keys** — full sheet has thousands of historical Yes rows; always count against reconcile scope (cache keys or period filter).

## District presets

| District | Stores (count) | Example `--label` | Example out dir |
|----------|----------------|-------------------|-----------------|
| 1 | 22 | `D1` | `Downloads/p06w2_district1` |
| 6 | 9 | `D6D8` | `Downloads/tracking_new` |
| 8 | 10 | `D6D8` | `Downloads/tracking_new` |

D6+D8 are often run together with `--districts "6,8"`.

## Live sources (read-only)

| Workbook | Path |
|----------|------|
| ISE | `C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker ISE V1.3.xlsm` |
| Blitz | `C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker Blitz V1.3.xlsx` |

Sheets: `ISE & CUT TRACKER`, `BLITZ TRACKER`. **K** = Complete, **L** = Notes.

## Copy naming

For `--label D1` in `--out-dir C:/Users/tgaut/Downloads/p06w2_district1`:

- `SUPER Tracker ISE V1.3 - D1 reconcile copy.xlsm` (reconcile write target)
- `SUPER Tracker ISE V1.3 - D1 copy.xlsm` (working copy — sync from reconcile after run)
- Same pattern for Blitz `.xlsx`

## Workflow A — Full reconcile

```powershell
cd C:\Users\tgaut\eod-api

# Any district (example D1 through P06W2)
node scripts/d6-d8-tracking-reconcile.js `
  --districts "1" `
  --out-dir "C:/Users/tgaut/Downloads/p06w2_district1" `
  --period-end P06W2 `
  --label D1 `
  --confirm-scope D1

# Cross-ref only (skip remediation)
node scripts/d6-d8-tracking-reconcile.js `
  --districts "6,8" --out-dir "C:/Users/tgaut/Downloads/tracking_new" `
  --period-end P06W1 --label D6D8 `
  --skip-prod-to-si --skip-si-to-prod --skip-si-photos
```

**PowerShell:** quote `--districts "6,8"` and `--confirm-scope "D6,D8"` (commas split args).

### K/L outcomes

| PROD | SI | K | L |
|------|----|---|---|
| done | done | `Yes` | blank |
| done | not | `No` | `needs SI complete` |
| not | done | `No` | `needs PROD complete` |
| neither | | `No` | `PROD not complete (...); SI not complete (...)` |

Shift-miss on SI→PROD backfill → L = `needs loaded to PROD`.

### Artifacts (under `--out-dir`)

- `{Label}_writes_cache.json` — proposed K/L per row (e.g. `D1_writes_cache.json`)
- `{Label}_confirmed_sets.json` — durable both-complete cache (skip PROD/SI re-fetch next week)
- `{Label}_reconcile_summary_<stamp>.json`
- `{Label}_reconcile_discrepancies_<stamp>.json` / `.csv`
- `prod-to-si-closeout/summary.json`
- `sitoprod/si-to-prod-backfill_<stamp>.json`

## Confirmed-sets cache (mandatory performance)

Once a set is verified **complete in both PROD and SI**, remember it forever under:

`{out-dir}/{label}_confirmed_sets.json`

Join key: `P##W#|store|categoryId|dbkey`.

| Behavior | Detail |
|----------|--------|
| Full reconcile | Skips confirmed keys even when live OneDrive still shows blank/No K |
| Delta scan | Default skips already-Yes + confirmed keys from live PROD/SI fetch |
| Finish-writes / apply-delta | Upserts Yes keys into the cache |
| First empty cache | Auto-seeds from `{label}_writes_cache.json` Yes rows |
| Force recheck | `--recheck-confirmed` |

### Railway sync (travel / multi-device)

Caches also live on the **eod-api Railway volume**:

`/app/data/eod-artifacts/tracker-cache/{LABEL}/confirmed_sets.json`

API (Bearer `SAS_AUTH_SECRET`):

- `GET/PUT https://eod-api.the-dump-bin.com/internal/tracker-cache/{LABEL}/confirmed_sets`
- `GET/PUT …/writes_cache`
- `GET …/internal/tracker-cache/` (list)

```powershell
cd C:\Users\tgaut\eod-api
# SAS_AUTH_SECRET in .env must match Railway
node scripts/tracker-cache-sync.js --pull --push --label D6D8 --out-dir "C:/Users/tgaut/Downloads/tracking_new"
node scripts/tracker-cache-sync.js --pull --push --label D1 --out-dir "C:/Users/tgaut/Downloads/p06w2_district1"
node scripts/tracker-cache-sync.js --list
```

Reconcile / finish-writes / apply-delta **auto pull+push** when `SAS_AUTH_SECRET` is set (`TRACKER_CACHE_REMOTE=0` to disable).

**Travel laptop still needs:** Advantage OneDrive sync (or working copies), `sas-auth` session, sibling repos (`kompass-netcap`, `rebotics-carry-forward`), Python for Excel writes. Railway holds the *memory* of confirmed sets — not a full headless Excel reconcile worker yet.

```powershell
# Optional shared path across out-dirs:
node scripts/d6-d8-tracking-reconcile.js `
  --districts "6,8" --label D6D8 `
  --out-dir "C:/Users/tgaut/Downloads/tracking_new" `
  --confirmed-cache "C:/Users/tgaut/Downloads/tracker_confirmed_sets.json"
```

Do **not** delete the confirmed cache between weeks — that is the point.

## Workflow B — Resume interrupted reconcile write

When cross-ref + remediation finished but Excel write hung:

```powershell
node scripts/district-tracker-finish-writes.js `
  --out-dir "C:/Users/tgaut/Downloads/p06w2_district1" `
  --label D1
```

Merges **both** `prod-to-si-closeout` completed keys **and** `sitoprod` completed keys + `needs loaded to PROD` from backfill skips. Writes **reconcile copy + working copy**.

## Workflow C — Delta scan (changes since last write)

Read-only live poll; compares to merged baseline (cache + remediation keys).

```powershell
node scripts/district-tracker-delta-scan.js `
  --out-dir "C:/Users/tgaut/Downloads/p06w2_district1" `
  --label D1 `
  --delta-periods P06W1,P06W2
```

**Default `--delta-periods P06W1,P06W2`** — ~30 min vs 2+ hours for full P03..P06 window. Set empty/`all` only when full refresh required.

**Performance:** one shared PROD+SI fetch for ISE+Blitz (do not fetch per workbook). SI task-layer is the bottleneck (~13 min per fiscal week × store batch).

Output: `{Label}_delta_scan_<stamp>.json` / `.csv` with `changes[]`, `summary.newlyYesRows`.

## Workflow D — Apply delta to copies

```powershell
node scripts/district-tracker-apply-delta-writes.js `
  --out-dir "C:/Users/tgaut/Downloads/p06w2_district1" `
  --label D1 `
  --delta-json "C:/Users/tgaut/Downloads/p06w2_district1/D1_delta_scan_<stamp>.json"
```

Writes changed rows to **both** reconcile + working copies; patches `{Label}_writes_cache.json`. Verify scoped Yes count with tracker reader (see [reference.md](reference.md)).

## Workflow E — Remediation (one-sided rows)

Use discrepancy JSON from Workflow A. **Local machine has no Railway `DATABASE_URL`** — always pass `--discrepancies`.

### PROD → SI closeout

```powershell
# Store-level batch (kompass-netcap) — all shift types, decoupled task/SAS dates
cd C:\Users\tgaut\kompass-netcap
node scripts/close-d6-d8-fresh-sas-si.js `
  --stores 218 `
  --task-dates 2026-07-02 `
  --sas-dates 2026-07-01,2026-06-30 `
  --out output/prod-to-si-closeout

# Tracker-driven batch (eod-api) — from discrepancy JSON
node scripts/reconcile-d1-d8-prod-to-si.js `
  --apply-si --districts "1" --confirm-scope D1 --cutoff P06W2 --allow-blurry `
  --discrepancies "C:/Users/tgaut/Downloads/p06w2_district1/D1_reconcile_discrepancies_<stamp>.json" `
  --out "C:/Users/tgaut/Downloads/p06w2_district1/prod-to-si-closeout"
```

Filter: `prodDone && !siDone`. Completed keys merge to Yes at finish-write.

Skill **`kompass-prod-to-si-closeout`** — mutex handling, POG exceptions, bay index mapping, FM 218 lessons.

### SI → PROD backfill

```powershell
node scripts/p06w1-si-to-prod-backfill.js `
  --apply `
  --discrepancies "C:/Users/tgaut/Downloads/p06w2_district1/D1_reconcile_discrepancies_<stamp>.json" `
  --out-root "C:/Users/tgaut/Downloads/p06w2_district1/sitoprod"
```

Requires `needs PROD complete` rows with `siTaskId` + before-photo sample.

## Prerequisites

| Need | Source |
|------|--------|
| SAS PROD session | `sas-auth` → `kompass-netcap/lib/sas-session` · skill `sas-auth-prod-session` |
| Rebotics token | `rebotics-carry-forward` Railway bridge |
| Excel writes | Python + `eod-api/scripts/write_tracker.py` |
| Orchestrator branch | `d6-d8-tracking-reconcile.js` on branch `tracker-reconciliation` (may not be on `main`) |

Refresh auth before long runs. `[db] DATABASE_URL is not set` during reconcile is **expected locally** (discrepancy-driven remediation avoids DB).

## Interpreting completion totals

After reconcile **write** + **delta apply**:

- **Yes** = live PROD **and** SI both done at classify time
- Remediation Yes (4 PROD→SI + 5 SI→PROD on D1 run) are included in reconcile Yes count **after finish-writes**, not in raw cache alone
- **Delta newly Yes** = field progress since last write; apply with Workflow D

**Verify on copies (scoped rows):** read cache keys, count K=Yes in workbook — do not count whole sheet.

## Related skills

- `d6-d8-tracker-reconcile` — D6/D8 shorthand (points here for delta/finish)
- `tracker-reconciliation-proof-workflow` — fixtures, `classifyReconciliation` tests
- `sas-auth-prod-session`, `rebotics-upload-sas-after-pictures`
- `kompass-prod-to-si-closeout` — store-level PROD→SI batch in kompass-netcap (Blitz/Cut In/all shifts)

## Gotchas and lessons learned

See [gotchas.md](gotchas.md) — hung runs, cache vs Excel drift, UTF-16 script corruption, SI fetch cost, Blitz lag vs ISE.

## Commands cheat sheet

| Goal | Script |
|------|--------|
| Full reconcile | `d6-d8-tracking-reconcile.js` |
| Finish after hang | `district-tracker-finish-writes.js` |
| Scan for changes | `district-tracker-delta-scan.js` |
| Apply delta | `district-tracker-apply-delta-writes.js` |
| Sync caches ↔ Railway | `tracker-cache-sync.js --pull --push --label D6D8` |
| PROD→SI | `reconcile-d1-d8-prod-to-si.js --discrepancies` |
| SI→PROD | `p06w1-si-to-prod-backfill.js --discrepancies` |
| Force recheck confirmed | add `--recheck-confirmed` to reconcile or delta-scan |
