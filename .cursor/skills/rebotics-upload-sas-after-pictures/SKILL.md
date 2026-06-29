---
name: rebotics-upload-sas-after-pictures
description: Uploads SAS prod category-report after photos into matching Kroger Store Intelligence backlog tasks by planogram and bay. Use after sas-extract-category-after-pictures, prod-to-SI carry-forward, reloaded NII closeout, or when user cites PROD Kompass ISE after photos for specific dbkeys.
---

# Upload SAS after photos → Store Intelligence

## Rebotics layers — critical understanding

| Layer | App tab | API |
|-------|---------|-----|
| **Tasks layer** | Tasks | `GET /api/v1/tasks/?store=…&from_date=…&to_date=…` |
| **Capture layer** | Capture | `GET /api/v1/tasks/{id}/capture/retailer/` |

Photos must target a **live task ID** from today's Tasks layer. Capture-layer uploads do not complete tasks.

## Task ID staleness

Query `GET /api/v1/tasks/?store={storeId}&from_date={today}&to_date={today}` for **today**, not the period's canonical week date.

## Extract then upload workflow

When `manifest-store{N}-p1-P05W2.json` is missing, extract from a scheduled CSV:

```bash
cd kompass-netcap
node scripts/extract-after-pictures.js \
  --csv "output/fresh-d6-d8-closeout/<run>/sas-csv/store286-2026-06-02-p1-ise-scheduled.csv" \
  --out output/after-photos/pre-p05w2
```

Write explicit live task IDs (from today's Tasks layer):

```json
[
  { "taskId": 39665554, "pog": "9159792", "period": "P05W2" }
]
```

```bash
node scripts/upload-to-tasks-direct.js --store 286 --tasks-file output/store286-closeout-tasks.json
node scripts/upload-to-tasks-direct.js --store 286 --tasks-file output/store286-closeout-tasks.json --dry-run
```

## Partial PROD photo count (N photos, M SI bays)

PROD often has **fewer after photos than SI sections** (example: 5 JPGs for a 10-bay NII bread set).

| SI bays | PROD photos | Strategy |
|---------|-------------|----------|
| 1–5 | 1–5 exact | Upload exact SAS per bay via `upload-to-tasks-direct.js` |
| 6–10 | none | Blurry one bay at a time (`rebotics-blurry-photo-cv-bypass`) after SAS bays finish CV |
| 10 | 5 only | Bay 10 can reuse SAS `bay05.jpg`; bays 6–9 usually need blurry or per-bay SAS retry |

**Wait 120–150s** after SAS upload before checking sections or adding blurry. Do not upload blurry while SAS sections are still `in progress`.

**Do not** map SAS bay01→SI bay6, bay02→bay7, etc. in one batch without expecting heavy move/remove exceptions and `pre_photo_required` on upper bays. Prefer blurry for bays without exact PROD photos.

## No PROD photos for a dbkey

If every CSV row for the dbkey has empty `After Pictures Link` (store 286 P05W2 `9007409`), skip SAS upload entirely — use blurry closeout (`rebotics-blurry-photo-cv-bypass`).

## Real-photo recovery after blurry fails

- Pull fresh scheduled CSV (`project_id=1`, no `shift_status`) before giving up on SAS.
- Search all cached store CSVs and rollover exports for exact planogram/dbkey rows with URLs.
- Delete failed scans, `PATCH { scan_status: null }`, upload real photos, wait, correct, close.

## CRITICAL: use correct IDs per task

See `rebotics-task-photo-correct-ids`. Never reuse `store_planogram` / `section_id` from a previous task.

## After upload

1. Wait for `report.status === 'done'` on each section (~2–5 min multi-bay)
2. `node scripts/process-backlog-corrections.js --store {fm} --date {today} --task {taskId}`
   - Real SAS on wrong/recycled bays produces **move/remove** idle actions — corrections script clears them
3. Survey `0` + `PUT completed` (direct API, not blocked by unrelated global `in_progress`)

## NII / Surge project tasks

Regular Kompass `project_id=1` can contain NII rows. Use Surge `9295` only for confirmed Surge/Pet work (`upload-surge-photos.js`).

## Related skills

- `rebotics-current-task-layer-closeout`
- `rebotics-blurry-photo-cv-bypass`
- `sas-extract-category-after-pictures`
- `rebotics-task-photo-correct-ids`
- `d6-d8-tracker-reconcile` (eod-api batch closeout)
