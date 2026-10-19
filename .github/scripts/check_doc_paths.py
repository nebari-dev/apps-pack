"""Fail when an agent-facing doc names a repository path that does not exist.

Checks every backticked or linked token with a slash in AGENTS.md and the
new-nebari-app skill. A token counts as a repo path when its first segment
exists in one of its bases: the repo root, the doc's own directory, or, in a
table row that starts with a directory (AGENTS.md's repository map), that
directory. Anything else (an apiVersion, a URL) is not a path and is skipped.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ["AGENTS.md", "skill/new-nebari-app/SKILL.md", "skill/new-nebari-app/references/manifest.md"]
TOKEN = re.compile(r"`([^`\s]+)`|\]\(([^)\s#]+)")


def check(doc: str) -> list[str]:
    path = ROOT / doc
    missing = []
    for line in path.read_text().splitlines():
        row = re.match(r"\| `([\w./-]+)/` \|", line)
        bases = [ROOT, path.parent] + ([ROOT / row.group(1)] if row else [])
        for m in TOKEN.finditer(line):
            tok = (m.group(1) or m.group(2)).rstrip("/")
            if "/" not in tok or tok.startswith("/") or "://" in tok or "*" in tok or "<" in tok:
                continue
            first = tok.split("/")[0]
            homes = [b for b in bases if (b / first).exists()]
            if homes and not any((b / tok).exists() for b in homes):
                missing.append(f"{doc}: {tok}")
    return missing


def main() -> int:
    missing = [m for doc in DOCS for m in check(doc)]
    for m in missing:
        print(f"::error::{m} does not exist")
    print(f"checked {', '.join(DOCS)}: {len(missing)} missing path(s)")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
