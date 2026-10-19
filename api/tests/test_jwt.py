"""Real RS256 tokens through the real current_user dependency."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
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


# --- Through a real (fake-served) JWKS: key lookup by kid, not a stub. ---

KID = "realm-key-1"
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def jwks(*pairs: tuple[str, rsa.RSAPrivateKey]) -> dict:
    keys = []
    for kid, key in pairs:
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        keys.append({**jwk, "kid": kid, "use": "sig", "alg": "RS256"})
    return {"keys": keys}


def signed(key=KEY, kid: str = KID, alg: str = "RS256", **extra) -> str:
    claims = {"iss": ISSUER, "sub": "u-1", "preferred_username": "alice", "azp": "apps-ui-spa"}
    claims |= {"aud": "account", "exp": int(time.time()) + 300, **extra}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


@pytest.fixture
def jwks_client(store, monkeypatch):
    """The real PyJWKClient, fed the realm's JWKS document instead of HTTP."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "admin_groups", ["admin"])
    fetched: list[int] = []

    def fetch_data(self):
        fetched.append(1)
        return jwks((KID, KEY), ("realm-key-2", OTHER))

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fetch_data)
    app = create_app(store)
    app.state.jwt_validator = JWTValidator("https://keycloak.example.test/certs", ISSUER, "", ALLOWED)
    client = TestClient(app)
    client.fetched = fetched  # type: ignore[attr-defined]
    return client


def test_jwks_key_selected_by_kid(jwks_client):
    assert me(jwks_client, signed()) == 200
    assert me(jwks_client, signed(key=OTHER, kid="realm-key-2")) == 200


def test_jwks_is_cached(jwks_client):
    for _ in range(3):
        assert me(jwks_client, signed()) == 200
    assert len(jwks_client.fetched) == 1


def test_token_signed_by_an_unpublished_key_rejected(jwks_client):
    rogue = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # Claims a published kid, but the signature does not verify against it.
    assert me(jwks_client, signed(key=rogue)) == 401
    # A kid the realm never published.
    assert me(jwks_client, signed(key=rogue, kid="rogue")) == 401


def test_algorithm_confusion_rejected(jwks_client):
    # HS256 with the public key as the shared secret, and unsigned tokens.
    from cryptography.hazmat.primitives import serialization

    pem = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    # PyJWT refuses to sign this, so forge it by hand as an attacker would.
    header = {"alg": "HS256", "typ": "JWT", "kid": KID}
    claims = {"iss": ISSUER, "preferred_username": "mallory", "azp": "apps-ui-spa", "exp": int(time.time()) + 300}
    segments = [base64.urlsafe_b64encode(json.dumps(part).encode()).rstrip(b"=") for part in (header, claims)]
    mac = hmac.new(pem, b".".join(segments), hashlib.sha256).digest()
    forged = b".".join([*segments, base64.urlsafe_b64encode(mac).rstrip(b"=")]).decode()
    assert me(jwks_client, forged) == 401
    unsigned = jwt.encode({"iss": ISSUER, "azp": "apps-ui-spa"}, None, algorithm="none", headers={"kid": KID})
    assert me(jwks_client, unsigned) == 401


def test_missing_or_malformed_bearer_rejected(jwks_client):
    assert jwks_client.get("/api/v1/auth/me").status_code == 401
    assert me(jwks_client, "not-a-jwt") == 401
    resp = jwks_client.get("/api/v1/auth/me", headers={"Authorization": f"Basic {signed()}"})
    assert resp.status_code == 401


def test_identity_and_groups_from_claims(jwks_client):
    resp = jwks_client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {signed(email='a@example.test', groups=['/admin', 'analytics'])}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["username"] == "alice"
    assert body["email"] == "a@example.test"
    # Keycloak's full-path group names lose the leading slash; /admin makes an admin.
    assert set(body["groups"]) == {"admin", "analytics"}
