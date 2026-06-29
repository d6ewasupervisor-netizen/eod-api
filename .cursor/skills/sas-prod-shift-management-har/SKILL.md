---
name: sas-prod-shift-management-har
description: Build and mutate SAS Prod team-scheduling visits from HAR-confirmed patterns. Use when the user provides date, time, shift type, store number, team lead, team members, asks to copy roster/team details from an existing Kompass ISE shift, or asks to change/reassign/swap the lead on one or more shifts for a date.
---

# SAS Prod Shift Management HAR

## Safety

Never build a SAS visit/shift, start a shift, add a person, remove a person, or change lead status unless the user explicitly instructs that exact mutation. A reconciliation or photo request is not permission to create shifts or edit rosters.

Before any live SAS API call, use `sas-auth-prod-session` to load the current SAS prod session. Never print or commit tokens, cookies, CSRF values, HAR headers, employee addresses, phone numbers, emails, or full raw HAR bodies.

## Store Number Matching (Mandatory)

SAS PROD **substring-matches** `store_number` on list endpoints. Verified: `team-scheduling/visits?store_number=28` returns store **281** (not store 28). Never trust that filter alone.

**Rules — every PROD workflow:**

1. Match store numbers as **whole numbers only** (store `28` ≠ `128`, `281`, `286`, `428`, …).
2. Fetch cycle visits **without** relying on `store_number=` results, then filter client-side with exact match.
3. When the user names a store, resolve **store + date** (+ lead if given) before any mutation. Do not pick a visit from employee-only cycle shift search unless the user did not specify a store.
4. Before mutate/report, confirm: requested store, actual visit store (`visit.store.store.number`), visit id, date, lead.
5. Use shared helpers — do not hand-roll string `includes` / partial matching:

```js
const {
  normalizeStoreNumber,
  getVisitStoreNumber,
  filterVisitsByStore,
  assertVisitStore,
} = require('./scripts/sas-store-match');
// eod-api app code: require('../../../lib/sas-store-match')
```

```js
// Preferred visit lookup when store + date are known:
const visits = rows(await sas('GET', `/team-scheduling/visits/?cycle=${cycleId}&page=1&page_size=500`));
const forStore = filterVisitsByStore(
  visits.filter((v) => String(v.scheduled_date) === targetDate),
  requestedStore
);
if (forStore.length !== 1) throw new Error(`Expected one visit for store ${requestedStore} on ${targetDate}, found ${forStore.length}`);
const visit = await sas('GET', `/team-scheduling/visits/${forStore[0].id}/`);
assertVisitStore(visit, requestedStore, 'Resolved visit');
```

If `store_number=` is used as a pre-filter for bandwidth, **always** re-filter with `filterVisitsByStore` / `assertVisitStore` before acting.

## Project Targeting

Always resolve and verify the project before mutation:

```text
1    Fred Meyer Kompass ISE
1715 Blitz Kompass ISE
1668 Cut In Kompass ISE
3568 Fred Meyer DIV Special Projects Kompass ISE
```

Use the user's "shift type" to pick the destination project. For example, "blitz shift" means project `1715`; "regular Kompass ISE" means project `1`; "cut in" means project `1668`. Query existing visits first:

```http
GET /api/v1/projects/projects/?current_status=active,approved&fields=id,name&program=1&sort=name
GET /api/v1/projects/project-cycles/?current_status=active&page=1&page_size=10&project={projectId}&sort=start_date
GET /api/v1/team-scheduling/visits/?cycle={cycleId}&page=1&page_size=500
# Optional pre-filter only — MUST exact-filter client-side (see Store Number Matching):
# GET ...&store_number={store}
GET /api/v1/operations/field-data/?customer_id=2&program_id=1&project_id={projectId}&project_store_id={projectStoreId}&scheduled_dt_from=YYYY-MM-DD&scheduled_dt_to=YYYY-MM-DD
```

If an active or in-progress visit already exists for the destination project, cycle, store, and date, use it. Do not create duplicates.

## HAR Endpoints

Observed endpoints for the shift-management UI:

```http
GET  /api/v1/projects/projects/{projectId}/?fields=id,name,project_service_types,is_external_cycle_id_required
GET  /api/v1/projects/project-cycles/{cycleId}/
GET  /api/v1/projects/project-stores-autocomplete/?limit=1000&project={projectId}
POST /api/v1/team-scheduling/visits/
GET  /api/v1/team-scheduling/visits/{visitId}/
GET  /api/v1/team-scheduling/shifts/?page=1&page_size=10&visit={visitId}
POST /api/v1/team-scheduling/shifts/
GET  /api/v1/field-app/visits/{visitId}/shift-complete/
```

Some Chrome HAR exports omit request bodies for these POST/PATCH calls. If body data is missing, use `scripts/sas-visit-create.js`, `OPTIONS /team-scheduling/visits/`, or the checked-in helper before mutating. Do not infer from response shape alone.

## Copying A Kompass Roster To Another Date (Same Project)

When the user asks to duplicate today's team onto tomorrow (same store, same lead, same Kompass ISE project):

1. Resolve the active cycle for the destination date (match period/week label such as `P06W1` in cycle name when given).
2. Find the **source** visit: exact store + source date + project. Use `filterVisitsByStore` after listing cycle visits.
3. Check the **destination** date for an existing visit at that store. Reuse it when present; do not create duplicates.
4. Create the destination visit when missing (see **Creating A Visit**), then copy active source shifts with `POST /team-scheduling/shifts/`.
5. Default destination start to **source start + 3 minutes** when the user says "a few minutes later" or when POST returns `Team already have scheduled Visit at this time!`.

Repeatable script (dry-run first):

```bash
node ~/.cursor/skills/sas-prod-shift-management-har/scripts/copy-roster-to-date.js \
  --store 462 --source-date 2026-06-25 --dest-date 2026-06-26 --project 1 --cycle-name P6W1 --dry-run
```

Omit `--dry-run` only after explicit user approval. Defaults: source date = today, dest date = tomorrow, project = `1`, start offset = 3 minutes.

**Terminated employees:** a person may remain on an in-progress source visit but fail on the new visit with `Active Employee does not exists`. Check `shift.employee.termination_date` on the source roster; report skips — do not substitute unless the user names a replacement.

## Copying A Kompass Roster To A Blitz Shift

When the user asks for a Blitz shift using the same people as a regular Kompass ISE shift, resolve both sides:

1. Resolve the source project as `1` and the destination project as `1715`.
2. Resolve the active cycle for each project from `project-cycles`. Match the requested date to the cycle whose start/end date contains it; if the user names a period/week such as `P05W4`, verify that label in the cycle detail before mutating.
3. Find the source regular Kompass visit for the requested store/date. If the user names a lead, prefer the visit where that employee has an active shift with `is_lead: true`.
4. Fetch the source roster:

```http
GET /api/v1/team-scheduling/shifts/?page=1&page_size=50&visit={sourceVisitId}
```

Use only active shifts. Copy the employee IDs from the source roster unless the user explicitly lists different team members. If the user says "same team members", include the source lead only if the requested lead is that same person; otherwise add the requested lead and copy the non-lead source employees.

5. Derive the destination team from the source regular visit's `team.id` and `team.name` unless the user gives a different team. HAR evidence for the 2026-06-15 store 391 Blitz build used regular Kompass source visit `26819843` and created Blitz visit `26935185` with team `Traveling Team Seattle`.
6. Derive destination time from the user input. If the user says "3 minutes later than the Kompass ISE shift", add three minutes to the source visit `shift_start_time`. Preserve the source visit `shift_end_time` unless the user gives another end time. HAR evidence: source `05:00 AM` regular Kompass start became Blitz `05:03 AM`.
7. Create or reuse the destination Blitz visit, then add the lead and roster with `POST /team-scheduling/shifts/`.

## Creating A Visit

Resolve these from an existing visit on the same project/store or from `project-stores-autocomplete` + cycle detail:

- `cycle`: destination cycle ID (integer).
- `store`: `{ "id": projectStoreId }` — **not** a bare integer (`store: 99` → 500 `'int' object has no attribute 'get'`).
- `team`: **full team object** from source visit GET (`{ id, name, teammates }`) — **not** bare team id (`team: 1570021` → same 500).
- `scheduled_date`, `due_by`: requested date `YYYY-MM-DD` (both required).
- `visit_id`: required composite string for new visits: `teamId + accountStoreId + projectId + cycleId` (no DB visit id prefix). Use `buildNewVisitId()` in `scripts/sas-visit-create.js`.
- `shift_start_time`, `shift_end_time`: display format `%I:%M %p` (e.g. `05:03 AM`, `01:30 PM`).
- `scheduled_end_time`: 24-hour `HH:MM:SS` (e.g. `13:30:00`).
- `estimated_shift_hours`: decimal string such as `8.00`.
- `current_status`: `active`.

Confirmed POST body (2026-06-25, store 462 → next day):

```json
{
  "cycle": 242295,
  "store": { "id": 99 },
  "team": { "id": 1570021, "name": "Kompass 1H", "teammates": [] },
  "scheduled_date": "2026-06-26",
  "due_by": "2026-06-26",
  "visit_id": "15700211591242295",
  "shift_start_time": "05:03 AM",
  "shift_end_time": "01:30 PM",
  "scheduled_end_time": "13:30:00",
  "estimated_shift_hours": "8.00",
  "current_status": "active"
}
```

Build bodies with:

```js
const { buildVisitCreateBody, teamSchedulingReferer } = require('./scripts/sas-visit-create');
const body = buildVisitCreateBody(sourceVisit, destDate, { startOffsetMinutes: 3 });
// POST with Referer: teamSchedulingReferer(cycleId)
```

If creating the visit returns success, immediately fetch it by ID and confirm project, cycle, store number, date, team, and times before adding people.

The HAR-confirmed Blitz result for store 391 on 2026-06-15 returned:

```json
{
  "id": 26935185,
  "cycle": 242553,
  "estimated_shift_hours": "8.00",
  "shift_start_time": "05:03 AM",
  "scheduled_end_time": "15:00:00",
  "scheduled_date": "2026-06-15",
  "current_status": "active",
  "store": { "id": 573354, "project": { "id": 1715 } },
  "team": { "id": 1731560, "name": "Traveling Team Seattle" },
  "shift_end_time": "03:00 PM"
}
```

## Adding A Person

Checked helper shape from `eod-api/src/shift-management.js`:

```json
{
  "home_to_store": true,
  "store_to_store": true,
  "store_to_home": true,
  "calculate_mileage": true,
  "visit": "26924761",
  "employee": 76141,
  "cycle": 242556,
  "shift_start_time": "05:00 AM",
  "shift_end_time": "03:00 PM",
  "current_status": "active",
  "rate_type": {},
  "device_reimbursement": false,
  "is_lead": "false"
}
```

Set `"is_lead": "true"` only for the requested team lead. A regular team member uses `"false"`. HAR evidence for the 2026-06-15 store 391 Blitz build added the requested lead with `is_lead: true`, then added copied team members with `is_lead: false`.

Search employees by name when IDs are not already known:

```http
GET /api/v1/human-resources/workday-employees/?address_verified=true&fields=id,person_name,workday_given_id&page_size=5&q=%22{name}%22&sort=person__person_name&visit_id={visitId}
```

If a roster was copied from a source visit, prefer source roster employee IDs over fuzzy name search.

## Removing A Person

Known route:

```http
PATCH /api/v1/team-scheduling/shifts/{shiftId}/
```

```json
{ "current_status": "deleted" }
```

Use only with explicit user approval for the named person/shift.

## Reassigning Lead On Existing Shifts

SAS does **not** support in-place lead changes. Pattern: **delete old lead shift, recreate new lead shift** on the same visit.

1. Resolve both employees via `workday-employees` search. User nicknames may not match SAS legal names — search partial names and confirm IDs (e.g. user "Alexandera Wright" → SAS `Alexandra Wright Jamsyn`).
2. For each Kompass project (`1`, `1668`, `1715`, `3568`), resolve the active cycle covering the target date.
3. Find active lead shifts for the outgoing employee:

```http
GET /api/v1/team-scheduling/shifts/?current_status=active&cycle={cycleId}&employee={oldEmployeeId}
```

Keep only rows where `is_lead` is truthy and the visit `scheduled_date` matches. Include visits with `current_status` `active` or `in-progress`.

4. **Deduplicate by `visitId`** before mutating. The same shift can surface when scanning multiple project cycles; mutate each visit once.
5. For each visit:
   - `PATCH /api/v1/team-scheduling/shifts/{oldLeadShiftId}/` → `{ "current_status": "deleted" }`
   - If the incoming lead already has a non-lead shift on the visit, delete that shift too.
   - `POST /api/v1/team-scheduling/shifts/` with same `visit`, `cycle`, `shift_start_time`, `shift_end_time`, new `employee`, and `"is_lead": "true"`.
6. Verify with `field-data` for the date (fast roster check) and per-visit `team-scheduling/shifts`.

Repeatable script (dry-run first):

```bash
node ~/.cursor/skills/sas-prod-shift-management-har/scripts/reassign-lead-by-date.js \
  --date YYYY-MM-DD --from "Old Lead Name" --to "New Lead Name" --dry-run
```

Omit `--dry-run` only after explicit user approval. Default date is tomorrow when `--date` is omitted.

## Autonomous Input Contract

When the user provides:

```text
Date, Time, Shift type, Store number, Team lead, team members
```

Use this skill to build the shift without asking for more details when the missing details can be resolved from SAS:

- If `Time` is explicit, use it. If it says "same as" or "N minutes later than" another shift, resolve that source shift and calculate the time.
- If `team members` says "same as the Kompass ISE shift", resolve the regular project `1` source visit for that store/date/lead and copy active roster employee IDs.
- If the user names a cycle/period/week, use it to choose the cycle; otherwise choose the active cycle containing the requested date.
- Always dry-run mentally from fetched data before posting: destination project, cycle, store project-store ID, date, start/end time, team ID/name, lead employee ID, and member employee IDs must all be known.

## Verification

After any approved shift/roster mutation:

```http
GET /api/v1/team-scheduling/shifts/?visit={visitId}&page=1&page_size=50
GET /api/v1/team-scheduling/visits/{visitId}/
GET /api/v1/field-app/visits/{visitId}/category-resets/
```

For date-wide lead changes, also query:

```http
GET /api/v1/operations/field-data/?customer_id=2&program_id=1&scheduled_dt_from=YYYY-MM-DD&scheduled_dt_to=YYYY-MM-DD&page=1&page_size=500
```

Filter `visit_lead` for old vs new names; expect zero old-lead rows when complete.

Report the visit id, project id, store number, employee names, `shift_id`s, lead flags, and current statuses.

For copied rosters, also report the source visit id and destination visit id, plus any source employees skipped because they were inactive, terminated (`termination_date` set), duplicates, missing from employee search, or explicitly excluded by the user.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/copy-roster-to-date.js` | Duplicate full roster to another date (same project/store/team) |
| `scripts/sas-visit-create.js` | `buildVisitCreateBody`, `buildNewVisitId`, start-time offset helper |
| `scripts/reassign-lead-by-date.js` | Swap visit lead across Kompass projects for a date |
| `scripts/sas-store-match.js` | Exact store-number filtering (mandatory) |
