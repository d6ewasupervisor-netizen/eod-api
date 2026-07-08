---
name: dc-scan-volunteer-board
description: >-
  Build and operate the live DC Scan volunteer signup board (SAS PROD project
  8081 / RO8 DC Scans): dual-panel claims, Dump Bin auth, SAS PROD live sync,
  finalize→SAS build, decide.html release/swap approvals, Resend notifications,
  and volunteer onboarding email. Use when the user mentions DC Scan, dc-scan,
  project 8081, RO8 DC Scans, P06W3 volunteer board, or FM 19/28/31/53/215/459/682
  signup.
---

# DC Scan volunteer board

Live signup board for **SAS PROD project 8081** / team **RO8 DC Scans**.
Extends the generic [shift_volunteer](../../../../.cursor/skills/shift_volunteer/SKILL.md) pattern with SAS PROD polling, finalize builds, and Dump Bin auth.

## Canonical URLs

| What | URL |
|------|-----|
| Dashboard UI | `https://the-dump-bin.com/dc-scan/` |
| API | `https://eod-api.the-dump-bin.com/api/dc-scan/` |
| Release/swap approval | `https://the-dump-bin.com/decide.html?type=dcscan&id=…&token=…` |

**UI lives in `the-dump-bin`**, not eod-api public assets. eod-api only **redirects** `/dc-scan` → dump-bin.

## Repos and file map

| Role | Repo | Path |
|------|------|------|
| Inventory, volunteers, fiscal weeks | eod-api | `src/lib/dc-scan-inventory.js` |
| Postgres state, snapshot, SSE | eod-api | `src/lib/dc-scan-board.js` |
| SAS PROD fetch (project 8081) | eod-api | `src/lib/dc-scan-sas-prod.js` |
| PROD poll + SAS session refresh | eod-api | `src/lib/dc-scan-sas-sync.js` |
| Finalize → create visits/shifts | eod-api | `src/lib/dc-scan-sas-build.js` |
| Resend notifications | eod-api | `src/lib/dc-scan-notify.js` |
| API routes | eod-api | `src/routes/dc-scan-board.js` |
| decide.html integration | eod-api | `src/routes/decide.js` (`type=dcscan`) |
| Dashboard HTML | the-dump-bin | `dc-scan/index.html` |
| Auth gate | the-dump-bin | `auth-gate.js` (shared) |
| Volunteer invite script | eod-api | `scripts/send-dc-scan-volunteer-invite.js` |

## Operators (P06W3 baseline)

| Person | Email | SAS employeeId |
|--------|-------|----------------|
| Ruth Northcutt | ruth.northcutt@sasretailservices.com | 76141 |
| James Duchene | james.duchene@retailodyssey.com | 394407 |
| Wolf (Aiyana Natarisalazar) | aiyana.natarisalazar@retailodyssey.com | 155473 |
| Supervisor | tyson.gauthier@retailodyssey.com | — |

Stores: **19, 28, 31, 53, 215, 459, 682** (exact match only — see `sas-exact-store-number` rule).

## Product rules (locked)

1. **Two panels:** urgent **this week** + **going forward** (next fiscal week+).
2. Claim **Wed–Fri**; multiple stores per person allowed.
3. **Claimed ≠ In PROD.** Badge **In PROD** / **Completed** only when live SAS sync confirms the visit (`prod.ok`). Stored `sasVisitId` / seed data alone is **not** enough.
4. **Completed** visits/shifts in SAS count as PROD-confirmed (FM 31 may show Completed).
5. **Finalize** locks picks and runs `dc-scan-sas-build` (staggered RO8 visits/shifts).
6. **Release/swap** → `decide.html` / `POST /api/decide` with `type=dcscan`; supervisor approves via email link.
7. Auth: Dump Bin magic-link JWT (`auth-gate.js`); allowlists in `dc-scan-inventory.js`.

## Startup order (mandatory)

In `src/index.js`:

```text
await sasBridge.init(app, pool);   // SAS session MUST exist first
await initDcScanBoard(pool);
startDcScanProdSync();             // delayed first poll + 60s interval
app.use('/api/dc-scan', …);
```

If PROD sync starts before `sasBridge.init()`, the banner stays **PROD pending** forever until **Resync SAS PROD**.

## API routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/dc-scan/` | JWT | Snapshot |
| GET | `/api/dc-scan/events` | JWT (`access_token` query) | SSE |
| POST | `/api/dc-scan/claim` | volunteer | Claim store + date |
| POST | `/api/dc-scan/change-request` | volunteer | Release or swap request |
| POST | `/api/dc-scan/finalize` | volunteer | Lock + SAS build |
| POST | `/api/dc-scan/resync` | JWT | Force SAS refresh + PROD fetch (no page reload) |
| POST | `/api/dc-scan/send-invite` | **supervisor** | Email volunteers dashboard + instructions |

## PROD sync

- Poll interval: `DC_SCAN_PROD_SYNC_MS` (default 60000).
- Startup delay: `DC_SCAN_PROD_START_DELAY_MS` (default 8000) so SAS bridge finishes init.
- Auto-refreshes dead SAS sessions via `sas-auto-refresh` (`SAS_USER`, `SAS_PASS`, `SAS_TOTP_SECRET` on Railway).
- UI **Resync SAS PROD** button calls `POST /api/dc-scan/resync` and applies returned `snapshot`.

## Email

| Event | From | To |
|-------|------|-----|
| Volunteer invite | `DC Scans <dcscans@retail-odyssey.com>` | all volunteers; **Cc** supervisor |
| Claim | DC Scan Board default | approver |
| Change request | DC Scan Board default | approver + decide link |
| Finalize | DC Scan Board default | approver + volunteer |

Send onboarding email:

```bash
# Dry run (prints recipients)
node scripts/send-dc-scan-volunteer-invite.js --dry-run

# Send (needs RESEND_API_KEY — see gotchas.md for Windows/Railway)
node scripts/send-dc-scan-volunteer-invite.js
```

Or after deploy, supervisor-signed `POST /api/dc-scan/send-invite`.

Env overrides: `DC_SCAN_FROM_ADDRESS`, `DC_SCAN_DASHBOARD_URL`, `DC_SCAN_APPROVER_EMAIL`.

## Deploy checklist

```
DC Scan deploy:
- [ ] Push eod-api to GitHub main (Railway auto-deploy or manual redeploy from dashboard)
- [ ] Push the-dump-bin to GitHub main (GitHub Pages)
- [ ] Confirm SAS creds on Railway (SAS_USER, SAS_PASS, SAS_TOTP_SECRET)
- [ ] Hard-refresh https://the-dump-bin.com/dc-scan/
- [ ] Resync SAS PROD — banner should show visit count
- [ ] FM 31 / 53 show In PROD or Completed when live
```

**Railway (eod-api):** project `5bc0629e-2ebb-49f2-9e13-8b878a16bf93`, service `7478ebb4-8bae-4e30-a2d5-9cb41723d2e2`, env `082a323e-a570-4ed0-8ee6-8eee60e28e95`.

Manual redeploy **only rebuilds what's on GitHub** — commit and push before redeploying.

## Common agent mistakes

Read [gotchas.md](gotchas.md) before changing status logic, PROD sync, or deploy paths.

## Additional resources

- Pain points: [gotchas.md](gotchas.md)
- Env vars, status matrix, seeds: [reference.md](reference.md)
- Generic volunteer-board pattern: `~/.cursor/skills/shift_volunteer/SKILL.md`
