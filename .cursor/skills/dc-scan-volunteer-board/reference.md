# DC Scan board — reference

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DC_SCAN_PROD_SYNC_MS` | `60000` | PROD poll interval |
| `DC_SCAN_PROD_START_DELAY_MS` | `8000` | Delay before first PROD sync |
| `DC_SCAN_DASHBOARD_URL` | `https://the-dump-bin.com/dc-scan/` | Email + notify links |
| `DC_SCAN_FROM_ADDRESS` | `DC Scans <dcscans@retail-odyssey.com>` | Volunteer invite From |
| `DC_SCAN_APPROVER_EMAIL` | Tyson | Change/finalize notify To |
| `DC_SCAN_VOLUNTEER_EMAILS` | — | Comma extra allowlist |
| `DC_SCAN_SUPERVISOR_EMAILS` | — | Comma extra supervisors |
| `SAS_USER` / `SAS_PASS` / `SAS_TOTP_SECRET` | — | SAS bridge + PROD sync |
| `RESEND_API_KEY` | — | All outbound email |
| `DUMP_BIN_SITE` | `https://the-dump-bin.com` | decide.html base |

## Status matrix (UI badges)

| `store.status` | Meaning |
|----------------|---------|
| `open` | No pledge; slot available |
| `pledged` | Claimed on board; not finalized |
| `finalized` | Locked for SAS build; not yet confirmed in PROD |
| `built` | Live PROD confirms active visit + shift |
| `completed` | Live PROD visit/shift marked complete |
| `scheduled` | In PROD without a board pledge (prod-only row) |

Snapshot pledge fields:

- `prodConfirmed` — boolean from live PROD
- `finalized` — explicit finalize only (not auto-set from PROD)

## Slot IDs

- This week: `thisWeek:FM{storeId}` (e.g. `thisWeek:FM31`)
- Ongoing: `ongoing:{weekKey}:FM{storeId}`

## Postgres

Table: `dc_scan_board_state` (single row `id=1`, JSONB `state`).

## API response shapes

**GET /** → `{ success, snapshot }`

**POST /claim** body: `{ scope: "thisWeek"|"ongoing", storeId, scheduledDate }`

**POST /change-request** body: `{ pledgeId, type: "release"|"swap", note?, swapToStoreId?, swapToDate? }`

**POST /resync** → `{ success, message, snapshot, prod }`

**POST /send-invite** (supervisor) → `{ success, message, emailId }`

## SAS PROD fetch

`fetchProdSchedule({ startDate, endDate })`:

1. `resolveActiveCycle()` for project **8081**
2. `listCycleVisits(cycleId)` — no store_number filter
3. Filter: date range, `isRo8Visit`, exact store via `sas-store-match`
4. `listVisitShifts(visitId)` per visit

## Known PROD seeds (2026-07-08)

| Store | Visit ID | Shift ID | Lead |
|-------|----------|----------|------|
| FM 31 | 27034474 | 44474494 | Wolf (155473) |
| FM 53 | 27034491 | 44474532 | James (394407) |

Cycle: **243666**

## Railway IDs (eod-api production)

| Resource | ID |
|----------|-----|
| Project | `5bc0629e-2ebb-49f2-9e13-8b878a16bf93` |
| Service | `7478ebb4-8bae-4e30-a2d5-9cb41723d2e2` |
| Environment | `082a323e-a570-4ed0-8ee6-8eee60e28e95` |

## Scripts

```bash
node scripts/send-dc-scan-volunteer-invite.js [--dry-run]
```

## Related skills

- `sas-prod-shift-management-har` — visit/shift mutations, store match
- `shift_volunteer` — generic pledge board pattern
- `sas-auth-prod-session` — SAS bridge credentials
