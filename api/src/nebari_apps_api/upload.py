"""Turn an uploaded zip archive or single .html file into inline source files.

Small static sites are carried inline in the App CR and materialized by the
operator as a ConfigMap-backed volume. ConfigMaps cap out at ~1MiB, so
uploads are size-limited; larger sites should use git or a PVC source.
"""

from __future__ import annotations

import io
import posixpath
import zipfile

from fastapi import HTTPException

from .config import settings

# ConfigMap values must be UTF-8 text; these are the extensions we accept.
TEXT_EXTENSIONS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".md", ".svg",
    ".xml", ".csv", ".webmanifest", ".map",
}


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


def files_from_upload(filename: str, data: bytes) -> dict[str, str]:
    """Convert an uploaded .zip or .html payload into inline source files."""
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            413,
            f"upload is {len(data)} bytes; inline uploads are capped at "
            f"{settings.max_upload_bytes} bytes - use a git or pvc source for larger sites",
        )

    lower = filename.lower()
    if lower.endswith((".html", ".htm")):
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
        content = archive.read(info)
        total += len(content)
        if total > settings.max_upload_bytes:
            raise HTTPException(
                413,
                f"extracted archive exceeds {settings.max_upload_bytes} bytes - "
                "use a git or pvc source for larger sites",
            )
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

    if "index.html" not in files:
        raise HTTPException(400, "upload must contain an index.html at its root")

    return files
