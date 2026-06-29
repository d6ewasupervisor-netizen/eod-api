#!/usr/bin/env python3
"""Build P06W1 signoffs for D1/D6/D8 from working tracker copies in Downloads."""
from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

BUILDER_ROOT = Path(r"C:/Users/tgaut/flow-automation/signoff_builder/signoff-builder")
TRACKER_ROOT = Path(r"C:/Users/tgaut/Downloads/p06w1 signoffs")
CROSSREF_ROOT = TRACKER_ROOT / "cross-reference"
PROD_XREF_DIR = CROSSREF_ROOT / "prod"
SI_XREF_DIR = CROSSREF_ROOT / "si"
FLOW_ENV = Path(r"C:/Users/tgaut/flow-automation/.env")
REPORT_ENV = Path(r"C:/Users/tgaut/flow-automation/report_extraction/.env")
ISE_COPY = TRACKER_ROOT / "SUPER Tracker ISE V1.3 - P06W1 working copy.xlsm"
BLITZ_COPY = TRACKER_ROOT / "SUPER Tracker Blitz V1.3 - P06W1 working copy.xlsx"

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

load_dotenv(FLOW_ENV)
load_dotenv(REPORT_ENV)

sys.path.insert(0, str(BUILDER_ROOT))

from signoff_builder import cli, config as cfg  # noqa: E402


def patched_config() -> dict:
    base = copy.deepcopy(cfg.load_config(BUILDER_ROOT / "config.yaml"))
    paths = base.setdefault("paths", {})
    paths["tracker_ise_path"] = str(ISE_COPY)
    paths["tracker_blitz_path"] = str(BLITZ_COPY)
    paths["prod_completion_dir"] = str(PROD_XREF_DIR)
    paths["si_completion_dir"] = str(SI_XREF_DIR)
    mirror = base.setdefault("mirror", {})
    mirror["source_path"] = str(ISE_COPY)
    return base


def main() -> int:
    if not ISE_COPY.is_file():
        raise SystemExit(f"Missing ISE copy: {ISE_COPY}")
    if not BLITZ_COPY.is_file():
        raise SystemExit(f"Missing Blitz copy: {BLITZ_COPY}")

    cfg._CONFIG_CACHE = patched_config()
    exit_code = 0
    for district in (1, 6, 8):
        print(f"\n=== P06W1 District {district} ===", flush=True)
        argv = [
            "--tracker",
            str(ISE_COPY),
            "--scope",
            "district",
            "--district",
            str(district),
            "--output",
            "pdf",
            "--export-pdf",
            "--email",
            "--period",
            "6",
            "--week",
            "1",
            "--exclude-week",
            "P06W2",
            "--exclude-week",
            "P06W3",
            "--exclude-week",
            "P06W4",
            "--verbose",
        ]
        code = cli.main(argv)
        if code != 0:
            print(f"District {district} failed with exit {code}", flush=True)
            exit_code = code
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
