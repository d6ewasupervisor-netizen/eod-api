# Survey Admin — Addendum

## What this adds
Admin dashboard for the office: trending problem questions, filterable/rearrangeable results, CSV/XLSX export, per-admin saved views. Read-only over survey data (saved views are the only writes, in their own table).

## Auth decision (confirmed)
Reuses `KOMPASS_ADMIN_EMAILS` -> `requireRole('admin')` on the normal session stack. No second login.
Note: supervisors on the roster can ALSO take the survey — store access rows already exist for them, so `/api/survey/stores/:store/response` works for supervisors with no code change.

## Districts (confirmed rule)
District = digits in team name (`Kompass 6B` -> district 6). Derived from the schedule export:
- 10 districts, 123 stores, **zero** stores split across districts.
- Traveling Team Seattle 2 is **Kompass 8C** (district 8): 7 people; stores 391, 658.
Materialized in `survey_store_districts` + `survey_roster.district` at seed time.

## Trending definition (confirmed: option a)
Problem-answer rate. Each tracked question carries a `good` answer in the v2 spec (35 tagged).
`problemRate = answers != good / answers`, minimum 3 answers to chart. Top 3 shown with
answer-distribution bar charts and the 2025 baseline problem rate beside each for context.
Text questions and neutral questions (Q24, Q31, Q39, contacts' names) are untracked.

## New files
| File | Purpose |
|---|---|
| `migrations/045_survey_admin.sql` | `survey_store_districts`, `survey_admin_views`, `survey_roster.district` |
| `src/routes/survey-admin.js` | `/api/survey/admin/*` — summary, responses, filters, export.csv, views CRUD |
| `src/public/survey-admin.html` | Static dashboard (auth-gate.js pattern; Chart.js + SheetJS via cdnjs) |
| seeds updated | roster districts, store_districts, `good` tags in question spec |

## Mount order (matters)
```js
app.use('/api/survey/admin', require('./routes/survey-admin')); // before general router
app.use('/api/survey', require('./routes/survey'));
```
`survey-admin.html` goes in `src/public/` beside the other tool pages. The page itself may be a
public static path (matches trackers/dc-scan pattern) — the APIs behind it are what's gated.

## Rearranging without touching data
All pivoting is client-side over `/admin/responses`; grouping by district/store/respondent,
column selection by question or block, sortable headers. Layouts persist per admin in
`survey_admin_views` keyed by email — one admin's views never affect another's, and nothing
writes to `survey_responses`.

## Export
- CSV: server-side `/api/survey/admin/export.csv` honoring active filters + question column selection.
- XLSX: client-side (SheetJS) from the currently filtered/arranged grid.

## Re-run seed after applying 045
`node scripts/seed-survey.js` (idempotent) to populate districts and the updated question spec.
