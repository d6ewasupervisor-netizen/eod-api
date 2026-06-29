#!/usr/bin/env python3
"""Send P06W1 district signoff emails from Working Files PDFs (no rebuild)."""
from __future__ import annotations

import os
import sys
from collections import defaultdict
from pathlib import Path

BUILDER_ROOT = Path(r"C:/Users/tgaut/flow-automation/signoff_builder/signoff-builder")
WORKING = Path(r"C:/Users/tgaut/OneDrive - Advantage Solutions/Build my signoffs/Working Files")
FLOW_ENV = Path(r"C:/Users/tgaut/flow-automation/.env")


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
sys.path.insert(0, str(BUILDER_ROOT))

from signoff_builder import config as cfg, email_distribution, scheduler as sched_mod  # noqa: E402

PERIOD, WEEK = 6, 1
DISTRICTS = (1, 6, 8)


def district_for_team_pdf(name: str) -> int | None:
    # P06W1 Signoffs 6A.pdf -> district 6
    if not name.startswith("P06W1 Signoffs "):
        return None
    if "Supervisor" in name:
        return None
    token = name.replace("P06W1 Signoffs ", "").replace(".pdf", "").strip()
    if not token or not token[0].isdigit():
        return None
    return int(token[0])


def main() -> int:
    config = cfg.load_config(BUILDER_ROOT / "config.yaml")
    scheduler = sched_mod.Scheduler(config["paths"]["team_scheduler"])
    builds: dict[int, list[Path]] = defaultdict(list)
    for pdf in sorted(WORKING.glob("P06W1 Signoffs *.pdf")):
        district = district_for_team_pdf(pdf.name)
        if district in DISTRICTS:
            builds[district].append(pdf)
    for district in DISTRICTS:
        sup = sorted(WORKING.glob(f"P06W1_Supervisor_D{district}_*.pdf"))
        builds[district].extend(sup)
        print(f"D{district}: {len(builds[district])} attachment(s)")
    results = email_distribution.send_district_packages(
        builds_by_district=dict(builds),
        period=PERIOD,
        week=WEEK,
        config=config,
        scheduler=scheduler,
    )
    for district, info in sorted(results.items()):
        if info.get("sent"):
            print(f"  D{district}: sent {info['attachments']} to {info['to']} id={info.get('message_id')}")
        else:
            print(f"  D{district}: NOT sent - {info.get('reason')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
