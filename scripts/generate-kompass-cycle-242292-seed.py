#!/usr/bin/env python3
"""Generate kompass cycle 242292 mock-shift seed JSON + SQL migration."""

from __future__ import annotations

import base64
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "data"
MIGRATIONS_DIR = ROOT / "src" / "migrations"

TARGET_STORES = [
    5, 13, 19, 23, 24, 28, 31, 53, 70, 90, 171, 180, 209, 215, 225,
    325, 328, 355, 390, 417, 459, 603, 604, 608, 658, 665, 682,
]
TARGET_SET = set(TARGET_STORES)
CYCLE_ID = 242292

EXCEL = Path(r"c:\Users\tgaut\Downloads\export_team_schedulings_242292_20260530003141267906.xlsx")
EMPLOYEES_JSON = Path(r"c:\Users\tgaut\Downloads\sas-employees-2026-05-30T00-38-51.json")
HAR_JSON = Path(r"c:\Users\tgaut\Downloads\sas-har-20260529-173311.json")

OVERSEERS = [
    {
        "workday_id": "800175315",
        "name": "Tyson Gauthier",
        "email": "tyson.gauthier@retailodyssey.com",
        "login_email": "tyson.gauthier@fredmeyer.com",
        "sas_id": None,
    },
    {
        "workday_id": "800556154",
        "name": "Amanda Mathews",
        "email": "amanda.mathews@retailodyssey.com",
        "login_email": "amanda.mathews@fredmeyer.com",
        "sas_id": None,
    },
    {
        "workday_id": "800263453",
        "name": "Seth Newman",
        "email": "seth.newman@retailodyssey.com",
        "login_email": "seth.newman@fredmeyer.com",
        "sas_id": None,
    },
    {
        "workday_id": "800165906",
        "name": "Michael Ashabranner",
        "email": "mashabranner@retailodyssey.com",
        "login_email": "mashabranner@fredmeyer.com",
        "sas_id": None,
    },
    {
        "workday_id": "800184474",
        "name": "Richard Beck",
        "email": "richard.beck@fredmeyer.com",
        "login_email": "rbeck@retailodyssey.com",
        "sas_id": None,
    },
]


def sql_str(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def visit_id_for_store(store_number: int) -> int:
    return int("99999" + str(store_number).zfill(3)[-5:])


def load_employees() -> dict[str, dict]:
    with EMPLOYEES_JSON.open(encoding="utf-8") as f:
        rows = json.load(f)
    by_wd: dict[str, dict] = {}
    by_id: dict[int, dict] = {}
    for row in rows:
        wd = str(row.get("workday_given_id", "")).strip()
        if wd:
            by_wd[wd] = row
        if row.get("id") is not None:
            by_id[int(row["id"])] = row
    return by_wd, by_id


def load_har_visits() -> dict[tuple[int, str], dict]:
    with HAR_JSON.open(encoding="utf-8") as f:
        har = json.load(f)
    out: dict[tuple[int, str], dict] = {}
    for entry in har["log"]["entries"]:
        url = entry["request"]["url"]
        if "field-data" not in url:
            continue
        content = entry.get("response", {}).get("content", {})
        text = content.get("text", "")
        if content.get("encoding") == "base64":
            text = base64.b64decode(text).decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else data.get("results", [])
        for visit in items:
            sn = visit.get("store_name", {}).get("number")
            if sn in TARGET_SET:
                out[(int(sn), visit["scheduled_date"])] = visit
    return out


def load_excel_rows(by_wd: dict[str, dict]) -> list[dict]:
    import openpyxl

    wb = openpyxl.load_workbook(EXCEL, read_only=True)
    ws = wb.active
    rows: list[dict] = []
    for raw in ws.iter_rows(min_row=2, values_only=True):
        store_number = int(raw[5])
        if store_number not in TARGET_SET:
            continue
        workday_id = str(raw[1]).strip()
        emp = by_wd[workday_id]
        person = emp.get("person") or {}
        rows.append(
            {
                "team": raw[0],
                "workday_id": workday_id,
                "name": raw[2],
                "role": raw[3] or "Rep",
                "store_number": store_number,
                "scheduled_date": str(raw[8]),
                "due_by": str(raw[9]),
                "hours": raw[10],
                "shift_start_time": raw[11],
                "shift_end_time": raw[12],
                "sas_employee_id": int(emp["id"]),
                "email": (person.get("email") or "").strip().lower(),
                "phone": person.get("phone_number"),
                "title": person.get("person_title"),
                "supervisor_id": emp.get("supervisor_id"),
                "supervisor_name": (emp.get("supervisor_person") or {}).get("name"),
            }
        )
    return rows


def infer_login_email(email: str, person_name: str) -> str | None:
    """Best-effort Fred Meyer companion login for retailodyssey.com associates."""
    if not email or "@retailodyssey.com" not in email.lower():
        return None
    local = email.split("@", 1)[0]
    if "." in local:
        first, last = local.split(".", 1)
    else:
        parts = re.sub(r"[^a-zA-Z ]", " ", person_name).split()
        if len(parts) < 2:
            return None
        first, last = parts[0], parts[-1]
    return f"{first.lower()}.{last.lower()}@fredmeyer.com"


def build_seed(by_wd: dict[str, dict], by_id: dict[int, dict], har_visits: dict, excel_rows: list[dict]) -> dict:
    for overseer in OVERSEERS:
        emp = by_wd.get(overseer["workday_id"])
        if emp:
            overseer["sas_id"] = int(emp["id"])
            overseer["name"] = emp.get("person_name") or overseer["name"]

    shifts: dict[tuple[int, str], dict] = defaultdict(
        lambda: {
            "team": None,
            "lead": None,
            "members": [],
            "shift_start_time": None,
            "shift_end_time": None,
            "hours": None,
            "due_by": None,
        }
    )
    associates: dict[str, dict] = {}

    for row in excel_rows:
        key = (row["store_number"], row["scheduled_date"])
        shift = shifts[key]
        shift["team"] = row["team"]
        shift["shift_start_time"] = row["shift_start_time"]
        shift["shift_end_time"] = row["shift_end_time"]
        shift["hours"] = row["hours"]
        shift["due_by"] = row["due_by"]
        member = {
            "workday_id": row["workday_id"],
            "name": row["name"],
            "role": row["role"],
            "sas_employee_id": row["sas_employee_id"],
            "email": row["email"],
            "phone": row["phone"],
            "title": row["title"],
        }
        shift["members"].append(member)
        if row["role"] == "Lead":
            shift["lead"] = member

        wd = row["workday_id"]
        if wd not in associates:
            login_email = infer_login_email(row["email"], row["name"])
            associates[wd] = {
                **member,
                "login_email": login_email,
                "supervisor_id": row["supervisor_id"],
                "supervisor_name": row["supervisor_name"],
                "stores": {},
            }
        store_role = "lead" if row["role"] == "Lead" else "rep"
        prev = associates[wd]["stores"].get(str(row["store_number"]))
        if prev != "lead":
            associates[wd]["stores"][str(row["store_number"])] = store_role

    schedule_rows = []
    for (store_number, scheduled_date), shift in sorted(shifts.items()):
        har = har_visits.get((store_number, scheduled_date))
        visit_id = har["id"] if har else visit_id_for_store(store_number)
        schedule_rows.append(
            {
                "visit_id": visit_id,
                "visit_id_full": har.get("visit_id") if har else f"mock-{store_number}-{scheduled_date}-{CYCLE_ID}",
                "cycle_id": CYCLE_ID,
                "store_number": store_number,
                "store_name": "Fred Meyer",
                "project_name": "Fred Meyer Kompass ISE",
                "project_id": 1,
                "scheduled_date": scheduled_date,
                "shift_start_time": shift["shift_start_time"],
                "shift_end_time": shift["shift_end_time"],
                "total_hours": str(shift["hours"] or ""),
                "current_status": har.get("current_status") if har else "scheduled",
                "visit_lead": (shift["lead"] or {}).get("name"),
                "supervisor": "tyson.gauthier@retailodyssey.com",
                "emp_count": len(shift["members"]),
                "no_show_count": 0,
                "due_by": shift["due_by"],
                "team": shift["team"],
                "members": shift["members"],
            }
        )

    stores = []
    for store_number in TARGET_STORES:
        har_dates = [v for (sn, _dt), v in har_visits.items() if sn == store_number]
        default_visit = har_dates[0]["id"] if har_dates else visit_id_for_store(store_number)
        stores.append(
            {
                "store_number": str(store_number),
                "name": f"FM {store_number}",
                "default_visit_id": default_visit,
                "is_test": False,
            }
        )

    return {
        "cycle_id": CYCLE_ID,
        "target_stores": TARGET_STORES,
        "overseers": OVERSEERS,
        "stores": stores,
        "associates": list(associates.values()),
        "schedules": schedule_rows,
        "source_files": {
            "excel": str(EXCEL),
            "employees": str(EMPLOYEES_JSON),
            "har": str(HAR_JSON),
        },
    }


def render_sql(seed: dict) -> str:
    lines = [
        "-- Kompass cycle 242292 mock shifts for Checklane Hub (27 FM stores).",
        "-- Generated by scripts/generate-kompass-cycle-242292-seed.py",
        "",
        "-- Overseer hub admins (see all stores).",
    ]

    for o in seed["overseers"]:
        lines.append(
            f"""INSERT INTO hub_users (email, name, sas_user_id, standing_rank, is_hub_admin, login_email, is_active)
VALUES ({sql_str(o['email'])}, {sql_str(o['name'])}, {o['sas_id'] or 'NULL'}, 3, TRUE, {sql_str(o.get('login_email'))}, TRUE)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  sas_user_id = COALESCE(EXCLUDED.sas_user_id, hub_users.sas_user_id),
  standing_rank = GREATEST(hub_users.standing_rank, 3),
  is_hub_admin = TRUE,
  login_email = COALESCE(EXCLUDED.login_email, hub_users.login_email),
  is_active = TRUE;"""
        )

    lines.append("")
    lines.append("-- Fred Meyer sign-in allowlist for Richard Beck.")
    lines.append(
        "INSERT INTO allowed_emails (email, note) VALUES "
        "('richard.beck@fredmeyer.com', 'Checklane Hub overseer (Fred Meyer)')"
        "\nON CONFLICT (email) DO NOTHING;"
    )

    lines.append("")
    lines.append("-- Hub store registry.")
    for store in seed["stores"]:
        lines.append(
            f"""INSERT INTO hub_stores (store_number, name, default_visit_id, is_test)
VALUES ({sql_str(store['store_number'])}, {sql_str(store['name'])}, {store['default_visit_id']}, {str(store['is_test']).upper()})
ON CONFLICT (store_number) DO UPDATE SET
  name = EXCLUDED.name,
  default_visit_id = EXCLUDED.default_visit_id,
  is_test = EXCLUDED.is_test;"""
        )

    lines.append("")
    lines.append("-- SAS employee directory (scheduled associates).")
    for a in seed["associates"]:
        lines.append(
            f"""INSERT INTO employees (
  sas_employee_id, workday_id, name, title, phone, email,
  supervisor_id, supervisor_name, synced_at
) VALUES (
  {a['sas_employee_id']}, {sql_str(a['workday_id'])}, {sql_str(a['name'])}, {sql_str(a.get('title'))},
  {sql_str(a.get('phone'))}, {sql_str(a.get('email'))}, {sql_str(a.get('supervisor_id'))},
  {sql_str(a.get('supervisor_name'))}, NOW()
) ON CONFLICT (sas_employee_id) DO UPDATE SET
  workday_id = EXCLUDED.workday_id,
  name = EXCLUDED.name,
  title = EXCLUDED.title,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  supervisor_id = EXCLUDED.supervisor_id,
  supervisor_name = EXCLUDED.supervisor_name,
  synced_at = NOW();"""
        )

    lines.append("")
    lines.append("-- Hub user rows + store assignments for scheduled associates.")
    lines.append("DO $$")
    lines.append("DECLARE")
    lines.append("  uid INTEGER;")
    lines.append("  sn TEXT;")
    lines.append("  role TEXT;")
    lines.append("BEGIN")

    for a in seed["associates"]:
        email = a["email"]
        login = a.get("login_email")
        lines.append(
            f"  INSERT INTO hub_users (email, name, sas_user_id, login_email, standing_rank, is_active)\n"
            f"  VALUES ({sql_str(email)}, {sql_str(a['name'])}, {a['sas_employee_id']}, {sql_str(login)}, 1, TRUE)\n"
            f"  ON CONFLICT (email) DO UPDATE SET\n"
            f"    name = EXCLUDED.name,\n"
            f"    sas_user_id = COALESCE(EXCLUDED.sas_user_id, hub_users.sas_user_id),\n"
            f"    login_email = COALESCE(EXCLUDED.login_email, hub_users.login_email),\n"
            f"    is_active = TRUE\n"
            f"  RETURNING id INTO uid;"
        )
        for sn, role in sorted(a["stores"].items(), key=lambda x: int(x[0])):
            lines.append(
                f"  sn := {sql_str(sn)}; role := {sql_str(role)};\n"
                f"  INSERT INTO hub_store_assignments (store_number, user_id, store_role)\n"
                f"  SELECT sn, uid, role\n"
                f"  ON CONFLICT (store_number, user_id) DO UPDATE SET\n"
                f"    store_role = CASE\n"
                f"      WHEN EXCLUDED.store_role = 'lead' OR hub_store_assignments.store_role = 'lead' THEN 'lead'\n"
                f"      ELSE 'rep'\n"
                f"    END;"
            )

    lines.append("END $$;")
    lines.append("")
    lines.append("-- Mock visit schedules (store + date).")
    for s in seed["schedules"]:
        lines.append(
            f"""INSERT INTO schedules (
  visit_id, visit_id_full, cycle_id, store_number, store_name,
  project_name, project_id, scheduled_date, shift_start_time,
  shift_end_time, total_hours, current_status, visit_lead,
  supervisor, emp_count, no_show_count, due_by, synced_at
) VALUES (
  {s['visit_id']}, {sql_str(s['visit_id_full'])}, {s['cycle_id']}, {s['store_number']}, {sql_str(s['store_name'])},
  {sql_str(s['project_name'])}, {s['project_id']}, {sql_str(s['scheduled_date'])}, {sql_str(s['shift_start_time'])},
  {sql_str(s['shift_end_time'])}, {sql_str(s['total_hours'])}, {sql_str(s['current_status'])}, {sql_str(s['visit_lead'])},
  {sql_str(s['supervisor'])}, {s['emp_count']}, {s['no_show_count']}, {sql_str(s['due_by'])}, NOW()
) ON CONFLICT (visit_id, scheduled_date) DO UPDATE SET
  visit_id_full = EXCLUDED.visit_id_full,
  cycle_id = EXCLUDED.cycle_id,
  store_number = EXCLUDED.store_number,
  store_name = EXCLUDED.store_name,
  project_name = EXCLUDED.project_name,
  project_id = EXCLUDED.project_id,
  shift_start_time = EXCLUDED.shift_start_time,
  shift_end_time = EXCLUDED.shift_end_time,
  total_hours = EXCLUDED.total_hours,
  current_status = EXCLUDED.current_status,
  visit_lead = EXCLUDED.visit_lead,
  supervisor = EXCLUDED.supervisor,
  emp_count = EXCLUDED.emp_count,
  no_show_count = EXCLUDED.no_show_count,
  due_by = EXCLUDED.due_by,
  synced_at = NOW();"""
        )

    lines.append("")
    lines.append("-- Physical store directory.")
    for store in seed["stores"]:
        sn = int(store["store_number"])
        lines.append(
            f"""INSERT INTO stores (store_number, name, synced_at)
VALUES ({sn}, {sql_str(store['name'])}, NOW())
ON CONFLICT (store_number) DO UPDATE SET name = EXCLUDED.name, synced_at = NOW();"""
        )

    return "\n".join(lines) + "\n"


def main() -> None:
    by_wd, by_id = load_employees()
    har_visits = load_har_visits()
    excel_rows = load_excel_rows(by_wd)
    seed = build_seed(by_wd, by_id, har_visits, excel_rows)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    seed_path = DATA_DIR / "kompass-cycle-242292-seed.json"
    seed_path.write_text(json.dumps(seed, indent=2), encoding="utf-8")

    sql_path = MIGRATIONS_DIR / "025_kompass_cycle_242292_mock_shifts.sql"
    sql_path.write_text(render_sql(seed), encoding="utf-8")

    print(f"Wrote {seed_path}")
    print(f"Wrote {sql_path}")
    print(
        f"stores={len(seed['stores'])} associates={len(seed['associates'])} "
        f"schedules={len(seed['schedules'])} excel_rows={len(excel_rows)}"
    )


if __name__ == "__main__":
    main()
