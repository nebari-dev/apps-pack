"""Set every version string to the given release version.

The chart's `version` and `appVersion`, the API and MCP `__version__`, and
`ui/package.json` with its lockfile all carry the pack's release version;
the "Version strings" CI check fails when they disagree. Merging the change
to `charts/nebari-apps/Chart.yaml` is the release (`release.yaml`).

    python3 .github/scripts/bump_version.py 0.2.0
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")

# (file, pattern, count): each pattern's group 1 and 2 surround the version.
EDITS = [
    ("charts/nebari-apps/Chart.yaml", r'^(version:\s*)[^\s#]+()', 1),
    ("charts/nebari-apps/Chart.yaml", r'^(appVersion:\s*")[^"]+(")', 1),
    ("api/src/nebari_apps_api/__init__.py", r'^(__version__ = ")[^"]+(")', 1),
    ("mcp/src/nebari_apps_mcp/__init__.py", r'^(__version__ = ")[^"]+(")', 1),
    ("ui/package.json", r'^(  "version": ")[^"]+(")', 1),
    # The lockfile's top-level version and packages[""].version.
    ("ui/package-lock.json", r'^(  (?:    )?"version": ")[^"]+(")', 2),
]


def main() -> int:
    if len(sys.argv) != 2 or not SEMVER.match(sys.argv[1]):
        print("usage: bump_version.py X.Y.Z", file=sys.stderr)
        return 2
    version = sys.argv[1]
    for path, pattern, count in EDITS:
        file = ROOT / path
        text, n = re.subn(pattern, rf"\g<1>{version}\g<2>", file.read_text(), count=count, flags=re.M)
        if n != count:
            print(f"::error::{path}: expected {count} version string(s), found {n}", file=sys.stderr)
            return 1
        file.write_text(text)
    print(f"set every version string to {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
