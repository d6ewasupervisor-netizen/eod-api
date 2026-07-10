# DC Scan board — gotchas

## Modify / release UI

- **Reschedule / back out** must stay available after finalize (do not hide behind `!finalized`).
- Reschedule = self-serve Wed–Fri; patches SAS `scheduled_date` + `due_by`; Cc supervisor.
- Back out (`dropout`) = email teammates with `?takeOffer=` link; **do not** delete SAS shift until someone takes it.
- Store swap still goes through supervisor `decide.html`.

## Claimed is not In PROD

**Never** mark a store **Built** / **In PROD** from:

- `pledge.buildStatus === 'built'` in Postgres alone
- Seed `sasVisitId` + `sasShiftId` without a live PROD fetch
- Finalize success before the next PROD poll

Use `prodConfirmsInProd(prodFormatted, liveProd)` in `dc-scan-board.js`:

- Requires `liveProd.ok` (SAS session + successful project 8081 fetch).
- Visit with `visitStatus` or `shiftStatus` **completed** counts as confirmed.
- Active visits need a `shiftId` (or completed terminal status).

## PROD stuck on "pending"

| Symptom | Cause | Fix |
|---------|-------|-----|
| Live pill: **PROD pending** | `sasBridge.init()` ran after board sync, or session dead | Ensure init order in `index.js`; click **Resync SAS PROD** |
| Banner: waiting for session | `SAS_*` env missing on Railway | Set `SAS_USER`, `SAS_PASS`, `SAS_TOTP_SECRET` |
| Banner: session active, no visits | No RO8 visits in date range | Check cycle 8081, store IDs, fiscal week window |

## SAS store matching

SAS **substring-matches** `store_number=` filters. Always:

1. Fetch cycle visits without trusting store filter alone.
2. Filter with `lib/sas-store-match.js` (`filterVisitsByStore`, `getVisitStoreNumber`).
3. Assert visit store before finalize mutations.

Store **28** must not match **281**, **128**, etc.

## Deploy and Railway on Windows

| Issue | What to do |
|-------|------------|
| `railway login` blocked by Windows | Use Railway **dashboard** → Redeploy; or run login from WSL |
| CLI returns empty / exit 1 | Call `node …/railway.js whoami` or use dashboard |
| Redeploy didn't pick up fix | Code was **local only** — **push to GitHub first** |
| GraphQL deploy "Not Authorized" | `railway login` again; token in `~/.railway/config.json` expires |
| `RESEND_API_KEY` missing locally | Set in `eod-api/.env`, or use `flow-automation/.env`, or Railway variables GraphQL (see send script), or `POST /api/dc-scan/send-invite` on prod |

**Do not** commit `.env` files or print API keys in logs.

## UI vs API hosting

- **Canonical UI:** `the-dump-bin/dc-scan/index.html` on GitHub Pages.
- `eod-api/src/public/dc-scan/` is **not** served in prod (redirect only).
- After UI changes, push **the-dump-bin** and wait for Pages — not just eod-api.

## Auth

- Volunteers sign in via Dump Bin magic link (`/signin.html?next=/dc-scan/`).
- API calls use `dumpBinAuthFetch` → JWT on `Authorization` header.
- SSE uses `?access_token=` on `/api/dc-scan/events`.
- **Dump Bin sign-in ≠ DC Scan claim access.** Corporate domains pass sign-in; claiming needs volunteer allowlist.
- Allowlist: `VOLUNTEERS` (+ `alternateEmails`) + `DC_SCAN_VOLUNTEER_EMAILS` env + `dc_scan_volunteer_grants` table.
- Signed-in non-volunteers: UI access gate → `POST /api/dc-scan/access-request` → supervisor approve.

See [access-and-allowlist.md](access-and-allowlist.md).

## Email alias mismatch

| Symptom | Cause | Fix |
|---------|-------|-----|
| Signed in OK; claim says **not on allowlist** | Session email ≠ roster primary (e.g. `@advantagesolutions.net` vs `@sasretailservices.com`) | Add `alternateEmails` on volunteer in `dc-scan-inventory.js`; or `DC_SCAN_VOLUNTEER_EMAILS`; or approve access request |
| User already on Dump Bin allowlist | Confused two auth layers | Dump Bin access does not grant DC Scan claims |

## Supervisor email not sent

| Symptom | Cause | Fix |
|---------|-------|-----|
| Access request submitted; no email | `supervisorEmails` not imported in `dc-scan-notify.js` | Import from `dc-scan-inventory.js` |
| No approver on Railway | `DC_SCAN_APPROVER_EMAIL` unset | Set to `tyson.gauthier@retailodyssey.com` — see [supervisor-notify.md](supervisor-notify.md) |

## UI black screen (the-dump-bin)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Black page, no content | JS syntax error; `#app` stays hidden | Validate inline script; fix duplicate/broken functions |
| Flash then black | `auth-gate` hide without `revealPage` | `auth-gate.js` in `<head>`; `bounceToSignIn` calls `revealPage()` first |

Full UI checklist: `the-dump-bin/.cursor/skills/dc-scan-volunteer-board/ui-troubleshooting.md`.

## Seeds vs live PROD

Seeds for FM **31** (Wolf) and **53** (James) pre-populate pledges with SAS IDs for **today**.
Display status still follows live PROD when `prod.ok`. FM 31 may show **Completed** if the shift is done in SAS.

## decide.html change requests

- `type=dcscan` in decide router.
- Tokens via `issueReviewToken` with `decisionType: 'dcscan'`.
- 24h expiry (`DC_SCAN_REQUEST_EXPIRY_MS` in decide.js).
- On approve/deny, `notifyChangeResolved` emails the requester.

## PowerShell commits

HEREDOC `$(cat <<'EOF')` **fails** on Windows PowerShell. Use:

```powershell
git commit -m "Single-line message."
```
