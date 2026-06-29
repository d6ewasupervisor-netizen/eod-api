---
name: rebotics-current-task-layer-closeout
description: Closes current visible Store Intelligence task-layer sets using live same-day task IDs, SAS after photos, scan-action cleanup, survey answer, and completion. Use when the user asks to close reloaded/erroneous backlog sets, specific dbkeys/POGs, or current assigned/Not started Rebotics tasks at a store.
---

# Rebotics Current Task-Layer Closeout

## Scope

Use this for current assigned Store Intelligence sets visible in the app Tasks tab, including tasks with `status.id === "created"` / Not started and backlog rows reloaded after prior completion. Do not use stale discovery JSON IDs.

## Discovery

1. Resolve the store internal id from `701-00xxx`.
2. Query **today's** Tasks layer only:

```http
GET /api/v1/tasks/?store={storeId}&from_date={today}&to_date={today}&offset=0&limit=200
```

3. Match only the user-requested titles / dbkeys / POGs from that response.
4. Do not use `capture/retailer` for discovery. Use it only after a live task ID is known.
5. Older dates for the same title can still list `incomplete` backlog rows — only mutate **today's** live instance.

### Exact matching discipline

- When the user names a category number, match the exact Rebotics/SAS category code: category `24` means `024`, not `242`; category `77` means `077`, not `177`.
- Prefer exact title/dbkey/POG matches such as `9159792 050-BAKED BREADS` or `9007409 010-ISOTONIC`. Do not substring-match short category numbers.
- Screenshot `Req ID` values are SAS visit/report IDs, not Rebotics task IDs. Resolve the live Rebotics task from store + exact task title/POG.

## Before Mutations

Open a shift:

```http
POST /api/v1/shifts/
{ "store": storeId, "user": userId, "uuid": "<uuid>", "start": "<iso>" }
```

Only **one task `in_progress` per user**. Close task A completely before `PUT in_progress` on task B.

If another task is `in_progress` and blocks `PUT status=in_progress`:
- If it is in the user's target list, close it first.
- If it is at another store, do **not** mutate it without approval — use direct survey + `PUT completed` on the target after corrections (see Close below) instead of `close-backlog-tasks.js`, which tries to close unrelated global `in_progress` tasks.

### Probe editability before uploads

```http
PUT /api/v1/tasks/{taskId}/
{ "status": "in_progress" }
```

- `409 … time for its completion has expired` → stop; re-query today's Tasks layer for a regenerated instance.
- Expired tasks can still accept uploads but cannot complete. Do not upload to expired IDs.

## SAS Photo Source

Prefer real SAS after photos over blurry fallback.

- Fresh SAS pull: regular Kompass `project_id=1`, `date_type=scheduled`, date-only range, **no** `shift_status`; filter by exact store + dbkey/planogram.
- Search cached CSVs and `output/fresh-d6-d8-closeout/*/sas-csv/store{N}-*-p1-ise-scheduled.csv` when `manifest-store{N}-p1-P##W#.json` is missing.
- A backlog row can have blank `After Pictures Link` while another same-store/same-week row for the exact dbkey has URLs — use the row with URLs.
- Some planograms have **no PROD after URLs at all** (example: store 286 P05W2 dbkey `9007409` isotonic cooler). Use blurry for those sets.
- Standard NII rows can still be Kompass project `1`; use Surge `9295` only when confirmed Surge/Pet.

Extract photos:

```bash
cd kompass-netcap
node scripts/extract-after-pictures.js \
  --csv "output/fresh-d6-d8-closeout/<run>/sas-csv/store286-2026-06-02-p1-ise-scheduled.csv" \
  --out output/after-photos/pre-p05w2
```

Upload to live task IDs:

```bash
node scripts/upload-to-tasks-direct.js \
  --store 286 \
  --tasks-file output/store286-closeout-tasks.json
```

Tasks file shape: `[{"taskId":39665554,"pog":"9159792","period":"P05W2"}]`

## Multi-bay NII with fewer PROD photos than SI bays

Common on 10-bay bread NII sets: PROD has 5 after photos, SI has 10 sections.

**Winning pattern (store 286 P05W2 dbkey `9159792`):**

1. Upload **exact** SAS photos for bays 1–5 only (`upload-to-tasks-direct.js`).
2. Wait **120–150s** for CV on all uploaded sections before any blurry fallback.
3. Upload blurry to bays 6–9 **one bay at a time**: delete old scan → upload → wait ~60s → `process-backlog-corrections.js --task {id}`.
4. If `PUT completed` returns `pre_photo_required` with `missing_sections`, fix **only those section IDs** — do not re-blurry the whole task.
5. For stubborn upper bays, retry SAS `bay05.jpg` on one section at a time before more blurry.
6. Bay 10 can use SAS `bay05.jpg` when only five PROD photos exist.

**Do not:** upload SAS to bays 1–5 and immediately blurry all 10 sections while SAS CV is still running — duplicate scans cause `REJECTED` and `pre_photo_required`.

## Upload IDs

```js
const task = await GET(`/api/v1/tasks/${taskId}/`);
const storePlanogramId = task.planograms[0].store_planogram_id;
const cap = await GET(`/api/v1/tasks/${taskId}/capture/retailer/?ordering=aisle&show_reports=true`);
const categoryId = cap.results[0].category.id;
const sectionId = cap.results[0].sections.find(s => s.name === String(bay)).id;
```

Upload one pre-photo per bay: `sequence_number = bay - 1`, `process_post_photo: false`.

## Wait And Clear

Wait until every intended section has `section.report.status === "done"`.

Run:

```bash
node scripts/process-backlog-corrections.js --store {fm} --date {today} --task {taskId}
```

Clears idle actions:

- `ACTION_IDENTIFY` → `STATE_REJECTED`, `Image not Ideal`
- `ACTION_ADD` → `STATE_ACCEPTED`, `On Shelf - UPC Confirmed`
- `ACTION_REMOVE` → `STATE_ACCEPTED`, `Removed Item`
- `ACTION_MOVE` → `STATE_ACCEPTED`, `Moved Item`

Real SAS photos on recycled/wrong bays generate **move/remove** idle actions — `process-backlog-corrections.js` handles these; do not skip corrections after SAS upload.

### pre_photo_required with done section reports

If `PUT completed` returns:

```json
{"code":"pre_photo_required","missing_sections":[5118047,5118046]}
```

even though `actions_count` is zero:

1. Inspect each missing section's scan: `GET …/processing/actions/{scanId}/?show_actions=below`
2. Many `ACTION_IDENTIFY | STATE_REJECTED | Image not Ideal` rows (often ~41) on blurry or recycled-photo sections block completion.
3. `DELETE …/processing/actions/{scanId}/` on those sections only, re-upload (SAS preferred, else blurry one bay at a time), wait, correct, retry close.

## Close

Survey → `0` bays/doors, then:

```http
PUT /api/v1/tasks/{taskId}/
{ "status": "completed" }
```

Prefer **direct** `PUT completed` after corrections when `close-backlog-tasks.js` tries to close an unrelated `in_progress` task at another store.

If blocked by `scan_status: REJECTED` with all sections done, `PATCH { scan_status: null }` then retry `PUT completed` once.

Final verification on **today's date only**: `status.id === "completed"`, `scan_status === "DONE"`.

## Small multi-bay NII (2 bays, no PROD photos)

Example: store 286 P05W2 dbkey `9007409` isotonic cooler — no after URLs in scheduled CSV.

1. `PUT in_progress`
2. Blurry photo on each section (2 bays typical)
3. Wait ~70s
4. `process-backlog-corrections.js --task {id}`
5. Survey + `PUT completed`

## Related Skills

- `rebotics-api-auth`
- `rebotics-task-photo-correct-ids`
- `sas-extract-category-after-pictures`
- `rebotics-upload-sas-after-pictures`
- `rebotics-blurry-photo-cv-bypass`
- `rebotics-close-maintenance-task`
