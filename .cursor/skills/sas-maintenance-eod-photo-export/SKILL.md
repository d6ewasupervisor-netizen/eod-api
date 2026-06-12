---
name: sas-maintenance-eod-photo-export
description: Pulls SAS Prod category-reset-report before and after photos for maintenance EOD audits, especially category 5555 by fiscal week and store list. Use when the user asks for missing EODs, maintenance category photos, before/after photo recovery, D1 P05W3 exports, or Downloads folders organized by store.
---

# SAS Maintenance EOD Photo Export

## When To Use

Use this for read-only SAS Prod photo recovery when the user asks to audit missing EODs or pull maintenance category photos. The default workflow is Fred Meyer Kompass ISE project `1`, category `5555`, scheduled-date reports, and output under `Downloads`.

## True District 1 Stores

The true District 1 Fred Meyer store list is:

```text
35, 40, 60, 63, 143, 153, 218, 220, 240, 242, 285, 375, 377, 393, 462, 482, 516, 651, 661, 694
```

When the user provides a general store list and asks for District 1 only, normalize store numbers and pull only the intersection. For example:

```text
General: 63, 668(Mon), 153, 63, 668(Tue), 694, 462, 668(Wed), 30, 240, 227, 668, 224
True D1 match: 63, 153, 240, 462, 694
```

## Export Command

Default D1/P05W3/category `5555` export:

```powershell
node scripts/export-sas-maintenance-eod-photos.js --out "$env:USERPROFILE\Downloads\eod_p05W3"
```

Custom store/week export:

```powershell
node scripts/export-sas-maintenance-eod-photos.js `
  --period P05W3 `
  --stores 63,153,240,462,694 `
  --category 5555 `
  --out "$env:USERPROFILE\Downloads\eod_p05W3"
```

Use `--start yyyy-mm-dd --end yyyy-mm-dd` only when the requested date range does not match the repo fiscal calendar.

## Auth

The script loads SAS auth in this order:

- `--token` or `SAS_TOKEN`
- `C:/Users/tgaut/sas-auth/.sas-session/auth-state.json`
- `http://127.0.0.1:7291/session`

Never print full SAS tokens. If auth is stale, refresh `sas-auth` before retrying.

## Output

The script creates:

- `store###/before/`
- `store###/after/`
- `store###/manifest.json`
- `_audit/sas-csv/`
- `audit-summary.csv`
- `manifest.json`

Photos and manifests use versioned filenames when the target already exists or is locked.

## Report Pull Rules

- Pull `/api/v1/reports/category-reset-report/` with `date_type=scheduled`, date-only `date_from` and `date_to`, no `shift_status`.
- Set `date_to` to the day after the requested end date because SAS scheduled filters can miss fresh/in-progress shifts otherwise.
- Resolve `store_id` from `/api/v1/projects/project-stores/?project=1` by matching `store.number`.
- Filter rows by exact `Category ID`, `Department #`, `Department Number`, or `Department ID`; fall back to category text/planogram text containing the requested category number.
- Parse `Before Pictures Link` and `After Pictures Link` with regex `https?://[^'\s,\]]+`; those fields are Python-list-like strings, not JSON.

## Verification

After running, check the terminal totals against files on disk:

```powershell
$root = "$env:USERPROFILE\Downloads\eod_p05W3"
$before = (Get-ChildItem $root -Recurse -File | Where-Object { $_.DirectoryName -like '*\before' -and $_.Extension -match '^\.jpe?g$' }).Count
$after = (Get-ChildItem $root -Recurse -File | Where-Object { $_.DirectoryName -like '*\after' -and $_.Extension -match '^\.jpe?g$' }).Count
"before=$before after=$after"
```

For code changes, run:

```powershell
node --check scripts/export-sas-maintenance-eod-photos.js
```
