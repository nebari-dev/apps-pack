"""Fail when a version string disagrees with .release-please-manifest.json.

release-please bumps all of these together; a hand edit to one of them
would ship mismatched versions.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def grep(path: str, pattern: str) -> str | None:
    m = re.search(pattern, (ROOT / path).read_text(), re.M)
    return m.group(1) if m else None


def main() -> int:
    want = json.loads((ROOT / ".release-please-manifest.json").read_text())["."]
    lock = json.loads((ROOT / "ui/package-lock.json").read_text())
    found = {
        "Chart.yaml version": grep("charts/nebari-apps/Chart.yaml", r"^version:\s*\"?([^\"\s#]+)"),
        "Chart.yaml appVersion": grep("charts/nebari-apps/Chart.yaml", r"^appVersion:\s*\"?([^\"\s#]+)"),
        "api __version__": grep("api/src/nebari_apps_api/__init__.py", r"^__version__ = \"([^\"]+)\""),
        "mcp __version__": grep("mcp/src/nebari_apps_mcp/__init__.py", r"^__version__ = \"([^\"]+)\""),
        "ui/package.json": json.loads((ROOT / "ui/package.json").read_text())["version"],
        "ui/package-lock.json": lock["version"],
        "ui/package-lock.json packages['']": lock["packages"][""]["version"],
    }
    bad = {k: v for k, v in found.items() if v != want}
    for k, v in found.items():
        print(("ok   " if v == want else "FAIL ") + f"{k}: {v}")
    if bad:
        print(f"::error::version strings must all be {want} (the release-please manifest)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
