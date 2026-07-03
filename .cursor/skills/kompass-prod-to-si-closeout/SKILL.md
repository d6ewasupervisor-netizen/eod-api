---
name: kompass-prod-to-si-closeout
description: >-
  Loads SAS PROD after photos into live Store Intelligence task-layer sets for Fred Meyer
  D6/D8 stores — audit all shift types, match by POG, upload, clear CV actions, complete.
  Use for prod-to-si reconcile, fresh SAS closeout, FM218-style backlog, Blitz/Cut In photos
  on today's SI tasks, close-d6-d8-fresh-sas-si, or when PROD has photos but SI is backlog.
---

# Kompass PROD → SI closeout (D6/D8)

Batch workflow: pull SAS category-reset **after** photos for one or more **source dates**, match to **today's live SI task IDs** by POG, upload, run CV corrections, survey `0`, `PUT completed`.

**Repo:** `kompass-netcap` · **Orchestrator:** `scripts/close-d6-d8-fresh-sas-si.js` · **Corrections:** `scripts/process-backlog-corrections.js`

## When to use

- User asks to reconcile PROD photos into Store Intelligence for a store/date.
- Tracker row says `needs SI complete` and PROD after URLs exist.
- Prior-day SAS photos must close **today's** SI task layer (yesterday's task IDs are frozen).
- Candy Blitz, Cut In rollover, ISE, Special, or Surge — not ISE-only.

## Hard rules

1. **SI task date ≠ SAS photo date.** PROD photos from `2026-07-01` load into SI tasks on `2026-07-02`. Never mutate frozen prior-day task IDs (`409` on `PUT in_progress`).
2. **One `in_progress` task per Rebotics user.** A stuck task blocks every other `PUT in_progress` at that store (`HTTP 400`). Finish or fix the blocker **before** batch closeout.
3. **Map photos by section index, not bay label.** SI bays may be non-contiguous (`1,3,5,7`). Photo index `i` → `i`th section sorted by bay — do not match `bay N` label to filename `bayN`.
4. **Never trust SAS `store_number=` filters alone** for visit lists — substring-match. Client-filter after fetch when using other SAS tools.
5. **Open shift once per store** before uploads: `POST /api/v1/shifts/`.
6. **Prefer script files over PowerShell inline `node -e`** — quoting breaks on Windows.

## Quick start

```powershell
cd C:\Users\tgaut\kompass-netcap

# Audit first (optional but recommended)
# Pull all shift types; write output/fm{N}-reconcile-report-{date}/

# Live closeout: SI layer = today, SAS photos = today + yesterday (+ Cut In rollover)
node scripts/close-d6-d8-fresh-sas-si.js `
  --stores 218 `
  --task-dates 2026-07-02 `
  --sas-dates 2026-07-01,2026-06-30 `
  --out output/fm218-prod-si-closeout
```

| Flag | Meaning |
|------|---------|
| `--stores` | FM store numbers (comma-separated) |
| `--task-dates` | SI Tasks layer date(s) to mutate |
| `--sas-dates` | SAS category-report source date(s) for after URLs |
| `--districts d6,d8` | Default store list when `--stores` omitted |
| `--dry-run` | Match + download only |
| `--skip-close` | Upload + corrections only |
| `--max-tasks N` | Cap per run |

## SAS shift types pulled (all strategies)

| Project | Mode | Label |
|---------|------|-------|
| 1 | scheduled / reported-completed | ISE |
| 1715 | scheduled / reported-completed | Blitz |
| 1668 | scheduled / reported-completed | Cut In |
| 3568 | scheduled / reported-completed | Special |
| 9295 | scheduled / reported-completed | Surge |

Cut In photos often appear on **reported-completed** rows from **prior scheduled date** (e.g. 6/30 work closing on 7/1).

## Pipeline

```text
1. Discover SI backlog on --task-dates (incomplete + Backlog reason)
2. Pull SAS CSVs for each --sas-dates × each strategy
3. Match task POG → SAS row with After Pictures Link URLs
4. Download JPGs → output/{run}/photos/
5. PUT in_progress → upload by section index → wait CV (~120s)
6. process-backlog-corrections.js --store {fm} --date {task-date} --task {id}
7. Survey "How many bays/doors?" → "0" → PUT completed
8. If pre_photo_required → exception-fix loop (see gotchas.md)
```

## Pivotal actions that unlock success

| Blocker | Fix that worked (FM 218, Jul 2026) |
|---------|-------------------------------------|
| Store mutex | Close stuck `in_progress` task first (39848643: delete scans → re-upload → correct → complete) |
| `insufficient photos: N for M sections` | Re-parse CSV **After Pictures Link** tail (row may have 7+ URLs); or SAS for available bays + **blurry** for remainder |
| `pre_photo_required` + all scans `done` | `pog_exception` on section — **DELETE** that scan, re-upload (blurry OK), wait 70s, corrections, retry **one section at a time** |
| `scan_status: REJECTED` | Delete problem scans; do not batch-blurry while SAS CV still running |
| Batch run errors after first task | Prior task left `in_progress` — run manual complete loop on blocker, then re-run orchestrator |
| HTTP 400 on complete (not mutex) | Read body: `{"code":"pre_photo_required","missing_sections":[...]}` |

## Manual exception-fix loop

When orchestrator stops mid-task:

```powershell
# 1. Diagnose
# GET task → status, scan_status
# PUT completed → read missing_sections from 400 body

# 2. Per missing section_id:
#    DELETE /api/v1/tasks/{id}/processing/actions/{scanId}/
#    upload blurry or SAS to that section_id only
#    wait 70s
#    node scripts/process-backlog-corrections.js --store {fm} --date {task-date} --task {id}

# 3. Survey start + PATCH answer "0" + PUT completed
```

See `rebotics-blurry-photo-cv-bypass` for blurry asset path and upload attach fields.

## What NOT to do

- Do **not** target yesterday's SI task IDs after midnight rollover — they return **409**.
- Do **not** run `close-backlog-tasks.js` when another store's task is globally `in_progress` — it tries to close the wrong task.
- Do **not** `PATCH { scan_status: null }` **before** deleting rejected scans — server reverts to `REJECTED`.
- Do **not** assume `actions_count` zero means completable — POG exceptions still block.
- Do **not** skip corrections after SAS upload — candy sets generate heavy move/remove/identify idle actions.
- Do **not** continue batch upload after orchestrator throws on one task without clearing that task's `in_progress` state.

## Auth

| System | Source |
|--------|--------|
| SAS PROD | `sas-auth/.sas-session/auth-state.json` · skill `sas-auth-prod-session` |
| Rebotics | `rebotics-carry-forward` Railway bridge · skill `rebotics-api-auth` |

## Artifacts

Each `--out` run writes:

- `summary.json` — discovered / matched / completed / skipped / errors
- `sas-csv/store{fm}-{date}-p{project}-*.csv`
- `photos/` — downloaded after JPGs per task

## Related skills

- `rebotics-current-task-layer-closeout` — single-store / single-POG manual closeout
- `rebotics-blurry-photo-cv-bypass` — partial photos + POG exceptions
- `rebotics-task-photo-correct-ids` — store_planogram / category_id / section_id
- `kompass-backlog-sas-reports-batch` — SAS CSV pulls without SI closeout
- `district-tracker-prod-si-reconcile` — tracker K/L + batch remediation from discrepancy JSON

## Deep reference

- [gotchas.md](gotchas.md) — FM 218 case study, CSV parsing, bay mapping, mutex chain
- [examples.md](examples.md) — command recipes and outcome tables
