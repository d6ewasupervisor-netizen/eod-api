# DC Scan — supervisor email and notifications

## Default supervisor

`tyson.gauthier@retailodyssey.com` — hardcoded as `DEFAULT_SUPERVISOR_EMAIL` in `dc-scan-inventory.js`.

## Railway env (required in production)

Set on **eod-api** service:

```text
DC_SCAN_APPROVER_EMAIL=tyson.gauthier@retailodyssey.com
```

Railway IDs (production):

| Resource | ID |
|----------|-----|
| Project | `5bc0629e-2ebb-49f2-9e13-8b878a16bf93` |
| Service | `7478ebb4-8bae-4e30-a2d5-9cb41723d2e2` |
| Environment | `082a323e-a570-4ed0-8ee6-8eee60e28e95` |

```powershell
railway variable set DC_SCAN_APPROVER_EMAIL=tyson.gauthier@retailodyssey.com `
  -p 5bc0629e-2ebb-49f2-9e13-8b878a16bf93 `
  -s 7478ebb4-8bae-4e30-a2d5-9cb41723d2e2 `
  -e 082a323e-a570-4ed0-8ee6-8eee60e28e95
```

Also needs `ACCESS_REQUEST_SECRET` (shared with Dump Bin `/api/access-request` HMAC) and `RESEND_API_KEY`.

Optional extras: `DC_SCAN_SUPERVISOR_EMAILS` (comma), `OVERRIDE_APPROVER_EMAIL`, `SHIFT_REQUEST_APPROVER_EMAIL`.

## Who receives what

| Event | Function | Recipients |
|-------|----------|------------|
| Claim | `notifyClaim` | `approverEmail()` |
| Change request | `notifyChangeRequest` | supervisors + decide link |
| Finalize | `notifyFinalize` | supervisor + volunteer |
| Volunteer invite | `notifyVolunteerInvite` | all volunteers; Cc supervisor |
| **Access request** | `notifyDcScanAccessRequest` | `supervisorEmails()` — **must import from inventory** |
| Access approved/denied | `notifyDcScanAccessResolved` | requester |

`approverEmail()` resolution order: `DC_SCAN_APPROVER_EMAIL` → `OVERRIDE_APPROVER_EMAIL` → `SHIFT_REQUEST_APPROVER_EMAIL` → `DEFAULT_SUPERVISOR_EMAIL`.

`supervisorEmails()` = default + override envs + `DC_SCAN_SUPERVISOR_EMAILS`.

## Common failure — access request email silent

**Symptom:** User submits access request; no supervisor email.

**Cause:** `dc-scan-notify.js` called `supervisorEmails()` without importing it from `dc-scan-inventory.js` (ReferenceError at runtime).

**Fix:** Ensure notify module imports:

```js
const { …, supervisorEmails } = require('./dc-scan-inventory');
```

**Verify locally:**

```bash
node -e "const inv=require('./src/lib/dc-scan-inventory'); console.log([...inv.supervisorEmails()])"
```

## Access-request decision URLs

HMAC namespace: `dcscan-access|{id}|{action}|{approverEmail}` (distinct from Dump Bin `access_requests`).

Base URL: `BACKEND_BASE_URL` or `https://eod-api.the-dump-bin.com`.

Public path prefix (no JWT): `/api/dc-scan-access-requests/`
