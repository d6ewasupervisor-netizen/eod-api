#!/usr/bin/env python3
"""Build hub-fixtures from Kroger manifest + checklane scan_index."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCAN_INDEX_DIR = ROOT.parent / "Checklanes" / "Checklanes" / "checklane-deploy" / "scan_index"
AUDIT_MANIFEST = (
    ROOT.parent / "Checklanes" / "Checklanes" / "checklane-deploy" / "audit" / "_manifest_163.json"
)
FIXTURES_DIR = ROOT / "src" / "data" / "hub-fixtures"
DATA_DIR = ROOT / "src" / "data"
DEFAULT_MANIFEST_XLSX = Path(
    r"c:\Users\tgaut\Downloads\Kroger Manifest - Event Date 05-31-2026 - Fred_Meyer_701.xlsx"
)
DEFAULT_MANIFEST_JSON = DATA_DIR / "kroger-manifest-701-20260531.json"

TARGET_STORES = [
    5, 13, 19, 23, 24, 28, 31, 53, 70, 90, 171, 180, 209, 215, 225,
    325, 328, 355, 390, 417, 459, 603, 604, 608, 658, 665, 682,
]

CKLN_RE = re.compile(r"CKLN|CHECKLANE|CHECK LANE", re.I)
POG_RE = re.compile(r"^D701_L(\d+)_D(\d+)_(.+)_(\d{5,})$")
STRIP_RANK = {"R BOTH": 0, "NII BOTH": 1, "R STRIPS": 2, "NII STRIPS": 3}


def load_action_map() -> dict[str, str]:
    if not AUDIT_MANIFEST.exists():
        return {}
    data = json.loads(AUDIT_MANIFEST.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for dbkey, meta in (data.get("dbkeys") or {}).items():
        ssn = meta.get("ssn") or ""
        m = re.search(r"_D03_(.+)$", ssn)
        if m:
            out[str(dbkey)] = m.group(1)
    return out


def manifest_row_score(row: dict) -> tuple:
    strip = str(row.get("strip") or "")
    return (
        0 if row.get("dept") == "03" else 1,
        STRIP_RANK.get(strip, 9),
        0 if row.get("lane_code") not in (None, "", "00000") else 1,
    )


def store_pog_id(pog_id: str, store: int) -> str:
    return pog_id.replace("L00000", f"L{store:05d}")


def parse_kroger_manifest_xlsx(xlsx_path: Path) -> dict:
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, read_only=True)
    ws = wb["DivisionReport"]
    rows = list(ws.iter_rows(min_row=1, values_only=True))

    current_store: int | None = None
    ckln_by_store: dict[str, dict[str, dict]] = {}
    additional_by_store: dict[str, list[dict]] = {}

    for row in rows:
        if row[1] and str(row[1]).startswith("Store #:"):
            current_store = int(str(row[1]).split(":")[1].strip())
            ckln_by_store.setdefault(str(current_store), {})
            additional_by_store.setdefault(str(current_store), [])
            continue

        pog_id = row[2]
        if not pog_id or current_store is None:
            continue

        store_key = str(current_store)
        text = str(row[3] or "").strip()
        pog_id_str = str(pog_id).strip()
        m = POG_RE.match(pog_id_str)
        if not m:
            continue

        lane_code, dept, action, dbkey = m.groups()
        entry = {
            "pog_id": pog_id_str,
            "pog_id_store": store_pog_id(pog_id_str, current_store),
            "text": text,
            "action": action,
            "dbkey": dbkey,
            "dept": dept,
            "lane_code": lane_code,
            "strip": row[6],
            "office": row[7],
        }

        if CKLN_RE.search(text):
            prev = ckln_by_store[store_key].get(dbkey)
            if not prev or manifest_row_score(entry) < manifest_row_score(prev):
                ckln_by_store[store_key][dbkey] = entry
        else:
            additional_by_store[store_key].append(entry)

    return {
        "event_date": "2026-05-31",
        "division": 701,
        "source_xlsx": str(xlsx_path),
        "checklanes_by_store": ckln_by_store,
        "additional_sets_by_store": additional_by_store,
    }


def load_kroger_manifest(manifest_xlsx: Path | None, manifest_json: Path | None) -> dict:
    json_path = manifest_json or DEFAULT_MANIFEST_JSON
    if json_path.exists():
        return json.loads(json_path.read_text(encoding="utf-8"))

    xlsx_path = manifest_xlsx or DEFAULT_MANIFEST_XLSX
    if not xlsx_path.exists():
        print(f"WARN: no manifest at {xlsx_path}; using scan_index only")
        return {"checklanes_by_store": {}, "additional_sets_by_store": {}}

    parsed = parse_kroger_manifest_xlsx(xlsx_path)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(parsed, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote parsed manifest -> {json_path}")
    return parsed


def lane_code(short: str) -> str | None:
    s = (short or "").strip().upper()
    if s.isdigit():
        n = int(s)
        return f"6{n:02d}" if n < 100 else f"6{n}"
    if s in {"AU", "FO"}:
        return f"69{0 if s == 'AU' else 8}"
    if s == "?":
        return "690"
    return None


def infer_side(name: str) -> str:
    upper = (name or "").upper()
    if "CUSTOMER LEFT" in upper or " LEFT" in upper:
        return "L"
    if "CUSTOMER RIGHT" in upper or " RIGHT" in upper:
        return "R"
    return "E"


def classify_type(name: str, action: str | None) -> str:
    upper = (name or "").upper()
    act = action or ""
    if "COOLER" in upper and "ENDCAP" not in upper:
        return "cooler"
    if "ENDCAP" in upper or "END CAP" in upper:
        return "endcap"
    if "CIGARETTE" in upper:
        return "cigarette"
    if "BELTED" in upper or "SCO" in upper:
        return "belted_sco"
    if "USCAN" in upper and "RETRO" in upper:
        return "side_shelf"
    if "USCAN" in upper:
        return "uscan_stand"
    if "QUE" in upper or "QUEUE" in upper:
        return "queue"
    if "LIBERTY" in upper and "TAIL" in upper:
        return "liberty_tail"
    if "CHECKSTAND" in upper or "HCC" in upper:
        return "checkstand"
    if "BATTERY" in upper:
        return "battery"
    if act.startswith("C082"):
        return "cooler"
    if act.startswith("C121"):
        return "cigarette"
    if act.startswith("C201"):
        return "register"
    return "unclassified"


def on_manifest(name: str, dbkey: str | None) -> bool:
    if not dbkey:
        return False
    upper = (name or "").upper()
    if "FRONT OFFICE" in upper or "GM FRONT OTHER" in upper:
        return False
    if upper.strip().startswith("AUTH ONLY"):
        return False
    return True


def fixture_from_meta(
    *,
    store: int,
    dbkey: str,
    lane: str,
    name: str,
    action: str,
    manifest_pog_id: str | None,
    action_map: dict[str, str],
) -> dict:
    if not action:
        action = action_map.get(dbkey, "C201_V000_F000_MX")
    manifest_id = manifest_pog_id or f"D701_L{store:05d}_D03_{action}_{dbkey}"
    return {
        "lane": lane,
        "name": name,
        "action": action,
        "dbkey": str(dbkey),
        "manifest_pog_id": manifest_id if on_manifest(name, dbkey) else None,
        "on_manifest": on_manifest(name, dbkey),
        "type": classify_type(name, action),
        "side": infer_side(name),
    }


def build_fixtures(
    store: int,
    scan: dict,
    manifest_ckln: dict[str, dict],
    action_map: dict[str, str],
) -> list[dict]:
    lanes = scan.get("lanes") or {}
    pog_desc = scan.get("pogDesc") or {}
    fixtures: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    all_dbkeys = set(lanes.keys()) | set(manifest_ckln.keys())

    for dbkey in sorted(all_dbkeys, key=str):
        mf = manifest_ckln.get(dbkey)
        name = (mf or {}).get("text") or pog_desc.get(dbkey) or f"POG {dbkey}"
        action = (mf or {}).get("action") or action_map.get(str(dbkey), "")
        manifest_id = (mf or {}).get("pog_id_store") or (mf or {}).get("pog_id")

        lane_rows = lanes.get(dbkey) or []
        if lane_rows:
            for row in lane_rows:
                lc = lane_code(row.get("s") or row.get("d", ""))
                if not lc:
                    continue
                key = (lc, str(dbkey), action or "")
                if key in seen:
                    continue
                seen.add(key)
                fixtures.append(
                    fixture_from_meta(
                        store=store,
                        dbkey=str(dbkey),
                        lane=lc,
                        name=name,
                        action=action,
                        manifest_pog_id=manifest_id,
                        action_map=action_map,
                    )
                )
        elif mf:
            key = ("600", str(dbkey), action or "")
            if key not in seen:
                seen.add(key)
                fixtures.append(
                    fixture_from_meta(
                        store=store,
                        dbkey=str(dbkey),
                        lane="600",
                        name=name,
                        action=action,
                        manifest_pog_id=manifest_id,
                        action_map=action_map,
                    )
                )

    fixtures.sort(key=lambda f: (f["lane"], f["name"]))
    return fixtures


def sql_str(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


HYDRATION_ACTION = "C082_V861_I021_MX"


def is_hydration_fixture(fixture: dict) -> bool:
    name = (fixture.get("name") or "").upper()
    return fixture.get("action") == HYDRATION_ACTION or (
        "HYDRATION COOLER" in name and "SUPER NATURAL" not in name
    )


def patch_manifest_hydration(
    store: int,
    fixtures: list[dict],
    manifest_ckln: dict[str, dict],
    *,
    dbkey: str = "9007685",
) -> int:
    mf = manifest_ckln.get(dbkey) or {}
    pog_id = mf.get("pog_id_store") or store_pog_id(
        mf.get("pog_id") or f"D701_L00000_D01_C082_V861_I021_MX_{dbkey}",
        store,
    )
    changed = 0
    for fixture in fixtures:
        if not is_hydration_fixture(fixture):
            continue
        if (
            fixture.get("dbkey") == dbkey
            and fixture.get("on_manifest")
            and fixture.get("manifest_pog_id") == pog_id
        ):
            continue
        fixture["dbkey"] = dbkey
        fixture["manifest_pog_id"] = pog_id
        fixture["on_manifest"] = True
        changed += 1
    return changed


def resolve_target_stores(
    manifest_by_store: dict,
    *,
    manifest_dbkey: str | None,
    store_args: list[int] | None,
) -> list[int]:
    if store_args:
        return sorted(store_args)
    if manifest_dbkey:
        return sorted(
            int(store)
            for store, pogs in manifest_by_store.items()
            if manifest_dbkey in pogs and (SCAN_INDEX_DIR / f"{store}.json").exists()
        )
    return list(TARGET_STORES)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate hub fixture catalogs")
    parser.add_argument("--manifest-xlsx", type=Path, default=DEFAULT_MANIFEST_XLSX)
    parser.add_argument("--manifest-json", type=Path, default=DEFAULT_MANIFEST_JSON)
    parser.add_argument(
        "--manifest-dbkey",
        help="Generate for every store that has this dbkey on the Kroger manifest",
    )
    parser.add_argument(
        "--stores",
        nargs="+",
        type=int,
        help="Explicit store numbers (overrides TARGET_STORES / --manifest-dbkey)",
    )
    parser.add_argument(
        "--preserve-stores",
        nargs="+",
        type=int,
        default=[163],
        help="Keep existing fixture layout; only patch manifest hydration rows",
    )
    args = parser.parse_args()

    action_map = load_action_map()
    kroger = load_kroger_manifest(args.manifest_xlsx, args.manifest_json)
    manifest_by_store = kroger.get("checklanes_by_store") or {}
    preserve_stores = set(args.preserve_stores or [])

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    store_fixtures: dict[int, list[dict]] = {}
    summary = []
    target_stores = resolve_target_stores(
        manifest_by_store,
        manifest_dbkey=args.manifest_dbkey,
        store_args=args.stores,
    )

    for store in target_stores:
        path = SCAN_INDEX_DIR / f"{store}.json"
        if not path.exists():
            print(f"WARN missing scan_index for store {store}")
            continue
        scan = json.loads(path.read_text(encoding="utf-8"))
        manifest_ckln = manifest_by_store.get(str(store), {})
        out_path = FIXTURES_DIR / f"{store}.json"
        if store in preserve_stores and out_path.exists():
            out = json.loads(out_path.read_text(encoding="utf-8"))
            fixtures = out.get("fixtures") or []
            patched = patch_manifest_hydration(store, fixtures, manifest_ckln)
            out["manifestEventDate"] = kroger.get("event_date")
            out["checklaneSetCount"] = len(manifest_ckln)
            out["additionalSetCount"] = len(
                (kroger.get("additional_sets_by_store") or {}).get(str(store), [])
            )
            out["fixtures"] = fixtures
            store_fixtures[store] = fixtures
            out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
            lanes = len({f["lane"] for f in fixtures})
            summary.append((store, len(fixtures), lanes, len(manifest_ckln), f"patched {patched}"))
            continue

        fixtures = build_fixtures(store, scan, manifest_ckln, action_map)
        store_fixtures[store] = fixtures
        out = {
            "storeNumber": str(store),
            "manifestEventDate": kroger.get("event_date"),
            "checklaneSetCount": len(manifest_ckln),
            "additionalSetCount": len((kroger.get("additional_sets_by_store") or {}).get(str(store), [])),
            "fixtures": fixtures,
        }
        out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
        lanes = len({f["lane"] for f in fixtures})
        summary.append((store, len(fixtures), lanes, len(manifest_ckln), "generated"))


    print(f"Wrote {len(summary)} fixture catalogs -> {FIXTURES_DIR}")
    for store, count, lanes, ckln, mode in summary:
        print(f"  FM {store}: {count} fixtures, {lanes} lanes, {ckln} manifest CKLN sets ({mode})")


if __name__ == "__main__":
    main()
