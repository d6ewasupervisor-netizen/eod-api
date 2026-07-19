# Survey-Taker UI + Photos — Addendum 2

## Decisions applied
- **Photos optional** everywhere (9 photo-suggested questions keep the camera control, labeled optional).
- **Universal comments**: every question renders an "Add a comment" expander. Stored as `<questionId>_c`
  inside the same answers JSONB. Analytics/trending ignore comment keys; CSV + XLSX exports now emit a
  `Qn comment` column for any question that has at least one comment in the filtered data.
- **Q38** gained an `Other` option (before `None`).
- No question-set version bump: prod has zero responses, v2 spec updated in place. Re-run the seed.

## New/changed files
| File | Change |
|---|---|
| `migrations/046_survey_photos.sql` | `survey_photos` table (Postgres-stored images) |
| `src/routes/survey.js` | + photo endpoints (POST/GET list/GET one/DELETE own), 8MB JSON limit on upload route only |
| `src/routes/survey-admin.js` | exports include comment columns |
| `src/public/survey.html` | **new** — mobile-first taker UI |
| `src/public/survey-admin.html` | XLSX export includes comments |
| `seed/question_set_v2.json` | Q38 Other |

## Taker UI behavior
- Store picker from `/api/survey/me` with per-store status badges (draft / submitted).
- One section per screen, A→K, sticky progress bar, 48px+ tap targets.
- **Autosave**: debounced 800ms after every answer; flush on every navigation; offline retry loop with
  "Offline — will retry" status. Backroom dead zones don't lose work.
- Branching (Q5/Q7/Q31/Q39) and detail-on-answer fields (e.g. Q40 "No" → explain) render live.
- 2025 baseline answers appear as a "tap to use" chip on mapped questions — prefill is explicit, never automatic.
- Photos: camera capture, client-side resize to 1280px JPEG (~150–250KB) before upload, delete own only.
- Review screen shows gaps; submit allowed with gaps (blanks stay blank). Resubmission replaces the
  respondent's row for that store (existing upsert semantics).

## Photo access notes
- `GET /api/survey/photos/:id` is auth-gated with store-access check; `<img>` tags use the existing
  `?access_token=` query support in auth-middleware (same mechanism as SSE).
- Storage is Postgres bytea. At ~200KB/photo, even 3,000 photos ≈ 600MB — acceptable. If growth demands,
  migrate to object storage; the API surface won't change.

## Integration steps
1. Copy `046_survey_photos.sql` → `src/migrations/` (renumber if taken).
2. Replace `src/routes/survey.js` and `src/routes/survey-admin.js` with these versions.
3. Add `src/public/survey.html`; update `src/public/survey-admin.html`.
4. Copy updated `seed/question_set_v2.json`; re-run `node scripts/seed-survey.js`.
5. Deploy. Field URL: `https://eod-api.the-dump-bin.com/survey`.

## Smoke additions
- POST photo (base64 jpeg) → 200 with id; GET as another roster member with store access → 200; as
  non-access user → 403; DELETE by non-owner → 404.
- PUT response with `{ "Q5": "Yes", "Q5_c": "left of receiving door" }` → draft saves; CSV export shows
  a `Q5 comment` column.
