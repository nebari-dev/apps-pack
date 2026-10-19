"""Turn an uploaded zip archive or single .html file into inline source files.

Small apps (static sites or Python/pixi source trees) are carried inline in
the App CR and materialized by the operator as a ConfigMap-backed volume.
ConfigMaps cap out at ~1MiB, so uploads are size-limited; larger apps should
use git or a PVC source.
"""

from __future__ import annotations

import io
import posixpath
import zipfile
from typing import IO

from fastapi import HTTPException

from .config import settings

# ConfigMap values must be UTF-8 text; these are the extensions we accept.
TEXT_EXTENSIONS = {
    ".html",
    ".htm",
    ".css",
    ".js",
    ".mjs",
    ".json",
    ".txt",
    ".md",
    ".svg",
    ".xml",
    ".csv",
    ".webmanifest",
    ".map",
    # Python/pixi source trees.
    ".py",
    ".toml",
    ".lock",
    ".cfg",
    ".ini",
    ".yaml",
    ".yml",
    ".in",
    ".sh",
}

_CHUNK = 64 * 1024

# Files that mark the root of a pixi project.
PIXI_MANIFESTS = ("pixi.toml", "pyproject.toml")


def _safe_name(name: str) -> str | None:
    """Normalize a zip entry to a safe relative path, or None to skip it."""
    name = name.replace("\\", "/")
    norm = posixpath.normpath(name)
    if norm.startswith(("/", "../")) or norm == "..":
        raise HTTPException(400, f"unsafe path in archive: {name!r}")
    if norm in (".", ""):
        return None
    parts = norm.split("/")
    # Skip metadata directories and hidden files.
    if any(p.startswith(".") or p == "__MACOSX" for p in parts):
        return None
    return norm


def _too_large(detail: str) -> HTTPException:
    return HTTPException(413, f"{detail} - use a git or pvc source for larger apps")


def read_capped(stream: IO[bytes], limit: int, what: str = "upload") -> bytes:
    """Read at most `limit` bytes from a file-like object, in chunks.

    Raises 413 as soon as the stream yields more than `limit` bytes, so the
    caller never holds more than limit + one chunk in memory.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(min(_CHUNK, limit + 1 - total))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            raise _too_large(f"{what} exceeds the {settings.max_upload_bytes}-byte inline cap")
        chunks.append(chunk)


def files_from_upload(filename: str, data: bytes, pixi: bool = False) -> dict[str, str]:
    """Convert an uploaded .zip or .html payload into inline source files.

    With pixi=True the upload is a Python/pixi app: it must be a zip and must
    contain a pixi manifest (pixi.toml or pyproject.toml) at its root instead
    of an index.html.
    """
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            413,
            f"upload is {len(data)} bytes; inline uploads are capped at "
            f"{settings.max_upload_bytes} bytes - use a git or pvc source for larger apps",
        )

    lower = filename.lower()
    if lower.endswith((".html", ".htm")):
        if pixi:
            raise HTTPException(400, "pixi apps must be uploaded as a .zip archive")
        try:
            return {"index.html": data.decode("utf-8")}
        except UnicodeDecodeError as exc:
            raise HTTPException(400, "HTML upload must be UTF-8 text") from exc

    if not lower.endswith(".zip"):
        raise HTTPException(400, "upload must be a .zip archive or a single .html file")

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, "invalid zip archive") from exc

    files: dict[str, str] = {}
    total = 0
    for info in archive.infolist():
        if info.is_dir():
            continue
        name = _safe_name(info.filename)
        if name is None:
            continue
        ext = posixpath.splitext(name)[1].lower()
        if ext not in TEXT_EXTENSIONS:
            raise HTTPException(
                400,
                f"{name!r}: only text assets ({', '.join(sorted(TEXT_EXTENSIONS))}) can be "
                "inlined - use a git or pvc source for sites with binary assets",
            )
        # Check the declared size before decompressing anything, then read
        # with a hard cap in case the header lies: a zip bomb never gets
        # inflated past the remaining budget.
        remaining = settings.max_upload_bytes - total
        if info.file_size > remaining:
            raise _too_large(
                f"{name!r} is {info.file_size} bytes uncompressed; the extracted archive "
                f"is capped at {settings.max_upload_bytes} bytes"
            )
        try:
            with archive.open(info) as member:
                content = read_capped(member, remaining, what="extracted archive")
        except zipfile.BadZipFile as exc:
            raise HTTPException(400, f"{name!r}: corrupt archive member") from exc
        total += len(content)
        try:
            files[name] = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(400, f"{name!r} is not UTF-8 text") from exc

    if not files:
        raise HTTPException(400, "archive contains no usable files")

    # Flatten a single top-level directory (zip-of-a-folder is the common case).
    tops = {f.split("/", 1)[0] for f in files}
    if len(tops) == 1 and all("/" in f for f in files):
        files = {f.split("/", 1)[1]: c for f, c in files.items()}

    if pixi:
        if not any(m in files for m in PIXI_MANIFESTS):
            raise HTTPException(
                400,
                "pixi app upload must contain a pixi.toml or pyproject.toml at its root",
            )
    elif "index.html" not in files:
        raise HTTPException(400, "upload must contain an index.html at its root")

    return files
