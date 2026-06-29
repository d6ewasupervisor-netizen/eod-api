---
name: sas-extract-category-after-pictures
description: Downloads and labels after photos from SAS category-reset-report CSV After Pictures Link column (Python-style URL lists). Use when extracting CloudFront JPGs for Rebotics upload, carry-forward, reloaded NII closeout, or bay-ordered photo folders.
---

# Extract SAS category after pictures

## When to use

- CSV from category-reset-report has **After Pictures Link** with embedded URLs.
- Need ordered JPGs per store / week / planogram for Store Intelligence bay upload.
- User cites PROD Kompass ISE after photos for a store/period but no local manifest exists yet.

## Column format

Python-list-like strings — not JSON:

```text
"['https://djttbrw0ufia8.cloudfront.net/media/image_BjRpBAA.jpg', 'https://...']"
```

Parser: regex `https?://[^'\s,\]]+` — do not use `JSON.parse`.

## Run

Single CSV (including fresh closeout scheduled exports):

```bash
cd kompass-netcap
node scripts/extract-after-pictures.js \
  --csv "output/fresh-d6-d8-closeout/2026-06-02T22-59-24-742Z/sas-csv/store286-2026-06-02-p1-ise-scheduled.csv" \
  --out output/after-photos/pre-p05w2
```

Canonical pre-p05w2 cache:

```bash
node scripts/extract-after-pictures.js \
  --csv output/sas-reports/pre-p05w2/store286-p1-P05W1.csv \
  --out output/after-photos/pre-p05w2
```

Directory batch:

```bash
node scripts/extract-after-pictures.js \
  --csv-dir output/sas-reports/pre-p05w2 \
  --out output/after-photos/pre-p05w2
```

## Output layout

```
output/after-photos/pre-p05w2/
  store286/
    P05W2/
      P05W2_9159792_D701_L00286_..._BAKED_BREADS_NII/
        P05W2_store286_P05W2_9159792_..._bay01.jpg
        … bay05.jpg
  manifest-store286-2026-06-02-p1-ise-scheduled.json
```

- URLs sorted by timestamp in filename for bay order.
- Period from `Cycle Name` or `Planogram ID` prefix (`P05W2_…`).

## Match to Rebotics tasks

1. FM store ↔ `701-00xxx`
2. Period in task title ↔ folder period
3. Dbkey/POG in title ↔ `Planogram ID` column
4. **Photo count may be less than SI bay count** — PROD 5 photos / SI 10 bays is normal; upper bays need blurry (`rebotics-blurry-photo-cv-bypass`)

## Rows with blank After Pictures Link

Extract skips rows with no URLs. Example: store 286 P05W2 dbkey `9007409` (isotonic) had completed PROD rows but **empty** after-photo URLs — extract yields nothing for that dbkey; use blurry SI closeout instead.

Dbkey `9159792` (10-bay bread) on the same store/CSV can still extract 5 bays successfully.

## Rollover / scheduled CSV recovery

Before blurry fallback:

- Use `date_type=scheduled`, no `shift_status`, for fresh pulls when completed export is header-only.
- Search other rows in the same CSV for the exact `Planogram ID` / dbkey — backlog row blank, completed row has URLs.
- Search `output/fresh-d6-d8-closeout/*/sas-csv/store{N}-*-p1-ise-scheduled.csv` when `output/sas-reports/pre-p05w2/store{N}-p1-P05W2.csv` does not exist.

## Related skills

- `rebotics-upload-sas-after-pictures`
- `rebotics-current-task-layer-closeout`
- `kompass-backlog-sas-reports-batch`
- `sas-pull-category-reset-report`
