#!/usr/bin/env python3
"""P06W2 re-run for D6 test-set stores 286 and 163 only.

Re-builds just these two stores with the new test-set routing rule (PROD+SI-complete
sets stay on the team signoff). Re-copies the live trackers, reuses today's fresh
cross-reference cache (no in-process refresh -> no node/morning-auth deadlock), and
drops PDFs into the correct weekly Dump Bin folders by district. No email is sent --
they will be pulled from the dump bin and emailed manually.
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
STORES = ["286", "163"]


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


def patched_config() -> dict:
    sys.path.insert(0, str(BUILDER_ROOT))
    from signoff_builder import config as cfg  # noqa: E402

    base = copy.deepcopy(cfg.load_config(BUILDER_ROOT / "config.yaml"))
    paths = base.setdefault("paths", {})
    paths["tracker_ise_path"] = str(ISE_COPY)
    paths["tracker_blitz_path"] = str(BLITZ_COPY)
    paths["cross_reference_cache_dir"] = str(CROSSREF_CACHE)
    # Reuse today's fresh cache; skip in-process refresh (python->node->morning-auth
    # spawn can deadlock when the SAS session needs re-auth).
    paths["prod_completion_dir"] = str(CROSSREF_CACHE / "prod")
    paths["si_completion_dir"] = str(CROSSREF_CACHE / "si")
    mirror = base.setdefault("mirror", {})
    mirror["source_path"] = str(ISE_COPY)

    xref = base.setdefault("cross_reference", {})
    xref["auto_refresh"] = False
    return base


def main() -> int:
    load_dotenv(FLOW_ENV)
    load_dotenv(REPORT_ENV)
    ensure_working_copies()
    store_csv = ",".join(STORES)
    print(f"\nRe-run stores ({len(STORES)}): {store_csv}\n", flush=True)

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
