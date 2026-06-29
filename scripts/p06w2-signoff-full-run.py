#!/usr/bin/env python3
"""P06W2 COMPLETE run — ALL stores in D1/D6/D8/D9, fresh pull, email Tyson only.

Mirrors p06w2-signoff-test-batch.py but builds every store in the four districts
(no random sampling). Cross-references are refreshed live ("pull fresh from
everywhere"); per-district packages are emailed to Tyson as directed previously
and dropped into the correct weekly Dump Bin folders by district.
"""
from __future__ import annotations

import copy
import os
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


def all_stores() -> list[str]:
    sys.path.insert(0, str(BUILDER_ROOT))
    from signoff_builder.scheduler import Scheduler  # noqa: E402

    scheduler = Scheduler(
        r"C:/Users/tgaut/OneDrive - Advantage Solutions/Build my signoffs/team_scheduler.xlsx"
    )
    picked: list[str] = []
    for district in DISTRICTS:
        pool = sorted(scheduler.stores_for_district(district), key=lambda s: int(s))
        if not pool:
            raise SystemExit(f"District {district} has no stores in the scheduler.")
        print(f"D{district}: {len(pool)} store(s): {', '.join(pool)}", flush=True)
        picked.extend(pool)
    return picked


def patched_config() -> dict:
    sys.path.insert(0, str(BUILDER_ROOT))
    from signoff_builder import config as cfg  # noqa: E402

    base = copy.deepcopy(cfg.load_config(BUILDER_ROOT / "config.yaml"))
    paths = base.setdefault("paths", {})
    paths["tracker_ise_path"] = str(ISE_COPY)
    paths["tracker_blitz_path"] = str(BLITZ_COPY)
    paths["cross_reference_cache_dir"] = str(CROSSREF_CACHE)
    # Cross-references were refreshed out-of-band (node refresh_signoff_crossrefs.mjs),
    # so point the loaders straight at the fresh cache and skip the in-process refresh
    # (the Python->node->morning-auth spawn can deadlock when the SAS session needs
    # re-auth). The CSVs under prod/ and si/ are the same files auto_refresh produces.
    paths["prod_completion_dir"] = str(CROSSREF_CACHE / "prod")
    paths["si_completion_dir"] = str(CROSSREF_CACHE / "si")
    mirror = base.setdefault("mirror", {})
    mirror["source_path"] = str(ISE_COPY)

    xref = base.setdefault("cross_reference", {})
    xref["auto_refresh"] = False

    email_cfg = base.setdefault("email_distribution", {})
    email_cfg["cc"] = []
    email_cfg["district_recipient_overrides"] = {d: TYSON for d in DISTRICTS}
    return base


def main() -> int:
    load_dotenv(FLOW_ENV)
    load_dotenv(REPORT_ENV)
    ensure_working_copies()
    stores = all_stores()
    store_csv = ",".join(stores)
    print(f"\nFull run stores ({len(stores)}): {store_csv}\n", flush=True)

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
