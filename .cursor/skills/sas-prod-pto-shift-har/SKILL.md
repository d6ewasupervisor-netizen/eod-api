---
name: sas-prod-pto-shift-har
description: Build and complete Fred Meyer PTO/admin shifts in SAS PROD (sick, holiday, vacation, bereavement, jury duty). Use when the user asks to create a single-employee PTO shift, sick day, vacation day, or non-billable store 999 shift for one employee and run it through Field Data Management to completion. For multi-person admin Holiday rosters (team Holiday, project 147), use sas-prod-shift-management-har instead.
---

# SAS Prod PTO / Admin Shift (HAR)

## PTO vs Admin Holiday (pick the right skill)

| Scenario | Team | Skill |
|----------|------|-------|
| **Single employee** sick / vacation / bereavement / jury duty at store 999 | `989886` **PTO** | **This skill** — then Field Data start/complete |
| **Multi-person roster** admin Holiday shift at store 999 (D1/D8 + named lead, mileage off) | `1081083` **Holiday** | **`sas-prod-shift-management-har`** → **Admin Holiday Shift (Project 147)** |

Both use project `147` and store `999`. Do not use the PTO team or Field Data completion flow for a 14-person Holiday roster build.

## Kompass in-progress roster (shift-completion)

For **multi-employee PTO on an active in-progress visit** (Field Data Management → shift-completion roster, `.supervisorPunchBtn` EDIT buttons), use skill **`sas-shift-completion-pto-punch`** instead of this document. That flow is DOM-driven per employee index; this document covers **store 999 admin shift creation** and single-employee API PATCH shapes.

## Safety

Never create, start, or complete a PTO/admin shift unless the user explicitly requests that exact mutation for a named employee and date.

Before any live SAS API call, use `sas-auth-prod-session` to load the current SAS prod session. Never print or commit tokens, cookies, CSRF values, employee addresses, phone numbers, emails, or full raw HAR bodies.

## HAR Source

Primary evidence: `C:/Users/tgaut/Downloads/sas-har-20260617-150709.json` (recorded 2026-06-17, sick shift).

Extracted summary: `reference/har-evidence-20260617.json`.

Scenario captured: **Sick** PTO for **Alexandra Wright Jamsyn** on **2026-06-17** under project **147** / store **999** / team **PTO**, then started and completed in Field Data Management.

The HAR recorder did **not** capture POST/PATCH request bodies (empty `params`). Shapes below are confirmed from **responses**, live GET of the completed shift, and the v2 shift detail endpoint.

## Defaults (override only when the user says otherwise)

| Field | Value |
|-------|-------|
| Customer | Fred Meyer |
| Program | `92` Fred Meyer Admin |
| Project | `147` Fred Meyer InHouse NonBillable Admin |
| Store | `999` (admin / non-billable) |
| Team | `989886` PTO |
| Billable | non-billable |
| Lead | the employee themselves (`is_lead: true`) |
| Mileage | **all off** (`home_to_store`, `store_to_store`, `store_to_home`, `calculate_mileage` = false) |
| Scheduled window | project default `07:00 AM` – `03:00 PM` (8 h) unless user specifies hours |

Resolve the active **cycle** for project `147` whose date range contains the shift date. Example from HAR: cycle `242543` “2026 Non-Billable Admin P5”.

Resolve **project-store id** from `project-stores-autocomplete` for store **999** (HAR: `3289133`). Use exact store matching — see `sas-prod-shift-management-har` **Store Number Matching**.

## Exception Types (shift-break-reasons)

From HAR `GET /team-scheduling/shift-break-reasons/`:

| User term | API reason id | Label |
|-----------|---------------|-------|
| sick | 4 | Sick |
| holiday | 5 | Holiday |
| vacation | 6 | Vacation |
| bereavement | 7 | Bereavement |
| jury_duty | 8 | Jury Duty |

Same flow for all — only the break `reason` id changes.

## End-to-End Flow

```text
Cycle Management (create)          Field Data Management (start + complete)
─────────────────────────          ─────────────────────────────────────
1. POST team-scheduling/visits/    4. PATCH field-app/visits/{visitId}/
2. POST team-scheduling/shifts/    5. POST v2 field-app/travel/{shiftId}/to_store/
                                   6. PATCH v2 field-app/shifts/{shiftId}/
                                   7. PUT  field-app/visits/{visitId}/shift-complete/
                                   8. PATCH field-app/visits/{visitId}/shift-complete/
```

### Step 1 — Create visit

```http
GET /api/v1/projects/project-cycles/?current_status=active&project=147&sort=start_date
GET /api/v1/projects/project-stores-autocomplete/?limit=1000&project=147
POST /api/v1/team-scheduling/visits/
```

Inferred body (confirmed by HAR response `26944919`; visit POST fields corrected 2026-07-04 — bare `store`/`team` integers cause 500; missing `broker_company_id` causes `broker company id None`):

```json
{
  "cycle": 242543,
  "store": { "id": 3289133 },
  "team": { "id": 989886, "name": "PTO", "team_label": "Fred Meyer" },
  "scheduled_date": "2026-06-17",
  "due_by": "2026-06-17",
  "shift_start_time": "07:00 AM",
  "shift_end_time": "03:00 PM",
  "scheduled_end_time": "15:00:00",
  "estimated_shift_hours": "8.00",
  "current_status": "active",
  "timezone_store": "PDT",
  "broker_company_id": "Fred Meyer"
}
```

Use `buildAdminHolidayVisitBody()` in `sas-prod-shift-management-har/scripts/sas-visit-create.js` with `team: { id: 989886, name: "PTO", team_label: "Fred Meyer" }` or the PTO script helpers. See `sas-prod-shift-management-har` **Creating A Visit** for the `broker_company_id` trap.

If a visit already exists for store 999 + date + employee, do not duplicate — reuse or stop and report.

### Step 2 — Add employee shift (mileage off, employee is lead)

```http
POST /api/v1/team-scheduling/shifts/
```

HAR-confirmed response shape (`44265162`):

```json
{
  "home_to_store": false,
  "store_to_store": false,
  "store_to_home": false,
  "calculate_mileage": false,
  "visit": "26944919",
  "employee": 390965,
  "cycle": 242543,
  "shift_start_time": "07:00 AM",
  "shift_end_time": "03:00 PM",
  "current_status": "active",
  "rate_type": {},
  "device_reimbursement": false,
  "is_lead": "true"
}
```

Search employee when ID unknown:

```http
GET /api/v1/human-resources/workday-employees/?address_verified=true&fields=id,person_name,workday_given_id&page_size=5&q=%22{name}%22&sort=person__person_name
```

### Step 3 — Resolve in Field Data Management

```http
GET /api/v1/field-app/visits/?from_state=admin&visit_id={visitId}
GET /api/v1/operations/field-data/?customer_id=2&merchandiser={employeeId}&scheduled_dt_from={date}&scheduled_dt_to={date}
```

### Step 4 — Start visit

```http
PATCH /api/v1/field-app/visits/{visitId}/
```

HAR response: `{"message":"Schedule started successfully","success":true}`. Body was not captured; empty `{}` is sufficient.

### Step 5 — Travel stub (admin / no mileage)

```http
POST /api/v2/field-app/travel/{shiftId}/to_store/
```

HAR used empty body. Required before supervisor time entry in the captured flow.

### Step 6 — Set actual times + exception (critical)

```http
PATCH /api/v2/field-app/shifts/{shiftId}/
```

Confirmed from completed shift `44265162` GET on v2:

```json
{
  "actual_start_date": "2026-06-17",
  "actual_start_time": "07:00:00",
  "actual_end_date": "2026-06-17",
  "actual_end_time": "15:00:00",
  "no_show": false,
  "time_change_reason": 5,
  "time_change_comment": "Supervisor PTO entry",
  "shift_breaks": [
    {
      "reason": 4,
      "start_time": "2026-06-17T14:00:00Z",
      "end_time": "2026-06-17T22:00:00Z",
      "time_change_reason": 5,
      "time_change_comment": "Supervisor PTO entry"
    }
  ]
}
```

Notes:

- `reason` is the numeric **shift-break-reason** id (4 = Sick, 5 = Holiday, 6 = Vacation, …).
- Times use store-local `HH:MM:SS` for `actual_*_time` and UTC ISO for break `start_time` / `end_time` (PDT offset 420 min in HAR: `07:00 AM` → `2026-06-17T14:00:00Z`).
- `time_change_reason` comes from `GET /operations/time-change-reason/?is_admin=true`. HAR used id **5** (“Tablet was Not Available”). Default to **5** unless the user specifies another admin reason.

For partial-day PTO, shorten `actual_end_time` / break `end_time` to the requested hours.

### Step 7 — Complete visit

```http
PUT  /api/v1/field-app/visits/{visitId}/shift-complete/
PATCH /api/v1/field-app/visits/{visitId}/shift-complete/
```

HAR bodies were not captured; empty `{}` succeeded after step 6. PUT response: `Visit completed successfully.`

## Repeatable Script

Dry-run first:

```bash
node ~/.cursor/skills/sas-prod-pto-shift-har/scripts/build-pto-shift.js \
  --employee "Alexandra Wright" \
  --date 2026-06-17 \
  --exception sick \
  --hours 8 \
  --dry-run
```

Live run only after explicit user approval (omit `--dry-run`):

```bash
node ~/.cursor/skills/sas-prod-pto-shift-har/scripts/build-pto-shift.js \
  --employee "Alexandra Wright" \
  --date 2026-06-17 \
  --exception vacation \
  --hours 8
```

Flags:

- `--exception` — `sick`, `holiday`, `vacation`, `bereavement`, `jury_duty`
- `--hours` — default `8`
- `--shift-start` / implied end from hours
- `--no-complete` — create visit + shift only, skip field-data start/complete
- `--time-change-reason` / `--time-change-comment` — override supervisor change reason

## Verification

After completion, confirm:

```http
GET /api/v1/field-app/visits/{visitId}/shift-complete/
GET /api/v2/field-app/shifts/{shiftId}/
GET /api/v1/field-app/visits/?from_state=admin&visit_id={visitId}
```

Expect:

- Visit `current_status`: `completed`
- Employee `no_show`: false
- `shift_breaks[0].reason` matches requested exception
- All mileage flags false
- Store number **999** exactly

Report back: **created → started → completed** (or which step failed), with visit id, shift id, employee name, date, exception type, and hours.

## Related Skills

- `sas-auth-prod-session` — PROD auth
- `sas-prod-shift-management-har` — Kompass roster shifts (different project/store rules)
- `sas-prod-shift-management-har` / `sas-store-match` — exact store number matching when store 999 is involved
