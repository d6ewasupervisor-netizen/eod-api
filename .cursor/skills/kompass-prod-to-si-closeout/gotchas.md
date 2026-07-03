# PROD → SI closeout — gotchas (FM 218 case study)

Validated on store **218**, SI layer **2026-07-02**, SAS sources **2026-07-01 Blitz** + **2026-06-30 Cut In**.

## Task layer vs photo source dates

| Layer | Date | Notes |
|-------|------|-------|
| SI tasks mutated | 2026-07-02 | Live IDs; only these accept `PUT in_progress` / `completed` |
| SAS after photos | 2026-07-01 | Blitz visit 27000016 — 11–18 rows with URLs |
| SAS rollover | 2026-06-30 | Cut In reported-completed — 5 rows with URLs |
| SI frozen | 2026-07-01 task IDs | `409` — read-only after rollover |

**Lesson:** Always pass `--task-dates` = today (or live layer) and `--sas-dates` = when field actually captured photos.

## Zero photos on "today" does not mean zero work

7/2 audit: ISE + Blitz visits existed but **0 after URLs**; 15 Blitz candy sets **completed in PROD with no photos**. Those SI tasks cannot be PROD-reconciled — need field re-capture or blurry-only closeout.

When user asks for "today's photos," **also pull yesterday** (and Cut In rollover) before concluding nothing is uploadable.

## Store mutex chain

Only one `in_progress` per user (Tyson.Gauthier / id 211 in automation).

Typical failure pattern:

1. Orchestrator `PUT in_progress` on task A — succeeds
2. Upload or complete fails — task A stays `in_progress`
3. Tasks B–N fail with `HTTP 400 on PUT` (not always explicit mutex message)

**Fix:** Identify `in_progress` via `GET /api/v1/tasks/?store={id}&start={task-date}&end={task-date}`, complete task A, then resume batch.

FM 218 blocker sequence: 39848643 → 39849157 → 39849383 → 39849393 → …

## Bay / section mapping

POG 9088147: SI sections bays **1,2,3,4,6,7,8** (7 sections, no bay 5).

- **Wrong:** map filename `bay4.jpg` to section named `"4"` by label when order differs
- **Right:** sort sections by bay; photo index `0..n-1` maps to sorted sections

`listTaskSections()` in `lib/image-sync/rebotics-sections.js` — orchestrator sorts both sections and photos by bay before index upload.

## CSV after URL under-count

Parser initially reported **6** URLs for POG 9088147; row actually had **13** in After Pictures Link column.

When `insufficient photos` fires:

1. Re-scan CSV line for POG — take URLs **after** `"After Pictures Link"` column
2. Prefer the row with the **longest** after URL list when duplicate POG lines exist

## POG shelf-count exceptions

`PUT completed` returns:

```json
{
  "code": "pre_photo_required",
  "msg": "Please rescan sections as some of them have exceptions.",
  "missing_sections": [5239714]
}
```

Section may show `report.status === "done"` **and** `pog_exception.reason === "Discrepancy in shelf count"`.

**Winning fix:** DELETE scan on **only** `missing_sections` → blurry (or SAS) re-upload → wait 70s → `process-backlog-corrections.js` → retry complete. Repeat per section; do not re-blurry entire task.

## Partial PROD photos

| Task | PROD bays | SI bays | Resolution |
|------|-----------|---------|------------|
| 39849632 | 5 | 6 | 5 SAS + blurry for gap; then exception fix on 3 sections |
| 39849157 | 7+ URLs | 7 | Full SAS upload after correct URL parse |

Orchestrator throws `insufficient photos` when PROD < SI — handle manually with blurry fill or fix CSV parse before re-run.

## CV timing

- Wait **120s** after multi-bay SAS upload before corrections
- Blurry re-upload per section: **70s** minimum before corrections
- `waitForDoneReports` timeout in orchestrator may leave task `in_progress` with `REJECTED` — use manual complete loop

## Stuck after "successful" upload

Task 39848643 pattern:

- All sections show `report.status === done`
- Task `scan_status: REJECTED`, `pre_photo: null` on sections via wrong API shape
- Complete fails `pre_photo_required` on specific section

Fix: DELETE all scan actions on affected sections, re-upload PROD photos, wait, correct, survey, complete.

## Automation user vs field rep

Stuck `in_progress` tasks were owned by **Tyson.Gauthier (211)** from automation — not a field rep blocking the store in the app.

## Do not use for tracker writes

This skill closes SI tasks only. SUPER Tracker K/L updates go through `district-tracker-prod-si-reconcile` on **working copies** under `Downloads/` — never live OneDrive trackers.
