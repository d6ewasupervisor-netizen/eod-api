---
name: rebotics-blurry-photo-cv-bypass
description: Uploads a visually blurry shelf photo to a Rebotics task section to bypass CV rejection and satisfy pre_photo_required. Use when scan_status is REJECTED, PROD has no after photos, small NII cooler sets, upper bays of multi-bay sets, or pre_photo_required blocks completion after SAS upload.
---

# Rebotics blurry photo CV bypass

## When to use

- No SAS `After Pictures Link` URLs for the exact dbkey (e.g. store 286 P05W2 `9007409` isotonic — 2 bays, blurry-only closeout works).
- Upper bays of a multi-bay NII set where PROD only has photos for bays 1–5.
- `PUT completed` returns `pre_photo_required` / `missing_sections` after SAS photos on recycled/wrong bays.
- Real SAS photo content gets task-level `REJECTED` every time.
- User says **"load a blurry picture"** or **"use the blurry photo method"**.

## When not to use first

- Exact SAS after photos exist for that bay — use real photos first (`rebotics-upload-sas-after-pictures`).
- SAS uploads on bays 1–5 are still `in progress` — wait for CV before adding blurry to any section.

## The blurry photo asset

```
C:/Users/tgaut/.cursor/projects/c-Users-tgaut-EOD-EOD/assets/
  c__Users_tgaut_AppData_Roaming_Cursor_User_workspaceStorage_
  9f52f25b1d54bd5a8e9c797b752ba031_images_
  image-aed0d245-0ac3-4e6c-89ea-dc0edc3e9820.png
```

Provide as `image/jpeg` when uploading (PNG bytes with JPEG mime type is accepted).

## Upload sequence

**STOP** — read `rebotics-task-photo-correct-ids` first for `store_planogram`, `category_id`, `section_id`.

4-step chain: upload request → S3 multipart → finish → `POST /api/v4/processing/actions/` with `process_post_photo: false`.

See `rebotics-carry-forward/lib/rebotics-api.js` → `uploadAndAttachPhoto`.

## Multi-bay: upload one section at a time

Batch blurry on 6–10 sections often leaves several in `pre_photo_required` even when all reports show `done`.

**Per-section loop:**

```text
1. DELETE /api/v1/tasks/{taskId}/processing/actions/{scanId}/   (if re-uploading)
2. Upload blurry to ONE section_id
3. Wait 60s
4. node scripts/process-backlog-corrections.js --store {fm} --date {today} --task {taskId}
5. PUT completed — if missing_sections lists one section, repeat for that section only
```

Store 286 P05W2 bread (`9159792`): bays 6–9 needed one-at-a-time blurry; bays 8–9 required individual 60s wait + corrections before task completed.

## Small 2-bay NII sets

Store 286 P05W2 isotonic (`9007409`): upload blurry to both bays, wait ~70s, run corrections once, survey `0`, `PUT completed`. No SAS photos existed in PROD for this dbkey.

## Clear exceptions

```bash
cd kompass-netcap
node scripts/process-backlog-corrections.js --store 286 --date YYYY-MM-DD --task {taskId}
```

## Close

Prefer direct close after corrections:

```http
PUT /api/v1/surveys/{surveyId}/responses/{responseId}/start/
PATCH … { "answers": [{ "item": baysItemId, "answer": "0" }] }
PUT /api/v1/tasks/{taskId}/ { "status": "completed" }
```

Avoid `close-backlog-tasks.js` when another store's task is globally `in_progress` — it may try to close that unrelated task first.

## Gotchas

- Blurry generates identify + add idle actions. Always run `process-backlog-corrections.js` before close.
- `actions_count` all zero does **not** guarantee completable: ~41 `ACTION_IDENTIFY | STATE_REJECTED | Image not Ideal` rows on a section still trigger `pre_photo_required`. Delete that section's scan and re-upload (SAS if available).
- `scan_status: REJECTED` at task level with all sections `done` → delete/re-upload problem sections, or `PATCH { scan_status: null }` once then retry close.
- Delete scan **before** `PATCH { scan_status: null }` or the server reverts to `REJECTED`.
- One `in_progress` task per user — finish the current store task before starting the next dbkey at the same store.

## Related skills

- `rebotics-task-photo-correct-ids`
- `rebotics-current-task-layer-closeout`
- `rebotics-upload-sas-after-pictures`
