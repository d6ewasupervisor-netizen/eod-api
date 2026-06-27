---
name: d1-outstanding-sets-reconcile
description: Reconciles an "Outstanding Sets In District 1" Excel workbook against SAS PROD and Store Intelligence (Rebotics). Cross-references every outstanding set by DBKey, completes live SI tasks with PROD after-photos, performs a backward date search for sets not found in the active SI window, annotates a copy of the workbook with Supervisor Comments (initials TAG), and inserts blank rows between period/week groups. Use when the user has an outstanding-sets workbook from District 1 and needs to reconcile, complete, or annotate sets in PROD/SI.
disable-model-invocation: true
---

# D1 Outstanding Sets Reconciliation

## Scripts (eod-api repo)

| Script | Purpose |
|--------|---------|
| `scripts/d1-outstanding-si-reconcile.js` | Main reconcile — reads workbook, cross-refs PROD+SI, completes tasks, produces action log + workbook-update JSON |
| `scripts/d1-outstanding-update-workbook.py` | Writes Supervisor Comments back into a versioned copy of the workbook |

## Quick run

```powershell
# 1. Full reconcile (all stores)
cd C:\Users\tgaut\eod-api
node scripts/d1-outstanding-si-reconcile.js

# 2. Scope to specific stores
node scripts/d1-outstanding-si-reconcile.js --store 63,694

# 3. Dry run (no SI mutations)
node scripts/d1-outstanding-si-reconcile.js --dry-run

# 4. Apply workbook updates
python scripts/d1-outstanding-update-workbook.py "C:/path/to/updates.json" \
  --workbook "C:/path/to/Annotated.xlsx" \
  --replace-pattern "SI completion error|SI Error:"
```

Output goes to `C:/Users/tgaut/Downloads/d1-outstanding-YYYY-MM-DD/`:
- `d1_outstanding_action_log_*.json` — full per-row audit trail
- `d1_outstanding_action_log_*.csv` — spreadsheet-friendly version
- `d1_workbook_updates_*.json` — Supervisor Comment updates ready to apply

## What the reconcile script does per row

1. **Skip** Cat 201 CANDY rows and rows with no Rebotics store ID
2. **PROD check** — fetches the category-reset-report CSV for P4W1→present; matches by DBKey
3. **SI backward search** — queries SI task list day-by-day from today backward to find the task; records the completion date if already done
4. **Action decision:**
   - SI already complete → note date in workbook
   - PROD done, SI incomplete → upload PROD after-photos, clear actions, answer survey, close
   - PROD not done, supervisor says "complete in SI" → blurry photo bypass
   - No PROD, no supervisor instruction → mark prod-not-done
5. **Workbook annotation** — writes `Completed in SI MM/DD/YY TAG`, `Not in SI MM/DD/YY TAG`, etc.

## Workbook updater flags

| Flag | Effect |
|------|--------|
| `--workbook path` | Source workbook (defaults to original) |
| `--replace-pattern "regex"` | Replace matching segments in existing comments instead of appending |

The updater always writes a **versioned copy** (version 2, version 3, …) — never overwrites.

## Key constants (in reconcile script)

```js
const PERIOD_DATE_MAP = {
  P04W1: { start: '2026-04-26', end: '2026-05-02' },
  // ... update each period
  P06W1: { start: '2026-06-21', end: '2026-06-27' },
};
// PROD search window: dateFrom='2026-04-26', dateTo='2026-06-27' (covers all weeks)
```
Update `PERIOD_DATE_MAP` and the PROD date range each new period.

## Survey gotcha

Store 63 tasks have **201-item shelf-depth surveys** (none marked required). Always answer **all** items, not just required ones:

```js
const batch = (survey?.items || [])
  .filter(i => !existingIds.has(i.id))
  .map(i => ({ item: i.id, answer: '0' }));
```

## Blocking task pattern

If all Store 63 tasks fail with:
> "You are already working on another task — '[task name]'. To start a new one, finish the previous one."

One task is stuck `in_progress`. Find it, complete its survey (all items), clear actions, then `PUT status=completed`. That unblocks the rest. See `rebotics-unblock-stuck-in-progress` skill.

## Expired tasks (HTTP 409)

Tasks past their period deadline return:
> "Editing a task is not possible because the time for its completion has expired."

These cannot be completed via API regardless of method (including blurry bypass). Require admin SI web-interface intervention or rescheduling.

## Workbook comment conventions

| Situation | Comment format |
|-----------|---------------|
| Completed by agent today (PROD photos) | `Pulled photos from PROD and completed in SI MM/DD/YY TAG` |
| Already done in SI on a prior date | `Completed in SI MM/DD/YY TAG` |
| Attempted, could not complete | `Reconciliation attempted, failed MM/DD/YY TAG` |
| Not found in SI at all | `Not in SI MM/DD/YY TAG` |

Initials: **TAG**. Append to existing comments with `; ` separator — never replace prior supervisor notes.
