---
name: d6-d8-tracker-reconcile
description: Reconcile SUPER Tracker ISE/Blitz copies for Districts 6 and 8 against live SAS PROD and Store Intelligence through P06W1. Copies only — never live OneDrive trackers. Use for D6/D8 tracker cross-ref, needs SI complete, needs PROD complete, tracking_new, or prod-to-SI closeout from discrepancy JSON.
---

# D6/D8 Tracker Reconcile (copies only)

Operational batch workflow for **District 6 + District 8** Kompass ISE and Blitz tracker rows. **Never write live OneDrive trackers** — only working copies under `Downloads/tracking_new/`.

## Live sources (read-only)

| Workbook | Path |
|----------|------|
| ISE | `C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker ISE V1.3.xlsm` |
| Blitz | `C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker Blitz V1.3.xlsx` |

Sheets: `ISE & CUT TRACKER`, `BLITZ TRACKER`. Column **K** = Complete, **L** = Notes.

## District stores

From `src/lib/trackers/metadata.js`:

- **D6:** 49, 163, 214, 286, 351, 486, 652, 654, 657
- **D8:** 19, 23, 28, 31, 53, 215, 391, 459, 658, 682

Match store numbers as **exact integers** after normalization (never substring-match `store_number` API filters alone).

## Eligible rows

Include when **all** of:

- Store ∈ D6 ∪ D8
- K is blank or `No`, and L is blank (skip adjudicated rows with comments)
- Period ≤ **P06W1** (upper bound)
- Period ≥ **oldest** eligible incomplete period among D6/D8 rows (dynamic lower bound)

## Main orchestrator

```powershell
cd c:\Users\tgaut\eod-api
node scripts/d6-d8-tracking-reconcile.js
node scripts/d6-d8-tracking-reconcile.js --skip-prod-to-si --skip-si-to-prod --skip-si-photos
```

Steps:

1. Copy ISE + Blitz → `C:/Users/tgaut/Downloads/tracking_new/`
2. Discover period window (oldest eligible … P06W1)
3. Fetch live PROD + SI; `classifyReconciliation()` with join key `P##W#|store|categoryId|dbkey`
4. Write proposed K/L to **copies** via `write_tracker.py`
5. Optional remediation: PROD→SI closeout, SI→PROD backfill
6. Cache writes to `D6D8_writes_cache.json`; emit summary + discrepancy JSON/CSV

### K/L outcomes

| PROD | SI | K | L |
|------|----|---|---|
| done | done | `Yes` | blank |
| done | not | `No` | `needs SI complete` |
| not | done | `No` | `needs PROD complete` |
| neither | | `No` | `PROD not complete (...); SI not complete (...)` |

When user confirms **PROD-only complete** (SI task absent/expired), mark copy **Yes** / blank — do not leave stale SI failure comments.

## PROD → SI closeout (local, no Railway DB)

`reconcile-d1-d8-prod-to-si.js` normally needs Railway `DATABASE_URL` (internal hostname fails locally). Use **`--discrepancies`** with the reconcile export instead:

```powershell
node scripts/reconcile-d1-d8-prod-to-si.js `
  --apply-si `
  --districts "6,8" `
  --confirm-scope "D6,D8" `
  --cutoff P06W1 `
  --allow-blurry `
  --discrepancies "C:/Users/tgaut/Downloads/tracking_new/D6D8_reconcile_discrepancies_<stamp>.json" `
  --out "C:/Users/tgaut/Downloads/tracking_new/prod-to-si-closeout"
```

PowerShell: **quote** `--districts "6,8"` and `--confirm-scope "D6,D8"` (commas split args otherwise).

Filter discrepancies to rows where `prodDone && !siDone`. Seeds `siTaskId` from export when present; resolves today's Tasks-layer tasks per store.

### SI closeout failure notes (copies only)

| Situation | L comment |
|-----------|-----------|
| No Tasks-layer match | `no live SI task on task layer` |
| HTTP 409 expired window | `SI task expired — cannot close in SI` |
| User accepts PROD-only | `Yes` / blank |

## SI → PROD backfill

```powershell
node scripts/p06w1-si-to-prod-backfill.js `
  --apply `
  --discrepancies "C:/Users/tgaut/Downloads/tracking_new/D6D8_reconcile_discrepancies_<stamp>.json" `
  --out-root "C:/Users/tgaut/Downloads/tracking_new/sitoprod"
```

Requires `needs PROD complete` rows with `siTaskId` and before-photo sample at `p06w1_signoff_verify/samples/`.

Triage shift misses:

```powershell
node scripts/p06w1-needs-loaded-to-prod-list.js `
  "C:/Users/tgaut/Downloads/tracking_new/sitoprod/si-to-prod-backfill_<stamp>.json"
```

## Resume interrupted writes

```powershell
node scripts/d6-d8-tracking-finish-writes.js
```

Merges `D6D8_writes_cache.json` + prod-to-si `summary.json` completed keys + `needs loaded to PROD` from backfill report; writes copies only.

## Prerequisites

- SAS session (`sas-auth` / `kompass-netcap/lib/sas-session`)
- Rebotics token (Railway bridge via `rebotics-carry-forward`)
- Python for `scripts/write_tracker.py`
- Excel copies not locked open

## Related skills

- `tracker-reconciliation-proof-workflow` — hermetic tests, fixtures, adapter extraction
- `rebotics-upload-sas-after-pictures` — Tasks vs Capture layer, photo upload details
- `sas-auth-prod-session` — SAS cookie refresh

## Output artifacts

Under `C:/Users/tgaut/Downloads/tracking_new/`:

- `SUPER Tracker ISE V1.3 - D6D8 reconcile copy.xlsm`
- `SUPER Tracker Blitz V1.3 - D6D8 reconcile copy.xlsx`
- `D6D8_reconcile_summary_<stamp>.json`
- `D6D8_reconcile_discrepancies_<stamp>.json` / `.csv`
- `D6D8_writes_cache.json`
- `prod-to-si-closeout/summary.json`
- `sitoprod/si-to-prod-backfill_<stamp>.json`
