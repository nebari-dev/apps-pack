"""Upload hardening: zip bombs and oversize bodies are refused with 413
without inflating or buffering them."""

from __future__ import annotations

import io
import json
import tracemalloc
import zipfile

import pytest

from nebari_apps_api.config import settings

MANIFEST = json.dumps(
    {"name": "bomb", "namespace": "apps", "displayName": "Bomb", "access": {"public": True, "subdomain": "bomb"}}
)


def _deflated_zip(name: str, size: int) -> bytes:
    """A zip whose single member inflates to `size` bytes of zeros."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        with zf.open(name, "w", force_zip64=True) as member:
            chunk = b"\0" * (1024 * 1024)
            for _ in range(size // len(chunk)):
                member.write(chunk)
    return buf.getvalue()


@pytest.fixture(scope="module")
def bomb() -> bytes:
    data = _deflated_zip("index.html", 200 * 1024 * 1024)  # 200 MiB inflated
    assert len(data) < settings.max_upload_bytes  # small enough to pass the upload cap
    return data


def _post(client, data: bytes, filename: str = "site.zip"):
    return client.post(
        "/api/v1/apps/upload",
        data={"manifest": MANIFEST},
        files={"file": (filename, data, "application/zip")},
    )


def test_zip_bomb_rejected_without_inflating(client, store, bomb):
    tracemalloc.start()
    try:
        resp = _post(client, bomb)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert resp.status_code == 413, resp.text
    assert "uncompressed" in resp.json()["detail"]
    assert store.apps == {}
    # The request, its multipart parse and the zip directory fit in a few
    # MiB; inflating the member would need 200 MiB.
    assert peak < 16 * 1024 * 1024, peak


def test_members_count_against_one_budget(client, monkeypatch):
    """Several members that each fit but together exceed the cap."""
    monkeypatch.setattr(settings, "max_upload_bytes", 10_000)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", "a" * 6_000)
        zf.writestr("app.js", "b" * 6_000)
    resp = _post(client, buf.getvalue())
    assert resp.status_code == 413
    assert "'app.js'" in resp.json()["detail"]


def test_oversize_upload_file_rejected(client, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 1_000)
    resp = _post(client, b"<h1>" + b"x" * 5_000 + b"</h1>", filename="index.html")
    assert resp.status_code == 413


def test_oversize_body_rejected_by_content_length(client, monkeypatch):
    monkeypatch.setattr(settings, "max_request_bytes", 4_096)
    resp = client.post(
        "/api/v1/apps",
        content=b"{" + b" " * 10_000 + b"}",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 413
    assert "request body exceeds 4096 bytes" in resp.json()["detail"]


def test_oversize_body_rejected_while_streaming(client, monkeypatch):
    """A chunked body (no Content-Length) is cut off once it passes the cap."""
    monkeypatch.setattr(settings, "max_request_bytes", 4_096)
    sent = 0

    def body():
        nonlocal sent
        for _ in range(100):
            sent += 1024
            yield b" " * 1024

    resp = client.post("/api/v1/apps", content=body(), headers={"content-type": "application/json"})
    assert resp.status_code == 413
    assert "request body exceeds" in resp.json()["detail"]


def test_body_under_cap_still_works(client, monkeypatch):
    monkeypatch.setattr(settings, "max_request_bytes", 64 * 1024)
    from .test_apps import make_app_body

    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
