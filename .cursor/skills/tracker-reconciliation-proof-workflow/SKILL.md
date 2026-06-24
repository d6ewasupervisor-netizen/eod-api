---
name: tracker-reconciliation-proof-workflow
description: Guides eod-api tracker reconciliation work on tracker-reconciliation: read-only origin/main orientation, Grafana Query 46 fixture seeding, golden-before-extraction proofs, SI/PROD adapter extraction, Grafana cookie refresh safety, no-secrets gates, and explicit commit staging. Use when working on tracker reconciliation, classifyReconciliation, three-way-join-proof, Query 46, si-grafana-adapter, frozen fixtures, or productionizing tracker ingest reconciliation.
---

# Tracker Reconciliation Proof Workflow

Use this skill for `eod-api` tracker reconciliation work, especially on `tracker-reconciliation`, `scripts/kompass-proof/three-way-join-proof.js`, `src/lib/trackers/sheet-reconciliation.js`, `src/lib/trackers/si-grafana-adapter.js`, and frozen reconciliation fixtures.

## Non-Negotiables

- Stay on `tracker-reconciliation` unless the user explicitly says otherwise.
- Inspect deployed truth with `origin/main`, not local `main`. Use `git fetch origin --prune`, `git show origin/main:<path>`, and read-only diffs. Do not checkout `main`.
- Do not run `git pull`, `git checkout`, `git switch`, `git merge`, `git rebase`, `git reset`, or `git push` unless explicitly requested.
- Never use `git add -A` or `git add .` for these workflows. Stage explicit paths only.
- Never commit or expose `scripts/kompass-proof/.cookie`, `.env`, Grafana cookies, SAS tokens, request headers, or full request objects.
- Before committing frozen fixtures, run a no-secrets gate against the actual current cookie/token values and auth-shaped strings.
- Do not wire ingest routes, migrations, `src/index.js`, or `classifyReconciliation()` while doing proof/adapter extraction unless the user explicitly scopes that step.

## Orientation Pattern

Before productionizing reconciliation, establish what `origin/main` already ships:

- Locate `classifyReconciliation()` on `origin/main`.
- Read its full body and callers.
- Discover the proof engine import path from `scripts/kompass-proof/three-way-join-proof.js`; do not assume it.
- Compare branch engine to `origin/main`.
- Check provenance with `merge-base`, logs, contains, and blame.
- Verify whether the keystone category fix exists upstream: SI category must derive from `Commodity` or task title prefix like `055-BAG SNACKS` -> `55`, not from internal SI `category_id`.

Key lesson: if `origin/main` is the merge-base and the branch is strictly ahead, this is linear descent, not fork reconciliation.

## Fixture And Golden Rules

Use frozen fixtures for regression tests. Live data moves and must not become a test constant.

- Seed raw fixtures once from live systems, then run tests offline.
- Persist response bodies only:
  - `test/fixtures/si-p05w3-query46.raw.json`
  - `test/fixtures/prod-ise-p05w3.raw.csv`
  - matching `.meta.json` files
- Never persist request headers, cookies, tokens, full request objects, or URLs with credentials.
- Validate before writing fixtures:
  - SI Query 46 single-tag P05W3 should parse as JSON and have `2306` rows for the current fixture.
  - SI fixture must include a `055-` Commodity row.
  - PROD fixture must be non-empty CSV with data rows.
- Golden-before-extraction is mandatory:
  - Freeze `test/fixtures/si-normalized-golden.json` from the untouched inline transform before refactoring.
  - Only after the golden exists should adapter extraction begin.
  - If the golden is generated after extraction, equivalence is circular and invalid.

The golden should include full normalized SI row payloads and metadata:

- `siRowCount`
- `siKeyedCount`
- `prodRawRowCount`
- `prodJoinableRowCount`
- `prodKeyedCount`
- `prodCarryoverRowsFiltered`
- `sharedKeyCount`
- source fixture paths
- `transformSource: "inline (pre-extraction)"`

Do not hardcode old live counts like `327` or `363` from terminal runs. Compute intersection from frozen fixtures and assert against golden metadata.

## Adapter Extraction Boundary

Extract one boundary at a time.

For SI Query 46 extraction:

- Create `src/lib/trackers/si-grafana-adapter.js`.
- Export `normalizeQuery46Rows(rawFrameOrRows)`.
- Lift SI-only functions:
  - `rowsFromGrafanaFrame()`
  - `siRowToEngine()`
  - `categoryFromSiDisplay()`
  - `normalizeSiTaskStatus()`
  - `parseStoreFromDisplay()`
- Route category derivation through shared keystone helpers:
  - `rebotics-reports.categoryIdFromTask()`
  - `prod-row-fields.normalizeCategoryId()`
- Ignore SI internal `category_id` unless shared helper derivation fails.
- Keep PROD logic inline until explicitly scoped:
  - `parseCsv()`
  - `prodRowToEngine()`
  - carryover filter
  - `collapseRowsByKey()`

If SI logic is tangled with shared or PROD helpers, stop and report the tangle. Do not widen scope silently.

## Hermetic Proof Expectations

For SI adapter tests, assert offline against frozen fixtures:

- Adapter yields `2306` SI rows from `si-p05w3-query46.raw.json`.
- A `055-BAG SNACKS` row normalizes to category `55`.
- Adapter output deep-equals `si-normalized-golden.json` rows, including full payload fields.
- Recomputed SI/PROD intersection using adapter SI output and still-inline proof PROD path equals `golden.meta.sharedKeyCount`.

Run:

```powershell
npm test
node scripts/kompass-proof/three-way-join-proof.js
```

The live proof can fail due to expired Grafana cookie. Hermetic tests are the durable gate; live proof is an additional confidence check after refreshing `.cookie`.

## Grafana Cookie Dev Loop

Use `scripts/kompass-proof/refresh-cookie.js` for interactive cookie refresh.

- It validates `.gitignore` contains `scripts/kompass-proof/.cookie`.
- It accepts hidden prompt input or `--clipboard`.
- It validates `/api/user` by default.
- `--deep` optionally POSTs Query 46 and requires frame rows > 0. Do not assert `2306` in cookie validation.
- It writes `.cookie` atomically only after validation passes.
- It never logs cookie values, only cookie names and validation status.

Recommended command:

```powershell
node scripts/kompass-proof/refresh-cookie.js --clipboard
```

Then:

```powershell
node scripts/kompass-proof/three-way-join-proof.js
```

## No-Secrets Gate Before Fixture Commits

Run a hard gate before staging fixture files. It should compare committed fixture content against actual current secrets from env and `.cookie` without printing secrets.

Also run a sanity search for:

- `grafana_session=`
- `Authorization: Token`
- `Cookie:`

If any live secret matches, stop before staging.

## Commit Pattern

Prefer two commits when both dev tooling and proof extraction changed:

1. Dev-loop helper only:
   - `scripts/kompass-proof/refresh-cookie.js`
2. Adapter/proof/regression:
   - `src/lib/trackers/si-grafana-adapter.js`
   - `scripts/kompass-proof/three-way-join-proof.js`
   - `scripts/kompass-proof/_gen-golden.js`
   - `test/trackers-si-grafana-adapter.test.js`
   - frozen raw fixtures, meta fixtures, and golden

Verify staged sets with `git status --short` before each commit. Do not push unless the user explicitly asks.

## Useful Current State

As of Step 1 completion on `tracker-reconciliation`:

- `0f23d50` adds the Grafana cookie refresh helper.
- `df3541b` extracts SI Grafana normalization into `si-grafana-adapter.js`.
- Frozen P05W3 fixture metadata:
  - SI raw rows: `2306`
  - PROD raw rows: `826`
  - PROD joinable rows: `627`
  - PROD keyed count: `456`
  - shared key count: `363`
- Hermetic adapter test passes all four assertions.
- Live proof passed after refreshing `.cookie`: `PASS=6`, `FAIL=0`.

Next likely step: add `.gitattributes` for fixture byte stability, then extract PROD proof parsing into `src/` with its own golden before wiring the real ingest reconciliation path.

## Operational batch reconcile (D6/D8 copies)

For live District 6/8 tracker copy runs (not hermetic proof work), use skill **`d6-d8-tracker-reconcile`** and:

- `scripts/d6-d8-tracking-reconcile.js` — copy trackers, cross-ref PROD/SI, optional remediation, write copies
- `scripts/d6-d8-tracking-finish-writes.js` — resume K/L writes from cache + closeout reports
- `scripts/reconcile-d1-d8-prod-to-si.js --discrepancies` — local PROD→SI closeout without Railway DB snapshot

Do not conflate proof/fixture commits with operational tracker copy updates. Operational runs never modify live OneDrive tracker files.
