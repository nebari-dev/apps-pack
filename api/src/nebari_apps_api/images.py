"""Image references and the registry allowlist for source type image.

Mirrors operator/internal/controller/imageref.go, which is the boundary (it
checks every App, however it was written); apps-api applies the same rules so
a request outside the allowlist fails with a clear 422 before the App exists.

A reference is parsed with the Docker grammar and normalized the way the
container runtime would: a first path component without a '.' or ':' (and not
"localhost") is a Docker Hub repository, so "nginx:1.27" is
"docker.io/library/nginx:1.27", and index.docker.io / registry-1.docker.io are
written docker.io. A tag or a digest is required.

An allowlist entry is "<host>[:port][/<repository prefix>]". An image matches
when its "<host>/<repository>" equals the entry or starts with the entry
followed by "/": hosts compare whole (ghcr.io does not admit
ghcr.io.evil.com) and prefixes match whole path components (ghcr.io/org does
not admit ghcr.io/org-evil). There are no wildcards.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

DOCKER_HUB = "docker.io"
_HUB_ALIASES = {"docker.io", "index.docker.io", "registry-1.docker.io"}
_COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
_LABEL = r"[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?"
_PATH = re.compile(rf"^{_COMPONENT}(?:/{_COMPONENT})*$")
_HOST = re.compile(rf"^{_LABEL}(?:\.{_LABEL})*(?::[0-9]{{1,5}})?$")
_TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
MAX_REFERENCE_LENGTH = 512


@dataclass(frozen=True)
class ImageRef:
    host: str
    path: str
    tag: str = ""
    digest: str = ""

    @property
    def repository(self) -> str:
        return f"{self.host}/{self.path}"

    def __str__(self) -> str:
        out = self.repository
        if self.tag:
            out += f":{self.tag}"
        if self.digest:
            out += f"@{self.digest}"
        return out


def _looks_like_host(s: str) -> bool:
    return "." in s or ":" in s or s == "localhost"


def parse_image_ref(raw: str) -> ImageRef:
    """Parse and normalize a reference; ValueError explains a bad one."""
    if not raw or raw != raw.strip():
        raise ValueError("must be a non-empty image reference without spaces")
    name, digest = raw, ""
    if "@" in name:
        name, digest = name.split("@", 1)
        if not _DIGEST.fullmatch(digest):
            raise ValueError(f"digest {digest!r} must be sha256:<64 lowercase hex>")
    tag = ""
    colon = name.rfind(":")
    if colon > name.rfind("/"):
        name, tag = name[:colon], name[colon + 1 :]
        if not _TAG.fullmatch(tag):
            raise ValueError(f"invalid tag {tag!r}")
    first, sep, rest = name.partition("/")
    if sep and _looks_like_host(first):
        if not _HOST.fullmatch(first):
            raise ValueError(f"invalid registry host {first!r}")
        host, path = first.lower(), rest
    else:
        host, path = DOCKER_HUB, name
    if host in _HUB_ALIASES:
        host = DOCKER_HUB
    if not _PATH.fullmatch(path):
        raise ValueError(f"invalid repository {path!r} (lowercase letters, digits and . _ - separators)")
    if host == DOCKER_HUB and "/" not in path:
        path = f"library/{path}"
    ref = ImageRef(host, path, tag, digest)
    if not tag and not digest:
        raise ValueError("needs a tag (:1.2.3) or a digest (@sha256:...)")
    if len(str(ref)) > MAX_REFERENCE_LENGTH:
        raise ValueError(f"is longer than {MAX_REFERENCE_LENGTH} characters")
    return ref


def parse_allowlist(entries: list[str]) -> list[str]:
    """Normalize allowlist entries; ValueError for one that names no host or
    carries a tag, digest or wildcard.
    """
    out: list[str] = []
    for raw in entries:
        entry = raw.strip().removesuffix("/")
        if not entry:
            continue
        first, _, rest = entry.partition("/")
        if not _looks_like_host(first) or not _HOST.fullmatch(first):
            raise ValueError(f"image registry {raw!r} must start with a registry host, e.g. ghcr.io or docker.io")
        host = first.lower()
        if host in _HUB_ALIASES:
            host = DOCKER_HUB
        if rest and not _PATH.fullmatch(rest):
            raise ValueError(
                f"image registry {raw!r}: invalid repository prefix {rest!r} (no tags, digests or wildcards)"
            )
        out.append(f"{host}/{rest}" if rest else host)
    return out


def registry_allowed(ref: ImageRef, allowlist: list[str]) -> bool:
    repo = ref.repository
    return any(repo == entry or repo.startswith(entry + "/") for entry in allowlist)


def check_image(raw: str, allowlist: list[str]) -> ImageRef:
    """The normalized reference, or ValueError saying why it may not run."""
    if not allowlist:
        raise ValueError(
            "image sources are disabled on this cluster: no registries are allowed (chart apps.image.allowedRegistries)"
        )
    ref = parse_image_ref(raw)
    if not registry_allowed(ref, allowlist):
        raise ValueError(f"{ref.repository} is not in the allowed image registries ({', '.join(allowlist)})")
    return ref
