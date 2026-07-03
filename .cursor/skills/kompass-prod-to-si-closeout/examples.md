# PROD → SI closeout — examples

## FM 218 — full reconcile (Jul 2026)

**Morning:** audit + first apply — 1 completed, store blocked on 39848643.  
**Evening:** unblock + 12 more — **13 total** `completed / DONE`.

```powershell
cd C:\Users\tgaut\kompass-netcap

# Evening batch (after clearing mutex)
node scripts/close-d6-d8-fresh-sas-si.js `
  --stores 218 `
  --task-dates 2026-07-02 `
  --sas-dates 2026-07-01,2026-06-30 `
  --out output/fm218-prod-si-final
```

### Completed tasks (13)

| Task | POG | PROD source |
|------|-----|-------------|
| 39849260 | 8885979 | Blitz 7/1 |
| 39848643 | 9088291 | Blitz 7/1 |
| 39848657 | 8920140 | Blitz 7/1 |
| 39849157 | 9088147 | Blitz 7/1 |
| 39849361 | 8885976 | Blitz 7/1 |
| 39849383 | 8885981 | Blitz 7/1 |
| 39849393 | 8885982 | Blitz 7/1 |
| 39849397 | 8922960 | Blitz 7/1 |
| 39849417 | 9086459 | Blitz 7/1 |
| 39849632 | 9123954 | Cut In 6/30 |
| 39849816 | 9194002 | Cut In 6/30 |
| 39849830 | 9194324 | Cut In 6/30 |
| 39850587 | 9112641 | Cut In 6/30 |

~21 backlog tasks skipped — no PROD after URLs on pulled dates.

## D6/D8 district batch

```powershell
node scripts/close-d6-d8-fresh-sas-si.js `
  --districts d6,d8 `
  --task-dates 2026-07-02 `
  --sas-dates 2026-07-02,2026-07-01,2026-06-30 `
  --out output/fresh-d6-d8-closeout
```

Process **in_progress** tasks first (orchestrator sorts them to front).

## Single-task recovery after batch failure

```powershell
# Check blocker
node -e "..."  # prefer a .js script file on Windows

# Corrections only
node scripts/process-backlog-corrections.js --store 218 --date 2026-07-02 --task 39849157

# Force close (when scans done + actions clear)
node scripts/close-backlog-tasks.js --store 218 --date 2026-07-02 --force-task 39849157
```

Use `--force-task` only when no **other** store holds global `in_progress`.

## Dry run before live apply

```powershell
node scripts/close-d6-d8-fresh-sas-si.js `
  --stores 218 `
  --task-dates 2026-07-02 `
  --sas-dates 2026-07-01 `
  --dry-run `
  --out output/fm218-prod-si-dryrun
```

Review `summary.json` → `matched` vs `skipped` before live run.
