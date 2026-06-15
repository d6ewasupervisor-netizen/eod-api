---
name: sas-prod-shift-management-har
description: Build and mutate SAS Prod team-scheduling visits from HAR-confirmed patterns. Use when the user provides date, time, shift type, store number, team lead, team members, or asks to copy roster/team details from an existing Kompass ISE shift.
---

# SAS Prod Shift Management HAR

## Safety

Never build a SAS visit/shift, start a shift, add a person, remove a person, or change lead status unless the user explicitly instructs that exact mutation. A reconciliation or photo request is not permission to create shifts or edit rosters.

Before any live SAS API call, use `sas-auth-prod-session` to load the current SAS prod session. Never print or commit tokens, cookies, CSRF values, HAR headers, employee addresses, phone numbers, emails, or full raw HAR bodies.

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
GET /api/v1/team-scheduling/visits/?cycle={cycleId}&page=1&page_size=10&store_number={store}
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

Some Chrome HAR exports omit request bodies for these POST/PATCH calls. If body data is missing, inspect the current frontend bundle or checked-in helper before mutating. Do not infer from response shape alone.

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

Resolve these IDs before creating a visit:

- `cycle`: destination cycle ID.
- `store`: destination project-store ID from `project-stores-autocomplete` or an existing visit response, not the plain store number.
- `team`: source or requested team ID.
- `scheduled_date`: requested date in `YYYY-MM-DD`.
- `shift_start_time`: SAS display time such as `05:03 AM`.
- `scheduled_end_time` or `shift_end_time`: preserve source end time unless the user provides a new time.

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

If creating the visit returns success, immediately fetch it by ID and confirm project, cycle, store number, date, team, and times before adding people.

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

Report the visit id, project id, employee names, `shift_id`s, lead flags, and current statuses.

For copied rosters, also report the source visit id and destination visit id, plus any source employees skipped because they were inactive, duplicates, missing from employee search, or explicitly excluded by the user.
