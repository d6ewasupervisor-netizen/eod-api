#!/usr/bin/env python3
"""P06W2 signoff test batch — 3 random stores × D1/D6/D8/D9, email Tyson only."""
from __future__ import annotations

import copy
import os
import random
import shutil
import sys
from pathlib import Path

BUILDER_ROOT = Path(r"C:/Users/tgaut/flow-automation/signoff_builder/signoff-builder")
LIVE_ISE = Path(
    r"C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker ISE V1.3.xlsm"
)
LIVE_BLITZ = Path(
    r"C:/Users/tgaut/OneDrive - Advantage Solutions/Auston Nix's files - Trackers/SUPER Tracker Blitz V1.3.xlsx"
)
TRACKER_ROOT = Path(r"C:/Users/tgaut/Downloads/p06w2 signoffs")
ISE_COPY = TRACKER_ROOT / "SUPER Tracker ISE V1.3 - P06W2 working copy.xlsm"
BLITZ_COPY = TRACKER_ROOT / "SUPER Tracker Blitz V1.3 - P06W2 working copy.xlsx"
CROSSREF_CACHE = Path(r"C:/SignoffBuilder/cross-reference-cache")
FLOW_ENV = Path(r"C:/Users/tgaut/flow-automation/.env")
REPORT_ENV = Path(r"C:/Users/tgaut/flow-automation/report_extraction/.env")
TYSON = "tyson.gauthier@retailodyssey.com"
DISTRICTS = (1, 6, 8, 9)
STORES_PER_DISTRICT = 3
RANDOM_SEED = 20260628


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def ensure_working_copies() -> None:
    TRACKER_ROOT.mkdir(parents=True, exist_ok=True)
    if not LIVE_ISE.is_file():
        raise SystemExit(f"Missing live ISE tracker: {LIVE_ISE}")
    if not LIVE_BLITZ.is_file():
        raise SystemExit(f"Missing live Blitz tracker: {LIVE_BLITZ}")
    shutil.copy2(LIVE_ISE, ISE_COPY)
    shutil.copy2(LIVE_BLITZ, BLITZ_COPY)
    print(f"Copied ISE  -> {ISE_COPY}", flush=True)
    print(f"Copied Blitz -> {BLITZ_COPY}", flush=True)


def pick_test_stores() -> list[str]:
    sys.path.insert(0, str(BUILDER_ROOT))
    from signoff_builder.scheduler import Scheduler  # noqa: E402

    scheduler = Scheduler(
        r"C:/Users/tgaut/OneDrive - Advantage Solutions/Build my signoffs/team_scheduler.xlsx"
    )
    rng = random.Random(RANDOM_SEED)
    picked: list[str] = []
    for district in DISTRICTS:
        pool = scheduler.stores_for_district(district)
        if len(pool) < STORES_PER_DISTRICT:
            raise SystemExit(
                f"District {district} has only {len(pool)} stores; need {STORES_PER_DISTRICT}."
            )
        sample = sorted(rng.sample(pool, STORES_PER_DISTRICT), key=lambda s: int(s))
        print(f"D{district}: {', '.join(sample)}", flush=True)
        picked.extend(sample)
    return picked


def patched_config() -> dict:
    sys.path.insert(0, str(BUILDER_ROOT))
    from signoff_builder import config as cfg  # noqa: E402

    base = copy.deepcopy(cfg.load_config(BUILDER_ROOT / "config.yaml"))
    paths = base.setdefault("paths", {})
    paths["tracker_ise_path"] = str(ISE_COPY)
    paths["tracker_blitz_path"] = str(BLITZ_COPY)
    paths["cross_reference_cache_dir"] = str(CROSSREF_CACHE)
    mirror = base.setdefault("mirror", {})
    mirror["source_path"] = str(ISE_COPY)

    xref = base.setdefault("cross_reference", {})
    xref["auto_refresh"] = True

    email_cfg = base.setdefault("email_distribution", {})
    email_cfg["cc"] = []
    email_cfg["district_recipient_overrides"] = {d: TYSON for d in DISTRICTS}
    return base


def main() -> int:
    load_dotenv(FLOW_ENV)
    load_dotenv(REPORT_ENV)
    ensure_working_copies()
    stores = pick_test_stores()
    store_csv = ",".join(stores)
    print(f"\nTest stores ({len(stores)}): {store_csv}\n", flush=True)

    from signoff_builder import cli, config as cfg  # noqa: E402

    cfg._CONFIG_CACHE = patched_config()
    argv = [
        "--tracker",
        str(ISE_COPY),
        "--scope",
        "custom",
        "--stores",
        store_csv,
        "--output",
        "pdf",
        "--export-pdf",
        "--email",
        "--period",
        "6",
        "--week",
        "2",
        "--exclude-week",
        "P06W3",
        "--exclude-week",
        "P06W4",
        "--verbose",
    ]
    return cli.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
