"""Keycloak group paths, compared the way nebari-operator matches them.

nebari-operator (v0.2.0+) enforces an App's access.groups at the gateway
against the token's groups claim, which carries full group paths such as
"/finance" or "/parent/child". An entry is the full path of one group: a bare
name is shorthand for the top-level group ("finance" is "/finance"), and a
parent does not include its subgroups ("/finance" does not admit members of
"/finance/analysts" only). apps-api uses the same rule for api.adminGroups
and access.managers.groups, so one group means the same thing everywhere.
"""

from __future__ import annotations

from collections.abc import Iterable


def group_path(entry: str) -> str:
    """The canonical full path of a group entry, as nebari-operator's
    groups.NormalizePath computes it: a leading "/", no trailing "/" and no
    empty segments. Returns "" for an entry that names no group ("", "/").
    """
    segments = [s for s in entry.strip().split("/") if s]
    return "/" + "/".join(segments) if segments else ""


def group_paths(entries: Iterable[str]) -> set[str]:
    """The canonical paths of entries, without the ones that name no group."""
    return {p for p in (group_path(e) for e in entries) if p}
