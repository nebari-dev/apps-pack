"""Real RS256 tokens through the real current_user dependency."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from nebari_apps_api.auth import JWTValidator
from nebari_apps_api.config import settings
from nebari_apps_api.main import create_app

ISSUER = "https://keycloak.example.test/realms/nebari"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _Key:
    key = KEY.public_key()


def token(azp: str = "apps-ui-spa", aud: str | list[str] = "account", **extra) -> str:
    claims = {
        "iss": ISSUER,
        "sub": "u-1",
        "preferred_username": "alice",
        "azp": azp,
        "aud": aud,
        "exp": int(time.time()) + 300,
        **extra,
    }
    return jwt.encode(claims, KEY, algorithm="RS256")


@pytest.fixture
def make_client(store, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)

    def make(allowed: list[str] | None, audience: str = "") -> TestClient:
        app = create_app(store)
        validator = JWTValidator("https://unused.example.test/certs", ISSUER, audience, allowed)
        validator._jwks.get_signing_key_from_jwt = lambda _t: _Key()  # type: ignore[method-assign]
        app.state.jwt_validator = validator
        return TestClient(app)

    return make


def me(client: TestClient, tok: str) -> int:
    return client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tok}"}).status_code


ALLOWED = ["apps-ui-spa", "apps-ui-device"]


def test_spa_token_accepted_by_azp(make_client):
    assert me(make_client(ALLOWED), token(azp="apps-ui-spa")) == 200


def test_device_token_accepted(make_client):
    assert me(make_client(ALLOWED), token(azp="apps-ui-device", aud=["apps-ui", "account"])) == 200


def test_token_for_another_client_rejected(make_client):
    """Same realm, valid signature, wrong client: 401."""
    assert me(make_client(ALLOWED), token(azp="grafana", aud="account")) == 401


def test_audience_match_accepted(make_client):
    assert me(make_client(ALLOWED), token(azp="other", aud=["apps-ui-device"])) == 200


def test_empty_allowlist_fails_closed(make_client):
    """OIDC_ALLOWED_CLIENTS set but empty (secret missing): reject everything."""
    assert me(make_client([]), token()) == 401


def test_unset_allowlist_skips_check(make_client):
    assert me(make_client(None), token(azp="anything")) == 200


def test_wrong_issuer_and_expired_rejected(make_client):
    client = make_client(ALLOWED)
    assert me(client, token(iss="https://evil.example.test/realms/nebari")) == 401
    assert me(client, token(exp=int(time.time()) - 10)) == 401


def test_strict_audience_still_supported(make_client):
    client = make_client(None, audience="apps-ui")
    assert me(client, token(aud="account")) == 401
    assert me(client, token(aud=["apps-ui"])) == 200


def test_allowed_clients_env_parsing(monkeypatch):
    from nebari_apps_api.config import _client_list

    monkeypatch.delenv("OIDC_ALLOWED_CLIENTS", raising=False)
    assert _client_list("OIDC_ALLOWED_CLIENTS") is None
    monkeypatch.setenv("OIDC_ALLOWED_CLIENTS", "spa, device,")
    assert _client_list("OIDC_ALLOWED_CLIENTS") == ["spa", "device"]
    # Unexpanded Kubernetes references from a missing secret: fail closed.
    monkeypatch.setenv("OIDC_ALLOWED_CLIENTS", "$(UI_KEYCLOAK_CLIENT_ID),$(OIDC_DEVICE_CLIENT_ID)")
    assert _client_list("OIDC_ALLOWED_CLIENTS") == []
