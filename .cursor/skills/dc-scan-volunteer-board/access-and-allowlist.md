# DC Scan — volunteer allowlist and access requests

## Two auth layers (do not confuse)

| Layer | What it gates | Where |
|-------|---------------|-------|
| **Dump Bin sign-in** | Can open gated dump-bin pages | `auth-gate.js`, `allowed-emails.js`, corporate domains (`@retailodyssey.com`, `@sasretailservices.com`, `@advantagesolutions.net`, `@youradv.com`) |
| **DC Scan volunteer list** | Can **claim** stores on the board | `dc-scan-inventory.js` → `volunteerEmails()`, `requireActor()` in `dc-scan-board.js` |

A user can be **signed in** to Dump Bin but still blocked from claiming with:

`Your account is not on the DC Scan signup allowlist.`

## Email alias matching (immediate unblock)

Volunteers often sign in with a different corporate email than the primary roster entry (e.g. `ruth.northcutt@advantagesolutions.net` vs `ruth.northcutt@sasretailservices.com`).

**Fix in code** — add `alternateEmails` on the volunteer in `src/lib/dc-scan-inventory.js`:

```js
{
  name: 'Ruth Northcutt',
  email: 'ruth.northcutt@sasretailservices.com',
  alternateEmails: ['ruth.northcutt@advantagesolutions.net'],
  employeeId: 76141,
  // ...
}
```

`findVolunteerByEmail()` and `volunteerEmails()` use `emailsForVolunteer()` — any alias counts for allowlist **and** SAS employeeId lookup on finalize.

**Fast prod workaround** (no deploy): ask user to sign out → request magic link to the **primary** roster email.

**Env workaround:** add comma-separated extras to `DC_SCAN_VOLUNTEER_EMAILS` on Railway.

## Self-serve access request flow

For signed-in users **not** on the volunteer list who are not known volunteers with aliases.

### User path

1. Open `https://the-dump-bin.com/dc-scan/` (signed in).
2. Board loads read-only; **Request DC Scan access** banner appears.
3. Submit name + optional note → `POST /api/dc-scan/access-request` (JWT required).

### Supervisor path

1. Email: `[DC Scan] Access request: …` with Approve/Deny links.
2. Links hit `GET /api/dc-scan-access-requests/:id/(approve|deny)?token=…&by=…` → confirmation page → POST.
3. **Approve** inserts `dc_scan_volunteer_grants`, adds email to in-memory grant set, emails requester.
4. User **refreshes** the board — `GET /api/dc-scan/approved-users` returns `canParticipate: true`.

### API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/dc-scan/approved-users` | JWT | `canParticipate`, `pendingAccessRequest` |
| POST | `/api/dc-scan/access-request` | JWT | Create pending request + email supervisor |

### Code / DB

| Piece | Path |
|-------|------|
| Grants + requests DB | `src/lib/dc-scan-access-db.js` |
| Approve/deny routes | `src/routes/dc-scan-access-decision.js` |
| Migration | `src/migrations/042_dc_scan_volunteer_access.sql` |
| Notify | `notifyDcScanAccessRequest`, `notifyDcScanAccessResolved` in `dc-scan-notify.js` |

Tables: `dc_scan_volunteer_grants`, `dc_scan_access_requests`.

Grants reload on boot via `loadGrantedVolunteerEmails()` in `dc-scan-board.js` `init()`.

## Agent checklist — “can’t claim / not on allowlist”

```
- [ ] Confirm signed-in email (UI header or /api/me)
- [ ] Check VOLUNTEERS primary + alternateEmails in dc-scan-inventory.js
- [ ] Check DC_SCAN_VOLUNTEER_EMAILS env on Railway
- [ ] Check dc_scan_volunteer_grants table for approved grant row
- [ ] If new volunteer: add roster entry OR approve access request
- [ ] Push eod-api; user hard-refreshes dc-scan/
```

## Do not

- Add everyone to Dump Bin `allowed_emails` thinking it fixes DC Scan claims — it does not.
- Use substring store matching when debugging visit issues (see `sas-exact-store-number` rule).
