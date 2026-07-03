# Reference — District Tracker PROD/SI Reconcile

## Script CLI

### d6-d8-tracking-reconcile.js

```
--districts "1" | "6,8"
--out-dir <path>
--period-end P06W2
--label D1 | D6D8
--confirm-scope D1 | D6,D8
--skip-prod-to-si --skip-si-to-prod --skip-si-photos
--allow-blurry | --no-allow-blurry
```

### district-tracker-finish-writes.js

```
--out-dir <path>
--label D1
```

Writes: `{out}/SUPER Tracker ISE V1.3 - {Label} reconcile copy.xlsm` and `- {Label} copy.xlsm` (both ISE + Blitz).

### district-tracker-delta-scan.js

```
--out-dir <path>
--label D1
--delta-periods P06W1,P06W2   # omit or "all" for every period in cache
--writes-cache <optional override path>
```

Env fallbacks: `TRACKER_OUT_DIR`, `TRACKER_LABEL`, `TRACKER_DELTA_PERIODS`.

### district-tracker-apply-delta-writes.js

```
--out-dir <path>
--label D1
--delta-json <path to delta_scan json>
--writes-cache <optional>
```

## Verify scoped Yes count (Node one-liner)

```javascript
const path = 'C:/Users/tgaut/Downloads/p06w2_district1';
const cache = require(path + '/D1_writes_cache.json');
const { readTrackerWorkbookRaw, normalizeTrackerRow } = require('C:/Users/tgaut/eod-api/src/lib/trackers/tracker-sheet-reader');

function norm(k) {
  const p = String(k).split('|');
  const m = p[0].match(/^P0?(\d+)W([1-4])$/i);
  const pw = m ? `P${String(+m[1]).padStart(2,'0')}W${+m[2]}` : p[0];
  return `${pw}|${+p[1]}|${+p[2]}|${p[3]}`;
}

(async () => {
  for (const kind of ['ise', 'blitz']) {
    const wb = kind === 'ise'
      ? path + '/SUPER Tracker ISE V1.3 - D1 copy.xlsm'
      : path + '/SUPER Tracker Blitz V1.3 - D1 copy.xlsx';
    const keys = new Set((cache[kind] || []).map(r => norm(r.key)));
    const raw = await readTrackerWorkbookRaw(kind, { workbookPath: wb });
    let yes = 0, n = 0;
    for (const r of raw) {
      const row = normalizeTrackerRow(r, kind);
      if (!row.store || !row.periodWeek) continue;
      const key = norm(`${row.periodWeek}|${row.store}|${row.categoryId}|${row.dbkey}`);
      if (!keys.has(key)) continue;
      n++;
      if (String(row.currentK || '').trim() === 'Yes') yes++;
    }
    console.log(kind, 'scoped', n, 'Yes', yes, 'open', n - yes);
  }
})();
```

## D1 example totals (2026-06-30 reconcile + 2026-07-01 delta apply)

| Stage | ISE Yes | Blitz Yes | Combined Yes | Open |
|-------|--------:|----------:|-------------:|-----:|
| After reconcile write | 67 | 0 | 67 | 696 |
| After delta apply | 85 | 13 | 98 | 665 |

Remediation within reconcile: 4 PROD→SI + 5 SI→PROD = 9 of 67 ISE Yes.

## Join key normalization

```javascript
// P6W2|063|190|8857714 → P06W2|63|190|8857714
const match = pw.match(/^P0?(\d{1,2})W([1-4])$/i);
const normPw = `P${String(Number(match[1])).padStart(2,'0')}W${Number(match[2])}`;
const store = String(Number(storeRaw));
```

## Branch checkout

```powershell
cd C:\Users\tgaut\eod-api
git checkout tracker-reconciliation -- scripts/d6-d8-tracking-reconcile.js
```

## Legacy `_d1-*` scripts

Superseded by `district-tracker-*.js` with `--out-dir` / `--label`. Still work with env `D1_OUT_DIR`, `D1_DELTA_PERIODS`, `D1_DELTA_JSON`.
